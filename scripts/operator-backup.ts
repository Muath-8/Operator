import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogicalBackup, operatorArguments, operatorConnectionFile } from '../apps/runtime/src/maintenance.js';
export async function backupCli(args: readonly string[]): Promise<number> {
  try {
    const flags = operatorArguments(args, ['--connection-file', '--directory']);
    if (!flags['--directory']) throw new Error('validation');
    const result = await createLogicalBackup(await operatorConnectionFile(flags['--connection-file']), flags['--directory']);
    process.stdout.write(JSON.stringify({ ok: true, ...result }) + '\n');
    return 0;
  } catch {
    process.stderr.write(
      'Backup blocked. Supply --connection-file <owner-only JSON> --directory <new backup directory>. Existing directories are never overwritten; partial files are not valid backups.\n',
    );
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await backupCli(process.argv.slice(2));
