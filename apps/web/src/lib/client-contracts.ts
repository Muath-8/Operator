import { z } from 'zod';
import type { CommandResult, MissionSummary } from '../ui-contract';

const count = z.number().int().safe().nonnegative();
const level = z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]);
/** Explicit runtime boundaries remain checked against the public TypeScript contracts. */
export const MissionSummarySchema: z.ZodType<MissionSummary> = z.object({
  id: z.string().min(1),
  name: z.string(),
  untitled: z.boolean(),
  icon: z
    .object({
      viewBox: z.string(),
      paths: z.array(
        z.object({
          d: z.string(),
          stroke: z.union([z.number(), z.literal('current')]).optional(),
          fill: z.union([z.number(), z.literal('current')]).optional(),
          width: z.number().optional(),
        }),
      ),
    })
    .nullable(),
  pendingDecisions: count,
  overdueCommitments: count,
  levels: z.object({ brand: level, product: level, supply: level, commerce: level, compliance: level, demand: level }),
  status: z.enum(['active', 'paused', 'ended']),
  sandbox: z.boolean(),
  line: z.string(),
});
export const MissionListSchema = z.object({ missions: z.array(MissionSummarySchema) });
export const CommandResultSchema: z.ZodType<CommandResult> = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    ledgerVersion: count,
    redirectUrl: z.string().min(1).optional(),
    downloadUrl: z.string().min(1).optional(),
    missionId: z.string().min(1).optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      code: z.enum(['offline', 'unavailable', 'forbidden', 'conflict', 'validation', 'rate_limited', 'needs_approval', 'unknown']),
      message: z.string(),
      retryable: z.boolean(),
    }),
  }),
]);
