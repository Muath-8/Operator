import { z } from 'zod';
import { withRole, type ActorScope } from './database.js';

export const DecisionTimingResultSchema = z.object({ autoDefaulted: z.array(z.uuid()), momentIds: z.array(z.uuid()) }).strict();
export type DecisionTimingResult = z.infer<typeof DecisionTimingResultSchema>;
/** Database clock, scoped mission lock and append-only system provenance govern
 * defaults/moments. No model output or caller-supplied date can authorize them. */
export async function reconcileDecisionTiming(scope: ActorScope): Promise<DecisionTimingResult> {
  const mission = z.uuid().parse(scope.missionId);
  return withRole('lead_role', scope, async db =>
    DecisionTimingResultSchema.parse((await db.query('select public.reconcile_decision_timing($1)result', [mission])).rows[0]?.result),
  );
}
export async function configureDecisionTiming(scope: ActorScope, momentsPerWeek: number): Promise<void> {
  const mission = z.uuid().parse(scope.missionId),
    count = z.number().int().min(1).max(7).parse(momentsPerWeek);
  await withRole('founder_role', scope, async db => {
    await db.query('select public.configure_decision_timing($1,$2)', [mission, count]);
  });
}
export async function applySafeDefaults(
  scope: ActorScope,
  momentId: string | null = null,
): Promise<{ resolvedDecisionIds: string[]; remainingDecisionIds: string[] }> {
  const mission = z.uuid().parse(scope.missionId),
    moment = z.uuid().nullable().parse(momentId);
  return withRole('founder_role', scope, async db =>
    z
      .object({ resolvedDecisionIds: z.array(z.uuid()), remainingDecisionIds: z.array(z.uuid()) })
      .strict()
      .parse((await db.query('select public.apply_safe_defaults($1,$2)result', [mission, moment])).rows[0]?.result),
  );
}
