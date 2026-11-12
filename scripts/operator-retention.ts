import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorArguments, operatorConnectionFile, runRetention, expireBackupArchives } from '../apps/runtime/src/maintenance.js';
export async function retentionCli(args: readonly string[]): Promise<number> {
  try {
    const flags = operatorArguments(args, ['--connection-file', '--dry-run', '--backup-root']);
    if (flags['--dry-run'] !== undefined && !['true', 'false'].includes(flags['--dry-run'])) throw new Error('validation');
    const dryRun = flags['--dry-run'] !== 'false',
      result = await runRetention(await operatorConnectionFile(flags['--connection-file'], 'DATABASE_MAINTENANCE_URL'), dryRun),
      backups = flags['--backup-root'] ? await expireBackupArchives(flags['--backup-root'], dryRun) : undefined;
    process.stdout.write(JSON.stringify({ ok: true, ...result, ...(backups ? { backups } : {}) }) + '\n');
    return backups?.blocked ? 2 : 0;
  } catch {
    process.stderr.write(
      'Retention blocked. Supply --connection-file <owner-only maintenance login JSON> [--dry-run true|false] [--backup-root <explicit private root>]. Default is dry-run; business ledgers are never deleted.\n',
    );
    return 2;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await retentionCli(process.argv.slice(2));
