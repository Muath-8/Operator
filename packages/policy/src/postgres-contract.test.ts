import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client, Pool } from 'pg';
import { expect, it } from 'vitest';
import { PostgresMissionRepository } from '@lo/state';
import { executeGuarded, postgresEffectRepository, type EffectIntent } from './index.js';

it('AT-FR-MAN-07-2 real PostgreSQL bridge preserves authorized receipt operation under dispatch lease', async () => {
  const adminUrl = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres';
  const databaseName = `lo_policy_contract_${Date.now()}`;
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  let db: Client | undefined;
  let pool: Pool | undefined;
  try {
    await admin.query(`create database ${databaseName}`);
    db = new Client({ connectionString: databaseUrl.href });
    await db.connect();
    const root = fileURLToPath(new URL('../../..', import.meta.url));
    const bootstrap = (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
      'create role authenticated nologin noinherit nobypassrls;',
      () =>
        "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
    );
    await db.query(bootstrap);
    for (const name of (await readdir(`${root}/supabase/migrations`)).filter(n => n.endsWith('.sql') && n < '202611120005').sort())
      await db.query(await readFile(`${root}/supabase/migrations/${name}`, 'utf8'));
    const user = randomUUID(),
      founder = randomUUID(),
      mission = randomUUID(),
      party = randomUUID(),
      decision = randomUUID(),
      mandate = randomUUID();
    const claims = JSON.stringify({ sub: user, mission_id: mission });
    await db.query("select set_config('request.jwt.claims',$1,false)", [claims]);
    await db.query('insert into public.founders(id,auth_user_id)values($1,$2)', [founder, user]);
    await db.query(
      "insert into public.missions(id,founder_id,type,goal_brief,currency)values($1,$2,'launch','Policy integration test','SAR')",
      [mission, founder],
    );
    await db.query("insert into public.counterparties(id,founder_id,kind,name)values($1,$2,'supplier','Test supplier')", [party, founder]);
    await db.query("insert into public.decisions(id,mission_id,kind,packet,actor_id)values($1,$2,'mandate','{}',$3)", [
      decision,
      mission,
      user,
    ]);
    await db.query("insert into public.decision_resolutions(mission_id,decision_id,response,actor_id)values($1,$2,'approve',$3)", [
      mission,
      decision,
      user,
    ]);
    await db.query(
      "insert into public.mandates(id,mission_id,decision_id,type,scope,ceiling_per,ceiling_total,currency,expires_at)values($1,$2,$3,'outreach',$4,0,0,'SAR',clock_timestamp()+interval '1 hour')",
      [
        mandate,
        mission,
        decision,
        {
          actions: ['send_message'],
          effectClasses: ['communicate'],
          counterpartyIds: [party],
          channels: ['email'],
          purposes: ['notification'],
          instrumentIds: [],
          maxNewContacts: 5,
        },
      ],
    );
    await db.query('update private.platform_controls set effects_enabled=true');
    await db.query('set role policy_role');
    pool = new Pool({ connectionString: databaseUrl.href, max: 1 });
    const leasePool = pool;
    const repository = new PostgresMissionRepository(db, async () => {
      const client = await leasePool.connect();
      await client.query('set role policy_role');
      await client.query("select set_config('request.jwt.claims',$1,false)", [claims]);
      return client;
    });
    const guarded = postgresEffectRepository(repository, mission);
    const intent: EffectIntent = {
      missionId: mission,
      taskId: 'contract',
      action: 'send_message',
      effectClass: 'communicate',
      counterpartyId: party,
      idempotencyKey: randomUUID(),
      mode: 'do',
      sandboxMode: true,
      mandateId: mandate,
      channel: 'email',
      purpose: 'notification',
      newContact: false,
    };
    let calls = 0;
    const run = () =>
      executeGuarded(intent, { role: 'sourcing' }, guarded, async i => {
        calls++;
        return {
          ok: true,
          data: {},
          receipt: {
            provider: 'test-email',
            providerId: randomUUID(),
            operation: i.action,
            timestamp: new Date().toISOString(),
            payloadHash: 'a'.repeat(64),
            idempotencyKey: i.idempotencyKey,
            sandboxMode: i.sandboxMode,
          },
        };
      });
    expect(await run()).toMatchObject({ ok: true, receipt: { operation: 'send_message' } });
    expect(await run()).toMatchObject({ ok: true, replay: true, receipt: { operation: 'send_message' } });
    expect(calls).toBe(1);
    const stored = await db.query('select operation from public.provider_receipts where mission_id=$1', [mission]);
    expect(stored.rows).toEqual([{ operation: 'send_message' }]);
  } finally {
    await pool?.end();
    await db?.end();
    await admin.query(`drop database if exists ${databaseName} with(force)`);
    await admin.end();
  }
}, 30000);
