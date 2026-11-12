import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { JsonObjectSchema } from '@lo/state';
import { ProviderStorage } from '@lo/runtime/provider-storage';
import { providerToolRegistry } from '@lo/runtime/provider-tools';
import { withRole, closeDatabasePools, TaskBriefSchema, redact } from '@lo/runtime';

/** Explicit live sandbox runner. Uses the real durable repository, never the simulator. */
async function main(): Promise<void> {
  if (process.env['LIVE_SANDBOX'] !== '1')
    throw new Error('Blocked: set LIVE_SANDBOX=1 to explicitly run a configured live sandbox contract.');
  const scope = z
    .object({ authUserId: z.uuid(), missionId: z.uuid() })
    .strict()
    .parse(JSON.parse(z.string().parse(process.env['LIVE_SCOPE_JSON'])) as unknown);
  const taskId = z.uuid().parse(process.env['LIVE_TASK_ID']);
  const name = z.string().min(1).parse(process.env['LIVE_TOOL_NAME']);
  const inputFile = z.string().min(1).parse(process.env['LIVE_INPUT_FILE']);
  const storage = new ProviderStorage(scope);
  if (!(await storage.mission()).sandbox_mode) throw new Error('Blocked: live contract runner requires an immutable sandbox mission.');
  const task = await withRole('specialist_role', scope, async db =>
    TaskBriefSchema.parse(
      (await db.query('select brief from public.runs where mission_id=$1 and id=$2', [scope.missionId, taskId])).rows[0]?.brief,
    ),
  );
  const tools = await providerToolRegistry.forTask(scope, task);
  const tool = tools[name];
  if (!tool) throw new Error('Blocked: requested live capability is outside the stored task role.');
  const input = JsonObjectSchema.parse(JSON.parse(await readFile(inputFile, 'utf8')) as unknown);
  const result = await tool.execute(input, task);
  console.log(JSON.stringify(redact(result), null, 2));
  if (!result.ok) process.exitCode = 2;
}
main()
  .catch(() => {
    console.error(
      'Live sandbox validation blocked: verify scoped database roles, encrypted provider connections, approved artifacts/mandates, service budgets and LIVE_* inputs. No passing provider result was inferred.',
    );
    process.exitCode = 2;
  })
  .finally(closeDatabasePools);
