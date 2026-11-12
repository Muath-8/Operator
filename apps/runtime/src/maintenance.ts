import { Client } from 'pg';
import { z } from 'zod';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, lstat, chmod, readdir, realpath, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, join, dirname, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { withRole, type ActorScope } from './database.js';
const execute = promisify(execFile);
const Identifier = z.string().regex(/^[a-z][a-z0-9_]{0,62}$/);
const q = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const ConnectionSchema = z
  .string()
  .url()
  .refine(value => ['postgres:', 'postgresql:'].includes(new URL(value).protocol));
export const OperatorConnectionSchema = z.object({ databaseUrl: ConnectionSchema, binaryDirectory: z.string().min(1).optional() }).strict();
export interface OperatorConnection {
  databaseUrl: string;
  binaryDirectory?: string;
}
export const SERVICE_LOGIN_ROLES = {
  DATABASE_AUTH_URL: 'auth_role',
  DATABASE_MAINTENANCE_URL: 'maintenance_role',
  DATABASE_KNOWLEDGE_URL: 'knowledge_role',
  DATABASE_FOUNDER_URL: 'founder_role',
  DATABASE_LEAD_URL: 'lead_role',
  DATABASE_SPECIALIST_URL: 'specialist_role',
  DATABASE_POLICY_URL: 'policy_role',
  DATABASE_INGRESS_URL: 'ingress_role',
  DATABASE_VOICE_URL: 'voice_role',
  DATABASE_OPERATOR_URL: 'operator_role',
  DATABASE_SCHEDULER_URL: 'scheduler_role',
  DATABASE_DEMAND_PUBLIC_URL: 'demand_public_role',
} as const;
/** Passwords are sent as SCRAM verifiers to PostgreSQL, never SQL plaintext. */
export function scramVerifier(password: string): string {
  const salt = randomBytes(16),
    salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256'),
    client = createHmac('sha256', salted).update('Client Key').digest(),
    stored = createHash('sha256').update(client).digest('base64'),
    server = createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
async function windowsSid(): Promise<string> {
  const result = await execute('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true });
  const sid = result.stdout.match(/S-1-5-[0-9-]+/);
  if (!sid) throw new Error('validation: current Windows identity unavailable');
  return sid[0];
}
export async function protectPrivateFile(path: string): Promise<void> {
  if (process.platform === 'win32') {
    const sid = await windowsSid();
    await execute('icacls.exe', [path, '/inheritance:r', '/grant:r', `*${sid}:(F)`], { windowsHide: true });
    await execute('icacls.exe', [path, '/setowner', `*${sid}`], { windowsHide: true });
  } else await chmod(path, (await stat(path)).isDirectory() ? 0o700 : 0o600);
}
async function assertPrivateAccess(path: string): Promise<void> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error('validation: private paths cannot be symbolic links');
  if (process.platform === 'win32') {
    const sid = await windowsSid(),
      script =
        "$ErrorActionPreference='Stop'; $a=Get-Acl -LiteralPath $env:LO_PRIVATE_FILE; @{owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;identities=@($a.Access | Where-Object {$_.AccessControlType -eq 'Allow'} | ForEach-Object {$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value})} | ConvertTo-Json -Compress";
    const acl = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        windowsHide: true,
        env: {
          ...Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'psmodulepath')),
          NODE_ENV: process.env.NODE_ENV,
          LO_PRIVATE_FILE: absolute,
        },
      }),
      permissions = z.object({ owner: z.string(), identities: z.array(z.string()) }).parse(JSON.parse(acl.stdout.trim()) as unknown),
      allowed = new Set([
        sid,
        'S-1-5-18',
        'S-1-5-32-544',
        ...((await execute('whoami.exe', ['/logonid'], { windowsHide: true })).stdout.match(/S-1-5-5-[0-9]+-[0-9]+/g) ?? []),
      ]);
    if (!allowed.has(permissions.owner) || permissions.identities.some(identity => !allowed.has(identity)))
      throw new Error('validation: private path ACL grants another identity access');
  } else if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
    throw new Error('validation: current-owner-only path permissions required');
}
export async function readProtectedJson(path: string): Promise<unknown> {
  const absolute = resolve(path),
    info = await lstat(absolute);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error('validation: bounded private configuration file required');
  await assertPrivateAccess(dirname(absolute));
  await assertPrivateAccess(absolute);
  return JSON.parse(await readFile(absolute, 'utf8')) as unknown;
}
async function writeNewPrivate(path: string, value: string | Buffer): Promise<void> {
  await assertPrivateAccess(dirname(path));
  const file = await open(path, 'wx', 0o600);
  try {
    await file.writeFile(value);
    await file.sync();
  } finally {
    await file.close();
  }
  await protectPrivateFile(path);
}
async function assertGroupRole(db: Client, group: string): Promise<void> {
  const existing = (
    await db.query('select rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls from pg_roles where rolname=$1', [
      group,
    ])
  ).rows[0];
  if (!existing || Object.values(existing).some(value => value === true))
    throw new Error('invariant_violation: application group role has privileged attributes');
  const parents = (
    await db.query(
      'select parent.rolname from pg_auth_members m join pg_roles member on member.oid=m.member join pg_roles parent on parent.oid=m.roleid where member.rolname=$1',
      [group],
    )
  ).rows;
  if (parents.some(parent => group !== 'authenticated' || parent.rolname !== 'founder_role'))
    throw new Error('invariant_violation: application group role has unexpected transitive membership');
}
export async function provisionServiceLogins(
  config: OperatorConnection,
  prefix: string,
  outputFile: string,
): Promise<{ roles: number; credentialsFile: string }> {
  const input = OperatorConnectionSchema.parse(config),
    name = Identifier.max(35).parse(prefix),
    output = resolve(outputFile);
  const db = new Client({ connectionString: input.databaseUrl });
  await db.connect();
  try {
    await db.query('begin');
    const credentials: Record<string, string> = {};
    for (const [env, group] of Object.entries(SERVICE_LOGIN_ROLES)) {
      const role = `${name}_${group.replace('_role', '')}`;
      Identifier.parse(role);
      await assertGroupRole(db, group);
      if ((await db.query('select 1 from pg_roles where rolname=$1', [role])).rowCount)
        throw new Error('conflict: service login already exists');
      const password = randomBytes(36).toString('base64url');
      await db.query(
        `create role ${q(role)} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls connection limit 20 password ${literal(scramVerifier(password))}`,
      );
      await db.query(`grant ${q(group)} to ${q(role)}`);
      const url = new URL(input.databaseUrl);
      url.username = role;
      url.password = password;
      credentials[env] = url.href;
    }
    await writeNewPrivate(output, JSON.stringify({ version: 1, createdAt: new Date().toISOString(), credentials }, null, 2));
    await db.query('commit');
    return { roles: Object.keys(credentials).length, credentialsFile: output };
  } catch {
    await db.query('rollback');
    throw new Error('provider_down: service role provisioning failed; no passwords were logged');
  } finally {
    await db.end();
  }
}

