import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Inngest } from 'inngest';
import { serve } from 'inngest/node';
import { z } from 'zod';
import { missionTick, type EngineServices } from '../src/engine.js';
import { closeDatabasePools } from '../src/database.js';
const database = new URL(process.env.DATABASE_URL ?? '');
if (
  process.env.LO_RESTART_DRILL !== 'true' ||
  process.env.NODE_ENV !== 'test' ||
  !/^lo_restart_[0-9]+$/.test(database.pathname.slice(1)) ||
  !['127.0.0.1', 'localhost'].includes(database.hostname)
)
  throw new Error('Isolated local restart drill database required');
const directory = resolve(z.string().min(1).parse(process.env.LO_DRILL_DIRECTORY)),
  executionId = z.uuid().parse(process.env.LO_DRILL_EXECUTION_ID),
  missionId = '20000000-0000-4000-8000-000000000001',
  authUserId = '00000000-0000-4000-8000-000000000001',
  port = z.coerce.number().int().min(1024).max(65535).parse(process.env.LO_DRILL_WORKER_PORT);
const client = new Inngest({ id: 'launch-operator-restart-drill' }),
  steps = { run: <T>(_id: string, work: () => Promise<T>) => work() };
function services(phase: number): EngineServices {
  return {
    plan: async () => ({
      ok: true,
      value: {
        questions: [],
        runs: [],
        decisions: [],
        commitments: [],
        founderMessage: `Synthetic restart drill ${executionId} phase ${phase}`,
        evidenceIds: [],
        focus: null,
      },
    }),
    run: async () => {
      throw Error('No model or specialist in this scripted restart drill');
    },
    review: async () => ({ accepted: false, defects: ['No decisions requested'] }),
    dispatch: async () => {
      throw Error('No dispatch requested');
    },
  };
}
const workflow = client.createFunction(
  { id: 'three-durable-ticks', triggers: { event: 'drill/run' }, retries: 2, concurrency: 1 },
  async ({ event, step }) => {
    if (event.data.executionId !== executionId) throw Error('Drill identity mismatch');
    const tick = async (phase: number) =>
      missionTick(
        { id: `${executionId}:phase:${phase}`, missionId, authUserId, type: 'test.restart-drill', payload: { phase, synthetic: true } },
        steps,
        services(phase),
      );
    const first = await step.run('first-ledger-tick', () => tick(1));
    await step.run('record-wait-marker', () =>
      writeFile(join(directory, 'waiting.json'), JSON.stringify({ executionId, first, pid: process.pid })),
    );
    const resumed = await step.waitForEvent('await-restart-resume', { event: 'drill/resume', timeout: '5m', match: 'data.executionId' });
    if (!resumed) throw Error('Drill resume event timed out');
    await step.run('second-ledger-tick', () => tick(2));
    await step.run('third-ledger-tick', () => tick(3));
    await step.run('record-completion', () =>
      writeFile(join(directory, 'complete.json'), JSON.stringify({ executionId, pid: process.pid })),
    );
    return { executionId, phases: 3, synthetic: true, externalEffectsExercised: false };
  },
);
const server = createServer(serve({ client, functions: [workflow] }));
server.listen(port, '127.0.0.1', () => process.stdout.write(JSON.stringify({ workerReady: true, pid: process.pid, port }) + '\n'));
for (const signal of ['SIGTERM', 'SIGINT'] as const)
  process.once(signal, () => {
    server.close();
    void closeDatabasePools().then(() => process.exit(0));
  });
