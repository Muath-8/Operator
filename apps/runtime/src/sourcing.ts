import { z } from 'zod';
import { JsonObjectSchema, type JsonValue } from '@lo/state';
import { withRole, type ActorScope } from './database.js';
import { QuoteSchema, NegotiationBoundsSchema } from './contracts.js';
import { checkCompatibility, checkNegotiation, SCORECARD_CRITERIA } from './domain.js';
import { contentHash } from './security.js';
import { conservativeConvertedMinor } from '@lo/adapters';

/** Integration contract (COM05/06, SUP02/04/05/09/12, PLY04/05):
 * - Root supplies two separately checkpointed, tool-less extractors with distinct configured IDs.
 *   Both receive only the same untrusted source; neither receives the other's answer.
 * - ingestion is append-only and keyed by real inbound supplier message + explicit attemptKey.
 *   Matching readings are CLAIMED, never verification. Failure/disagreement/missing terms block use.
 * - Root feeds clarification/material-change signals to the Lead; this module sends nothing,
 *   changes no approval, pays nothing and never writes readiness.
 * - Route assessment reads a CURRENT APPROVED product spec, current negotiation mandate and
 *   current scoped evidence from SQL. Compatibility rules come from the approved spec, not the model.
 * - Normalization changes currency only using a persisted current SAMA quote; unit/Incoterm
 *   differences remain explicit blockers rather than invented freight or unit conversions.
 */
export const SourcingQuoteReadingSchema = QuoteSchema.omit({ supplierId: true, sourceEvidenceId: true })
  .extend({
    terms: z.string().max(12000),
    language: z.string().min(2).max(20),
    unit: z.enum(['unit', 'set', 'kg', 'litre']).nullable(),
    dimensionsMm: z.record(z.string().min(1), z.number().finite().positive()).nullable(),
  })
  .strict();
export type SourcingQuoteReading = z.infer<typeof SourcingQuoteReadingSchema>;
const OutcomeSchema = z
  .object({
    extractorId: z.string().min(1).max(200),
    reading: SourcingQuoteReadingSchema.nullable(),
    failure: z.enum(['provider_down', 'schema_invalid']).nullable(),
  })
  .strict()
  .refine(v => (v.reading === null) === (v.failure !== null), 'Reading or explicit failure is required');
type ReadingOutcome = z.infer<typeof OutcomeSchema>;
export interface QuoteSource {
  messageId: string;
  text: string;
  supplierId: string;
  sourceLanguage: string;
}
export interface QuoteExtractor {
  id: string;
  extract(source: Readonly<QuoteSource>): Promise<unknown>;
}
export interface ReconciledQuote {
  status: 'confirmed_reading' | 'needs_clarification' | 'extraction_failed';
  quote: SourcingQuoteReading | null;
  unconfirmedFields: string[];
  missingFields: string[];
  clarification: string | null;
}
const REQUIRED_TERMS = ['currency', 'unitPriceMinor', 'moq', 'leadDays', 'validUntil', 'incoterm', 'depositPercent', 'unit'] as const;
export function reconcileReadings(first: ReadingOutcome, second: ReadingOutcome): ReconciledQuote {
  const a = OutcomeSchema.parse(first),
    b = OutcomeSchema.parse(second);
  if (a.extractorId === b.extractorId) throw new Error('validation: independent extractor IDs required');
  if (!a.reading || !b.reading)
    return { status: 'extraction_failed', quote: null, unconfirmedFields: [], missingFields: [], clarification: null };
  const unconfirmedFields = Object.keys(a.reading).filter(
    key => contentHash(a.reading?.[key as keyof SourcingQuoteReading]) !== contentHash(b.reading?.[key as keyof SourcingQuoteReading]),
  );
  const missingFields: string[] = REQUIRED_TERMS.filter(key => a.reading?.[key] === null || b.reading?.[key] === null);
  if (!a.reading.terms.trim() || !b.reading.terms.trim()) missingFields.push('terms');
  const fields = [...new Set([...unconfirmedFields, ...missingFields])];
  if (fields.length)
    return {
      status: 'needs_clarification',
      quote: null,
      unconfirmedFields,
      missingFields,
      clarification: `Please confirm the quotation's ${fields.join(', ')} in writing. No missing or contradictory term has been assumed.`,
    };
  return { status: 'confirmed_reading', quote: a.reading, unconfirmedFields: [], missingFields: [], clarification: null };
}
const StoredSchema = z
  .object({
    id: z.uuid(),
    messageId: z.uuid(),
    supplierId: z.uuid(),
    sourceEvidenceId: z.uuid(),
    status: z.enum(['confirmed_reading', 'needs_clarification', 'extraction_failed']),
    quote: SourcingQuoteReadingSchema.nullable(),
    unconfirmedFields: z.array(z.string()),
    missingFields: z.array(z.string()),
    clarification: z.string().nullable(),
  })
  .strict();
