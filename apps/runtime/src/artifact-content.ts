import { RegistrationProposalSchema } from '@lo/adapters';
import {
  ProfessionalTermsSchema,
  ProfessionalPaymentSchema,
  ProfessionalDocumentSchema,
  ProfessionalConfirmationSchema,
} from './professional.js';
import { ContentReviewSchema } from './content-review.js';
import { z } from 'zod';
import { JsonObjectSchema, type JsonValue } from '@lo/state';
import { checkCompatibility } from './domain.js';
import { KitSchema } from './contracts.js';
import {
  RfqArtifactSchema,
  SampleOrderSchema,
  CampaignPaymentSchema,
  CampaignCountExceptionSchema,
  CampaignInspectionConfirmationSchema,
} from './sourcing-campaign.js';
import { OptionalStepSchema } from './optional-steps.js';
const text = z.string().trim().min(1),
  ids = z.array(z.uuid()),
  minor = z.number().int().safe().nonnegative();
const fact = z
  .object({
    text,
    trust: z.enum(['planned', 'claimed', 'verified', 'founder_confirmed']),
    evidenceIds: ids,
    source: text,
    observedAt: z.iso.datetime(),
  })
  .strict();
export const LeanCanvasSchema = z
  .object(
    Object.fromEntries(
      [
        'problem',
        'customerSegment',
        'uniqueValueProposition',
        'solution',
        'channels',
        'revenue',
        'costs',
        'keyMetrics',
        'unfairAdvantage',
      ].map(k => [k, fact]),
    ),
  )
  .strict();
const positioning = z.object({ target: text, need: text, category: text, benefit: text, reasonsToBelieve: text }).strict();
const availability = z
  .object({ status: z.enum(['available', 'unavailable', 'unknown']), observedAt: z.iso.datetime(), evidenceIds: ids.min(1) })
  .strict();
