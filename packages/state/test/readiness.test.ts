import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { randomUUID } from 'node:crypto';
import {
  calculateImpact,
  deriveReadiness,
  READINESS_RULES,
  type ReadinessContext,
  type ReadinessDecision,
  type ReadinessFact,
} from '../src/readiness.js';
import { DecisionPacketSchema, EffectIntentSchema, EvidenceSchema, MoneySchema, OUTCOMES } from '../src/schemas.js';

describe('FR-STATE-02/03 I-5/6 six-outcome readiness', () => {
  for (const outcome of OUTCOMES)
    for (let target = 0; target <= 5; target++)
      it(`${outcome} derives R${target} from qualifying immutable ledgers`, () => {
        const facts: ReadinessFact[] = [];
        const decisions: ReadinessDecision[] = [];
        const context: ReadinessContext = { artifacts: [], commitments: [] };
        for (const rule of READINESS_RULES.filter(r => r.outcome === outcome && r.level <= target)) {
          for (const kind of rule.evidenceKinds)
            facts.push({
              id: randomUUID(),
              outcome,
              kind,
              trust: rule.founderKinds?.includes(kind) ? 'founder_confirmed' : rule.highTrust ? 'verified' : 'claimed',
              stale: false,
            });
          for (const gate of rule.decisionGates) decisions.push({ id: randomUUID(), outcome, gate, approved: true, stale: false });
        }
        if (outcome === 'supply' && target === 5) {
          const decisionId = randomUUID(),
            versionId = randomUUID(),
            statement = 'I accept the explicitly described sourcing sequence risk.';
          decisions.push({
            id: decisionId,
            outcome,
            kind: 'engagement',
            gate: 'sourcing_risk_accepted',
            approved: true,
            stale: false,
            selectedVersionIds: [versionId],
          });
          context.artifacts = [
            {
              id: versionId,
              outcome,
              type: 'confirmation',
              current: true,
              approved: true,
              stale: false,
              content: { founderConfirmation: { outcome, kind: 'sourcing_risk_accepted', statement, payload: { riskAccepted: true } } },
            },
          ];
          facts.push({
            id: randomUUID(),
            outcome,
            kind: 'sourcing_risk_accepted',
            trust: 'founder_confirmed',
            stale: false,
            payload: {
              riskAccepted: true,
              statement,
              decisionId,
              artifactVersionId: versionId,
              confirmedAt: new Date(Date.now() - 1000).toISOString(),
            },
          });
        }
        expect(deriveReadiness(facts, decisions, READINESS_RULES, context).find(r => r.outcome === outcome)?.level).toBe(target);
      });
  it('claimed-only evidence never exceeds R3 under 10000 random ledger permutations', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: READINESS_RULES.length - 1 }), { maxLength: 80 }), indexes => {
        const facts: ReadinessFact[] = indexes.flatMap(index => {
          const rule = READINESS_RULES[index];
          return rule
            ? rule.evidenceKinds.map(kind => ({ id: randomUUID(), outcome: rule.outcome, kind, trust: 'claimed' as const, stale: false }))
            : [];
        });
        const decisions = READINESS_RULES.flatMap(r =>
          r.decisionGates.map(gate => ({ id: randomUUID(), outcome: r.outcome, gate, approved: true, stale: false })),
        );
        expect(deriveReadiness(facts, decisions).every(r => r.level <= 3)).toBe(true);
      }),
      { numRuns: 10000 },
    );
  });
  it('performed registration receipts qualify only after external verification prerequisite', () => {
    const rules = READINESS_RULES.filter(r => r.outcome === 'brand');
    const facts = rules.flatMap(r =>
      r.evidenceKinds.map(kind => ({
        id: randomUUID(),
        outcome: r.outcome,
        kind,
        trust: r.founderKinds?.includes(kind)
          ? ('founder_confirmed' as const)
          : kind === 'founder_owned_domain'
            ? ('performed' as const)
            : ('verified' as const),
        stale: false,
      })),
    );
    const decisions = rules.flatMap(r =>
      r.decisionGates.map(gate => ({ id: randomUUID(), outcome: r.outcome, gate, approved: true, stale: false })),
    );
    expect(deriveReadiness(facts, decisions)[0]?.level).toBe(5);
    expect(
      deriveReadiness(
        facts.map(f => (f.kind === 'external_verification' ? { ...f, stale: true } : f)),
        decisions,
      )[0]?.level,
    ).toBe(3);
  });
  it('I-7 impact includes second-order dependencies and terminates cycles', () => {
    expect(
      calculateImpact('a', [
        { upstreamId: 'a', dependentId: 'b' },
        { upstreamId: 'b', dependentId: 'c' },
        { upstreamId: 'c', dependentId: 'a' },
        { upstreamId: 'x', dependentId: 'y' },
      ]),
    ).toEqual(['b', 'c']);
  });
});
describe('strict boundary schemas', () => {
  it('requires integer minor units and ISO currency', () => {
    expect(MoneySchema.safeParse({ amountMinor: 1.5, currency: 'SAR' }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: 1, currency: 'sar' }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: 123, currency: 'SAR' }).success).toBe(true);
  });
  it('rejects performed evidence without a provider receipt', () => {
    expect(
      EvidenceSchema.safeParse({
        id: randomUUID(),
        missionId: randomUUID(),
        outcome: 'supply',
        kind: 'sent',
        trust: 'performed',
        payload: {},
        source: { type: 'url', reference: 'https://example.test' },
        providerReceiptId: null,
        supersedesId: null,
        sandboxMode: true,
        createdAt: new Date().toISOString(),
        actorId: randomUUID(),
      }).success,
    ).toBe(false);
  });
  it('rejects incomplete packets and incomplete spend intents', () => {
    expect(DecisionPacketSchema.safeParse({ question: 'Choose' }).success).toBe(false);
    expect(
      EffectIntentSchema.safeParse({
        missionId: randomUUID(),
        taskId: 'x',
        action: 'pay',
        effectClass: 'spend',
        counterpartyId: randomUUID(),
        idempotencyKey: 'deterministic-key',
        mode: 'do',
        sandboxMode: true,
      }).success,
    ).toBe(false);
  });
});
