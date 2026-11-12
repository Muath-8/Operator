import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  operatorArguments,
  operatorConnectionFile,
  readProtectedJson,
  KnowledgeInputSchema,
  inspectKnowledge,
  appendKnowledge,
  activateKnowledge,
} from '../apps/runtime/src/maintenance.js';
export async function knowledgeCli(args: readonly string[]): Promise<number> {
  try {
    const flags = operatorArguments(args, ['--connection-file', '--file', '--review-file', '--mode']);
    if (!flags['--file'] || !['inspect', 'append', 'activate'].includes(flags['--mode'] ?? '')) throw new Error('validation');
    const input = KnowledgeInputSchema.parse(await readProtectedJson(flags['--file'])),
      review = flags['--review-file'] ? await readProtectedJson(flags['--review-file']) : undefined,
      config = await operatorConnectionFile(
        flags['--connection-file'],
        review || flags['--mode'] === 'activate' ? 'DATABASE_KNOWLEDGE_REVIEWER_URL' : 'DATABASE_KNOWLEDGE_URL',
      );
    let result: unknown;
    if (flags['--mode'] === 'inspect') result = await inspectKnowledge(config, input);
    else if (flags['--mode'] === 'activate') {
      await activateKnowledge(config, input.kind, input.id, input.version);
      result = { activated: true, kind: input.kind, id: input.id, version: input.version };
    } else result = await appendKnowledge(config, input, review);
    process.stdout.write(JSON.stringify({ ok: true, ...(result as Record<string, unknown>) }) + '\n');
    return 0;
  } catch {
    process.stderr.write(
      'Knowledge change blocked. Use --connection-file <owner-only role credentials> --file <owner-only sourced knowledge JSON> --mode inspect|append|activate and optional --review-file <exact dated human attestation>. Unreviewed appends never imply human review or activate a version.\n',
    );
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await knowledgeCli(process.argv.slice(2));
