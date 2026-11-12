import { z } from 'zod';
import { calculateImpact, DecisionPacketSchema, JsonObjectSchema, PostgresMissionRepository, type JsonValue } from '@lo/state';
import { withRole, type ActorScope } from './database.js';
import type { PoolClient } from 'pg';
import { activateApprovedVersions } from './founder-approval.js';

const base = { missionId: z.uuid(), idempotencyKey: z.string().min(16).max(256), seenLedgerVersion: z.number().int().nonnegative() };
const context = z
  .object({
    artifactId: z.uuid().optional(),
    frameId: z.string().optional(),
    versionId: z.uuid().optional(),
    decisionId: z.uuid().optional(),
    point: z
      .object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })
      .strict()
      .optional(),
  })
  .strict();
const schema = <const K extends string, T extends z.ZodRawShape>(kind: K, shape: T) =>
  z.object({ ...base, kind: z.literal(kind), ...shape }).strict();
export const CommandSchema = z.discriminatedUnion('kind', [
  schema('resolveDecision', {
    decisionId: z.uuid(),
    response: z.enum(['approve', 'choose', 'reject']),
    optionId: z.string().min(1),
    mandateScope: z
      .object({
        ceiling: z.object({ amountMinor: z.number().int().safe().nonnegative(), currency: z.string().length(3) }),
        count: z.number().int().positive(),
        expiresOn: z.iso.date(),
      })
      .optional(),
  }),
  schema('deferDecision', { decisionId: z.uuid() }),
  schema('requestChange', {
    decisionId: z.uuid().optional(),
    artifactId: z.uuid().optional(),
    versionId: z.uuid().optional(),
    actionId: z.string().optional(),
  }),
  schema('confirmChange', { impactId: z.uuid() }),
  schema('keepDecision', { impactId: z.uuid() }),
  schema('justGo', { momentId: z.string().nullable() }),
  schema('completeMoment', { momentId: z.string(), resolvedDecisionIds: z.array(z.uuid()) }),
  schema('sendMessage', { text: z.string().trim().min(1).max(12000), context: context.optional() }),
  schema('answerQuestion', { questionId: z.uuid(), answer: z.string().max(12000), skipped: z.boolean() }),
  schema('setHelpMode', {
    control: z.object({ targetId: z.string(), targetKind: z.enum(['thread', 'commitment', 'activity']) }).strict(),
    mode: z.enum(['guide', 'do', 'help']),
  }),
  schema('approveDraft', { artifactId: z.uuid(), draftId: z.uuid() }),
  schema('discardDraft', { artifactId: z.uuid(), draftId: z.uuid() }),
  schema('retryStep', { stepId: z.uuid() }),
  schema('requestVariation', {
    artifactId: z.uuid(),
    frameId: z.string(),
    versionId: z.uuid(),
    request: z.string().trim().min(1).max(4000),
  }),
  schema('runArtifactAction', {
    artifactId: z.uuid(),
    actionId: z.string(),
    frameId: z.string().optional(),
    versionId: z.uuid().optional(),
  }),
  schema('setMandateStatus', { mandateId: z.uuid(), status: z.literal('revoked') }),
  schema('setMissionStatus', { status: z.enum(['paused', 'active']) }),
  schema('setTraceRetention', { enabled: z.boolean() }),
  schema('keepRetainedContent', { objectId: z.uuid(), keep: z.boolean() }),
  schema('markNotificationsRead', { notificationIds: z.array(z.uuid()).max(500) }),
  schema('updateNotificationSettings', {
    settings: z
      .object({
        momentsPerWeek: z.number().int().min(1).max(7).optional(),
        digestCadence: z.enum(['daily', 'twice_weekly', 'weekly']),
        quietHours: z
          .object({ from: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), to: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/) })
          .strict()
          .nullable(),
      })
      .strict(),
  }),
  schema('exportLaunchRecord', { format: z.enum(['pdf', 'markdown', 'json', 'zip']) }),
]);
export type FounderCommand = z.infer<typeof CommandSchema>;
export interface CommandReceipt {
  ok: true;
  ledgerVersion: number;
  downloadUrl?: string;
  missionId?: string;
  paymentVersionId?: string;
  approvedEffectVersionIds?: string[];
  commandId?: string;
}
export async function ledgerVersion(db: PoolClient, missionId: string): Promise<number> {
  const result = await db.query('select coalesce(max(revision),0)::text as revision from public.ledger_events where mission_id=$1', [
    missionId,
  ]);
  return z.coerce.number().int().safe().parse(result.rows[0]?.revision);
}
async function unwrap<T>(result: Promise<{ ok: true; value: T } | { ok: false; error: { code: string; message: string } }>): Promise<T> {
  const r = await result;
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
async function founderThread(db: PoolClient, missionId: string): Promise<string> {
  const result = await db.query(
    'select id from public.threads where mission_id=$1 and counterparty_id is null order by created_at,id limit 1',
    [missionId],
  );
  return z.uuid().parse(result.rows[0]?.id);
}
async function preference(db: PoolClient, scope: ActorScope, kind: string, value: unknown): Promise<void> {
  await db.query('insert into public.founder_preferences(mission_id,kind,value,actor_id) values($1,$2,$3,$4)', [
    scope.missionId,
    kind,
    JSON.stringify(value),
    scope.authUserId,
  ]);
}
/** Binding operations and their idempotent acknowledgement commit together. Agent
 * requests are queued in the same transaction and remain pending until processed. */
export async function executeFounderCommand(authUserId: string, raw: unknown): Promise<CommandReceipt> {
  const command = CommandSchema.parse(raw);
  const scope = { authUserId, missionId: command.missionId };
  return withRole('founder_role', scope, async db => {
    const repository = new PostgresMissionRepository(db);
    const submitted = await db.query('select public.submit_command($1,$2,$3,$4) as id', [
      command.missionId,
      command.idempotencyKey,
      command.kind,
      JSON.stringify(command),
    ]);
    const commandId = z.uuid().parse(submitted.rows[0]?.id);
    const prior = await db.query('select result from public.command_results where mission_id=$1 and command_id=$2', [
      command.missionId,
      commandId,
    ]);
    if (prior.rowCount)
      return {
        ok: true,
        ledgerVersion: await ledgerVersion(db, command.missionId),
        ...JsonObjectSchema.parse(prior.rows[0]?.result),
      } as CommandReceipt;
    // A stale screen cannot make a binding choice. The new command's two ledger
    // entries are excluded from the comparison, so compare its creation revision.
    const before = await db.query(
      "select coalesce(max(revision),0)::text as revision from public.ledger_events where mission_id=$1 and not (source_table='command_requests' and row_id=$2) and not (source_table='outbox' and row_id in(select id::text from public.outbox where mission_id=$1 and payload->>'commandId'=$2))",
      [command.missionId, commandId],
    );
    if (
      ['resolveDecision', 'confirmChange', 'approveDraft'].includes(command.kind) &&
      Number(before.rows[0]?.revision) > command.seenLedgerVersion
    )
      throw new Error('conflict: mission changed; refresh before deciding');
    let result: Record<string, JsonValue> = {};
    switch (command.kind) {
      case 'resolveDecision':
        await unwrap(repository.resolveDecision(command.missionId, command.decisionId, command.response, command.optionId));
        if (command.response !== 'reject') {
          const activated = await activateApprovedVersions(db, scope, command.decisionId, command.optionId, command.mandateScope);
          result = {
            ...(activated.paymentVersionId ? { paymentVersionId: activated.paymentVersionId } : {}),
            approvedEffectVersionIds: activated.approvedEffectVersionIds,
            commandId,
          };
        }
        break;
      case 'setTraceRetention':
        await db.query('select public.configure_trace_retention($1,$2)', [command.missionId, command.enabled]);
        break;
      case 'keepRetainedContent':
        await db.query('select public.keep_retained_content($1,$2,$3)', [command.missionId, command.objectId, command.keep]);
        break;
      case 'deferDecision':
        await unwrap(repository.resolveDecision(command.missionId, command.decisionId, 'defer'));
        break;
      case 'setMissionStatus':
        await unwrap(repository.transitionMission(command.missionId, command.status));
        break;
      case 'setMandateStatus':
        await unwrap(repository.revokeMandate(command.missionId, command.mandateId));
        break;
      case 'sendMessage': {
        if (command.context?.artifactId) {
          const item = await db.query('select id from public.artifacts where mission_id=$1 and id=$2', [
            command.missionId,
            command.context.artifactId,
          ]);
          if (!item.rowCount) throw new Error('validation: artifact context not found');
        }
        const message = await unwrap(
          repository.appendFounderMessage(command.missionId, await founderThread(db, command.missionId), command.text),
        );
        if (command.context) await preference(db, scope, 'message_context', { messageId: message, ...command.context });
        break;
      }
      case 'answerQuestion':
        await db.query('select public.answer_mission_question($1,$2,$3,$4)', [
          command.missionId,
          command.questionId,
          command.answer,
          command.skipped,
        ]);
        break;
      case 'updateNotificationSettings':
        await preference(db, scope, 'notifications', command.settings);
        if (command.settings.momentsPerWeek !== undefined)
          await db.query('select public.configure_decision_timing($1,$2)', [command.missionId, command.settings.momentsPerWeek]);
        break;
      case 'markNotificationsRead':
        await preference(db, scope, 'notifications_read', command.notificationIds);
        break;
      case 'setHelpMode':
        await preference(db, scope, 'help_mode', { ...command.control, mode: command.mode });
        break;
      case 'requestChange': {
        const node = command.decisionId ?? command.versionId;
        if (!node) throw new Error('validation: change needs a decision or artifact version');
        const exists = await db.query('select id from public.state_nodes where mission_id=$1 and id=$2', [command.missionId, node]);
        if (!exists.rowCount) throw new Error('validation: change target not found');
        const edges = await db.query('select upstream_id,dependent_id from public.dependencies where mission_id=$1', [command.missionId]);
        const affected = calculateImpact(
          node,
          edges.rows.map(r => ({ upstreamId: String(r.upstream_id), dependentId: String(r.dependent_id) })),
        );
        await preference(db, scope, 'change_request', {
          id: commandId,
          rootId: node,
          affected,
          decisionId: command.decisionId ?? null,
          status: 'awaiting_replacement',
          cost: 'unknown_until_replanned',
          delay: 'unknown_until_replanned',
        });
        break;
      }
      case 'confirmChange': {
        const impact = await db.query(
          "select value from public.founder_preferences where mission_id=$1 and kind='change_request' and value->>'id'=$2 order by created_at desc limit 1",
          [command.missionId, command.impactId],
        );
        const value = JsonObjectSchema.parse(impact.rows[0]?.value);
        const replacements = await db.query(
          "select d.id,d.packet from public.decisions d where d.mission_id=$1 and d.supersedes_id=$2 and d.kind='change' and not exists(select from public.decision_resolutions r where r.decision_id=d.id)",
          [command.missionId, z.uuid().parse(value.decisionId)],
        );
        if (replacements.rowCount !== 1)
          throw new Error('needs_approval: the Lead must provide one reviewed replacement and impact analysis before a binding change');
        // The parsed packet is required below to contain exactly one selected option.
        const replacement = replacements.rows[0];
        const packet = DecisionPacketSchema.parse(replacement?.packet);
        if (packet.options.length !== 1) throw new Error('needs_approval: choose the exact replacement option in its decision packet');
        const selected = packet.options[0];
        if (!selected) throw new Error('needs_approval: replacement option is missing');
        const replacementId = z.uuid().parse(replacement?.id);
        await unwrap(repository.resolveDecision(command.missionId, replacementId, 'approve', selected.id));
        const activated = await activateApprovedVersions(db, scope, replacementId, selected.id);
        result = {
          ...(activated.paymentVersionId ? { paymentVersionId: activated.paymentVersionId } : {}),
          approvedEffectVersionIds: activated.approvedEffectVersionIds,
          commandId,
        };
        break;
      }
      case 'keepDecision':
        await preference(db, scope, 'change_kept', { impactId: command.impactId });
        break;
      case 'justGo': {
        await db.query('select public.apply_safe_defaults($1,$2)', [
          command.missionId,
          command.momentId === null ? null : z.uuid().parse(command.momentId),
        ]);
        break;
      }
      case 'completeMoment': {
        const members = await db.query('select decision_id from public.decision_moment_items where mission_id=$1 and moment_id=$2', [
          command.missionId,
          z.uuid().parse(command.momentId),
        ]);
        if (
          !members.rowCount ||
          members.rows.some(row => !command.resolvedDecisionIds.includes(String(row.decision_id))) ||
          command.resolvedDecisionIds.some(id => !members.rows.some(row => row.decision_id === id))
        )
          throw new Error('validation: decisions do not belong to this moment');
        const resolved = await db.query(
          "select decision_id from public.decision_resolutions where mission_id=$1 and decision_id=any($2::uuid[]) and response in('approve','choose','reject')",
          [command.missionId, command.resolvedDecisionIds],
        );
        if (resolved.rowCount !== new Set(command.resolvedDecisionIds).size)
          throw new Error('validation: moment contains unresolved decisions');
        await preference(db, scope, 'moment_completed', { momentId: command.momentId, decisionIds: command.resolvedDecisionIds });
        break;
      }
      case 'approveDraft': {
        const versions = await db.query('select id from public.artifact_versions where mission_id=$1 and id=$2 and artifact_id=$3', [
          command.missionId,
          command.draftId,
          command.artifactId,
        ]);
        if (!versions.rowCount) throw new Error('validation: draft is not in this artifact');
        const decisions = await db.query(
          'select d.id,d.packet from public.decisions d where mission_id=$1 and $2::uuid=any(d.approved_version_refs) and not exists(select from public.decision_resolutions r where r.decision_id=d.id)',
          [command.missionId, command.draftId],
        );
        if (decisions.rowCount !== 1) throw new Error('needs_approval: draft needs one reviewed version-bound decision packet');
        const decision = decisions.rows[0];
        const packet = DecisionPacketSchema.parse(decision?.packet);
        const option =
          packet.options.find(o => o.artifactVersionIds?.includes(command.draftId)) ??
          (packet.options.length === 1 ? packet.options[0] : undefined);
        if (!option) throw new Error('needs_approval: choose the exact draft option');
        await unwrap(repository.resolveDecision(command.missionId, String(decision?.id), 'approve', option.id));
        const activated = await activateApprovedVersions(db, scope, String(decision?.id), option.id);
        result = {
          ...(activated.paymentVersionId ? { paymentVersionId: activated.paymentVersionId } : {}),
          approvedEffectVersionIds: activated.approvedEffectVersionIds,
          commandId,
        };
        break;
      }
      case 'discardDraft': {
        const draft = await db.query('select id from public.artifact_versions where mission_id=$1 and id=$2 and artifact_id=$3', [
          command.missionId,
          command.draftId,
          command.artifactId,
        ]);
        if (!draft.rowCount) throw new Error('validation: draft is not in this artifact');
        await db.query('select public.set_artifact_status($1,$2,$3)', [command.missionId, command.draftId, 'rejected']);
        break;
      }
      case 'exportLaunchRecord':
        result = { downloadUrl: `/api/missions/${command.missionId}/export?format=${command.format}` };
        break;
      default:
        // Explicit requests are durable commands consumed by the Mission Lead.
        // Their acknowledgement does not mark a task or external action complete.
        await preference(db, scope, 'agent_request', { commandId, kind: command.kind, status: 'queued' });
    }
    await db.query('select public.complete_founder_command($1,$2,$3)', [command.missionId, commandId, JSON.stringify(result)]);
    return { ok: true, ledgerVersion: await ledgerVersion(db, command.missionId), ...result } as CommandReceipt;
  });
}
