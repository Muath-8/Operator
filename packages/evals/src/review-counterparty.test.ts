import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CounterpartySimulator, CounterpartyScriptSchema } from './counterparty.js';
import { counterparties } from '../fixtures/counterparties.js';
import type { EvalTransport } from './runner.js';
let directory: string;
const config = { apiKey: 'explicit-independent-test-key', models: {}, pricing: {}, maxOutputTokens: 1024 },
  model = 'synthetic-model-v1';
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lo-review-counterparty-'));
  vi.stubEnv('NODE_ENV', 'test');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  const base = resolve(tmpdir()),
    target = resolve(directory);
  if (relative(base, target).startsWith('..') || !target.includes('lo-review-counterparty-')) throw new Error('Unsafe test cleanup');
  await rm(target, { recursive: true });
});
const script = () => CounterpartyScriptSchema.parse(counterparties[0]);
const turn = (sessionId = randomUUID()) => ({
  sessionId,
  eventId: randomUUID(),
  scriptId: 'bottle-standard',
  at: '2026-11-12T12:00:00.000Z',
  text: 'Explicit independent synthetic enquiry.',
});
const response = (body: string) => {
  const request = JSON.parse(body) as { input: { content: string }[] },
    input = JSON.parse(request.input[0]?.content ?? '{}') as { currentTerms: unknown; script: { language: string } };
  return new Response(
    JSON.stringify({
      id: 'resp_independent_synthetic',
      model,
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                resultJson: JSON.stringify({
                  body: 'Independent synthetic response.',
                  language: input.script.language,
                  quotedTerms: input.currentTerms,
                }),
              }),
            },
          ],
        },
      ],
      usage: { input_tokens: 30, output_tokens: 20 },
    }),
    { status: 200 },
  );
};
describe('independent simulator capability and durable session bounds', () => {
  it('compares actual instants across valid ISO fractional precision variants', async () => {
    const s = { ...script(), moves: [{ afterTurn: 1, silent: true }] },
      sim = new CounterpartySimulator(directory, [s], config, model),
      first = { ...turn(), at: '2026-11-12T12:00:00.100Z' };
    await sim.respond(first);
    await expect(sim.respond({ ...turn(first.sessionId), at: '2026-11-12T12:00:00Z' })).rejects.toThrow(/backwards/);
  });
  it('rejects the exported capability itself in production before any API call', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => new CounterpartySimulator(directory, [script()], config, model)).toThrow(/production|nonproduction|test/i);
    } finally {
      vi.stubEnv('NODE_ENV', 'test');
    }
  });
  it('an exclusive disk claim serializes separate simulator instances before generating different events', async () => {
    let entered: () => void = () => undefined,
      release: () => void = () => undefined,
      calls = 0;
    const started = new Promise<void>(resolve => {
        entered = resolve;
      }),
      gate = new Promise<void>(resolve => {
        release = resolve;
      }),
      transport: EvalTransport = async (_url, request) => {
        calls++;
        entered();
        await gate;
        return response(String(request.body));
      },
      first = new CounterpartySimulator(directory, [script()], config, model, transport),
      second = new CounterpartySimulator(directory, [script()], config, model, transport),
      a = turn(),
      b = { ...turn(a.sessionId), at: '2026-11-12T13:00:00.000Z' },
      pending = first.respond(a);
    await started;
    await expect(second.respond(b)).rejects.toThrow(/reconcile/);
    expect(calls).toBe(1);
    release();
    await pending;
    await second.respond(b);
    expect(calls).toBe(2);
  });
  it('rejects script drift and backwards time after a durable completed turn', async () => {
    const s = { ...script(), moves: [{ afterTurn: 1, silent: true }] },
      first = turn(),
      sim = new CounterpartySimulator(directory, [s], config, model);
    await sim.respond(first);
    await expect(
      new CounterpartySimulator(directory, [{ ...s, persona: 'Changed hidden persona' }], config, model).respond({
        ...turn(first.sessionId),
        at: '2026-11-12T13:00:00.000Z',
      }),
    ).rejects.toThrow(/script revision/);
    await expect(sim.respond({ ...turn(first.sessionId), at: '2026-11-12T11:00:00.000Z' })).rejects.toThrow(/backwards/);
  });
  it('caps actual persisted history at50 turns and does not generate while explicitly silent', async () => {
    let calls = 0;
    const s = { ...script(), moves: [{ afterTurn: 1, silent: true }] },
      sim = new CounterpartySimulator(directory, [s], config, model, async () => {
        calls++;
        throw new Error('No model call expected');
      }),
      session = randomUUID();
    for (let i = 0; i < 50; i++) expect((await sim.respond(turn(session))).status).toBe('silent');
    await expect(sim.respond(turn(session))).rejects.toThrow(/50-turn budget/);
    expect(calls).toBe(0);
  });
  it('holds an interrupted durable writer instead of clearing its lock or generating', async () => {
    const request = turn(),
      session = join(directory, request.sessionId);
    await mkdir(session);
    await writeFile(join(session, '.writer.lock'), 'explicit interrupted synthetic process', { flag: 'wx' });
    let calls = 0;
    const sim = new CounterpartySimulator(directory, [script()], config, model, async () => {
      calls++;
      throw new Error('No model call expected');
    });
    await expect(sim.respond(request)).rejects.toThrow(/interrupted writer/);
    expect(calls).toBe(0);
  });
});
