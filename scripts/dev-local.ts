import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configurationPath = resolve(root, '.env.local-testing');
const configuration = existsSync(configurationPath) ? parseEnv(readFileSync(configurationPath, 'utf8')) : {};
const optionalKeys = ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET', 'PAYPAL_MERCHANT_ID', 'LO_CODEX_BIN', 'LO_LOCAL_PORT'];
const localOptions: Record<string, string> = {};
for (const key of optionalKeys) {
  const value = process.env[key] || configuration[key];
  if (value) localOptions[key] = value;
}
const port = Number(localOptions['LO_LOCAL_PORT'] || '3100');
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('LO_LOCAL_PORT must be between 1024 and 65535');
const dataDirectory = resolve(root, '.local', 'testing');
mkdirSync(dataDirectory, { recursive: true });
const generated = spawnSync(process.execPath, [resolve(root, 'scripts/generate-ui-validator.mjs')], { cwd: root, stdio: 'inherit' });
if (generated.status !== 0) process.exit(generated.status || 1);
const requireWeb = createRequire(resolve(root, 'apps/web/package.json'));
const ai = process.argv.includes('--ai') ? 'codex' : 'simulated';
const env: NodeJS.ProcessEnv = {
  ...process.env,
  ...localOptions,
  NODE_ENV: 'development',
  LO_EXECUTION_MODE: 'local',
  LO_STORAGE_BACKEND: 'sqlite',
  LO_LOCAL_AI: ai,
  LO_SQLITE_PATH: resolve(dataDirectory, 'operator.sqlite'),
  LO_NEXT_DIST_DIR: '.next-local',
  APP_ORIGIN: `http://127.0.0.1:${port}`,
  LO_DEV_FOUNDER_ID: '00000000-0000-4000-8000-000000000001',
  LO_DEV_AUTH_TOKEN: randomBytes(32).toString('base64url'),
};
// Explicit empty values take precedence over Next's existing production/local env files.
for (const key of [
  'DATABASE_URL',
  'DATABASE_FOUNDER_URL',
  'DATABASE_LEAD_URL',
  'DATABASE_SPECIALIST_URL',
  'DATABASE_POLICY_URL',
  'DATABASE_INGRESS_URL',
  'DATABASE_VOICE_URL',
  'DATABASE_OPERATOR_URL',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
  'INNGEST_EVENT_KEY',
  'INNGEST_SIGNING_KEY',
  'INNGEST_DEV',
  'NEXT_PUBLIC_SENTRY_DSN',
  'SENTRY_DSN',
])
  env[key] = '';
console.log(
  `Launch Operator — LOCAL TESTING\nSQLite: ${env.LO_SQLITE_PATH}\nAI: ${ai === 'codex' ? 'Codex CLI / your ChatGPT sign-in' : 'explicit offline simulation'}\nOpen ${env.APP_ORIGIN}/login\nReal PayPal sandbox is optional at /local/paypal. No live payments.\n`,
);
const child = spawn(
  process.execPath,
  [requireWeb.resolve('next/dist/bin/next'), 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(port)],
  {
    cwd: resolve(root, 'apps/web'),
    env,
    stdio: 'inherit',
    windowsHide: true,
  },
);
child.on('error', () => {
  console.error('Unable to start Next.js. Run pnpm install --frozen-lockfile first.');
  process.exitCode = 1;
});
child.on('exit', code => {
  process.exitCode = code || 0;
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
