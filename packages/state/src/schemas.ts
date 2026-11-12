import { z } from 'zod';

export const SchemaVersion = 1 as const;
export const IdSchema = z.uuid();
export const OutcomeSchema = z.enum(['brand', 'product', 'supply', 'commerce', 'compliance', 'demand']);
export type Outcome = z.infer<typeof OutcomeSchema>;
export const OUTCOMES = OutcomeSchema.options;
export const TrustLevelSchema = z.enum(['planned', 'performed', 'claimed', 'verified', 'founder_confirmed']);
export type TrustLevel = z.infer<typeof TrustLevelSchema>;
export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);
export const MinorUnitsSchema = z.number().int().safe().nonnegative();
export const MoneySchema = z.object({ amountMinor: MinorUnitsSchema, currency: CurrencySchema }).strict();
export type Money = z.infer<typeof MoneySchema>;
export const ErrorCodeSchema = z.enum([
  'provider_down',
  'rejected',
  'rate_limited',
  'window_closed',
  'needs_approval',
  'invariant_violation',
  'validation',
]);
export const TypedErrorSchema = z
  .object({ code: ErrorCodeSchema, message: z.string(), retryable: z.boolean(), retryAt: z.iso.datetime().optional() })
  .strict();
export type TypedError = z.infer<typeof TypedErrorSchema>;
export type Result<T> = { ok: true; value: T } | { ok: false; error: TypedError };
export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export const JsonObjectSchema = z.record(z.string(), JsonValueSchema);

export const DecisionOptionSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    evidenceIds: z.array(IdSchema),
    artifactVersionIds: z.array(IdSchema).optional(),
    cost: MoneySchema.nullable(),
    timeDays: z.number().int().nonnegative(),
    consequences: z.string().min(1),
  })
  .strict();
