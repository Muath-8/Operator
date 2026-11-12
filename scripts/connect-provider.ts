import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectProviderAccount } from '../apps/runtime/src/accounts.js';
import { closeDatabasePools } from '../apps/runtime/src/database.js';

/** Operator-only CLI: credentials are read from a protected file, never flags, output or artifacts. */
export async function connectProviderCli(args: readonly string[]): Promise<number> {
  try {
    const allowed = new Set(['--file', '--mission', '--actor', '--mode']);
    if (args.length !== 8) throw new Error('Usage');
    const values: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) {
      const flag = args[i],
        value = args[i + 1];
      if (!flag || !value || !allowed.has(flag) || values[flag]) throw new Error('Usage');
      values[flag] = value;
    }
    const scope = { authUserId: z.uuid().parse(values['--actor']), missionId: z.uuid().parse(values['--mission']) },
      mode = z.enum(['local', 'sandbox', 'live']).parse(values['--mode']);
    const path = resolve(z.string().min(1).parse(values['--file'])),
      info = await stat(path);
    if (!info.isFile() || info.size > 262144 || (process.platform !== 'win32' && (info.mode & 0o077) !== 0))
      throw new Error('Protected credential file required');
    const input = z.record(z.string(), z.unknown()).parse(JSON.parse(await readFile(path, 'utf8')) as unknown);
    if ('mode' in input) throw new Error('Mode must be explicitly selected on the command line');
    const result = await connectProviderAccount(scope, { ...input, mode });
    process.stdout.write(JSON.stringify(result) + '\n');
    return result.ok ? 0 : 2;
  } catch {
    process.stderr.write(
      'Connection blocked. Use --file <protected JSON file> --mission <UUID> --actor <authenticated founder UUID> --mode local|sandbox|live. File must contain provider, credential, founderAttestsOwnership:true and optional settings/serviceBudgetUnits/allowUnverified. No credential values are printed.\n',
    );
    return 2;
  } finally {
    await closeDatabasePools();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = await connectProviderCli(process.argv.slice(2));
