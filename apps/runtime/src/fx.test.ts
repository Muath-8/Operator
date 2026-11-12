import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Client } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { PostgresMissionRepository, EffectIntentSchema, type JsonValue } from '@lo/state';
import { conservativeConvertedMinor, type FxConversion, type Transport } from '@lo/adapters';
import { fetchAuthoritativeFxQuote, SAMA_FX_ENDPOINT } from './fx.js';
import { closeDatabasePools, withRole } from './database.js';
import { ProviderStorage } from './provider-storage.js';
const root = fileURLToPath(new URL('../../..', import.meta.url)),
  url = process.env['LO_DATABASE_URL'] ?? 'postgresql://postgres@127.0.0.1:55439/postgres',
  name = `lo_fx_${Date.now()}`,
  admin = new Client({ connectionString: url });
let db: Client;
const prior = { ...process.env };
const scope = { authUserId: '00000000-0000-4000-8000-000000000001', missionId: '20000000-0000-4000-8000-000000000001' },
  party = '30000000-0000-4000-8000-000000000001',
  founder = '10000000-0000-4000-8000-000000000001';
let accountId: string, conversion: FxConversion, version: string, mandateId: string;
let authorization: string, payment: string, receipt: string, secondAuthorization: string;
const packet = {
  question: 'Approve exactly this source?',
  options: [{ id: 'a', label: 'Approve', evidenceIds: [], cost: null, timeDays: 0, consequences: 'Test fixture only' }],
  recommendation: { optionId: 'a', reasons: ['Explicit fixture source'] },
  staleImpact: [],
  defaultIfNoAnswer: { optionId: 'a', at: null, binding: true },
};
const sourceDate = () => new Date(Date.now() + 3 * 3600000).toISOString().slice(0, 10) + 'T00:00:00';
const sama: Transport = async request => {
  expect(request.url.startsWith(SAMA_FX_ENDPOINT)).toBe(true);
  const code = new URL(request.url).searchParams.get('code');
  return {
    status: 200,
    headers: {},
    body: { data: [{ CurrencyCode: code, CurrencyRate: code === 'USD=' ? 3.75 : 4, CurrencyDate: sourceDate() }] },
  };
};
async function approved(content: Record<string, JsonValue>, kind = 'selection') {
  const artifact = await withRole('specialist_role', scope, async d => {
    const a = (await d.query("select public.create_artifact($1,'payment_proposal','supply','Synthetic FX fixture')id", [scope.missionId]))
      .rows[0]?.id;
    const v = String((await d.query('select public.append_artifact_version($1,$2,$3)id', [scope.missionId, a, content])).rows[0]?.id);
    await d.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, v]);
    return v;
  });
  const decision = await withRole('lead_role', scope, async d =>
    String(
      (
        await d.query("select public.propose_decision($1,$2,$3,'supply','samples')id", [
          scope.missionId,
          kind,
          { ...packet, approvedVersionIds: [artifact] },
        ])
      ).rows[0]?.id,
    ),
  );
  await withRole('founder_role', scope, async d => {
    await d.query("select public.resolve_decision($1,$2,'approve','a')", [scope.missionId, decision]);
    await d.query("select public.set_artifact_status($1,$2,'approved',$3)", [scope.missionId, artifact, decision]);
  });
  return { version: artifact, decision };
}
function intent(patch: Record<string, unknown> = {}) {
  return EffectIntentSchema.parse({
    missionId: scope.missionId,
    taskId: randomUUID(),
    action: 'payment_capture',
    effectClass: 'spend',
    counterpartyId: party,
    amountMinor: 6000,
    currency: 'USD',
    artifactVersionId: version,
    instrumentId: accountId,
    idempotencyKey: randomUUID(),
    mode: 'do',
    sandboxMode: true,
    mandateId,
    purpose: 'samples',
    newContact: false,
    ...patch,
  });
}
async function reserve(i: ReturnType<typeof intent>, hash: string | null = null) {
  return withRole(
    'policy_role',
    scope,
    async d =>
      (await d.query('select public.reserve_effect($1,$2,$3)result', [scope.missionId, i, hash])).rows[0]?.result as {
        authorizationId: string;
      },
  );
}
async function providerReceipt(id: string, operation: string, reference: string, amount = 6000) {
  await withRole('policy_role', scope, async d => {
    await d.query('select public.begin_effect($1,$2)', [scope.missionId, id]);
    await d.query('select public.complete_effect($1,$2,$3)', [
      scope.missionId,
      id,
      {
        provider: 'paypal',
        providerReference: reference,
        operation,
        sandboxMode: true,
        data: {
          testFixture: true,
          orderId: 'TEST_FX_ORDER',
          captureId: 'TEST_FX_CAPTURE',
          payeeId: party,
          payeeMerchantId: 'PAYEE',
          amountMinor: amount,
          currency: 'USD',
        },
      },
    ]);
  });
  return String((await db.query('select id from public.provider_receipts where authorization_id=$1', [id])).rows[0]?.id);
}
beforeAll(async () => {
  await admin.connect();
  await admin.query(`create database ${name}`);
  const local = new URL(url);
  local.pathname = `/${name}`;
  db = new Client({ connectionString: local.href });
  await db.connect();
  const bootstrap = (await readFile(`${root}/supabase/tests/bootstrap.sql`, 'utf8')).replace(
    'create role authenticated nologin noinherit nobypassrls;',
    () =>
      "do $$begin if not exists(select from pg_roles where rolname='authenticated')then create role authenticated nologin noinherit nobypassrls;end if;end$$;",
  );
  await db.query(bootstrap);
  for (const f of (await readdir(`${root}/supabase/migrations`)).filter(f => f.endsWith('.sql') && f < '202611120017').sort())
    await db.query(await readFile(`${root}/supabase/migrations/${f}`, 'utf8'));
  await db.query(await readFile(`${root}/supabase/seed.sql`, 'utf8'));
  await db.query('update private.platform_controls set effects_enabled=true');
  accountId = randomUUID();
  await db.query("insert into public.founder_accounts(id,founder_id,provider,status,scopes)values($1,$2,'paypal','connected','{pay}')", [
    accountId,
    founder,
  ]);
  process.env['DATABASE_URL'] = local.href;
  process.env['LO_EXECUTION_MODE'] = 'local';
  process.env['APP_ORIGIN'] = 'http://127.0.0.1:3000';
  process.env['PROVIDER_ENCRYPTION_KEY'] = randomBytes(32).toString('base64');
}, 30000);
afterAll(async () => {
  await closeDatabasePools();
  process.env = prior;
  await db?.end();
  await admin.query(`drop database if exists ${name}with(force)`);
  await admin.end();
});
describe('FR-PAY-09 cross-currency authority and receipt-correlated accounting', () => {
  it('fetches exact first-party dated rates and conservatively converts USD60 to SAR225', async () => {
    const r = await fetchAuthoritativeFxQuote(scope, { amountMinor: 6000, from: 'USD', to: 'SAR' }, sama);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('Quote unavailable');
    conversion = r.value;
    expect(conversion).toMatchObject({ from: 'USD', to: 'SAR', missionAmountMinor: 22500, numerator: 375000000, denominator: 100000000 });
    expect(conservativeConvertedMinor(1, 375, 100)).toBe(4);
    expect(conservativeConvertedMinor(2, 375, 100)).toBe(8);
  });
  it('rejects mismatched, stale, future and missing source payloads without guessed fallback', async () => {
    for (const row of [
      { CurrencyCode: 'EUR=', CurrencyRate: 3.75, CurrencyDate: sourceDate() },
      { CurrencyCode: 'USD=', CurrencyRate: 3.75, CurrencyDate: '2000-01-01T00:00:00' },
      { CurrencyCode: 'USD=', CurrencyRate: 3.75, CurrencyDate: '2999-01-01T00:00:00' },
      null,
    ]) {
      const r = await fetchAuthoritativeFxQuote(scope, { amountMinor: 6000, from: 'USD', to: 'SAR' }, async () => ({
        status: 200,
        headers: {},
        body: { data: [row] },
      }));
      expect(r.ok).toBe(false);
    }
  });
  it('reserves mandate ceilings in mission currency and enforces count across repeated recipients', async () => {
    const source = await approved({ payload: { amountMinor: 6000, currency: 'USD', conversion: conversion as unknown as JsonValue } });
    version = source.version;
    const mandateScope = {
      actions: ['payment_capture'],
      effectClasses: ['spend'],
      counterpartyIds: [party],
      channels: [],
      purposes: ['samples'],
      instrumentIds: [accountId],
      maxNewContacts: 0,
      maxActions: 2,
    };
    const expires = new Date(Date.now() + 3600000).toISOString(),
      m = await approved(
        {
          mandate: {
            type: 'sample_order',
            scope: mandateScope,
            ceilingPer: 23000,
            ceilingTotal: 50000,
            currency: 'SAR',
            expiresAt: expires,
          },
        },
        'mandate',
      );
    mandateId = await withRole('founder_role', scope, async d =>
      String(
        (
          await d.query("select public.grant_mandate($1,$2,'sample_order',$3,23000,50000,$4)id", [
            scope.missionId,
            m.decision,
            mandateScope,
            expires,
          ])
        ).rows[0]?.id,
      ),
    );
    authorization = (await reserve(intent())).authorizationId;
    expect(
      (await db.query('select amount_minor from public.effect_authorizations where id=$1', [authorization])).rows[0]?.amount_minor,
    ).toBe('22500');
    secondAuthorization = (await reserve(intent())).authorizationId;
    await expect(reserve(intent())).rejects.toThrow(/action count exceeded/);
    await expect(
      withRole('founder_role', scope, d =>
        d.query("select public.grant_mandate($1,$2,'sample_order',$3,23000,50000,$4)", [
          scope.missionId,
          m.decision,
          { ...mandateScope, maxActions: 3 },
          expires,
        ]),
      ),
    ).rejects.toThrow(/action count widened/);
  });
  it('a missing or manipulated conversion cannot reserve even below the original-currency numeric ceiling', async () => {
    for (const payload of [
      { amountMinor: 6000, currency: 'USD' },
      { amountMinor: 6000, currency: 'USD', conversion: { ...conversion, missionAmountMinor: 6000 } },
      { amountMinor: 6000, currency: 'USD', conversion: { ...conversion, numerator: 1 } },
    ]) {
      const a = await approved({ payload: payload as JsonValue });
      await expect(reserve(intent({ artifactVersionId: a.version }))).rejects.toThrow(/FX|equivalent/);
    }
  });
  it('preserves original provider amount; no confirmation creates no spent; exact original-unit poll produces mission-unit spent', async () => {
    payment = await withRole('policy_role', scope, async d =>
      String((await d.query("select public.prepare_payment($1,$2,'paypal')id", [scope.missionId, authorization])).rows[0]?.id),
    );
    expect((await db.query('select amount_minor,currency from public.payments where id=$1', [payment])).rows[0]).toEqual({
      amount_minor: '6000',
      currency: 'USD',
    });
    const committed = (
      await db.query(
        "select amount_minor,currency,original_amount_minor,original_currency,fx_source from public.money_ledger where ref_id=$1 and kind='committed'",
        [payment],
      )
    ).rows[0];
    expect(committed).toMatchObject({
      amount_minor: '22500',
      currency: 'SAR',
      original_amount_minor: '6000',
      original_currency: 'USD',
      fx_source: conversion.source,
    });
    receipt = await providerReceipt(authorization, 'payment_capture', 'TEST_FX_CAPTURE');
    expect((await db.query("select count(*)::int n from public.money_ledger where ref_id=$1 and kind='spent'", [payment])).rows[0]?.n).toBe(
      0,
    );
    const store = new ProviderStorage(scope, 'ingress_role').webhookStore('payment.verified_poll'),
      payload = {
        paymentId: payment,
        payeeId: party,
        providerReference: 'TEST_FX_CAPTURE',
        orderId: 'TEST_FX_ORDER',
        amountMinor: 6000,
        currency: 'USD',
        sandboxMode: true,
      };
    const bad = await store.insertVerified({
      provider: 'paypal',
      providerEventId: randomUUID(),
      payload: { ...payload, amountMinor: 22500, currency: 'SAR' },
      signatureVerified: true,
      payloadHash: 'a'.repeat(64),
      receivedAt: new Date().toISOString(),
    });
    await expect(
      withRole('policy_role', scope, d =>
        d.query('select public.confirm_payment($1,$2,$3,$4)', [scope.missionId, payment, receipt, bad.eventId]),
      ),
    ).rejects.toThrow(/verified payment confirmation/);
    const event = await store.insertVerified({
      provider: 'paypal',
      providerEventId: randomUUID(),
      payload,
      signatureVerified: true,
      payloadHash: 'b'.repeat(64),
      receivedAt: new Date().toISOString(),
    });
    for (let n = 0; n < 2; n++)
      await withRole('policy_role', scope, d =>
        d.query('select public.confirm_payment($1,$2,$3,$4)', [scope.missionId, payment, receipt, event.eventId]),
      );
    expect(
      (
        await db.query(
          "select amount_minor,currency,original_amount_minor,original_currency,fx_quote_id from public.money_ledger where ref_id=$1 and kind='spent'",
          [payment],
        )
      ).rows,
    ).toEqual([
      { amount_minor: '22500', currency: 'SAR', original_amount_minor: '6000', original_currency: 'USD', fx_quote_id: conversion.quoteId },
    ]);
  });
  it('refunds preserve provider USD units and credit the originally booked SAR equivalent once', async () => {
    for (let n = 0; n < 2; n++) {
      const source = await approved({
          payload: {
            orderId: 'TEST_FX_ORDER',
            captureId: 'TEST_FX_CAPTURE',
            payeeMerchantId: 'PAYEE',
            amountMinor: 6000,
            currency: 'USD',
            sandboxMode: true,
            conversion: { ...conversion, missionAmountMinor: 11250 },
          },
        }),
        token = randomBytes(32).toString('hex');
      await withRole('founder_role', scope, async d => {
        const r = await new PostgresMissionRepository(d).issueApproval(
          scope.missionId,
          source.decision,
          { action: 'payment_refund', counterpartyId: party, amountMinor: 3000, currency: 'USD', artifactVersionId: source.version },
          token,
          new Date(Date.now() + 60000).toISOString(),
        );
        if (!r.ok) throw new Error('Refund test approval failed');
      });
      const a = await reserve(
          intent({ action: 'payment_refund', amountMinor: 3000, artifactVersionId: source.version }),
          createHash('sha256').update(token).digest('hex'),
        ),
        receiptId = await providerReceipt(a.authorizationId, 'payment_refund', `TEST_FX_REFUND_${n}`, 3000);
      const refundId = await withRole('policy_role', scope, async d =>
        String((await d.query('select public.register_payment_refund($1,$2)id', [scope.missionId, receiptId])).rows[0]?.id),
      );
      expect((await db.query('select amount_minor,currency from public.payment_refunds where id=$1', [refundId])).rows[0]).toEqual({
        amount_minor: '3000',
        currency: 'USD',
      });
      const event = await new ProviderStorage(scope, 'ingress_role')
        .webhookStore('payment.refund_verified_poll')
        .insertVerified({
          provider: 'paypal',
          providerEventId: randomUUID(),
          payload: {
            refundId,
            providerReference: `TEST_FX_REFUND_${n}`,
            orderId: 'TEST_FX_ORDER',
            captureId: 'TEST_FX_CAPTURE',
            payeeId: party,
            amountMinor: 3000,
            currency: 'USD',
            sandboxMode: true,
          },
          signatureVerified: true,
          payloadHash: 'c'.repeat(64),
          receivedAt: new Date().toISOString(),
        });
      for (let k = 0; k < 2; k++)
        await withRole('policy_role', scope, d =>
          d.query('select public.confirm_payment_refund($1,$2,$3)', [scope.missionId, refundId, event.eventId]),
        );
    }
    expect(
      (
        await db.query(
          "select sum(amount_minor)::text total,min(currency)currency,sum(original_amount_minor)::text original,min(original_currency)original_currency from public.money_ledger where ref_id=$1 and kind='refund'",
          [payment],
        )
      ).rows[0],
    ).toEqual({ total: '22500', currency: 'SAR', original: '6000', original_currency: 'USD' });
  });
  it('a quoted FX reservation is checked again at dispatch when the quote has expired', async () => {
    await db.query('alter table public.fx_quotes disable trigger immutable_row');
    await db.query("update public.fx_quotes set expires_at=clock_timestamp()-interval'1 second'where id=$1", [conversion.quoteId]);
    await db.query('alter table public.fx_quotes enable trigger immutable_row');
    await expect(
      withRole('policy_role', scope, d => d.query('select public.begin_effect($1,$2)', [scope.missionId, secondAuthorization])),
    ).rejects.toThrow(/FX conversion required/);
    await db.query('alter table public.fx_quotes disable trigger immutable_row');
    await db.query('update public.fx_quotes set expires_at=$1 where id=$2', [conversion.expiresAt, conversion.quoteId]);
    await db.query('alter table public.fx_quotes enable trigger immutable_row');
  });
  it('Guide/Help changes scope down an existing mandate claim before dispatch', async () => {
    const thread = await db.query('insert into public.threads(mission_id,counterparty_id)values($1,$2)returning id', [
        scope.missionId,
        party,
      ]),
      id = String(thread.rows[0]?.id);
    const storage = new ProviderStorage(scope);
    const candidate = intent({
      action: 'send_message',
      effectClass: 'communicate',
      amountMinor: undefined,
      currency: undefined,
      artifactVersionId: undefined,
      channel: 'email',
    });
    expect(
      (await withRole('policy_role', scope, d => d.query('select public.effective_effect_mode($1,$2)mode', [scope.missionId, candidate])))
        .rows[0]?.mode,
    ).toBe('do');
    const scopeData = {
        actions: ['send_message'],
        effectClasses: ['communicate'],
        counterpartyIds: [party],
        channels: ['email'],
        purposes: [],
        instrumentIds: [accountId],
        maxNewContacts: 1,
      },
      expires = new Date(Date.now() + 60000).toISOString(),
      m = await approved(
        { mandate: { type: 'outreach', scope: scopeData, ceilingPer: 0, ceilingTotal: 0, currency: 'SAR', expiresAt: expires } },
        'mandate',
      );
    const liveMandate = await withRole('founder_role', scope, async d =>
      String(
        (await d.query("select public.grant_mandate($1,$2,'outreach',$3,0,0,$4)id", [scope.missionId, m.decision, scopeData, expires]))
          .rows[0]?.id,
      ),
    );
    const pending = await reserve({ ...candidate, mandateId: liveMandate, purpose: undefined });
    await withRole('founder_role', scope, d =>
      d.query("insert into public.founder_preferences(mission_id,kind,value,actor_id)values($1,'help_mode',$2,$3)", [
        scope.missionId,
        { targetKind: 'thread', targetId: id, mode: 'guide' },
        scope.authUserId,
      ]),
    );
    const effective = await storage.buildIntent(
      randomUUID(),
      'send_message',
      'communicate',
      { counterpartyId: party, channel: 'email' },
      [],
    );
    expect(effective.mode).toBe('guide');
    await expect(
      withRole('policy_role', scope, d => d.query('select public.begin_effect($1,$2)', [scope.missionId, pending.authorizationId])),
    ).rejects.toThrow(/current Guide or Help/);
    await expect(reserve({ ...candidate, idempotencyKey: randomUUID() })).rejects.toThrow(/guide or help|Guide or Help/);
  });
});