const TableFingerprint = z
  .object({ schema: z.string(), table: z.string(), rows: z.string().regex(/^\d+$/), sha256: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export const BackupManifestSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.iso.datetime(),
    sourceDatabase: z.string(),
    serverMajor: z.number().int().positive(),
    archive: z.literal('database.dump'),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    tables: z.array(TableFingerprint),
    roles: z.array(z.string()),
    containsExternalStorageBinaries: z.literal(false),
  })
  .strict();
async function fingerprints(db: Client) {
  const names = (
    await db.query(
      "select n.nspname schema,c.relname table_name from pg_class c join pg_namespace n on n.oid=c.relnamespace where c.relkind in('r','p')and n.nspname not in('pg_catalog','information_schema')and n.nspname not like'pg_toast%'and not c.relispartition order by n.nspname,c.relname",
    )
  ).rows;
  const result: z.infer<typeof TableFingerprint>[] = [];
  for (const row of names) {
    const schema = z.string().parse(row.schema),
      table = z.string().parse(row.table_name),
      hash = "encode(public.digest(to_jsonb(t)::text,'sha256'),'hex')",
      value = (
        await db.query(
          `select count(*)::text "rows",encode(public.digest(coalesce(string_agg(${hash},'' order by ${hash}),''),'sha256'),'hex')sha256 from ${q(schema)}.${q(table)} t`,
        )
      ).rows[0];
    result.push(TableFingerprint.parse({ schema, table, ...value }));
  }
  return result;
}
async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const data of createReadStream(path)) hash.update(data);
  return hash.digest('hex');
}
function pgEnvironment(connection: string): NodeJS.ProcessEnv {
  const url = new URL(ConnectionSchema.parse(connection));
  return {
    ...process.env,
    PGHOST: url.hostname,
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGSSLMODE: url.searchParams.get('sslmode') ?? 'prefer',
    PGOPTIONS: undefined,
    PGSERVICE: undefined,
    PGAPPNAME: 'launch-operator-maintenance',
  };
}
async function postgresTool(config: OperatorConnection, tool: 'pg_dump' | 'pg_restore', args: string[]): Promise<void> {
  const executable = config.binaryDirectory
    ? join(resolve(config.binaryDirectory), `${tool}${process.platform === 'win32' ? '.exe' : ''}`)
    : tool;
  try {
    await execute(executable, args, { env: pgEnvironment(config.databaseUrl), windowsHide: true, maxBuffer: 1024 * 1024 });
  } catch {
    throw new Error(`provider_down: ${tool} failed; inspect the isolated operation without exposing credentials`);
  }
}
export async function createLogicalBackup(
  config: OperatorConnection,
  directory: string,
): Promise<{ directory: string; sha256: string; tables: number }> {
  const input = OperatorConnectionSchema.parse(config),
    target = resolve(directory);
  await assertPrivateAccess(dirname(target));
  await mkdir(target, { recursive: false, mode: 0o700 });
  await protectPrivateFile(target);
  const db = new Client({ connectionString: input.databaseUrl });
  await db.connect();
  try {
    await db.query("set time zone 'UTC'");
    await db.query('begin isolation level repeatable read read only');
    const snapshot = String((await db.query('select pg_export_snapshot()snapshot')).rows[0]?.snapshot),
      major = Math.floor(Number((await db.query('show server_version_num')).rows[0]?.server_version_num) / 10000),
      tables = await fingerprints(db),
      archive = join(target, 'database.dump.pending');
    await postgresTool(input, 'pg_dump', ['--format=custom', '--no-owner', `--snapshot=${snapshot}`, `--file=${archive}`]);
    await protectPrivateFile(archive);
    await db.query('commit');
    const sha256 = await fileHash(archive),
      size = (await stat(archive)).size,
      manifest = BackupManifestSchema.parse({
        version: 1,
        createdAt: new Date().toISOString(),
        sourceDatabase: decodeURIComponent(new URL(input.databaseUrl).pathname.slice(1)),
        serverMajor: major,
        archive: 'database.dump',
        bytes: size,
        sha256,
        tables,
        roles: [...Object.values(SERVICE_LOGIN_ROLES), 'authenticated', 'knowledge_reviewer_role'],
        containsExternalStorageBinaries: false,
      });
    await rename(archive, join(target, 'database.dump'));
    await writeNewPrivate(join(target, 'manifest.json'), JSON.stringify(manifest, null, 2));
    return { directory: target, sha256, tables: tables.length };
  } catch {
    await db.query('rollback');
    throw new Error('provider_down: logical backup failed; partial files are not a valid backup');
  } finally {
    await db.end();
  }
}
export async function restoreLogicalBackup(
  config: OperatorConnection,
  directory: string,
  targetName: string,
): Promise<{ database: string; tables: number; verified: true; effectsQuarantined: true }> {
  const input = OperatorConnectionSchema.parse(config),
    name = z
      .string()
      .regex(/^lo_restore_[a-z0-9_]{1,40}$/)
      .parse(targetName),
    source = await realpath(resolve(directory)),
    manifest = BackupManifestSchema.parse(await readProtectedJson(join(source, 'manifest.json'))),
    archive = join(source, manifest.archive);
  const archiveInfo = await lstat(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || relative(source, await realpath(archive)) !== 'database.dump')
    throw new Error('validation: restore archive must be a confined regular file');
  await assertPrivateAccess(archive);
  if (archiveInfo.size !== manifest.bytes || (await fileHash(archive)) !== manifest.sha256)
    throw new Error('invariant_violation: backup archive integrity check failed');
  const admin = new Client({ connectionString: input.databaseUrl });
  await admin.connect();
  let target: Client | undefined,
    created = false;
  const url = new URL(input.databaseUrl);
  url.pathname = `/${name}`;
  const groups = [...new Set<string>([...Object.values(SERVICE_LOGIN_ROLES), 'authenticated', 'knowledge_reviewer_role'])];
  const denyRuntimeConnect = async () => {
    await admin.query(`revoke connect on database ${q(name)} from public`);
    for (const group of groups) await admin.query(`revoke connect on database ${q(name)} from ${q(group)}`);
  };
  try {
    if ((await admin.query('select 1 from pg_database where datname=$1', [name])).rowCount)
      throw new Error('conflict: restore target must be a new isolated database');
    const allowed = new Set(groups),
      createdRoles = new Set<string>();
    if (manifest.roles.some(role => !allowed.has(role))) throw new Error('validation: backup names an unsupported role');
    for (const role of manifest.roles) {
      if (!(await admin.query('select 1 from pg_roles where rolname=$1', [role])).rowCount) {
        await admin.query(`create role ${q(role)} nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
        createdRoles.add(role);
      }
    }
    for (const role of manifest.roles) await assertGroupRole(admin, role);
    // pg_dump does not include global role membership. Bootstrap the one known
    // authentication edge only for newly created application groups; an existing
    // deployment with a changed role graph must be repaired explicitly.
    if ((await admin.query("select pg_has_role('authenticated','founder_role','MEMBER')member")).rows[0]?.member !== true) {
      if (!createdRoles.has('authenticated') && !createdRoles.has('founder_role'))
        throw new Error('invariant_violation: existing authentication role membership differs');
      await admin.query('grant founder_role to authenticated');
    }
    // Connections start disabled atomically. Even an existing runtime login
    // cannot enter the clone while its source data and effect controls restore.
    await admin.query(`create database ${q(name)} template template0 allow_connections false`);
    created = true;
    await denyRuntimeConnect();
    const owner = z.string().parse((await admin.query('select current_user owner')).rows[0]?.owner);
    await admin.query(`grant connect on database ${q(name)} to ${q(owner)}`);
    await admin.query(`alter database ${q(name)} allow_connections true`);
    await postgresTool({ ...input, databaseUrl: url.href }, 'pg_restore', [
      '--exit-on-error',
      '--clean',
      '--if-exists',
      '--no-owner',
      `--dbname=${name}`,
      archive,
    ]);
    target = new Client({ connectionString: url.href });
    await target.connect();
    await target.query("set time zone 'UTC'");
    const actual = await fingerprints(target);
    if (JSON.stringify(actual) !== JSON.stringify(manifest.tables))
      throw new Error('invariant_violation: restored table fingerprint differs from backup snapshot');
    return { database: name, tables: actual.length, verified: true, effectsQuarantined: true };
  } finally {
    try {
      if (created) {
        // Both success and partial/mismatched restores remain admin-only. Preserve
        // the failed clone for inspection without ever making it an effect source.
        await denyRuntimeConnect();
        if (!target) {
          target = new Client({ connectionString: url.href });
          await target.connect();
        }
        await target.query(
          "do $$begin if to_regclass('private.platform_controls')is not null then update private.platform_controls set effects_enabled=false;end if;if to_regclass('private.maintenance_audit')is not null then insert into private.maintenance_audit(operation,object_count,stream_count,dry_run)values('restore_quarantine',0,0,false);end if;end$$;",
        );
      }
    } finally {
      await target?.end();
      await admin.end();
    }
  }
}
async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}
/** Deletes only a SHA-verified archive in an explicitly selected private backup
 * root. Manifest and request/completion audit metadata remain after30days. */
export async function expireBackupArchives(
  directory: string,
  dryRun = true,
): Promise<{ dryRun: boolean; expiredBackups: number; purgedArchives: number; blocked: number }> {
  const root = await realpath(resolve(directory));
  await assertPrivateAccess(root);
  let expiredBackups = 0,
    purgedArchives = 0,
    blocked = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !/^lo_backup_[a-zA-Z0-9_-]+$/.test(entry.name)) continue;
    try {
      const folder = await realpath(join(root, entry.name));
      if (relative(root, folder) !== entry.name) throw new Error('validation');
      await assertPrivateAccess(folder);
      const manifest = BackupManifestSchema.parse(await readProtectedJson(join(folder, 'manifest.json')));
      if (Date.parse(manifest.createdAt) > Date.now() - 30 * 86400000) continue;
      const archive = join(folder, manifest.archive),
        request = join(folder, 'purge-request.json'),
        complete = join(folder, 'purge-completed.json'),
        archiveExists = await exists(archive);
      if (await exists(complete)) {
        if (archiveExists) blocked++;
        continue;
      }
      if (await exists(request)) {
        const recorded = z
          .object({ sha256: z.string(), requestedAt: z.iso.datetime(), reason: z.literal('backup_expired_30_days') })
          .strict()
          .parse(await readProtectedJson(request));
        if (recorded.sha256 !== manifest.sha256) throw new Error('invariant_violation');
      } else if (!archiveExists) throw new Error('invariant_violation');
      if (archiveExists) {
        const resolvedArchive = await realpath(archive);
        if (relative(root, resolvedArchive) !== join(entry.name, 'database.dump') || (await lstat(archive)).isSymbolicLink())
          throw new Error('validation');
        await assertPrivateAccess(archive);
        if ((await stat(archive)).size !== manifest.bytes || (await fileHash(archive)) !== manifest.sha256)
          throw new Error('invariant_violation');
        const handle = await open(archive, 'r');
        try {
          const magic = Buffer.alloc(5);
          await handle.read(magic, 0, 5, 0);
          if (magic.toString() !== 'PGDMP') throw new Error('validation');
        } finally {
          await handle.close();
        }
      }
      expiredBackups++;
      if (dryRun) continue;
      if (!(await exists(request)))
        await writeNewPrivate(
          request,
          JSON.stringify({ sha256: manifest.sha256, requestedAt: new Date().toISOString(), reason: 'backup_expired_30_days' }),
        );
      if (archiveExists) await unlink(archive);
      await writeNewPrivate(
        complete,
        JSON.stringify({ sha256: manifest.sha256, purgedAt: new Date().toISOString(), archiveAlreadyAbsent: !archiveExists }),
      );
      purgedArchives++;
    } catch {
      blocked++;
    }
  }
  return { dryRun, expiredBackups, purgedArchives, blocked };
}

/** Small CLI parser: connection strings and passwords belong only in protected
 * files. None of these helpers prints raw child-process/driver error objects. */
export function operatorArguments(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  if (args.length % 2 !== 0) throw new Error('validation: named operator arguments required');
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i],
      value = args[i + 1];
    if (!flag || !value || !allowed.includes(flag) || result[flag]) throw new Error('validation: invalid operator arguments');
    result[flag] = value;
  }
  return result;
}
export async function operatorConnectionFile(path: string | undefined, key?: string): Promise<OperatorConnection> {
  if (!path) throw new Error('validation: protected connection file required');
  const raw = await readProtectedJson(path);
  if (key) {
    const bundle = z
      .object({ credentials: z.record(z.string(), ConnectionSchema), binaryDirectory: z.string().optional() })
      .passthrough()
      .safeParse(raw);
    if (bundle.success)
      return OperatorConnectionSchema.parse({
        databaseUrl: bundle.data.credentials[key],
        ...(bundle.data.binaryDirectory ? { binaryDirectory: bundle.data.binaryDirectory } : {}),
      });
  }
  return OperatorConnectionSchema.parse(raw);
}

const RetentionReportSchema = z
  .object({
    dryRun: z.boolean(),
    rawObjects: z.number().int().nonnegative(),
    ephemeralStreams: z.number().int().nonnegative(),
    businessLedgerRowsDeleted: z.literal(0),
  })
  .strict();
export async function runRetention(config: OperatorConnection, dryRun = true) {
  const input = OperatorConnectionSchema.parse(config),
    db = new Client({ connectionString: input.databaseUrl });
  await db.connect();
  try {
    await db.query('begin');
    await db.query('set local role maintenance_role');
    const report = RetentionReportSchema.parse(
      (await db.query('select public.expire_retained_content($1)report', [dryRun])).rows[0]?.report,
    );
    await db.query('commit');
    return report;
  } catch {
    await db.query('rollback');
    throw new Error('provider_down: retention maintenance failed; no raw content was logged');
  } finally {
    await db.end();
  }
}
export async function missionTraceExportAllowed(scope: ActorScope): Promise<boolean> {
  return withRole('policy_role', scope, async db =>
    z.boolean().parse((await db.query('select public.trace_export_allowed($1)allowed', [scope.missionId])).rows[0]?.allowed),
  );
}
export async function configureTraceRetention(scope: ActorScope, enabled: boolean): Promise<void> {
  await withRole('founder_role', scope, async db => {
    await db.query('select public.configure_trace_retention($1,$2)', [scope.missionId, z.boolean().parse(enabled)]);
  });
}
export async function keepRetainedContent(scope: ActorScope, objectId: string, keep: boolean): Promise<void> {
  await withRole('founder_role', scope, async db => {
    await db.query('select public.keep_retained_content($1,$2,$3)', [scope.missionId, z.uuid().parse(objectId), z.boolean().parse(keep)]);
  });
}

export async function provisionKnowledgeReviewer(
  config: OperatorConnection,
  prefix: string,
  reviewerReference: string,
  outputFile: string,
): Promise<{ loginRole: string; credentialsFile: string }> {
  const input = OperatorConnectionSchema.parse(config),
    login = Identifier.parse(`${Identifier.max(35).parse(prefix)}_reviewer`),
    reference = z
      .string()
      .regex(/^reviewer:[a-f0-9-]{36}$/i)
      .parse(reviewerReference),
    output = resolve(outputFile),
    db = new Client({ connectionString: input.databaseUrl });
  await db.connect();
  try {
    await db.query('begin');
    await assertGroupRole(db, 'knowledge_reviewer_role');
    if ((await db.query('select 1 from pg_roles where rolname=$1', [login])).rowCount) throw new Error('conflict');
    const password = randomBytes(36).toString('base64url');
    await db.query(
      `create role ${q(login)} login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls password ${literal(scramVerifier(password))}`,
    );
    await db.query(`grant knowledge_reviewer_role to ${q(login)}`);
    await db.query('insert into private.knowledge_reviewers(login_role,reviewer_reference)values($1,$2)', [login, reference]);
    const url = new URL(input.databaseUrl);
    url.username = login;
    url.password = password;
    await writeNewPrivate(
      output,
      JSON.stringify(
        { version: 1, createdAt: new Date().toISOString(), credentials: { DATABASE_KNOWLEDGE_REVIEWER_URL: url.href } },
        null,
        2,
      ),
    );
    await db.query('commit');
    return { loginRole: login, credentialsFile: output };
  } catch {
    await db.query('rollback');
    throw new Error('provider_down: reviewer provisioning failed; no human review was inferred');
  } finally {
    await db.end();
  }
}
export const KnowledgeInputSchema = z
  .object({
    kind: z.enum(['category_profile', 'playbook', 'template', 'readiness_rules']),
    id: z.string().regex(/^[a-z0-9][a-z0-9_.:-]{0,119}$/),
    version: z.number().int().positive(),
    content: z.record(z.string(), z.unknown()),
    sources: z
      .array(z.string().regex(/^(?:https:\/\/|repo:docs\/)/))
      .min(1)
      .max(50),
  })
  .strict();
export const KnowledgeReviewSchema = z
  .object({
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    reviewReference: z.string().regex(/^(?:https:\/\/|repo:docs\/)/),
    reviewedAt: z.iso.datetime(),
    attestation: z.literal('I personally reviewed this exact content and sources'),
  })
  .strict();
export async function inspectKnowledge(config: OperatorConnection, raw: unknown) {
  const input = KnowledgeInputSchema.parse(raw),
    db = new Client({ connectionString: OperatorConnectionSchema.parse(config).databaseUrl });
  await db.connect();
  try {
    const reviewer =
      (await db.query("select pg_has_role(current_user,'knowledge_reviewer_role','MEMBER')reviewer")).rows[0]?.reviewer === true;
    await db.query(`set role ${reviewer ? 'knowledge_reviewer_role' : 'knowledge_role'}`);
    return z
      .object({ contentHash: z.string(), sourceHash: z.string() })
      .parse((await db.query('select public.knowledge_payload_hashes($1,$2)hashes', [input.content, input.sources])).rows[0]?.hashes);
  } finally {
    await db.end();
  }
}
export async function appendKnowledge(
  config: OperatorConnection,
  raw: unknown,
  review?: unknown,
): Promise<{ revisionId: string; reviewStatus: 'unverified' | 'reviewed' }> {
  const input = KnowledgeInputSchema.parse(raw),
    checked = review === undefined ? undefined : KnowledgeReviewSchema.parse(review),
    db = new Client({ connectionString: OperatorConnectionSchema.parse(config).databaseUrl });
  await db.connect();
  try {
    await db.query('begin');
    await db.query(`set local role ${checked ? 'knowledge_reviewer_role' : 'knowledge_role'}`);
    const id = z
      .uuid()
      .parse(
        (
          await db.query('select public.append_knowledge_revision($1,$2,$3,$4,$5,$6)id', [
            input.kind,
            input.id,
            input.version,
            input.content,
            input.sources,
            checked ?? null,
          ])
        ).rows[0]?.id,
      );
    await db.query('commit');
    return { revisionId: id, reviewStatus: checked ? 'reviewed' : 'unverified' };
  } catch {
    await db.query('rollback');
    throw new Error(
      'rejected: knowledge append requires current version, source provenance and valid human review credentials when reviewed',
    );
  } finally {
    await db.end();
  }
}
export async function activateKnowledge(config: OperatorConnection, kind: string, id: string, version: number): Promise<void> {
  const db = new Client({ connectionString: OperatorConnectionSchema.parse(config).databaseUrl });
  await db.connect();
  try {
    await db.query('begin');
    await db.query('set local role knowledge_reviewer_role');
    await db.query('select public.activate_knowledge_version($1,$2,$3)', [kind, id, version]);
    await db.query('commit');
  } catch {
    await db.query('rollback');
    throw new Error('rejected: only an explicitly reviewed knowledge version may be activated');
  } finally {
    await db.end();
  }
}
