import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { ApprovalBindingSchema, DecisionPacketSchema, JsonObjectSchema, MandateScopeSchema, PostgresMissionRepository } from '@lo/state';
import type { PoolClient } from 'pg';
import type { ActorScope } from './database.js';
import { encryptProviderValue } from './provider-storage.js';

/** Decision resolution, version status and exact single-use capability are one
 * transaction. Tokens go only into the encrypted private vault, never the UI. */
export async function activateApprovedVersions(
  db: PoolClient,
  scope: ActorScope,
  decisionId: string,
  optionId: string,
  requestedScope?: { ceiling: { amountMinor: number; currency: string }; count: number; expiresOn: string },
): Promise<{ paymentVersionId?: string; approvedEffectVersionIds: string[] }> {
  const row = (await db.query('select packet,kind,gate from public.decisions where mission_id=$1 and id=$2', [scope.missionId, decisionId]))
    .rows[0];
  const packet = DecisionPacketSchema.parse(row?.packet);
  const chosen = packet.options.find(option => option.id === optionId);
  if (!chosen) throw new Error('validation: selected option missing');
  const versions = chosen.artifactVersionIds ?? (packet.options.length === 1 ? (packet.approvedVersionIds ?? []) : []);
  const repository = new PostgresMissionRepository(db);
  let paymentVersionId: string | undefined;
  const approvedEffectVersionIds: string[] = [];
  const closingVersions: { id: string; terminal: string }[] = [];
  for (const versionId of new Set(versions)) {
    const version = (
      await db.query('select content from public.artifact_versions where mission_id=$1 and id=$2', [scope.missionId, versionId])
    ).rows[0];
    const content = JsonObjectSchema.parse(version?.content);
    const status = (
      await db.query(
        'select status from public.artifact_statuses where mission_id=$1 and artifact_version_id=$2 order by created_at desc,id desc limit 1',
        [scope.missionId, versionId],
      )
    ).rows[0]?.status;
    if (status !== 'approved')
      await db.query('select public.set_artifact_status($1,$2,$3,$4)', [scope.missionId, versionId, 'approved', decisionId]);
    if (content.missionBrief) await db.query('select public.apply_mission_brief($1,$2,$3)', [scope.missionId, decisionId, versionId]);
    if (content.financialPlan) await db.query('select public.apply_financial_plan($1,$2,$3)', [scope.missionId, decisionId, versionId]);
    if (content.acceptedQuote) await db.query('select public.accept_supplier_quote($1,$2,$3)', [scope.missionId, decisionId, versionId]);
    if (content.costAcceptance) await db.query('select public.accept_cost_line($1,$2,$3)', [scope.missionId, decisionId, versionId]);
    if (content.optionalStep)
      await db.query('select public.apply_optional_step_choice($1,$2,$3)', [scope.missionId, decisionId, versionId]);
    if (content.founderConfirmation) {
      const confirmation = JsonObjectSchema.parse(content.founderConfirmation);
      if (confirmation.kind === 'sourcing_campaign_exception')
        await db.query('select public.confirm_sourcing_campaign_exception($1,$2,$3)', [scope.missionId, decisionId, versionId]);
      else if (confirmation.kind === 'campaign_inspection_result')
        await db.query('select public.confirm_sourcing_campaign_inspection($1,$2,$3)', [scope.missionId, decisionId, versionId]);
      else if (confirmation.kind === 'owned_resource')
        await db.query('select public.confirm_owned_resource($1,$2,$3)', [scope.missionId, decisionId, versionId]);
      else if (confirmation.kind === 'professional_deliverable_confirmation')
        await db.query('select public.confirm_professional_deliverable($1,$2,$3)', [scope.missionId, decisionId, versionId]);
      else await db.query('select public.confirm_founder_artifact($1,$2,$3)', [scope.missionId, decisionId, versionId]);
    }
    if (content.closingRecord) {
      const closing = z
        .object({ terminal: z.enum(['launch', 'pivot', 'stop', 'infeasible']), summary: z.string().min(1) })
        .passthrough()
        .parse(content.closingRecord);
      closingVersions.push({ id: versionId, terminal: closing.terminal });
    }
    if (content.mandate) {
      if (row?.kind !== 'mandate' || !requestedScope) throw new Error('needs_approval: mandate requires its explicit scope review');
      const mandate = z
        .object({
          type: z.string(),
          scope: MandateScopeSchema,
          ceilingPer: z.number().int().safe().nonnegative(),
          ceilingTotal: z.number().int().safe().nonnegative(),
          currency: z.string().length(3),
          expiresAt: z.iso.datetime(),
        })
        .strict()
        .parse(content.mandate);
      let per = mandate.ceilingPer,
        total = mandate.ceilingTotal,
        expires = mandate.expiresAt;
      const narrowedScope = { ...mandate.scope };
      if (requestedScope) {
        const requestedTotal = requestedScope.ceiling.amountMinor;
        const requestedExpiry = new Date(Math.min(Date.parse(`${requestedScope.expiresOn}T23:59:59Z`), Date.parse(expires))).toISOString();
        const countLimit = mandate.scope.maxActions ?? (per > 0 ? Math.max(1, Math.ceil(total / per)) : mandate.scope.maxNewContacts);
        if (
          requestedScope.ceiling.currency !== mandate.currency ||
          requestedTotal > total ||
          requestedScope.count > countLimit ||
          requestedScope.expiresOn > expires.slice(0, 10)
        )
          throw new Error('needs_approval: expanded mandate needs a reviewed replacement packet');
        per = Math.min(per, requestedTotal);
        total = requestedTotal;
        expires = requestedExpiry;
        narrowedScope.maxActions = requestedScope.count;
        if (per === 0) narrowedScope.maxNewContacts = Math.min(narrowedScope.maxNewContacts, requestedScope.count);
      }
      await db.query('select public.grant_mandate($1,$2,$3,$4,$5,$6,$7)', [
        scope.missionId,
        decisionId,
        mandate.type,
        narrowedScope,
        per,
        total,
        expires,
      ]);
    }
    if (content.effectIntent) {
      const intent = z
        .object({
          action: z.string(),
          effectClass: z.enum(['communicate', 'spend', 'publish', 'bind']),
          counterpartyId: z.uuid(),
          amountMinor: z.number().int().safe().nonnegative().optional(),
          currency: z.string().length(3).optional(),
          instrumentId: z.uuid().optional(),
          channel: z.string().optional(),
          purpose: z.string().optional(),
        })
        .strict()
        .parse(content.effectIntent);
      if (
        intent.effectClass === 'spend' &&
        (!chosen.cost || chosen.cost.amountMinor !== intent.amountMinor || chosen.cost.currency !== intent.currency)
      )
        throw new Error('needs_approval: payment does not match the price in the selected option');
      const token = randomBytes(32).toString('base64url');
      const approval = await repository.issueApproval(
        scope.missionId ?? '',
        decisionId,
        ApprovalBindingSchema.parse({
          action: intent.action,
          counterpartyId: intent.counterpartyId,
          amountMinor: intent.amountMinor ?? null,
          currency: intent.currency ?? null,
          artifactVersionId: versionId,
        }),
        token,
        new Date(Date.now() + 86400000).toISOString(),
      );
      if (!approval.ok) throw new Error(`${approval.error.code}: ${approval.error.message}`);
      await db.query('select public.store_approval_token($1,$2,$3)', [
        scope.missionId,
        approval.value,
        encryptProviderValue({ token }, `approval:${scope.missionId}:${approval.value}`),
      ]);
      if (intent.effectClass === 'spend' && !(row?.kind === 'mandate' || (row?.kind === 'engagement' && row?.gate === 'payment')))
        throw new Error('needs_approval: money movement requires an explicit payment decision');
      if (
        intent.action !== 'payment_capture' &&
        (intent.effectClass !== 'communicate' || ['send_message', 'marketplace_message'].includes(intent.action))
      )
        approvedEffectVersionIds.push(versionId);
      if (intent.action === 'payment_capture') {
        if (paymentVersionId) throw new Error('validation: one payment per decision click');
        paymentVersionId = versionId;
      }
    }
  }
  if (row?.kind === 'terminal') {
    if (optionId === 'pivot')
      throw new Error('needs_approval: pivot requires a Change decision with a revised mission brief, not a terminal end');
    const closing = closingVersions[0];
    if (closingVersions.length !== 1 || !closing || closing.terminal !== optionId)
      throw new Error('needs_approval: terminal choice requires its exact closing record');
    await db.query("select public.transition_mission($1,'ended',$2,$3)", [scope.missionId, decisionId, closing.id]);
  }
  if (requestedScope && !versions.length) throw new Error('needs_approval: no version-bound mandate in this decision');
  return { paymentVersionId, approvedEffectVersionIds };
}