export type StoredQuote = z.infer<typeof StoredSchema>;
function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
const sourceSchema = z
  .object({ messageId: z.uuid(), supplierId: z.uuid(), text: z.string().min(1).max(60000), sourceLanguage: z.string().min(2) })
  .strict();
export async function ingestQuote(
  scope: ActorScope,
  input: { messageId: string; first: QuoteExtractor; second: QuoteExtractor; attemptKey?: string },
): Promise<StoredQuote> {
  const messageId = z.uuid().parse(input.messageId);
  const ids = [input.first.id, input.second.id].map(id => z.string().min(1).max(200).parse(id));
  if (ids[0] === ids[1]) throw new Error('validation: independent extractor IDs required');
  const key = z
    .string()
    .min(1)
    .max(256)
    .parse(input.attemptKey ?? contentHash(ids));
  const loaded = await withRole('specialist_role', scope, async db => {
    const source = (await db.query('select public.sourcing_message_source($1,$2) value', [scope.missionId, messageId])).rows[0]?.value;
    const previous = (
      await db.query(
        'select public.sourcing_quote_result(id) value from public.sourcing_quote_ingestions where mission_id=$1 and message_id=$2 and attempt_key=$3',
        [scope.missionId, messageId, key],
      )
    ).rows[0]?.value;
    if (previous) {
      const previousQuote = StoredSchema.parse(previous);
      const readers = (
        await db.query('select extractor_id from public.sourcing_quote_readings where ingestion_id=$1 order by ordinal', [previousQuote.id])
      ).rows.map(row => String(row.extractor_id));
      if (JSON.stringify(readers) !== JSON.stringify(ids))
        throw new Error('invariant_violation: quote attempt extractor configuration changed');
    }
    return { source: sourceSchema.parse(source), previous: previous ? StoredSchema.parse(previous) : null };
  });
  if (loaded.previous) return loaded.previous;
  const read = async (extractor: QuoteExtractor): Promise<ReadingOutcome> => {
    let raw: unknown;
    try {
      raw = await extractor.extract(Object.freeze({ ...loaded.source }));
    } catch {
      return { extractorId: extractor.id, reading: null, failure: 'provider_down' };
    }
    const parsed = SourcingQuoteReadingSchema.safeParse(raw);
    return parsed.success
      ? { extractorId: extractor.id, reading: parsed.data, failure: null }
      : { extractorId: extractor.id, reading: null, failure: 'schema_invalid' };
  };
  const [first, second] = await Promise.all([read(input.first), read(input.second)]);
  // SQL independently reconciles the two outcomes; no caller-supplied successful status is accepted.
  return withRole('specialist_role', scope, async db =>
    StoredSchema.parse(
      (
        await db.query('select public.record_sourcing_readings($1,$2,$3,$4,$5) value', [
          scope.missionId,
          messageId,
          key,
          json(first),
          json(second),
        ])
      ).rows[0]?.value,
    ),
  );
}

const FxSchema = z
  .object({
    id: z.uuid(),
    from_currency: z.string().length(3),
    to_currency: z.string().length(3),
    numerator: z.coerce.number().int().positive().safe(),
    denominator: z.coerce.number().int().positive().safe(),
    source: z.literal('https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx'),
    observed_at: z.coerce.date(),
    expires_at: z.coerce.date(),
  })
  .passthrough();
