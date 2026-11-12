import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { describe, it, expect, vi } from 'vitest';
import { withTrace, type ModelRequest } from '@openai/agents';
import { CheckpointedModel, createModelProvider } from './agents.js';

/** Independent regression for the actual pinned SDK transport, not a fake Model. */
describe('independent physical HTTP attempt budget regression', () => {
  it('does not let SDK HTTP500 retries multiply one reserved physical model attempt', async () => {
    let httpRequests = 0;
    const reserve = vi.fn(async () => {}),
      record = vi.fn(async () => {});
    const server = createServer((_request, response) => {
      httpRequests++;
      response.writeHead(500, { 'Content-Type': 'application/json', 'retry-after-ms': '1' });
      response.end(JSON.stringify({ error: { message: 'Explicit local review fixture', type: 'server_error', code: 'test_error' } }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Local review fixture missing');
      const delegate = await createModelProvider('explicit-local-test', `http://127.0.0.1:${address.port}/v1`).getModel(
        'explicit-test-model',
      );
      const model = new CheckpointedModel(delegate, { run: async (_id, fn) => fn() }, randomUUID(), 10000, { reserve, record });
      const request: ModelRequest = {
        systemInstructions: 'Explicit local test only',
        input: 'test',
        modelSettings: { maxTokens: 10 },
        tools: [],
        handoffs: [],
        outputType: 'text',
        tracing: false,
      };
      await withTrace('Explicit local review', async () => {
        await expect(model.getResponse(request)).rejects.toThrow();
      });
      expect(httpRequests).toBe(1);
      expect(reserve).toHaveBeenCalledTimes(1);
      expect(record).not.toHaveBeenCalled();
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
  it('refuses the test endpoint override outside test processes', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => createModelProvider('explicit-test', 'http://127.0.0.1:1')).toThrow();
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('reports an aged unknown paid attempt and an ambiguous payment before any payment row exists', async () => {
    const root = fileURLToPath(new URL('../../..', import.meta.url)),
      adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
      name = `lo_review_meter_${Date.now()}`,
      admin = new Client({ connectionString: adminUrl });
    let db: Client | undefined;
    await admin.connect();
    await admin.query(`create database ${name}`);
    try {
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
      for (const f of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql')).sort())
        await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
      await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
      const mission = '20000000-0000-4000-8000-000000000001',
        run = randomUUID(),
        authorization = randomUUID(),
        reservation = randomUUID(),
        decision = randomUUID(),
        mandate = randomUUID(),
        user = '00000000-0000-4000-8000-000000000001';
      await db.query(
        "insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier)values($1,$2,'lead','{}','explicit-review-fixture','frontier')",
        [run, mission],
      );
      await db.query(
        "insert into public.model_usage_reservations(id,mission_id,run_id,call_key,ceiling_micro_usd,created_at)values($1,$2,$3,$4,500,clock_timestamp()-interval'20 minutes')",
        [reservation, mission, run, randomUUID()],
      );
      await db.query("select set_config('request.jwt.claims',$1,false)", [JSON.stringify({ sub: user, mission_id: mission })]);
      await db.query(
        "insert into public.decisions(id,mission_id,kind,packet,actor_id)values($1,$2,'mandate','{\"testFixture\":true}',$3)",
        [decision, mission, user],
      );
      await db.query(
        "insert into public.mandates(id,mission_id,decision_id,type,scope,ceiling_per,ceiling_total,currency,expires_at)values($1,$2,$3,'sample_order','{\"testFixture\":true}',6000,6000,'SAR',clock_timestamp()+interval'1 hour')",
        [mandate, mission, decision],
      );
      await db.query(
        "insert into public.effect_authorizations(id,mission_id,intent,intent_hash,idempotency_key,mandate_id,amount_minor,sandbox_mode)values($1,$2,$3,'explicit-review-fixture',$4,$5,6000,true)",
        [authorization, mission, { testFixture: true, action: 'payment_capture', effectClass: 'spend' }, randomUUID(), mandate],
      );
      await db.query(
        "insert into public.effect_states(mission_id,authorization_id,status,created_at)values($1,$2,'ambiguous',clock_timestamp()-interval'2 hours')",
        [mission, authorization],
      );
      await db.query('begin');
      await db.query('set local role operator_role');
      const report = (await db.query('select public.operator_health_snapshot(1000)report')).rows[0]?.report as {
        metrics: Record<string, number>;
        alerts: { code: string; reference_id: string }[];
      };
      await db.query('commit');
      expect(report.metrics['pendingModelReservations']).toBe(1);
      expect(report.metrics['heldModelCeilingMicroUsd']).toBe(500);
      expect(report.metrics['knownModelMicroUsd']).toBe(0);
      expect(report.alerts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'model_usage_pending', reference_id: reservation }),
          expect.objectContaining({ code: 'payment_ambiguous', reference_id: authorization }),
        ]),
      );
      expect((await db.query('select count(*)::int n from public.payments')).rows[0]?.n).toBe(0);
    } finally {
      await db?.end();
      await admin.query(`drop database if exists ${name}with(force)`);
      await admin.end();
    }
  }, 30000);
});
