import { z } from 'zod';
import { OutcomeSchema } from '@lo/state';
import { withRole, type ActorScope } from './database.js';

export const OptionalStepSchema = z
  .object({
    playbookId: z.string().min(1),
    playbookVersion: z.number().int().positive(),
    stepId: z.string().min(1),
    choice: z.enum(['do', 'skip']),
    cost: z.object({ amountMinor: z.number().int().safe().nonnegative(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
    risk: z.string().trim().min(1).max(1000),
    evidenceIds: z.array(z.uuid()).max(50),
  })
  .strict();
export const OptionalOfferSchema = OptionalStepSchema.omit({ choice: true })
  .extend({ outcome: OutcomeSchema, title: z.string().min(1).max(200) })
  .strict();
/** Creates only proposed choice versions. The Lead must present an explicit
 * decision; its exact founder choice is recorded atomically on approval. */
export async function prepareOptionalStep(scope: ActorScope, raw: unknown): Promise<{ doVersionId: string; skipVersionId: string }> {
  const { outcome, title, ...step } = OptionalOfferSchema.parse(raw);
  return withRole('specialist_role', scope, async db => {
    const create = async (choice: 'do' | 'skip') => {
      const artifact = z
        .uuid()
        .parse(
          (await db.query("select public.create_artifact($1,'optional_step',$2,$3)id", [scope.missionId, outcome, title])).rows[0]?.id,
        );
      const version = z
        .uuid()
        .parse(
          (
            await db.query('select public.append_artifact_version($1,$2,$3,$4,$5,$6)id', [
              scope.missionId,
              artifact,
              { optionalStep: { ...step, choice } },
              [],
              [],
              step.evidenceIds,
            ])
          ).rows[0]?.id,
        );
      await db.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, version]);
      return version;
    };
    return { doVersionId: await create('do'), skipVersionId: await create('skip') };
  });
}