export function normalizeReading(quote: SourcingQuoteReading, targetCurrency: string, fx: unknown, now = new Date()) {
  const q = SourcingQuoteReadingSchema.parse(quote);
  z.string()
    .regex(/^[A-Z]{3}$/)
    .parse(targetCurrency);
  if (q.currency === null || q.unitPriceMinor === null || q.unit === null || q.incoterm === null)
    throw new Error('validation: complete quote basis required');
  if (q.validUntil === null || Date.parse(q.validUntil) <= now.getTime())
    throw new Error('validation: quotation validity missing or expired');
  if (q.currency === targetCurrency)
    return {
      ...q,
      currency: targetCurrency,
      originalCurrency: q.currency,
      originalUnitPriceMinor: q.unitPriceMinor,
      fxQuoteId: null,
      fxSource: null,
      fxObservedAt: null,
    };
  const rate = FxSchema.parse(fx);
  if (rate.from_currency !== q.currency || rate.to_currency !== targetCurrency || rate.observed_at > now || rate.expires_at <= now)
    throw new Error('validation: current correlated source FX required');
  return {
    ...q,
    currency: targetCurrency,
    unitPriceMinor: conservativeConvertedMinor(q.unitPriceMinor, rate.numerator, rate.denominator),
    tiers: q.tiers.map(t => ({ ...t, unitPriceMinor: conservativeConvertedMinor(t.unitPriceMinor, rate.numerator, rate.denominator) })),
    originalCurrency: q.currency,
    originalUnitPriceMinor: q.unitPriceMinor,
    fxQuoteId: rate.id,
    fxSource: rate.source,
    fxObservedAt: rate.observed_at.toISOString(),
  };
}
export async function normalizeQuote(scope: ActorScope, input: { quoteId: string; targetCurrency: string; fxQuoteId?: string }) {
  return withRole('specialist_role', scope, async db => {
    const quote = StoredSchema.parse(
      (await db.query('select public.sourcing_quote_result($1) value', [z.uuid().parse(input.quoteId)])).rows[0]?.value,
    );
    if (quote.status !== 'confirmed_reading' || !quote.quote) throw new Error('validation: unconfirmed quote cannot be normalized');
    const fx = input.fxQuoteId
      ? (await db.query('select *from public.fx_quotes where mission_id=$1 and id=$2', [scope.missionId, z.uuid().parse(input.fxQuoteId)]))
          .rows[0]
      : null;
    return {
      ...normalizeReading(quote.quote, input.targetCurrency, fx),
      supplierId: quote.supplierId,
      sourceEvidenceId: quote.sourceEvidenceId,
    };
  });
}

/** Call before presenting normalized prices as a single comparable basis. Changing Incoterm or
 * physical units requires additional sourced cost/spec data; a currency rate cannot do that work. */
export function comparisonBasis(raw: unknown) {
  const rows = z
    .array(
      z
        .object({
          currency: z.string().regex(/^[A-Z]{3}$/),
          unit: z.enum(['unit', 'set', 'kg', 'litre']),
          incoterm: z.enum(['EXW', 'FOB', 'CIF', 'DAP', 'DDP']),
        })
        .passthrough(),
    )
    .min(2)
    .parse(raw);
  const blockers = (['currency', 'unit', 'incoterm'] as const)
    .filter(key => new Set(rows.map(row => row[key])).size !== 1)
    .map(key => `${key}_basis_mismatch`);
  const first = rows[0];
  if (!first) throw new Error('validation: at least two comparable quotes are required');
  return {
    comparable: blockers.length === 0,
    blockers,
    basis: blockers.length ? null : { currency: first.currency, unit: first.unit, incoterm: first.incoterm },
    note: 'Quoted unit-price basis only. Landed freight, duties, taxes and fees require their own sourced lines.',
  };
}

const CompatibilitySchema = z
  .object({
    dimensionsMm: z.record(z.string(), z.number().finite().positive()),
    rules: z.array(
      z
        .object({
          left: z.string().min(1),
          right: z.string().min(1),
          relation: z.enum(['equal', 'fits']),
          toleranceMm: z.number().finite().nonnegative(),
        })
        .strict(),
    ),
  })
  .strict();
const SignalSchema = z
  .object({
    id: z.uuid(),
    trust: z.enum(['claimed', 'verified', 'founder_confirmed', 'planned', 'performed']),
    kind: z.string(),
    payload: JsonObjectSchema,
  })
  .passthrough();