const named = z.object({ name: text, domain: availability, handle: availability, trademark: availability }).strict();
const direction = z
  .object({
    id: text,
    name: text,
    positioning: text,
    palette: z.array(z.string().regex(/^#[0-9a-f]{6}$/i)).min(2),
    wordmark: text,
    sourceAssetIds: ids.min(1),
  })
  .passthrough();
const spec = z
  .object({
    kind: text,
    components: z
      .array(
        z
          .object({
            name: text,
            material: text,
            finish: text,
            dimensions: z.record(text, z.number().positive()),
            tolerances: z.record(text, z.number().nonnegative()),
          })
          .strict(),
      )
      .min(1),
    packaging: z.array(text).min(1),
    labels: z.array(text).min(1),
    dims_mm: z.object({ w: z.number().positive(), h: z.number().positive(), d: z.number().positive().optional() }).strict(),
    parts: z.array(JsonObjectSchema).min(1),
    dimensions: z.record(text, z.number().finite()),
    compatibility: z.array(
      z.object({ left: text, right: text, relation: z.enum(['equal', 'fits']), toleranceMm: z.number().nonnegative() }).strict(),
    ),
    sourcingCompatibility: z
      .object({
        dimensionsMm: z.record(text, z.number().positive()),
        rules: z
          .array(z.object({ left: text, right: text, relation: z.enum(['equal', 'fits']), toleranceMm: z.number().nonnegative() }).strict())
          .min(1),
      })
      .strict(),
    specialistWork: z.array(text),
  })
  .passthrough();
const opportunity = z
  .object({
    id: text,
    title: text,
    demand: fact,
    competition: fact,
    unitEconomics: fact,
    regulatoryBurden: fact,
    effort: fact,
    evidenceIds: ids.min(2),
    leanCanvas: LeanCanvasSchema,
  })
  .strict();
const financialPlan = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    envelopes: z
      .array(z.object({ name: text, amountMinor: minor }).strict())
      .min(1)
      .max(20),
    forecastToFirstRestock: z
      .array(
        z
          .object({
            envelope: text,
            amountMinor: minor,
            basis: z.enum(['estimate', 'claimed', 'accepted']),
            evidenceIds: ids,
            quantity: z.number().int().positive().optional(),
            fxQuoteId: z.uuid().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const costAcceptance = z
  .object({
    costLineId: z.uuid(),
    evidenceId: z.uuid().optional(),
    quantity: z.number().int().positive().optional(),
    fxQuoteId: z.uuid().optional(),
  })
  .strict();
const schemas: Record<string, z.ZodType> = {
  domain_registration: z.object({ registration: RegistrationProposalSchema, effectIntent: JsonObjectSchema }).passthrough(),
  professional_engagement: z.object({ professionalEngagement: ProfessionalTermsSchema, payload: JsonObjectSchema }).passthrough(),
  professional_document: z.object({ professionalDocument: ProfessionalDocumentSchema }).passthrough(),
  rfq: RfqArtifactSchema,
  optional_step: z.object({ optionalStep: OptionalStepSchema }).strict(),
  opportunities: z.object({ opportunities: z.array(opportunity).min(5) }).passthrough(),
  lean_canvas: z.object({ leanCanvas: LeanCanvasSchema }).passthrough(),
  mission_goal: z.object({ missionBrief: JsonObjectSchema, leanCanvas: LeanCanvasSchema }).passthrough(),
  brand_directions: z.object({ positioning, names: z.array(named).min(3), directions: z.array(direction).min(3) }).passthrough(),
  brand_assets: z
    .object({
      editableLogoAssetIds: ids,
      logoSvg: z.string().min(1).max(1_000_000).optional(),
      palette: z.array(text).min(2),
      typography: z.array(text).min(1),
      guidelines: text,
      packagingAssetIds: ids.min(1),
      copy: z.record(text, text),
    })
    .passthrough(),
  product_spec: spec,
  founder_kit: KitSchema,
  compliance_checklist: z
    .object({
      market: text,
      category: text,
      reviewStatus: z.enum(['unverified', 'reviewed']),
      items: z
        .array(
          z
            .object({
              id: text,
              requirement: text,
              source: z.url(),
              owner: text,
              status: z.enum(['unverified', 'pending', 'satisfied', 'risk_accepted']),
              evidenceIds: ids,
              professionalRequired: z.boolean(),
            })
            .strict(),
        )
        .min(1),
      prohibitedClaims: z.array(text),
    })
    .passthrough(),
  engagement: z
    .object({
      professionalKind: text,
      brief: text,
      counterpartyId: z.uuid().nullable(),
      deliverables: z.array(text).min(1),
      dueAt: z.iso.datetime(),
      verification: text,
      quoteVersionId: z.uuid().nullable(),
      mode: z.literal('professional'),
    })
    .passthrough(),
  financial_plan: z.object({ financialPlan }).passthrough(),
  accepted_quote: z
    .object({ acceptedQuote: z.object({ quoteId: z.uuid(), specVersionId: z.uuid() }).strict(), costAcceptance: costAcceptance.optional() })
    .strict(),
  cost_acceptance: z.object({ costAcceptance }).strict(),
  supplier_comparison: z
    .object({
      specVersionId: z.uuid(),
      ranking: z.array(z.object({ supplierId: z.uuid(), assessmentId: z.uuid(), rank: z.number().int().positive() }).strict()).min(1),
    })
    .passthrough(),
  pricing: z
    .object({
      pricing: z
        .object({
          currency: z.string().length(3),
          priceMinor: minor.positive(),
          landedCostMinor: minor,
          costs: z
            .array(
              z
                .object({
                  amountMinor: minor,
                  basis: z.enum(['estimate', 'claimed', 'accepted']),
                  evidenceIds: ids,
                  quantity: z.number().int().positive().optional(),
                  fxQuoteId: z.uuid().optional(),
                })
                .strict(),
            )
            .min(1),
          scenarios: z.array(z.object({ priceMinor: minor.positive(), fixedMinor: minor }).strict()).min(2),
        })
        .passthrough(),
    })
    .passthrough(),
  render: z.object({ specVersionId: z.uuid(), identityVersionId: z.uuid(), assetIds: ids.min(1) }).passthrough(),
  note: z.object({ summary: text, paragraphs: z.array(text).min(1) }).passthrough(),
  research: z.object({ summary: text, findings: z.array(fact).min(1) }).passthrough(),
};
const authorityTypes = new Set([
  'payment',
  'mandate',
  'founder_confirmation',
  'closing_record',
  'quotation',
  'supplier_comparison',
  'validation',
  'change_request',
]);
/** Validate semantics before a proposed artifact enters the ledger. This gate
 * never upgrades trust; accepted provider/physical outcomes remain dedicated RPCs. */
export function validateArtifactContent(
  type: string,
  content: Record<string, JsonValue>,
  evidence: ReadonlyMap<string, { trust: string; kind?: string }>,
  marketLanguages: readonly string[] = [],
): void {
  const schema = schemas[type];
  if (schema) schema.parse(content);
  else if (!authorityTypes.has(type)) throw new Error(`validation: unsupported generated artifact type ${type}`);
  if (content.contentReview) ContentReviewSchema.parse(content.contentReview);
  if (content.professionalPayment) ProfessionalPaymentSchema.parse(content.professionalPayment);
  if (content.sampleOrder) SampleOrderSchema.parse(content.sampleOrder);
  if (content.campaignPayment) CampaignPaymentSchema.parse(content.campaignPayment);
  if (content.founderConfirmation) {
    const confirmation = JsonObjectSchema.parse(content.founderConfirmation);
    if (confirmation.kind === 'sourcing_campaign_exception') CampaignCountExceptionSchema.parse(confirmation.payload);
    if (confirmation.kind === 'campaign_inspection_result') CampaignInspectionConfirmationSchema.parse(confirmation.payload);
    if (confirmation.kind === 'owned_resource')
      z.object({
        kind: z.enum(['domain', 'handles']),
        accountId: z.uuid(),
        resource: z.string().trim().min(3).max(253),
        sourceEvidenceIds: z.array(z.uuid()).min(1).max(20),
      })
        .strict()
        .parse(confirmation.payload);
    if (confirmation.kind === 'professional_deliverable_confirmation') ProfessionalConfirmationSchema.parse(confirmation.payload);
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (['claimed', 'verified', 'founder_confirmed', 'performed'].includes(String(record.trust)) && !Array.isArray(record.evidenceIds))
      throw new Error('validation: observed trust requires explicit current evidence references');
    if (Array.isArray(record.evidenceIds)) {
      const references = ids.parse(record.evidenceIds);
      if (references.some(id => !evidence.has(id)))
        throw new Error('validation: artifact content cites absent, stale or cross-mission evidence');
      if (['claimed', 'verified', 'founder_confirmed', 'performed'].includes(String(record.trust)) && !references.length)
        throw new Error('validation: observed fact requires evidence');
      if (record.trust === 'verified' && references.some(id => evidence.get(id)?.trust !== 'verified'))
        throw new Error('validation: generated content cannot upgrade evidence trust');
      if (record.trust === 'founder_confirmed' && references.some(id => evidence.get(id)?.trust !== 'founder_confirmed'))
        throw new Error('validation: founder confirmation requires founder evidence');
      if (record.trust === 'performed' && references.some(id => evidence.get(id)?.trust !== 'performed'))
        throw new Error('validation: performed status requires receipt-backed evidence');
    }
    for (const child of Object.values(record)) visit(child);
  };
  visit(content);
  if (type === 'founder_kit' && content.status === 'verified')
    throw new Error('validation: generated kits cannot assert completed verification; use the dedicated confirmation workflow');
  if (type === 'compliance_checklist') {
    if (content.reviewStatus === 'reviewed') throw new Error('validation: generated guidance cannot assert human review');
    for (const item of z.array(JsonObjectSchema).parse(content.items))
      if (['satisfied', 'risk_accepted'].includes(String(item.status))) {
        const refs = ids.min(1).parse(item.evidenceIds);
        if (
          refs.some(id => !['verified', 'founder_confirmed'].includes(evidence.get(id)?.trust ?? '')) ||
          (item.status === 'risk_accepted' &&
            refs.some(id => evidence.get(id)?.trust !== 'founder_confirmed' || evidence.get(id)?.kind !== 'risk_acceptance'))
        )
          throw new Error('validation: compliance resolution requires current dedicated evidence');
      }
  }
  if (type === 'product_spec') {
    const parsed = spec.parse(content);
    if (checkCompatibility(parsed.dimensions, parsed.compatibility).length)
      throw new Error('validation: incompatible component interfaces require revision');
  }
  if (type === 'brand_assets') {
    if (!z.array(z.uuid()).parse(content.editableLogoAssetIds).length && !content.logoSvg)
      throw new Error('validation: editable vector source required');
    const copy = z.record(text, text).parse(content.copy);
    if (marketLanguages.some(lang => !copy[lang])) throw new Error('validation: asset package lacks required market-language copy');
  }
  if (type === 'pricing') {
    const pricing = JsonObjectSchema.parse(content.pricing),
      costs = z.array(z.object({ amountMinor: minor })).parse(pricing.costs);
    if (costs.reduce((n, c) => n + c.amountMinor, 0) !== pricing.landedCostMinor)
      throw new Error('validation: landed cost does not equal its lines');
  }
  if (type === 'financial_plan') {
    const plan = financialPlan.parse(content.financialPlan);
    if (
      new Set(plan.envelopes.map(e => e.name)).size !== plan.envelopes.length ||
      plan.forecastToFirstRestock.some(f => !plan.envelopes.some(e => e.name === f.envelope))
    )
      throw new Error('validation: financial plan envelope references do not reconcile');
  }
}
