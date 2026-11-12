import { z } from 'zod';
import { withRole, type ActorScope } from './database.js';
import { executeApprovedProviderEffect } from './provider-tools.js';
import { ProviderStorage } from './provider-storage.js';
import { publishDemandPage } from './demand.js';
import { JsonObjectSchema } from '@lo/state';

/** Jobs derive only from a committed founder command. The exact approval is
 * revalidated by the effect boundary on every attempt; this queue grants nothing. */
export async function reconcileApprovedEffects(scope: ActorScope): Promise<void> {
  await withRole('policy_role', scope, async db => {
    await db.query('select public.reconcile_outbound_receipts($1)', [scope.missionId]);
    await db.query('select public.reconcile_commitment_chase_receipts($1)', [scope.missionId]);
    await db.query('select public.reconcile_sourcing_campaign_deliveries($1)', [scope.missionId]);
  });
  const jobs = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          `
    select c.command_id, v.value as version_id, a.status, a.retry_after,
      (select count(*) from public.approved_effect_attempts n where n.command_id=c.command_id and n.artifact_version_id=v.value::uuid) as attempts
    from public.command_results c
    cross join lateral jsonb_array_elements_text(coalesce(c.result->'approvedEffectVersionIds','[]')) v
    left join lateral(select status,retry_after from public.approved_effect_attempts a
      where a.command_id=c.command_id and a.artifact_version_id=v.value::uuid order by created_at desc,id desc limit 1)a on true
    where c.mission_id=$1 and (a.status is null or(a.status='retryable' and a.retry_after<=clock_timestamp()))
    order by c.created_at limit 20`,
          [scope.missionId],
        )
      ).rows,
  );
  for (const job of jobs) {
    const commandId = z.uuid().parse(job.command_id),
      versionId = z.uuid().parse(job.version_id);
    let status: 'succeeded' | 'blocked' | 'retryable' = 'retryable',
      code: string | null = null;
    try {
      const storage = new ProviderStorage(scope);
      const artifact = await storage.artifact(versionId);
      const template = JsonObjectSchema.parse(artifact.content.effectIntent);
      if (template.action === 'marketing_publish') {
        if (artifact.status !== 'approved') throw new Error('needs_approval');
        const { action: _action, effectClass: _effectClass, ...fields } = template;
        const intent = await storage.buildIntent(
          commandId,
          'marketing_publish',
          'publish',
          { ...fields, artifactVersionId: versionId },
          [],
        );
        const config = z.object({ slug: z.string(), thresholdDecisionId: z.uuid() }).passthrough().parse(artifact.content);
        await publishDemandPage(scope, intent, versionId, config.thresholdDecisionId, config.slug);
        status = 'succeeded';
      } else {
        const result = await executeApprovedProviderEffect(scope, versionId, commandId);
        status = result.ok ? 'succeeded' : result.error.retryable ? 'retryable' : 'blocked';
        code = result.ok ? null : result.error.code;
      }
    } catch (error: unknown) {
      code = error instanceof Error && error.message.includes('needs_approval') ? 'needs_approval' : 'provider_down';
      status = code === 'needs_approval' ? 'blocked' : 'retryable';
    }
    if (Number(job.attempts) >= 4 && status === 'retryable') status = 'blocked';
    await withRole('policy_role', scope, async db => {
      await db.query(
        'insert into public.approved_effect_attempts(mission_id,command_id,artifact_version_id,status,error_code,retry_after)values($1,$2,$3,$4,$5,$6)',
        [
          scope.missionId,
          commandId,
          versionId,
          status,
          code,
          status === 'retryable' ? new Date(Date.now() + 60000 * 2 ** Number(job.attempts)) : null,
        ],
      );
      if (status === 'blocked')
        await db.query("insert into public.outbox(mission_id,type,payload)values($1,'effect.blocked',$2)", [
          scope.missionId,
          { commandId, artifactVersionId: versionId, errorCode: code },
        ]);
    });
  }
}