export function evaluateSupplierRoute(input: {
  quote: SourcingQuoteReading;
  bounds: unknown;
  spec: unknown;
  signals: unknown[];
  supplierId: string;
  now?: Date;
}) {
  const quote = SourcingQuoteReadingSchema.parse(input.quote),
    bounds = NegotiationBoundsSchema.parse(input.bounds);
  const { unit: _unit, dimensionsMm: _dimensions, ...terms } = quote;
  const negotiation = checkNegotiation(
    { ...terms, supplierId: input.supplierId, sourceEvidenceId: '00000000-0000-4000-8000-000000000001' },
    bounds,
  );
  const reasons = [...negotiation.breaches, ...negotiation.missing];
  if (!quote.validUntil || Date.parse(quote.validUntil) <= (input.now ?? new Date()).getTime()) reasons.push('quote_expired_or_undated');
  const signals = z
    .array(SignalSchema)
    .parse(input.signals)
    .filter(
      s =>
        ['verified', 'founder_confirmed'].includes(s.trust) &&
        s.payload['supplierId'] === input.supplierId &&
        typeof s.payload['independentSource'] === 'string' &&
        typeof s.payload['signalKind'] === 'string',
    );
  if (
    new Set(signals.map(s => String(s.payload['independentSource']))).size < 2 ||
    !signals.some(s => ['registry', 'marketplace_history'].includes(String(s.payload['signalKind'])))
  )
    reasons.push('supplier_verification_missing');
  const spec = JsonObjectSchema.parse(input.spec),
    compatibility = CompatibilitySchema.safeParse(spec['sourcingCompatibility']);
  let incompatible: string[] = [];
  if (!compatibility.success) reasons.push('approved_spec_compatibility_missing');
  else {
    const dimensions = Object.fromEntries([
      ...Object.entries(compatibility.data.dimensionsMm).map(([k, v]) => [`spec.${k}`, v]),
      ...Object.entries(quote.dimensionsMm ?? {}).map(([k, v]) => [`quote.${k}`, v]),
    ]);
    incompatible = checkCompatibility(dimensions, compatibility.data.rules);
    if (incompatible.length) reasons.push('component_incompatible');
  }
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    incompatible,
    verificationEvidenceIds: signals.map(s => s.id),
    requiresFounderDecision: negotiation.breaches.length > 0,
    trust: 'claimed' as const,
  };
}
export async function assessQuoteRoute(
  scope: ActorScope,
  input: { quoteId: string; specVersionId: string; negotiationMandateId: string; fxQuoteId?: string },
) {
  return withRole('specialist_role', scope, async db => {
    const context = JsonObjectSchema.parse(
      (
        await db.query('select public.sourcing_route_context($1,$2,$3,$4) value', [
          scope.missionId,
          z.uuid().parse(input.quoteId),
          z.uuid().parse(input.specVersionId),
          z.uuid().parse(input.negotiationMandateId),
        ])
      ).rows[0]?.value,
    );
    const stored = StoredSchema.parse(context['quote']);
    if (!stored.quote || stored.status !== 'confirmed_reading') throw new Error('validation: quote needs clarification');
    const bounds = NegotiationBoundsSchema.parse(context['bounds']);
    const fx = input.fxQuoteId
      ? (await db.query('select *from public.fx_quotes where mission_id=$1 and id=$2', [scope.missionId, z.uuid().parse(input.fxQuoteId)]))
          .rows[0]
      : null;
    const normalized = normalizeReading(stored.quote, bounds.currency, fx);
    const assessment = {
      ...evaluateSupplierRoute({
        quote: { ...stored.quote, currency: normalized.currency, unitPriceMinor: normalized.unitPriceMinor, tiers: normalized.tiers },
        bounds,
        spec: context['spec'],
        signals: z.array(z.unknown()).parse(context['evidence']),
        supplierId: stored.supplierId,
      }),
      fxQuoteId: normalized.fxQuoteId,
    };
    const id = z
      .uuid()
      .parse(
        (
          await db.query('select public.record_sourcing_assessment($1,$2,$3,$4,$5) id', [
            scope.missionId,
            input.quoteId,
            input.specVersionId,
            input.negotiationMandateId,
            json(assessment),
          ])
        ).rows[0]?.id,
      );
    return { id, ...assessment, specVersionId: input.specVersionId, quoteId: input.quoteId };
  });
}

