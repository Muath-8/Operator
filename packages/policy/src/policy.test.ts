import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  alwaysApproveActions,
  bindingHash,
  evaluatePolicy,
  executeGuarded,
  failure,
  roleCanExecute,
  tokenHash,
  type EffectIntent,
  type PolicySnapshot,
  type Receipt,
} from './index.js';
import { MemoryEffectRepository } from './testing.js';

const uuid = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
function intent(overrides: Partial<EffectIntent> = {}): EffectIntent {
  return {
    missionId: uuid,
    taskId: 'task',
    action: 'send_message',
    effectClass: 'communicate',
    counterpartyId: uuid,
    idempotencyKey: 'effect-key-00000001',
    mode: 'do',
    sandboxMode: true,
    newContact: false,
    mandateId: uuid,
    ...overrides,
  };
}
function state(): PolicySnapshot {
  return {
    paused: false,
    killed: false,
    sandboxMode: true,
    missionCurrency: 'SAR',
    budgetRemainingMinor: 100000,
    mandates: [
      {
        id: uuid,
        missionId: uuid,
        effectClass: 'communicate',
        actions: ['send_message'],
        counterparties: [uuid],
        expiresAt: '2099-01-01T00:00:00.000Z',
        reservedMinor: 0,
        spentMinor: 0,
        maxActions: 15,
        usedActions: 0,
      },
    ],
  };
}
function receipt(i: EffectIntent): Receipt {
  return {
    provider: 'test',
    providerId: 'provider-id',
    operation: i.action,
    timestamp: new Date().toISOString(),
    payloadHash: 'a'.repeat(64),
    idempotencyKey: i.idempotencyKey,
    sandboxMode: i.sandboxMode,
  };
}
describe('FR-MAN-01..10 policy / I-1 I-2 I-4 I-10 I-13', () => {
  it('AT-FR-MAN-02-1 fails closed for 10000 arbitrary uncovered effects', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer({ min: 0, max: 100000 }), fc.boolean(), (action, amount, sandbox) => {
        const i = intent({
          action,
          effectClass: 'spend',
          amountMinor: amount,
          currency: 'SAR',
          artifactVersionId: uuid,
          instrumentId: uuid,
          sandboxMode: sandbox,
        });
        const s = state();
        s.mandates = [];
        expect(evaluatePolicy(i, s).kind).toBe('deny');
      }),
      { numRuns: 10000, seed: 20261112 },
    );
  });
  it('AT-FR-MAN-04-1 no mandate covers any always-approve action', () => {
    // state() always constructs one fully specified outreach mandate.
    for (const action of alwaysApproveActions) {
      const s = state();
      s.mandates = [
        {
          // state() always supplies the initial outreach mandate.
          // state() always supplies the initial outreach mandate.
          ...s.mandates[0]!,
          actions: [action],
          effectClass: 'spend',
          currency: 'SAR',
          perTransactionMinor: 100000,
          totalMinor: 100000,
          instrumentIds: [uuid],
        },
      ];
      expect(
        evaluatePolicy(
          intent({ action, effectClass: 'spend', amountMinor: 1, currency: 'SAR', artifactVersionId: uuid, instrumentId: uuid }),
          s,
        ).kind,
      ).toBe('deny');
    }
  });
  it.each([
    'production_order',
    'agreement',
    'publish',
    'legal_filing',
    'mission_end',
    'final_selection',
    'material_terms',
    'payment_refund',
  ])('AT-FR-MAN-07-1 %s allows only the bound token', action => {
    const i = intent({ action, approvalToken: 'token-'.repeat(8), artifactVersionId: uuid });
    const s = state();
    s.approval = {
      tokenHash: tokenHash(i.approvalToken ?? ''),
      bindingHash: bindingHash(i),
      consumed: false,
      revoked: false,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    expect(evaluatePolicy(i, s).kind).toBe('allow');
    for (const changed of [
      { counterpartyId: other },
      { artifactVersionId: other },
      { amountMinor: 1 },
      { currency: 'USD' },
      { action: 'other' },
    ])
      expect(evaluatePolicy({ ...i, ...changed }, s).kind).toBe('deny');
  });
  it('AT-FR-MAN-03-1 holds contact 16 and expired/revoked mandates', () => {
    // state() always constructs one fully specified outreach mandate.
    for (const patch of [{ usedActions: 15 }, { expiresAt: '2020-01-01T00:00:00.000Z' }, { revokedAt: new Date().toISOString() }]) {
      const s = state();
      // state() always supplies the initial outreach mandate.
      s.mandates = [{ ...s.mandates[0]!, ...patch }];
      expect(evaluatePolicy(intent(), s).kind).toBe('deny');
    }
  });
  it('AT-FR-MAN-08-1 Guide becomes a draft', () => {
    expect(evaluatePolicy(intent({ mode: 'guide' }), state()).kind).toBe('draft');
  });
  it('FR-PAY-09 original foreign amount cannot bypass mission-currency budget, including a bound approval', () => {
    const i = intent({
        action: 'sample_payment',
        effectClass: 'spend',
        amountMinor: 6000,
        currency: 'USD',
        artifactVersionId: uuid,
        instrumentId: uuid,
        approvalToken: 'token-'.repeat(8),
      }),
      s = state();
    s.budgetRemainingMinor = 10000;
    s.approval = {
      tokenHash: tokenHash(i.approvalToken ?? ''),
      bindingHash: bindingHash(i),
      consumed: false,
      revoked: false,
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    expect(evaluatePolicy(i, s).kind).toBe('deny');
    s.fxConversions = [
      {
        artifactVersionId: uuid,
        amountMinor: 6000,
        currency: 'USD',
        missionCurrency: 'SAR',
        missionAmountMinor: 22500,
        numerator: 375,
        denominator: 100,
        source: 'https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx',
        observedAt: new Date(Date.now() - 60000).toISOString(),
        expiresAt: new Date(Date.now() + 60000).toISOString(),
      },
    ];
    expect(evaluatePolicy(i, s).kind).toBe('deny');
    s.budgetRemainingMinor = 22500;
    expect(evaluatePolicy(i, s).kind).toBe('allow');
  });
  it('AT-FR-MAN-06-1 includes reserved spend in ceilings', () => {
    // state() always constructs one fully specified outreach mandate.
    const s = state();
    s.mandates = [
      {
        // state() always supplies the initial outreach mandate.
        ...s.mandates[0]!,
        effectClass: 'spend',
        actions: ['sample_payment'],
        currency: 'SAR',
        perTransactionMinor: 800,
        totalMinor: 1000,
        reservedMinor: 700,
        spentMinor: 100,
        instrumentIds: [uuid],
      },
    ];
    expect(
      evaluatePolicy(
        intent({
          action: 'sample_payment',
          effectClass: 'spend',
          amountMinor: 201,
          currency: 'SAR',
          artifactVersionId: uuid,
          instrumentId: uuid,
        }),
        s,
      ).kind,
    ).toBe('deny');
    expect(
      evaluatePolicy(
        intent({
          action: 'sample_payment',
          effectClass: 'spend',
          amountMinor: 200,
          currency: 'SAR',
          artifactVersionId: uuid,
          instrumentId: uuid,
        }),
        s,
      ),
    ).toMatchObject({ kind: 'allow', warning: 'ceiling_80_percent' });
  });
  it('I-10 restricted roles have no spend publish or bind capability', () => {
    for (const role of ['voice', 'operations', 'extraction'] as const)
      for (const effect of ['spend', 'publish', 'bind'] as const) expect(roleCanExecute(role, effect)).toBe(false);
  });
  it('Attack 1: replay/race consumes approval once across 100 concurrent calls', async () => {
    const i = intent({ action: 'production_order', approvalToken: 'token-'.repeat(8), artifactVersionId: uuid });
    const s = state();
    s.approval = {
      tokenHash: tokenHash(i.approvalToken ?? ''),
      bindingHash: bindingHash(i),
      expiresAt: '2099-01-01T00:00:00.000Z',
      consumed: false,
      revoked: false,
    };
    const repository = new MemoryEffectRepository(s, 'test');
    let effects = 0;
    await Promise.all(
      Array.from({ length: 100 }, (_, n) =>
        executeGuarded({ ...i, idempotencyKey: `race-effect-key-${n}` }, { role: 'policy' }, repository, async intent => {
          effects++;
          return { ok: true, data: {}, receipt: receipt(intent) };
        }),
      ),
    );
    expect(effects).toBe(1);
  });
  it('Attack 2: timeout then retry never causes a second effect', async () => {
    const repository = new MemoryEffectRepository(state(), 'test');
    let effects = 0;
    const i = intent();
    const call = () =>
      executeGuarded(i, { role: 'sourcing' }, repository, async () => {
        effects++;
        throw new Error('timeout after provider committed');
      });
    expect(await call()).toMatchObject({ ok: false, retry: 'reconcile' });
    expect(await call()).toMatchObject({ ok: false, retry: 'reconcile' });
    expect(effects).toBe(1);
  });
  it('I-3 no receipt means no performed state', async () => {
    const repository = new MemoryEffectRepository(state(), 'test');
    await executeGuarded(intent(), { role: 'sourcing' }, repository, async () => failure('provider_down', 'No receipt.', 'reconcile'));
    expect([...repository.reservations.values()].every(r => r.status !== 'performed')).toBe(true);
  });
  it('I-13 revocation between reservation and execution stops next external effect', async () => {
    const s = state();
    const repository = new MemoryEffectRepository(s, 'test');
    const reserve = repository.reserveEffect.bind(repository);
    repository.reserveEffect = async i => {
      const result = await reserve(i);
      s.paused = true;
      return result;
    };
    let effects = 0;
    expect(
      await executeGuarded(intent(), { role: 'sourcing' }, repository, async i => {
        effects++;
        return { ok: true, data: {}, receipt: receipt(i) };
      }),
    ).toMatchObject({ ok: false });
    expect(effects).toBe(0);
  });
  it('I-16 rejects a receipt from a different environment', async () => {
    const repository = new MemoryEffectRepository(state(), 'test');
    expect(
      await executeGuarded(intent(), { role: 'sourcing' }, repository, async i => ({
        ok: true,
        data: {},
        receipt: { ...receipt(i), sandboxMode: false },
      })),
    ).toMatchObject({ ok: false, code: 'invariant_violation' });
  });
});
