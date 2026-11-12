import { z } from 'zod';
import { withRole, type ActorScope } from './database.js';
export const ContentReviewSchema = z.object({ checklistVersionId: z.uuid(), sourceVersionId: z.uuid().optional() }).strict();
export const ClaimsRequestSchema = z
  .object({
    checklistVersionId: z.uuid(),
    claims: z
      .array(z.object({ text: z.string().min(1).max(100000), evidenceIds: z.array(z.uuid()).min(1) }).strict())
      .min(1)
      .max(50),
  })
  .strict();
export async function screenContentClaims(scope: ActorScope, raw: unknown) {
  const request = ClaimsRequestSchema.parse(raw);
  return withRole('specialist_role', scope, async db => {
    const reports = [];
    for (const claim of request.claims) {
      const report = z
        .object({ checklistVersionId: z.uuid(), matches: z.array(z.string()), clear: z.boolean(), requiresDomainReview: z.literal(true) })
        .strict()
        .parse(
          (await db.query('select public.check_content_claims($1,$2,$3)result', [scope.missionId, request.checklistVersionId, claim.text]))
            .rows[0]?.result,
        );
      const proven = (
        await db.query(
          "select id from public.evidence e where e.mission_id=$1 and e.id=any($2::uuid[])and e.trust in('verified','founder_confirmed')and e.kind='claim_check'and e.payload->>'claimText'=$3 and e.payload->>'assessment'='supported'and length(trim(coalesce(e.payload->>'sourceExcerpt','')))>0 and not exists(select from public.stale_marks s where s.node_id=e.id)and not exists(select from public.evidence newer where newer.supersedes_id=e.id)",
          [scope.missionId, claim.evidenceIds, claim.text],
        )
      ).rows;
      reports.push({
        ...claim,
        ...report,
        supported: report.clear && new Set(proven.map(e => String(e.id))).size === new Set(claim.evidenceIds).size,
      });
    }
    return reports;
  });
}