const CriterionSchema = z.enum(SCORECARD_CRITERIA);
const ObservationSchema = z
  .object({
    criterion: CriterionSchema,
    score: z.number().finite().min(0).max(5),
    evidenceIds: z.array(z.uuid()).min(1),
    reason: z.string().trim().min(1),
  })
  .strict();
export function buildScorecard(observations: unknown, evidence: unknown[], supplierId: string) {
  const list = z.array(ObservationSchema).parse(observations),
    facts = z.array(SignalSchema).parse(evidence);
  if (new Set(list.map(o => o.criterion)).size !== list.length) throw new Error('validation: duplicate score criterion');
  for (const observation of list)
    for (const id of observation.evidenceIds)
      if (
        !facts.some(
          e =>
            e.id === id &&
            e.trust !== 'planned' &&
            e.payload['supplierId'] === supplierId &&
            (e.payload['criterion'] === observation.criterion ||
              (observation.criterion === 'price' &&
                e.kind === 'supplier_quote' &&
                typeof JsonObjectSchema.parse(e.payload['terms'] ?? {})['unitPriceMinor'] === 'number')),
        )
      )
        throw new Error('validation: score lacks current supplier evidence for this criterion');
  return SCORECARD_CRITERIA.map(criterion => ({
    criterion,
    observation: list.find(o => o.criterion === criterion) ?? null,
    label: list.some(o => o.criterion === criterion) ? 'observed' : 'not yet observed',
  }));
}
export async function recordScorecard(scope: ActorScope, input: { quoteId: string; specVersionId: string; observations: unknown }) {
  return withRole('specialist_role', scope, async db => {
    const context = JsonObjectSchema.parse(
        (
          await db.query('select public.sourcing_route_context($1,$2,$3,null) value', [
            scope.missionId,
            z.uuid().parse(input.quoteId),
            z.uuid().parse(input.specVersionId),
          ])
        ).rows[0]?.value,
      ),
      stored = StoredSchema.parse(context['quote']);
    const cells = buildScorecard(input.observations, z.array(z.unknown()).parse(context['evidence']), stored.supplierId);
    const id = z
      .uuid()
      .parse(
        (
          await db.query('select public.record_sourcing_assessment($1,$2,$3,null,$4) id', [
            scope.missionId,
            input.quoteId,
            input.specVersionId,
            json({ kind: 'scorecard', cells }),
          ])
        ).rows[0]?.id,
      );
    return { id, cells, quoteId: input.quoteId, specVersionId: input.specVersionId };
  });
}
export function detectMaterialTermChange(accepted: SourcingQuoteReading, proposed: SourcingQuoteReading) {
  const before = SourcingQuoteReadingSchema.parse(accepted),
    after = SourcingQuoteReadingSchema.parse(proposed);
  const fields = Object.keys(before).filter(
    k => contentHash(before[k as keyof SourcingQuoteReading]) !== contentHash(after[k as keyof SourcingQuoteReading]),
  );
  return {
    needsDecision: fields.length > 0,
    changedFields: fields,
    before,
    after,
    reason: fields.length ? 'Accepted terms changed; obtain a specific founder decision before commitment.' : null,
  };
}

/** Accepted quote provenance is frozen in an approved artifact's `{acceptedQuote:{quoteId}}`.
 * SQL checks its selected approval and dependency edge, computes every changed field itself,
 * and emits a durable Lead event. A model cannot silently accept the proposed replacement.
 */
export async function flagAcceptedTermChange(scope: ActorScope, input: { acceptedVersionId: string; quoteId: string }) {
  return withRole('specialist_role', scope, async db =>
    z
      .object({
        id: z.uuid(),
        needsDecision: z.boolean(),
        changedFields: z.array(z.string()),
        acceptedVersionId: z.uuid(),
        quoteId: z.uuid(),
      })
      .strict()
      .parse(
        (
          await db.query('select public.flag_sourcing_term_change($1,$2,$3) value', [
            scope.missionId,
            z.uuid().parse(input.acceptedVersionId),
            z.uuid().parse(input.quoteId),
          ])
        ).rows[0]?.value,
      ),
  );
}
