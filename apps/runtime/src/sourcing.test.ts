import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  SourcingQuoteReadingSchema,
  reconcileReadings,
  normalizeReading,
  evaluateSupplierRoute,
  buildScorecard,
  detectMaterialTermChange,
  comparisonBasis,
} from './sourcing.js';

const supplierId = randomUUID(),
  future = new Date(Date.now() + 86400000).toISOString();
const quote = {
  currency: 'SAR',
  unitPriceMinor: 240,
  moq: 500,
  leadDays: 20,
  validUntil: future,
  incoterm: 'FOB' as const,
  depositPercent: 30,
  tiers: [],
  terms: 'Written quotation; subject to approved specification.',
  language: 'en',
  unit: 'unit' as const,
  dimensionsMm: { neck: 20 },
};
const reading = (id: string, q: typeof quote) => ({ extractorId: id, reading: SourcingQuoteReadingSchema.parse(q), failure: null });
const bounds = { currency: 'SAR', maxUnitPriceMinor: 250, maxMoq: 1000, maxLeadDays: 30, maxDepositPercent: 30 };
const spec = {
  sourcingCompatibility: {
    dimensionsMm: { neck: 20 },
    rules: [{ left: 'quote.neck', right: 'spec.neck', relation: 'equal', toleranceMm: 0.1 }],
  },
};
const signals = [
  {
    id: randomUUID(),
    trust: 'verified',
    kind: 'supplier_signal',
    payload: { supplierId, independentSource: 'registry.example', signalKind: 'registry', criterion: 'price' },
  },
  {
    id: randomUUID(),
    trust: 'founder_confirmed',
    kind: 'supplier_signal',
    payload: { supplierId, independentSource: 'inspection.example', signalKind: 'address' },
  },
];
describe('real sourcing workflow contracts (FR-COM-05/06, FR-SUP-02/04/05/09/12, FR-PLY-05)', () => {
  it('matching independent readings remain claimed and missing currency never becomes SAR', () => {
    expect(reconcileReadings(reading('small-1', quote), reading('mid-2', quote))).toMatchObject({ status: 'confirmed_reading', quote });
    const unknown = { ...quote, currency: null };
    const result = reconcileReadings(
      { extractorId: 'a', reading: unknown, failure: null },
      { extractorId: 'b', reading: unknown, failure: null },
    );
    expect(result).toMatchObject({ status: 'needs_clarification', quote: null, missingFields: ['currency'] });
    expect(result.clarification).toContain('currency');
  });
  it('does not let the second reading borrow the first result or hide contradictory terms', () => {
    expect(reconcileReadings(reading('one', quote), reading('two', { ...quote, moq: 3000 }))).toMatchObject({
      status: 'needs_clarification',
      quote: null,
      unconfirmedFields: ['moq'],
    });
    expect(() => reconcileReadings(reading('same', quote), reading('same', quote))).toThrow('independent');
  });
  it('an extractor outage does not become a supplier clarification or successful quote', () => {
    expect(reconcileReadings(reading('one', quote), { extractorId: 'two', reading: null, failure: 'provider_down' })).toEqual({
      status: 'extraction_failed',
      quote: null,
      unconfirmedFields: [],
      missingFields: [],
      clarification: null,
    });
  });
  it('normalizes currency using current correlated source FX and retains the trade/unit basis', () => {
    const fx = {
      id: randomUUID(),
      from_currency: 'USD',
      to_currency: 'SAR',
      numerator: 375,
      denominator: 100,
      source: 'https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx',
      observed_at: new Date(Date.now() - 1000),
      expires_at: new Date(Date.now() + 100000),
    };
    expect(normalizeReading({ ...quote, currency: 'USD' }, 'SAR', fx)).toMatchObject({
      unitPriceMinor: 900,
      currency: 'SAR',
      originalCurrency: 'USD',
      unit: 'unit',
      incoterm: 'FOB',
      fxQuoteId: fx.id,
    });
    expect(() => normalizeReading({ ...quote, currency: 'USD' }, 'SAR', { ...fx, to_currency: 'EUR' })).toThrow('correlated');
    expect(() => normalizeReading({ ...quote, currency: 'USD' }, 'SAR', { ...fx, expires_at: new Date(0) })).toThrow('current');
    expect(() => normalizeReading({ ...quote, validUntil: null }, 'SAR', null)).toThrow('validity');
  });
  it('incompatible dimensions and exceeded negotiated MOQ block the actual shortlist evaluator', () => {
    expect(evaluateSupplierRoute({ quote, bounds, spec, signals, supplierId })).toMatchObject({ eligible: true, trust: 'claimed' });
    const result = evaluateSupplierRoute({ quote: { ...quote, moq: 3000, dimensionsMm: { neck: 22 } }, bounds, spec, signals, supplierId });
    expect(result.eligible).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(['moq', 'component_incompatible']));
    expect(result.requiresFounderDecision).toBe(true);
  });
  it('claimed or foreign supplier evidence cannot verify a shortlist', () => {
    expect(
      evaluateSupplierRoute({ quote, bounds, spec, signals: signals.map(s => ({ ...s, trust: 'claimed' })), supplierId }).reasons,
    ).toContain('supplier_verification_missing');
    expect(evaluateSupplierRoute({ quote, bounds, spec, signals, supplierId: randomUUID() }).eligible).toBe(false);
    expect(evaluateSupplierRoute({ quote, bounds, spec: {}, signals, supplierId }).reasons).toContain(
      'approved_spec_compatibility_missing',
    );
  });
  it('renders all eight evidence-bound criteria and keeps unobserved cells explicit', () => {
    // The static signals fixture above contains its first verified evidence row.
    const cells = buildScorecard(
      [{ criterion: 'price', score: 4, evidenceIds: [signals[0]!.id], reason: 'Claimed price compared on this basis.' }],
      signals,
      supplierId,
    );
    expect(cells).toHaveLength(8);
    expect(cells.filter(c => c.label === 'not yet observed')).toHaveLength(7);
    expect(() =>
      buildScorecard([{ criterion: 'price', score: 4, evidenceIds: [randomUUID()], reason: 'no source' }], signals, supplierId),
    ).toThrow('current supplier evidence');
  });
  it('every changed accepted commercial term produces a material-change signal', () => {
    expect(detectMaterialTermChange(quote, { ...quote, unitPriceMinor: 252 })).toMatchObject({
      needsDecision: true,
      changedFields: ['unitPriceMinor'],
    });
    expect(detectMaterialTermChange(quote, quote).needsDecision).toBe(false);
  });
  it('cannot call unlike units or trade terms a normalized comparable price', () => {
    expect(comparisonBasis([quote, quote]).comparable).toBe(true);
    expect(comparisonBasis([quote, { ...quote, incoterm: 'DDP', unit: 'kg' }])).toMatchObject({
      comparable: false,
      basis: null,
      blockers: ['unit_basis_mismatch', 'incoterm_basis_mismatch'],
    });
  });
});
