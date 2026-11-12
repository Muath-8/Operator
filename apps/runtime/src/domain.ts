import { z } from 'zod';
import type { Outcome } from '@lo/state';
import { NegotiationBoundsSchema, QuoteSchema, type Quote, type TaskBrief } from './contracts.js';

export function orderWork(tasks: readonly TaskBrief[], readiness: Readonly<Record<Outcome, number>>): TaskBrief[] {
  return [...tasks].sort(
    (a, b) =>
      Number(b.overdueExposure) - Number(a.overdueExposure) ||
      Number(b.unblocks.length >= 2) - Number(a.unblocks.length >= 2) ||
      readiness[a.outcome] - readiness[b.outcome] ||
      Number(b.requestedByFounder) - Number(a.requestedByFounder) ||
      a.id.localeCompare(b.id),
  );
}
export function checkNegotiation(raw: unknown, boundsRaw: unknown): { allowed: boolean; breaches: string[]; missing: string[] } {
  const q = QuoteSchema.parse(raw);
  const b = NegotiationBoundsSchema.parse(boundsRaw);
  const missing = ['currency', 'unitPriceMinor', 'moq', 'leadDays', 'depositPercent'].filter(key => q[key as keyof Quote] === null);
  const breaches: string[] = [];
  if (q.currency !== null && q.currency !== b.currency) breaches.push('currency_requires_normalisation');
  if (q.unitPriceMinor !== null && q.unitPriceMinor > b.maxUnitPriceMinor) breaches.push('unit_price');
  if (q.moq !== null && q.moq > b.maxMoq) breaches.push('moq');
  if (q.leadDays !== null && q.leadDays > b.maxLeadDays) breaches.push('lead_time');
  if (q.depositPercent !== null && q.depositPercent > b.maxDepositPercent) breaches.push('deposit');
  return { allowed: !missing.length && !breaches.length, breaches, missing };
}
export function reconcileDoubleRead(first: unknown, second: unknown): { quote: Quote | null; unconfirmedFields: string[] } {
  const a = QuoteSchema.parse(first);
  const b = QuoteSchema.parse(second);
  const unconfirmedFields = Object.keys(a).filter(key => JSON.stringify(a[key as keyof Quote]) !== JSON.stringify(b[key as keyof Quote]));
  return { quote: unconfirmedFields.length ? null : a, unconfirmedFields };
}
export interface FxRate {
  numerator: number;
  denominator: number;
  source: string;
  observedAt: string;
  from: string;
  to: string;
}
export function convertMinor(amount: number, rate: FxRate): number {
  z.number().int().safe().nonnegative().parse(amount);
  z.object({
    numerator: z.number().int().safe().positive(),
    denominator: z.number().int().safe().positive(),
    source: z.string().min(1),
    observedAt: z.iso.datetime(),
    from: z.string().length(3),
    to: z.string().length(3),
  })
    .strict()
    .parse(rate);
  const numerator = BigInt(amount) * BigInt(rate.numerator);
  const denominator = BigInt(rate.denominator);
  const result = (numerator + denominator / 2n) / denominator;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('validation: converted amount exceeds safe integer');
  return Number(result);
}
export interface CostLine {
  kind: string;
  amountMinor: number;
  currency: string;
  basis: 'estimate' | 'claimed' | 'accepted';
  evidenceId: string;
  estimateMinor?: number;
}
export function calculateEconomics(
  lines: readonly CostLine[],
  priceMinor: number,
  fixedMinor: number,
): { landedMinor: number; grossMargin: number; breakEvenUnits: number | null } {
  z.number().int().safe().positive().parse(priceMinor);
  z.number().int().safe().nonnegative().parse(fixedMinor);
  if (new Set(lines.map(l => l.currency)).size > 1) throw new Error('validation: costs need one currency');
  const landedMinor = lines.reduce((sum, l) => sum + z.number().int().safe().nonnegative().parse(l.amountMinor), 0);
  if (!Number.isSafeInteger(landedMinor)) throw new Error('validation: cost overflow');
  const contribution = priceMinor - landedMinor;
  return {
    landedMinor,
    grossMargin: contribution / priceMinor,
    breakEvenUnits: contribution > 0 ? Math.ceil(fixedMinor / contribution) : null,
  };
}
export function supplierEligible(signals: readonly { independentSource: string; kind: string; verified: boolean }[]): boolean {
  const verified = signals.filter(s => s.verified);
  return (
    new Set(verified.map(s => s.independentSource)).size >= 2 && verified.some(s => ['registry', 'marketplace_history'].includes(s.kind))
  );
}
export const SCORECARD_CRITERIA = [
  'response_speed',
  'language_quality',
  'sample_quality',
  'price',
  'moq_flexibility',
  'on_time_delivery',
  'defect_rate',
  'communication',
] as const;
export function scorecard(
  scores: Partial<Record<(typeof SCORECARD_CRITERIA)[number], { score: number; evidenceId: string; reason: string }>>,
) {
  return SCORECARD_CRITERIA.map(criterion => ({
    criterion,
    observation: scores[criterion] ?? null,
    label: scores[criterion] ? 'observed' : 'not yet observed',
  }));
}
export interface CompatibilityRule {
  left: string;
  right: string;
  relation: 'equal' | 'fits';
  toleranceMm: number;
}
export function checkCompatibility(dimensions: Readonly<Record<string, number>>, rules: readonly CompatibilityRule[]): string[] {
  return rules
    .filter(rule => {
      const left = dimensions[rule.left],
        right = dimensions[rule.right];
      if (left === undefined || right === undefined || !Number.isFinite(left) || !Number.isFinite(right)) return true;
      return rule.relation === 'equal' ? Math.abs(left - right) > rule.toleranceMm : left > right - rule.toleranceMm;
    })
    .map(rule => `${rule.left}:${rule.right}`);
}
