import { Client } from 'pg';
import { randomBytes, createHash } from 'node:crypto';
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
const url = new URL(adminUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Local setup only operates on a loopback database');
const name = 'launch_operator_local';
const admin = new Client({ connectionString: adminUrl });
await admin.connect();
try {
  if (!(await admin.query('select 1 from pg_database where datname=$1', [name])).rowCount) await admin.query(`create database ${name}`);
} finally {
  await admin.end();
}
url.pathname = `/${name}`;
const db = new Client({ connectionString: url.href });
await db.connect();
try {
  await db.query(
    'create schema if not exists private;create table if not exists private.schema_migrations(name text primary key,sha256 text not null,applied_at timestamptz not null default now())',
  );
  await db.query(
    "do $$begin if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
  );
  for (const file of (await readdir('supabase/migrations')).filter(f => f.endsWith('.sql')).sort()) {
    const sql = await readFile(`supabase/migrations/${file}`, 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const applied = await db.query('select sha256 from private.schema_migrations where name=$1', [file]);
    if (applied.rowCount) {
      if (applied.rows[0]?.sha256 !== hash)
        throw new Error(`Applied migration ${file} changed; use a fresh development database or a reviewed forward migration`);
      continue;
    }
    await db.query(sql);
    await db.query('insert into private.schema_migrations(name,sha256) values($1,$2)', [file, hash]);
  }
  await db.query(await readFile('supabase/seed.sql', 'utf8'));
} finally {
  await db.end();
}
const envPath = resolve('apps/web/.env.local');
let existing = '';
try {
  existing = await readFile(envPath, 'utf8');
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
if (!existing) {
  const token = randomBytes(32).toString('base64url');
  const encryptionKey = randomBytes(32).toString('base64');
  await writeFile(
    envPath,
    `LO_EXECUTION_MODE=local\nAPP_ORIGIN=http://127.0.0.1:3000\nDATABASE_URL=${url.href}\nLO_DEV_FOUNDER_ID=00000000-0000-4000-8000-000000000001\nLO_DEV_AUTH_TOKEN=${token}\nPROVIDER_ENCRYPTION_KEY=${encryptionKey}\nINNGEST_DEV=1\n`,
  );
}
await mkdir('.local', { recursive: true });
console.log(
  JSON.stringify({
    status: 'ready',
    database: name,
    mode: 'local',
    environmentFile: envPath,
    providerEffects: 'disabled until configured and operator-enabled',
    next: 'pnpm dev; open http://127.0.0.1:3000/login',
  }),
);
