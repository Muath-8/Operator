import { OUTCOMES, CurrencySchema, JsonValueSchema, type JsonValue, type Outcome, type TrustLevel } from './schemas.js';
import { z } from 'zod';

export type ReadinessLevel = 0 | 1 | 2 | 3 | 4 | 5;
export interface ReadinessFact {
  id: string;
  outcome: Outcome;
  kind: string;
  trust: TrustLevel;
  stale: boolean;
  superseded?: boolean;
  payload?: Readonly<Record<string, JsonValue>>;
}
export interface ReadinessDecision {
  id: string;
  outcome: Outcome;
  gate: string;
  approved: boolean;
  stale: boolean;
  superseded?: boolean;
  kind?: string;
  selectedVersionIds?: readonly string[];
}
export interface ReadinessRule {
  outcome: Outcome;
  level: ReadinessLevel;
  evidenceKinds: readonly string[];
  decisionGates: readonly string[];
  highTrust: boolean;
  performedKinds?: readonly string[];
  founderKinds?: readonly string[];
  ledgerGate?: 'sourcing_sequence';
}
/** approved requires the latest approved status AND its still-active approval decision. */
export interface ReadinessArtifactVersion {
  id: string;
  type: string;
  outcome: Outcome;
  content: Readonly<Record<string, JsonValue>>;
  current: boolean;
  approved: boolean;
  stale: boolean;
}
export interface ReadinessCommitment {
  id: string;
  dueAt: string;
  status: 'open' | 'overdue' | 'closed' | 'cancelled';
  stale: boolean;
  closedEvidenceCurrent?: boolean;
}
export interface ReadinessInspectionCommitment {
  commitmentId: string;
  proformaVersionId: string;
  specVersionId: string;
  checks: readonly string[];
}
/** These are scoped ledger projections, not model assertions or substitute evidence. */
export interface ReadinessContext {
  artifacts: readonly ReadinessArtifactVersion[];
  commitments: readonly ReadinessCommitment[];
  inspections?: readonly ReadinessInspectionCommitment[];
  now?: string;
}
export interface ReadinessResult {
  outcome: Outcome;
  level: ReadinessLevel;
  evidenceIds: string[];
  decisionIds: string[];
  missing: string[];
  stale: boolean;
}
export const READINESS_VERSION = 2 as const;
export const ProformaInvoiceSchema = z
  .object({
    specVersionId: z.uuid(),
    amountMinor: z.number().int().safe().positive(),
    currency: CurrencySchema,
    incoterm: z.string().trim().min(1),
  })
  .catchall(JsonValueSchema);
export type ProformaInvoice = z.infer<typeof ProformaInvoiceSchema>;
/** SQL injects this provenance after an explicit selected-version founder approval. */
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/;
export const DatedFounderSourcingRiskSchema = z
  .object({
    riskAccepted: z.literal(true),
    statement: z.string().trim().min(1),
    confirmedAt: z.iso.datetime({ offset: true }).regex(ISO_DATE_PATTERN),
    decisionId: z.uuid(),
    artifactVersionId: z.uuid(),
  })
  .catchall(JsonValueSchema);
