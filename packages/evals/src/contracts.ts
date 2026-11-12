import { z } from 'zod';
import { JsonObjectSchema, JsonValueSchema } from '@lo/state';

export const SuiteSchema = z.enum([
  'extraction',
  'negotiation',
  'planner',
  'packets',
  'reviewer',
  'brand',
  'product',
  'compliance',
  'sourcing',
  'channel',
  'voice',
  'honesty',
  'scenario',
]);
export type Suite = z.infer<typeof SuiteSchema>;
export const SUITES = SuiteSchema.options;
export const FixtureSchema = z
  .object({
    id: z.string().min(1),
    suite: SuiteSchema,
    synthetic: z.literal(true),
    reviewStatus: z.literal('unreviewed'),
    language: z.string(),
    format: z.string(),
    requirementIds: z.array(z.string()).min(1),
    invariants: z.array(z.string()),
    judging: z.boolean(),
    input: JsonObjectSchema,
    expected: JsonObjectSchema,
  })
  .strict();
export type EvalFixture = z.infer<typeof FixtureSchema>;
export const MeasurementSchema = z
  .object({
    caseId: z.string(),
    fixtureHash: z.string().regex(/^[a-f0-9]{64}$/),
    promptHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    mode: z.enum(['live', 'imported_runtime', 'untrusted_import', 'test']),
    status: z.enum(['completed', 'failed', 'blocked']),
    output: JsonValueSchema.nullable(),
    responseId: z.string().nullable(),
    model: z.string().nullable(),
    startedAt: z.iso.datetime(),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    usageComplete: z.boolean(),
    costUsd: z.number().nonnegative().nullable(),
    error: z.string().nullable(),
    outputHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    toolExecutions: z.array(
      z.object({
        name: z.string(),
        callId: z.string(),
        inputHash: z.string(),
        outputHash: z.string(),
        startedAt: z.iso.datetime(),
        completedAt: z.iso.datetime(),
      }),
    ),
  })
  .strict();
export type Measurement = z.infer<typeof MeasurementSchema>;
export const JudgeResultSchema = z
  .object({
    caseId: z.string(),
    rubric: z.string(),
    outputHash: z.string(),
    model: z.string().min(1),
    responseId: z.string().min(1),
    latencyMs: z.number().nonnegative(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cachedInputTokens: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative().nullable(),
    score: z.number().min(0).max(1),
    label: z.enum(['fail', 'partial', 'pass']),
    reasons: z.array(z.string()),
    observedAt: z.iso.datetime(),
  })
  .strict();
export type JudgeResult = z.infer<typeof JudgeResultSchema>;
export const HumanScoreSchema = z
  .object({
    runId: z.string(),
    caseId: z.string(),
    rubric: z.string(),
    reviewerId: z.string().min(1),
    label: z.enum(['fail', 'partial', 'pass']),
    scoredAt: z.iso.datetime(),
  })
  .strict();
export type HumanScore = z.infer<typeof HumanScoreSchema>;
export const DomainReviewSchema = z
  .object({
    corpusHash: z.string(),
    reviewerId: z.string().min(1),
    reviewedAt: z.iso.datetime(),
    fixtureIds: z.array(z.string()),
    decision: z.enum(['approved', 'rejected']),
    notes: z.string().min(1),
  })
  .strict();
export const MetricSchema = z
  .object({
    id: z.string(),
    value: z.number().finite().nullable(),
    threshold: z.number(),
    direction: z.enum(['min', 'max']),
    unit: z.string(),
    sampleCount: z.number().int().nonnegative(),
    status: z.enum(['pass', 'fail', 'blocked']),
    reason: z.string().nullable(),
  })
  .strict();
export type Metric = z.infer<typeof MetricSchema>;
export const QualityEvidenceSchema = z
  .object({
    kind: z.enum([
      'unit',
      'contract',
      'database',
      'run_evals',
      'scenario',
      'e2e',
      'fault_injection',
      'security',
      'visual_accessibility',
      'performance',
      'field',
      'legal',
    ]),
    id: z.string(),
    artifactPath: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    observedAt: z.iso.datetime(),
    command: z.array(z.string()).min(1),
    exitCode: z.number().int(),
    requirementIds: z.array(z.string()),
    invariants: z.array(z.string()),
    facts: JsonObjectSchema,
  })
  .strict();
export type QualityEvidence = z.infer<typeof QualityEvidenceSchema>;
export const EvalReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string(),
    createdAt: z.iso.datetime(),
    corpusHash: z.string(),
    fixtureCount: z.number().int(),
    mode: z.enum(['live', 'imported_runtime', 'test']),
    measurements: z.array(MeasurementSchema),
    judges: z.array(JudgeResultSchema),
    metrics: z.array(MetricSchema),
    calibration: z.array(
      z.object({
        rubric: z.string(),
        sampleCount: z.number().int(),
        kappa: z.number().nullable(),
        status: z.enum(['pass', 'fail', 'blocked']),
        reason: z.string(),
      }),
    ),
    externalGates: z.array(
      z.object({
        id: z.string(),
        status: z.enum(['pass', 'fail', 'blocked']),
        reason: z.string(),
      }),
    ),
    status: z.enum(['pass', 'fail', 'blocked']),
  })
  .strict();
export type EvalReport = z.infer<typeof EvalReportSchema>;
export const EXPECTED_COUNTS: Readonly<Record<Suite, number>> = {
  extraction: 50,
  negotiation: 30,
  planner: 25,
  packets: 40,
  reviewer: 40,
  brand: 20,
  product: 20,
  compliance: 10,
  sourcing: 10,
  channel: 60,
  voice: 15,
  honesty: 12,
  scenario: 25,
};
export const RUBRICS = ['planner', 'packets', 'brand'] as const;
