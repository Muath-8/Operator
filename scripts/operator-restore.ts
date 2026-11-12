import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorArguments, operatorConnectionFile, restoreLogicalBackup } from '../apps/runtime/src/maintenance.js';
export async function restoreCli(args: readonly string[]): Promise<number> {
  try {
    const flags = operatorArguments(args, ['--connection-file', '--directory', '--target-name']);
    if (!flags['--directory'] || !flags['--target-name']) throw new Error('validation');
    const result = await restoreLogicalBackup(
      await operatorConnectionFile(flags['--connection-file']),
      flags['--directory'],
      flags['--target-name'],
    );
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    return 0;
  } catch {
    process.stderr.write(
      'Restore blocked. Supply --connection-file <owner-only administrator JSON> --directory <verified backup> --target-name lo_restore_<new unique name>. Existing databases are never altered; a failed newly created target remains isolated for inspection.\n',
    );
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await restoreCli(process.argv.slice(2));