export type DatedFounderSourcingRisk = z.infer<typeof DatedFounderSourcingRiskSchema>;
const launchGates: Record<Outcome, readonly string[]> = {
  brand: [
    'name_availability',
    'name_approved',
    'founder_owned_domain',
    'founder_owned_handles',
    'trademark_screen',
    'identity_approved',
    'guidelines_approved',
    'identity_assets_delivered',
  ],
  product: ['physical_sample_approved', 'manufacturing_brief_sample_match'],
  supply: ['supplier_verified', 'accepted_terms', 'production_or_fulfilment', 'delivery_shipping', 'qa_agreed'],
  commerce: ['domain_live', 'store_published', 'checkout_test_refunded', 'shipping_configured', 'returns_support'],
  compliance: ['requirements_complete', 'requirements_resolved'],
  demand: ['validation_result', 'first_customer_channel', 'launch_week_plan', 'launch_content_approved'],
};
export const READINESS_RULES: readonly ReadinessRule[] = OUTCOMES.flatMap(outcome => [
  { outcome, level: 1 as const, evidenceKinds: ['research'], decisionGates: [], highTrust: false },
  { outcome, level: 2 as const, evidenceKinds: ['research'], decisionGates: ['direction'], highTrust: false },
  { outcome, level: 3 as const, evidenceKinds: ['specification'], decisionGates: ['specification'], highTrust: false },
  { outcome, level: 4 as const, evidenceKinds: ['external_verification'], decisionGates: ['specification'], highTrust: true },
  {
    outcome,
    level: 5 as const,
    evidenceKinds: launchGates[outcome],
    decisionGates: ['specification'],
    highTrust: true,
    performedKinds: [
      'founder_owned_domain',
      'founder_owned_handles',
      'identity_assets_delivered',
      'production_or_fulfilment',
      'domain_live',
      'store_published',
      'shipping_configured',
    ],
    founderKinds:
      outcome === 'brand'
        ? ['name_approved', 'identity_approved', 'guidelines_approved']
        : outcome === 'demand'
          ? ['launch_week_plan', 'launch_content_approved']
          : [],
    ...(outcome === 'supply' ? { ledgerGate: 'sourcing_sequence' as const } : {}),
  },
]);

const object = (value: JsonValue | undefined): Readonly<Record<string, JsonValue>> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value : undefined;
const date = (value: JsonValue | undefined): number =>
  typeof value === 'string' && ISO_DATE_PATTERN.test(value) && z.iso.datetime({ offset: true }).safeParse(value).success
    ? Date.parse(value)
    : NaN;
const currentApproved = (version: ReadinessArtifactVersion): boolean => version.current && version.approved && !version.stale;
function sourcingSequence(
  facts: readonly ReadinessFact[],
  decisions: readonly ReadinessDecision[],
  context: ReadinessContext,
): { missing: string[]; evidenceIds: string[] } {
  const now = Date.parse(context.now ?? new Date().toISOString());
  const risk = facts.find(f => {
    const p = f.payload,
      version = context.artifacts.find(v => v.id === p?.['artifactVersionId'] && v.outcome === 'supply' && currentApproved(v));
    const confirmation = object(version?.content['founderConfirmation']);
    return (
      f.kind === 'sourcing_risk_accepted' &&
      f.trust === 'founder_confirmed' &&
      p?.['riskAccepted'] === true &&
      typeof p['statement'] === 'string' &&
      p['statement'].trim().length > 0 &&
      Number.isFinite(date(p['confirmedAt'])) &&
      date(p['confirmedAt']) <= now &&
      decisions.some(
        d =>
          d.id === p['decisionId'] &&
          d.kind === 'engagement' &&
          d.gate === 'sourcing_risk_accepted' &&
          d.selectedVersionIds?.includes(version?.id ?? ''),
      ) &&
      confirmation?.['kind'] === 'sourcing_risk_accepted' &&
      confirmation['outcome'] === 'supply' &&
      confirmation['statement'] === p['statement'] &&
      object(confirmation['payload'])?.['riskAccepted'] === true
    );
  });
  if (risk) return { missing: [], evidenceIds: [risk.id] };
  const proformas = context.artifacts.filter(v => {
    const p = object(v.content['proformaInvoice']);
    return (
      v.type === 'proforma_invoice' &&
      v.outcome === 'supply' &&
      currentApproved(v) &&
      p &&
      typeof p['amountMinor'] === 'number' &&
      Number.isSafeInteger(p['amountMinor']) &&
      p['amountMinor'] > 0 &&
      typeof p['currency'] === 'string' &&
      /^[A-Z]{3}$/.test(p['currency']) &&
      typeof p['incoterm'] === 'string' &&
      p['incoterm'].trim().length > 0 &&
      context.artifacts.some(spec => spec.id === p['specVersionId'] && spec.outcome === 'product' && currentApproved(spec))
    );
  });
  const inspection = facts.find(
    f =>
      f.kind === 'inspection_plan' &&
      ['verified', 'founder_confirmed'].includes(f.trust) &&
      (context.inspections ?? []).some(
        i =>
          i.commitmentId === f.payload?.['commitmentId'] &&
          i.checks.length > 0 &&
          i.checks.every(check => check.trim().length > 0) &&
          proformas.some(
            v => v.id === i.proformaVersionId && object(v.content['proformaInvoice'])?.['specVersionId'] === i.specVersionId,
          ) &&
          context.commitments.some(
            c =>
              c.id === i.commitmentId &&
              !c.stale &&
              c.status !== 'cancelled' &&
              Number.isFinite(Date.parse(c.dueAt)) &&
              (c.status !== 'closed' || c.closedEvidenceCurrent === true),
          ),
      ),
  );
  return {
    missing: [...(!proformas.length ? ['artifact:proforma_invoice'] : []), ...(!inspection ? ['commitment:inspection'] : [])],
    evidenceIds: inspection ? [inspection.id] : [],
  };
}

