import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  operatorArguments,
  operatorConnectionFile,
  provisionServiceLogins,
  provisionKnowledgeReviewer,
} from '../apps/runtime/src/maintenance.js';
export async function provisionCli(args: readonly string[]): Promise<number> {
  try {
    const flags = operatorArguments(args, ['--connection-file', '--prefix', '--output-file', '--reviewer-reference']);
    if (!flags['--prefix'] || !flags['--output-file']) throw new Error('validation');
    const config = await operatorConnectionFile(flags['--connection-file']),
      result = flags['--reviewer-reference']
        ? await provisionKnowledgeReviewer(config, flags['--prefix'], flags['--reviewer-reference'], flags['--output-file'])
        : await provisionServiceLogins(config, flags['--prefix'], flags['--output-file']);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    return 0;
  } catch {
    process.stderr.write(
      'Provisioning blocked. Supply --connection-file <owner-only JSON> --prefix <new login prefix> --output-file <new owner-only credentials JSON>. Optional --reviewer-reference reviewer:<human UUID> creates a separate human review login, not service credentials. No credentials are printed.\n',
    );
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await provisionCli(process.argv.slice(2));