export const DecisionPacketSchema = z
  .object({
    question: z.string().min(1),
    options: z.array(DecisionOptionSchema).min(1).max(4),
    recommendation: z.object({ optionId: z.string(), reasons: z.array(z.string().min(1)).min(1) }).strict(),
    staleImpact: z.array(IdSchema),
    defaultIfNoAnswer: z.object({ optionId: z.string(), at: z.iso.datetime().nullable(), binding: z.boolean() }).strict(),
    approvedVersionIds: z.array(IdSchema).optional(),
    impact: z
      .object({
        decisionIds: z.array(IdSchema),
        artifactIds: z.array(IdSchema),
        commitmentIds: z.array(IdSchema),
        outcomes: z.array(OutcomeSchema),
        cost: MoneySchema.nullable(),
        delayDays: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((packet, ctx) => {
    const ids = new Set(packet.options.map(option => option.id));
    if (ids.size !== packet.options.length || !ids.has(packet.recommendation.optionId) || !ids.has(packet.defaultIfNoAnswer.optionId))
      ctx.addIssue({ code: 'custom', message: 'Options must be unique and recommendation/default must name an option' });
    if (packet.defaultIfNoAnswer.binding && packet.defaultIfNoAnswer.at !== null)
      ctx.addIssue({ code: 'custom', message: 'Binding decisions cannot auto-resolve' });
    if (packet.options.some(option => option.artifactVersionIds?.some(ref => !packet.approvedVersionIds?.includes(ref))))
      ctx.addIssue({ code: 'custom', message: 'Selected option artifact versions must be included in the frozen packet references' });
  });
export type DecisionPacket = z.infer<typeof DecisionPacketSchema>;
export const DecisionSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    kind: z.enum(['goal', 'constraint', 'selection', 'mandate', 'engagement', 'change', 'terminal']),
    outcome: OutcomeSchema.nullable(),
    gate: z.string().nullable(),
    packet: DecisionPacketSchema,
    evidenceIds: z.array(IdSchema),
    approvedVersionIds: z.array(IdSchema),
    supersedesId: IdSchema.nullable(),
    createdAt: z.iso.datetime(),
    actorId: IdSchema,
  })
  .strict();
export type Decision = z.infer<typeof DecisionSchema>;
export const MissionSchema = z
  .object({
    id: IdSchema,
    founderId: IdSchema,
    type: z.enum(['discover', 'launch']),
    status: z.enum(['active', 'paused', 'ended']),
    goalBrief: z.string(),
    currency: CurrencySchema,
    sandboxMode: z.boolean(),
    involvement: z.enum(['guide', 'do', 'help']),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type Mission = z.infer<typeof MissionSchema>;
export const EvidenceSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    outcome: OutcomeSchema.nullable(),
    kind: z.string().min(1),
    trust: TrustLevelSchema,
    payload: JsonObjectSchema,
    source: z
      .object({ type: z.enum(['url', 'message', 'receipt', 'founder', 'document', 'event', 'poll']), reference: z.string().min(1) })
      .strict(),
    providerReceiptId: IdSchema.nullable(),
    supersedesId: IdSchema.nullable(),
    sandboxMode: z.boolean(),
    createdAt: z.iso.datetime(),
    actorId: IdSchema,
  })
  .strict()
  .superRefine((e, ctx) => {
    if (e.trust === 'performed' && !e.providerReceiptId)
      ctx.addIssue({ code: 'custom', message: 'Performed evidence requires a provider receipt' });
  });
export type Evidence = z.infer<typeof EvidenceSchema>;
export const ArtifactVersionSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    artifactId: IdSchema,
    versionNo: z.number().int().positive(),
    content: JsonObjectSchema,
    fileRefs: z.array(z.string()),
    derivedFrom: z.array(IdSchema),
    decisionRefs: z.array(IdSchema),
    evidenceRefs: z.array(IdSchema),
    variationRequest: z.string().nullable(),
    createdByRunId: IdSchema.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;
export const ApprovalBindingSchema = z
  .object({
    action: z.string().min(1),
    counterpartyId: IdSchema,
    amountMinor: MinorUnitsSchema.nullable(),
    currency: CurrencySchema.nullable(),
    artifactVersionId: IdSchema.nullable(),
  })
  .strict();
export type ApprovalBinding = z.infer<typeof ApprovalBindingSchema>;
export const EffectIntentSchema = z
  .object({
    missionId: IdSchema,
    taskId: z.string().min(1),
    action: z.string().min(1),
    effectClass: z.enum(['communicate', 'spend', 'publish', 'bind']),
    counterpartyId: IdSchema,
    amountMinor: MinorUnitsSchema.optional(),
    currency: CurrencySchema.optional(),
    artifactVersionId: IdSchema.optional(),
    idempotencyKey: z.string().min(16).max(256),
    mode: z.enum(['guide', 'do', 'help']),
    sandboxMode: z.boolean(),
    mandateId: IdSchema.optional(),
    approvalToken: z.string().min(32).optional(),
    channel: z.string().optional(),
    purpose: z.string().optional(),
    instrumentId: IdSchema.optional(),
    newContact: z.boolean().default(false),
  })
  .strict()
  .superRefine((intent, ctx) => {
    if (
      intent.effectClass === 'spend' &&
      (intent.amountMinor === undefined ||
        intent.currency === undefined ||
        intent.artifactVersionId === undefined ||
        intent.instrumentId === undefined)
    )
      ctx.addIssue({ code: 'custom', message: 'Spend requires amount, currency, artifact version and founder instrument' });
  });
export type EffectIntent = z.infer<typeof EffectIntentSchema>;
export const ProviderReceiptSchema = z
  .object({
    provider: z.string().min(1),
    providerReference: z.string().min(1),
    operation: z.string().min(1),
    sandboxMode: z.boolean(),
    data: JsonObjectSchema,
  })
  .strict();
export type ProviderReceipt = z.infer<typeof ProviderReceiptSchema>;
export const AuthorizationSchema = z
  .object({
    authorizationId: IdSchema,
    status: z.enum(['reserved', 'started', 'performed', 'failed', 'ambiguous']),
    replay: z.boolean(),
    receiptId: IdSchema.optional(),
  })
  .strict();
export type Authorization = z.infer<typeof AuthorizationSchema>;
export const MandateScopeSchema = z
  .object({
    actions: z.array(z.string()).min(1),
    effectClasses: z.array(z.enum(['communicate', 'spend', 'publish', 'bind'])).min(1),
    counterpartyIds: z.array(IdSchema).min(1),
    channels: z.array(z.string()),
    purposes: z.array(z.string()),
    instrumentIds: z.array(IdSchema),
    maxNewContacts: z.number().int().nonnegative(),
    maxActions: z.number().int().safe().positive().optional(),
  })
  .strict();
export type MandateScope = z.infer<typeof MandateScopeSchema>;
export const LedgerEventSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    type: z.string().min(1),
    payload: JsonObjectSchema,
    provider: z.string().nullable(),
    providerEventId: z.string().nullable(),
    receivedAt: z.iso.datetime(),
  })
  .strict();
export type LedgerEvent = z.infer<typeof LedgerEventSchema>;