/** The only readiness evaluator; levels are never accepted from a model or client. */
export function deriveReadiness(
  facts: readonly ReadinessFact[],
  decisions: readonly ReadinessDecision[],
  rules: readonly ReadinessRule[] = READINESS_RULES,
  context: ReadinessContext = { artifacts: [], commitments: [] },
): ReadinessResult[] {
  return OUTCOMES.map(outcome => {
    const validFacts = facts.filter(f => f.outcome === outcome && !f.stale && !f.superseded);
    const validDecisions = decisions.filter(d => d.outcome === outcome && d.approved && !d.stale && !d.superseded);
    let level: ReadinessLevel = 0;
    const evidenceIds = new Set<string>();
    const decisionIds = new Set<string>();
    let missing: string[] = [];
    for (const rule of rules.filter(r => r.outcome === outcome).sort((a, b) => a.level - b.level)) {
      const qualifying = validFacts.filter(
        f =>
          (!rule.founderKinds?.includes(f.kind) || f.trust === 'founder_confirmed') &&
          (!rule.highTrust ||
            f.trust === 'verified' ||
            f.trust === 'founder_confirmed' ||
            (f.trust === 'performed' && rule.performedKinds?.includes(f.kind))),
      );
      const absent = [
        ...rule.evidenceKinds.filter(k => !qualifying.some(f => f.kind === k)),
        ...rule.decisionGates.filter(g => !validDecisions.some(d => d.gate === g)).map(g => `decision:${g}`),
      ];
      const ledger =
        rule.ledgerGate === 'sourcing_sequence' ? sourcingSequence(validFacts, validDecisions, context) : { missing: [], evidenceIds: [] };
      absent.push(...ledger.missing);
      if (absent.length) {
        missing = absent;
        break;
      }
      level = rule.level;
      qualifying.filter(f => rule.evidenceKinds.includes(f.kind)).forEach(f => evidenceIds.add(f.id));
      ledger.evidenceIds.forEach(id => evidenceIds.add(id));
      validDecisions.filter(d => rule.decisionGates.includes(d.gate)).forEach(d => decisionIds.add(d.id));
    }
    return {
      outcome,
      level,
      evidenceIds: [...evidenceIds],
      decisionIds: [...decisionIds],
      missing,
      stale: facts.some(f => f.outcome === outcome && f.stale) || decisions.some(d => d.outcome === outcome && d.stale),
    };
  });
}
export interface DependencyEdge {
  upstreamId: string;
  dependentId: string;
}
/** Breadth first, cycle-safe closure includes second and later order dependencies. */
export function calculateImpact(rootId: string, edges: readonly DependencyEdge[]): string[] {
  const seen = new Set([rootId]);
  const queue = [rootId];
  const affected: string[] = [];
  for (let index = 0; index < queue.length; index++)
    for (const edge of edges) {
      if (edge.upstreamId === queue[index] && !seen.has(edge.dependentId)) {
        seen.add(edge.dependentId);
        queue.push(edge.dependentId);
        affected.push(edge.dependentId);
      }
    }
  return affected;
}
