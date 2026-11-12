import { z } from 'zod';
import { IdSchema, OutcomeSchema, JsonObjectSchema, DecisionPacketSchema, CurrencySchema, MinorUnitsSchema } from '@lo/state';

export const RoleSchema = z.enum([
  'lead',
  'research',
  'brand',
  'product',
  'sourcing',
  'commerce',
  'compliance',
  'finance',
  'operations',
  'reviewer',
  'extraction',
  'voice',
]);
export type Role = z.infer<typeof RoleSchema>;
export const TierSchema = z.enum(['frontier', 'mid', 'small', 'realtime']);
export const TaskBriefSchema = z
  .object({
    id: IdSchema,
    missionId: IdSchema,
    role: RoleSchema,
    outcome: OutcomeSchema,
    objective: z.string().min(1),
    constraints: z.array(z.string()),
    budgetAuthority: z.array(IdSchema),
    deadline: z.iso.datetime(),
    doneCriteria: z.array(z.string().min(1)).min(1),
    evidenceRequired: z.array(z.string()).min(1),
    playbook: z.object({ id: z.string().min(1), version: z.number().int().positive(), step: z.string().min(1), source: z.url() }).strict(),
    maxToolCalls: z.number().int().min(1).max(40),
    maxTokens: z.number().int().min(256).max(40000),
    tier: TierSchema,
    requestedByFounder: z.boolean(),
    overdueExposure: z.boolean(),
    unblocks: z.array(OutcomeSchema),
    parentRunId: IdSchema.nullable(),
  })
  .strict();
export type TaskBrief = z.infer<typeof TaskBriefSchema>;
export const SourcedFigureSchema = z
  .object({
    value: z.number().finite(),
    unit: z.string().min(1),
    evidenceId: IdSchema,
    trust: z.enum(['planned', 'claimed', 'verified', 'founder_confirmed']),
    source: z.string().min(1),
    observedAt: z.iso.datetime(),
  })
  .strict();
export const UntrustedDataSchema = z
  .object({
    provenance: z.object({ evidenceId: IdSchema, source: z.string().min(1), receivedAt: z.iso.datetime() }).strict(),
    content: z.string().max(60000),
    classification: z.literal('untrusted_data'),
  })
  .strict();
export const ArtifactOutputSchema = z
  .object({
    artifactId: IdSchema.nullable(),
    type: z.string().min(1),
    title: z.string().min(1),
    outcome: OutcomeSchema,
    content: JsonObjectSchema,
    evidenceIds: z.array(IdSchema),
    derivedFrom: z.array(IdSchema),
    decisionRefs: z.array(IdSchema),
    variationRequest: z.string().nullable(),
  })
  .strict();
export const CommitmentOutputSchema = z
  .object({
    party: z.string().min(1),
    direction: z.enum(['owed_to_us', 'owed_by_us']),
    description: z.string().min(1),
    dueAt: z.iso.datetime(),
    evidenceIds: z.array(IdSchema),
    inspection: z
      .object({ proformaVersionId: IdSchema, checks: z.array(z.string().min(1)).min(1) })
      .strict()
      .optional(),
  })
  .strict();
export const RunResultSchema = z
  .object({
    artifacts: z.array(ArtifactOutputSchema),
    evidence: z.array(
      z
        .object({
          outcome: OutcomeSchema,
          kind: z.string().min(1),
          trust: z.enum(['planned', 'claimed']),
          payload: JsonObjectSchema,
          sourceEvidenceIds: z.array(IdSchema).min(1),
        })
        .strict(),
    ),
    commitments: z.array(CommitmentOutputSchema),
    questions: z.array(z.object({ question: z.string().min(1), recommendedDefault: z.string().min(1), blocking: z.boolean() }).strict()),
    selfAssessment: z
      .object({
        complete: z.boolean(),
        criteria: z.array(z.object({ criterion: z.string(), met: z.boolean(), evidenceIds: z.array(IdSchema) }).strict()).min(1),
        gaps: z.array(z.string()),
      })
      .strict(),
  })
  .strict();
export type RunResult = z.infer<typeof RunResultSchema>;
export const PlanDeltaSchema = z
  .object({
    questions: z
      .array(
        z
          .object({
            question: z.string().min(1),
            recommendedDefault: z.string().min(1),
            blocking: z.boolean(),
            outcome: OutcomeSchema,
            factKey: z.string().regex(/^[a-z][a-zA-Z0-9_]{0,79}$/),
            factScope: z.enum(['mission', 'founder']),
          })
          .strict(),
      )
      .max(5)
      .default([]),
    runs: z.array(TaskBriefSchema).max(6),
    decisions: z.array(
      z
        .object({
          kind: z.enum(['goal', 'constraint', 'selection', 'mandate', 'engagement', 'change', 'terminal']),
          outcome: OutcomeSchema,
          gate: z.string().nullable(),
          packet: DecisionPacketSchema,
          reviewRequired: z.boolean(),
          supersedesId: IdSchema.nullable(),
        })
        .strict(),
    ),
    commitments: z.array(CommitmentOutputSchema),
    founderMessage: z.string().min(1),
    evidenceIds: z.array(IdSchema),
    focus: z
      .object({ type: z.enum(['artifact', 'decision', 'thread', 'readiness', 'money']), id: IdSchema.nullable(), reason: z.string() })
      .strict()
      .nullable(),
  })
  .strict();
export type PlanDelta = z.infer<typeof PlanDeltaSchema>;
export const QuoteSchema = z
  .object({
    supplierId: IdSchema,
    sourceEvidenceId: IdSchema,
    currency: CurrencySchema.nullable(),
    unitPriceMinor: MinorUnitsSchema.nullable(),
    moq: z.number().int().positive().nullable(),
    leadDays: z.number().int().nonnegative().nullable(),
    validUntil: z.iso.datetime().nullable(),
    incoterm: z.enum(['EXW', 'FOB', 'CIF', 'DAP', 'DDP']).nullable(),
    depositPercent: z.number().min(0).max(100).nullable(),
    tiers: z.array(z.object({ quantity: z.number().int().positive(), unitPriceMinor: MinorUnitsSchema }).strict()),
    terms: z.string(),
    language: z.string().min(2),
  })
  .strict();
export type Quote = z.infer<typeof QuoteSchema>;
export const NegotiationBoundsSchema = z
  .object({
    currency: CurrencySchema,
    maxUnitPriceMinor: MinorUnitsSchema,
    maxMoq: z.number().int().positive(),
    maxLeadDays: z.number().int().positive(),
    maxDepositPercent: z.number().min(0).max(100),
  })
  .strict();
export const KitSchema = z
  .object({
    title: z.string().min(1),
    whereToGo: z.url(),
    whatToEnter: z.array(z.string().min(1)).min(1),
    whatToBringBack: z.array(z.string().min(1)).min(1),
    howVerified: z.string().min(1),
    status: z.enum(['prepared', 'awaiting_founder', 'awaiting_verification', 'verified']),
    evidenceIds: z.array(IdSchema),
  })
  .strict();
