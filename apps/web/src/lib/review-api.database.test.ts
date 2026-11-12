import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { withRole, closeDatabasePools } from '@lo/runtime';
import { persistEditableSources } from '../../../runtime/src/editable-assets';
import { unzipSync, strFromU8 } from 'fflate';
import validateMissionView from './mission-view-validator';
import { MissionListSchema } from './client-contracts';
const identity = vi.hoisted(() => ({ user: '00000000-0000-4000-8000-000000000001' as string | null }));
vi.mock('./auth', () => ({
  currentActor: async () => (identity.user ? { authUserId: identity.user, local: true } : null),
  sameOrigin: (request: Request) => request.headers.get('origin') === 'http://127.0.0.1:3000',
}));
import { GET as missionView } from '../app/api/missions/[missionId]/route';
import { GET as missionList } from '../app/api/missions/route';
import { GET as metrics } from '../app/api/missions/[missionId]/metrics/route';
import { GET as record } from '../app/api/missions/[missionId]/export/route';
import { GET as asset } from '../app/api/missions/[missionId]/assets/[assetId]/route';
import { GET as notice, DELETE as erase } from '../app/api/missions/[missionId]/deletion/route';
const root = fileURLToPath(new URL('../../../../', import.meta.url)),
  adminUrl = process.env.LO_DATABASE_URL ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_review_web_api_${Date.now()}`,
  admin = new Client({ connectionString: adminUrl }),
  prior = { ...process.env };
let db: Client;
const user = '00000000-0000-4000-8000-000000000001',
  mission = '20000000-0000-4000-8000-000000000001',
  second = '20000000-0000-4000-8000-000000000002',
  scope = { authUserId: user, missionId: mission };
const params = (missionId = mission) => ({ params: Promise.resolve({ missionId }) }),
  request = () => new Request('http://127.0.0.1:3000');
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  db = new Client({ connectionString: url.href });
  await db.connect();
  await db.query(
    (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
      'create role authenticated nologin noinherit nobypassrls;',
      () =>
        "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
    ),
  );
  for (const file of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
    await db.query(await readFile(`${root}/supabase/migrations/${file}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  process.env.DATABASE_URL = url.href;
  process.env.LO_EXECUTION_MODE = 'local';
  process.env.APP_ORIGIN = 'http://127.0.0.1:3000';
  process.env.PROVIDER_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
}, 40000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name} with(force)`);
  await admin.end();
});

describe('actual web read/export/erase handlers over disposable native PostgreSQL', () => {
  it('returns the real scoped six-outcome ledger and a contract-valid mission list', async () => {
    const response = await missionView(request(), params());
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = await response.json();
    expect(validateMissionView(body.view)).toBe(true);
    expect(body.view.missionId).toBe(mission);
    expect(body.view.readiness.outcomes).toHaveLength(6);
    const list = await missionList();
    expect(list.status).toBe(200);
    const parsed = MissionListSchema.parse(await list.json());
    expect(parsed.missions.map(m => m.id).sort()).toEqual([mission, second]);
  });
  it('separates malformed identifiers, unavailable scope and unauthenticated reads without leaking tenant content', async () => {
    expect((await missionView(request(), params('invalid'))).status).toBe(400);
    expect((await metrics(request(), params('invalid'))).status).toBe(400);
    identity.user = randomUUID();
    try {
      for (const get of [missionView, metrics, record, notice]) {
        const response = await get(request(), params());
        expect(response.status).toBe(404);
        expect(await response.text()).not.toContain('Ghaymah');
      }
      expect((await (await missionList()).json()).missions).toEqual([]);
    } finally {
      identity.user = user;
    }
    identity.user = null;
    try {
      for (const get of [missionView, metrics, record, notice]) expect((await get(request(), params())).status).toBe(401);
      expect((await missionList()).status).toBe(401);
    } finally {
      identity.user = user;
    }
  });
  it('exports actual ledger JSON/Markdown/PDF and measurement attachments with bounded trust claims', async () => {
    for (const [format, type] of [
      ['json', 'application/json'],
      ['markdown', 'text/markdown'],
      ['pdf', 'application/pdf'],
    ] as const) {
      const cwd =
        format === 'pdf' ? vi.spyOn(process, 'cwd').mockReturnValue(fileURLToPath(new URL('../../', import.meta.url))) : undefined;
      let response: Response;
      try {
        response = await record(new Request(`http://127.0.0.1:3000/export?format=${format}`), params());
      } finally {
        cwd?.mockRestore();
      }
      expect(response.status, `Actual ${format} export`).toBe(200);
      expect(response.headers.get('content-type')).toContain(type);
      expect(response.headers.get('content-disposition')).toContain('attachment;');
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(100);
      if (format === 'pdf') expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('%PDF');
      else expect(new TextDecoder().decode(bytes)).toContain('ledger export');
    }
    const measured = await metrics(request(), params());
    expect(measured.status).toBe(200);
    expect(measured.headers.get('content-disposition')).toContain('metrics.json');
    expect(await measured.json()).toMatchObject({ missionId: mission, sandboxMode: true, verifiedSupplierResponseRate: null });
    expect((await record(new Request('http://127.0.0.1:3000/export?format=unsupported'), params())).status).toBe(404);
    // Real font shaping of the full native record under V8 instrumentation needs a bounded execution allowance; this is not a product latency threshold.
  }, 60000);
  it('returns an inert editable source and includes the exact source bytes in a portable archive', async () => {
    const run = randomUUID();
    await db.query(
      "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'brand','{}','synthetic-web-asset','small')",
      [run, mission],
    );
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L3 3"/></svg>';
    const saved = await withRole('specialist_role', scope, c =>
        persistEditableSources(c, mission, run, { logoSvg: source, editableLogoAssetIds: [] }),
      ),
      id = String((saved.editableLogoAssetIds as string[])[0]);
    const download = await asset(request(), { params: Promise.resolve({ missionId: mission, assetId: id }) });
    expect(download.status).toBe(200);
    expect(download.headers.get('x-content-type-options')).toBe('nosniff');
    expect(download.headers.get('content-security-policy')).toContain('sandbox');
    expect(download.headers.get('content-disposition')).toContain(`${id}.svg`);
    expect(await download.text()).toBe(source);
    const archive = await record(new Request('http://127.0.0.1:3000/export?format=zip'), params()),
      files = unzipSync(new Uint8Array(await archive.arrayBuffer())),
      stored = files[`assets/${id}.svg`];
    if (!stored) throw new Error('Expected editable source in real archive');
    expect(strFromU8(stored)).toBe(source);
    expect((await asset(request(), { params: Promise.resolve({ missionId: second, assetId: id }) })).status).toBe(404);
  });
  it('refuses missing, malformed and hostile source payloads without rendering active content', async () => {
    expect((await asset(request(), { params: Promise.resolve({ missionId: mission, assetId: randomUUID() }) })).status).toBe(404);
    expect((await asset(request(), { params: Promise.resolve({ missionId: 'bad', assetId: 'bad' }) })).status).toBe(404);
    const id = String(
      (
        await db.query(
          "insert into public.provider_assets(mission_id,mime_type,content_base64,payload_hash,provider_reference)values($1,'image/png',$2,'synthetic-invalid',$3)returning id",
          [mission, Buffer.from('invalid image').toString('base64'), randomUUID()],
        )
      ).rows[0]?.id,
    );
    expect((await asset(request(), { params: Promise.resolve({ missionId: mission, assetId: id }) })).status).toBe(422);
    identity.user = null;
    try {
      expect((await asset(request(), { params: Promise.resolve({ missionId: mission, assetId: id }) })).status).toBe(401);
    } finally {
      identity.user = user;
    }
  });
  it('erases explicitly confirmed mission content including private retention bytes and preserves the founder external account', async () => {
    const scoped = { authUserId: user, missionId: second },
      account = randomUUID();
    await db.query(
      "insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,'10000000-0000-4000-8000-000000000001','shopify','connected','{}')",
      [account],
    );
    const raw = await withRole('policy_role', scoped, async c =>
      String(
        (
          await c.query("select public.store_retained_content($1,'trace','synthetic-web-erase','{\"syntheticRaw\":true}',null,true)id", [
            second,
          ])
        ).rows[0]?.id,
      ),
    );
    const result = await erase(
      new Request('http://127.0.0.1:3000/deletion', {
        method: 'DELETE',
        headers: { origin: 'http://127.0.0.1:3000', 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: true, understandExternalAssetsRemain: true }),
      }),
      params(second),
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ ok: true, externalAccountsRetained: true });
    expect((await db.query('select from public.missions where id=$1', [second])).rowCount).toBe(0);
    expect((await db.query('select from private.retention_payloads where object_id=$1', [raw])).rowCount).toBe(0);
    expect((await db.query('select from public.founder_accounts where id=$1', [account])).rowCount).toBe(1);
  });
});
