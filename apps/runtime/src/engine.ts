import { z } from 'zod';
import { PostgresMissionRepository, JsonObjectSchema, type Result, type JsonValue } from '@lo/state';
import type { PoolClient } from 'pg';
import { withRole, type ActorScope } from './database.js';
import { PlanDeltaSchema, RunResultSchema, type PlanDelta, type RunResult, type TaskBrief } from './contracts.js';
import { contentHash, redact } from './security.js';
import { environment } from './config.js';
import type { DurableSteps } from './agents.js';
import { loadKnowledge } from './knowledge.js';
import { validateArtifactContent } from './artifact-content.js';
import { orderWork } from './domain.js';
import { persistEditableSources, assertAssetReferences } from './editable-assets.js';

export interface MissionEvent {
  id: string;
  missionId: string;
  authUserId: string;
  type: string;
  payload: Record<string, JsonValue>;
}
export interface EngineServices {
  plan(snapshot: Record<string, JsonValue>, event: MissionEvent, steps: DurableSteps): Promise<Result<PlanDelta>>;
  run(brief: TaskBrief, snapshot: Record<string, JsonValue>, steps: DurableSteps): Promise<Result<RunResult>>;
  review(
    output: PlanDelta['decisions'][number],
    snapshot: Record<string, JsonValue>,
    steps: DurableSteps,
  ): Promise<{ accepted: boolean; defects: string[] }>;
  dispatch(brief: TaskBrief): Promise<void>;
}
export const MissionEventSchema = z
  .object({ id: z.string().min(1), missionId: z.uuid(), authUserId: z.uuid(), type: z.string().min(1), payload: JsonObjectSchema })
  .strict();
function resultOrThrow<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.value;
}
export async function loadMissionSnapshot(scope: ActorScope): Promise<Record<string, JsonValue>> {
  return withRole('lead_role', scope, async db => {
    const rows = await db.query('select public.mission_snapshot($1::uuid) as snapshot', [scope.missionId]);
    const snapshot = JsonObjectSchema.parse(rows.rows[0]?.snapshot);
    snapshot.knowledge = JSON.parse(
      JSON.stringify(await loadKnowledge(db, JsonObjectSchema.parse(JsonObjectSchema.parse(snapshot.mission).metadata ?? {}))),
    ) as JsonValue;
    snapshot.conversation_facts = JsonObjectSchema.parse(
      (await db.query('select public.conversation_facts($1)value', [scope.missionId])).rows[0]?.value,
    );
    snapshot.engagement = JsonObjectSchema.parse(
      (await db.query('select public.mission_engagement($1)value', [scope.missionId])).rows[0]?.value,
    );
    snapshot.current_financial_plan = (await db.query('select public.current_financial_plan($1)id', [scope.missionId])).rows[0]?.id ?? null;
    for (const table of [
      'command_requests',
      'command_results',
      'founder_preferences',
      'run_results',
      'mission_questions',
      'question_answers',
      'inspection_commitments',
      'financial_plans',
      'cost_estimates',
      'cost_acceptances',
      'mission_obstacles',
      'obstacle_resolutions',
      'readiness_observations',
      'commitment_chases',
      'commitment_chase_attempts',
      'commitment_chase_results',
      'commitment_chase_escalations',
      'payment_authorizations',
      'authorization_obligations',
      'marketplace_thread_bindings',
      'authorization_followups',
      'refund_claims',
      'voice_confirmation_obligations',
      'voice_confirmation_drafts',
      'generated_launch_records',
      'decision_moments',
      'decision_moment_items',
      'sourcing_quote_ingestions',
      'sourcing_assessments',
      'sourcing_term_changes',
      'sourcing_campaigns',
      'sourcing_campaign_recipients',
      'sourcing_campaign_deliveries',
      'sourcing_campaign_holds',
      'sourcing_campaign_shortlists',
      'sourcing_campaign_samples',
      'sourcing_campaign_proformas',
      'sourcing_campaign_inspections',
      'optional_step_choices',
      'registrar_quotes',
      'domain_registrations',
      'professional_proposals',
      'professional_engagements',
      'professional_starts',
      'professional_deliveries',
      'professional_confirmations',
      'professional_payments',
      'professional_holds',
      'provider_receipts',
    ] as const) {
      const data = await db.query(`select * from public.${table} where mission_id=$1 order by created_at desc,id desc limit 30`, [
        scope.missionId,
      ]);
      snapshot[table] = JSON.parse(JSON.stringify(data.rows.reverse())) as JsonValue;
    }
    snapshot.mandate_usage = JSON.parse(
      JSON.stringify(
        (
          await db.query('select id as mandate_id,public.mandate_usage($1,id)usage from public.mandates where mission_id=$1', [
            scope.missionId,
          ])
        ).rows,
      ),
    ) as JsonValue;
    return snapshot;
  });
}
export async function appendActivity(
  db: PoolClient,
  scope: ActorScope,
  label: 'planned' | 'blocked' | 'failed' | 'proposed',
  summary: string,
  refs: string[] = [],
): Promise<void> {
  await db.query('insert into public.activity(mission_id,label,summary,refs,actor_id) values($1,$2,$3,$4,$5)', [
    scope.missionId,
    label,
    summary,
    refs,
    scope.authUserId,
  ]);
}

/** All ticks serialize by mission in Inngest. The database consumption record is
 * a second deduplication barrier, surviving event retention and process restart. */
export async function missionTick(
  raw: MissionEvent,
  steps: DurableSteps,
  services: EngineServices,
): Promise<{ status: string; started: number }> {
  const event = MissionEventSchema.parse(raw);
  const scope = { authUserId: event.authUserId, missionId: event.missionId };
  const snapshot = await steps.run('load-and-reconcile', () => loadMissionSnapshot(scope));
  if (snapshot.status === 'ended' || snapshot.status === 'paused') return { status: String(snapshot.status), started: 0 };
  const prior = await steps.run('check-consumption', () =>
    withRole(
      'lead_role',
      scope,
      async db =>
        ((await db.query('select plan from public.runtime_ticks where mission_id=$1 and event_key=$2', [event.missionId, event.id])).rows[0]
          ?.plan as unknown) ?? null,
    ),
  );
  if (prior) {
    const previous = PlanDeltaSchema.parse(prior);
    for (const task of previous.runs) await steps.run(`dispatch-${task.id}`, () => services.dispatch(task));
    return { status: 'replayed', started: previous.runs.length };
  }
  const planned = await services.plan(snapshot, event, steps);
  if (!planned.ok) {
    await steps.run('record-plan-failure', () =>
      withRole('lead_role', scope, db => appendActivity(db, scope, 'failed', planned.error.message)),
    );
    return { status: 'blocked', started: 0 };
  }
  const plan = PlanDeltaSchema.parse(planned.value);
  const readiness = z
    .array(z.object({ outcome: z.enum(['brand', 'product', 'supply', 'commerce', 'compliance', 'demand']), level: z.number() }))
    .parse(snapshot.readiness);
  plan.runs = orderWork(plan.runs, {
    brand: 0,
    product: 0,
    supply: 0,
    commerce: 0,
    compliance: 0,
    demand: 0,
    ...Object.fromEntries(readiness.map(r => [r.outcome, r.level])),
  });
  for (const task of plan.runs) {
    if (task.missionId !== event.missionId) throw new Error('invariant_violation: cross-mission plan');
    if (task.role === 'lead' || task.role === 'voice')
      throw new Error('validation: asynchronous specialist dispatch cannot spawn Lead or voice sessions');
  }
  if (plan.runs.length > environment().MAX_PARALLEL_RUNS) throw new Error('validation: parallel run limit exceeded');
  const byOutcome = new Set<string>();
  for (const task of plan.runs) {
    if (task.role === 'research') continue;
    if (byOutcome.has(task.outcome)) throw new Error('validation: parallel writers for one outcome');
    byOutcome.add(task.outcome);
  }
  const reviewed: PlanDelta['decisions'] = [];
  for (const [index, decision] of plan.decisions.entries()) {
    const mandatory =
      decision.reviewRequired ||
      ['mandate', 'engagement', 'terminal', 'selection', 'change'].includes(decision.kind) ||
      decision.packet.options.some(o => o.cost !== null);
    if (mandatory) {
      const review = await services.review(decision, snapshot, steps);
      if (!review.accepted) {
        await steps.run(`review-rejected-${index}`, () =>
          withRole('lead_role', scope, db =>
            appendActivity(db, scope, 'blocked', `Independent review requires correction: ${review.defects.join('; ')}`),
          ),
        );
        continue;
      }
    }
    reviewed.push(decision);
  }
  const committed = await steps.run('persist-plan', () =>
    withRole('lead_role', scope, async db => {
      const claim = await db.query('select public.claim_runtime_tick($1,$2,$3) as status', [
        event.missionId,
        event.id,
        JSON.stringify({ ...plan, decisions: reviewed }),
      ]);
      if (claim.rows[0]?.status === 'paused') return false;
      if (claim.rows[0]?.status === 'replayed') return true;
      const active = await db.query(
        "select r.role,r.brief->>'outcome' as outcome from public.runs r where r.mission_id=$1 and r.role not in('lead','reviewer') and r.status in('scheduled','running') and not exists(select from public.run_results done where done.run_id=r.id)",
        [event.missionId],
      );
      if (active.rowCount && active.rowCount + plan.runs.length > environment().MAX_PARALLEL_RUNS)
        throw new Error('validation: active run capacity reached');
      for (const task of plan.runs)
        if (task.role !== 'research' && active.rows.some(r => r.role !== 'research' && r.outcome === task.outcome))
          throw new Error('validation: an outcome writer is already active');
      const repository = new PostgresMissionRepository(db);
      for (const decision of reviewed) {
        if (decision.supersedesId && decision.kind !== 'change') throw new Error('validation: supersession requires a change packet');
        resultOrThrow(
          await repository.proposeDecision(
            event.missionId,
            decision.kind,
            decision.packet,
            decision.outcome,
            decision.gate,
            decision.supersedesId,
          ),
        );
      }
      for (const task of plan.runs) {
        const existing = await db.query('select brief from public.runs where id=$1', [task.id]);
        if (existing.rowCount) throw new Error('invariant_violation: run id reused in a different plan');
        await db.query(
          'insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier,status) values($1,$2,$3,$4,$5,$6,$7)',
          [task.id, event.missionId, task.role, task, contentHash(task), task.tier, 'scheduled'],
        );
        await db.query('insert into public.tasks(mission_id,run_id,objective,status,deadline) values($1,$2,$3,$4,$5)', [
          event.missionId,
          task.id,
          task.objective,
          'scheduled',
          task.deadline,
        ]);
      }
      for (const question of plan.questions) {
        const unanswered = await db.query(
          'select count(*)::integer count from public.mission_questions q where mission_id=$1 and not exists(select from public.question_answers a where a.question_id=q.id)',
          [event.missionId],
        );
        if (Number(unanswered.rows[0]?.count) >= 5) break;
        const intake = await db.query(
          "select (select count(*)from public.mission_questions where mission_id=$1)::integer asked,exists(select from public.active_decisions where mission_id=$1 and kind='goal') as goal_approved",
          [event.missionId],
        );
        if (!intake.rows[0]?.goal_approved && Number(intake.rows[0]?.asked) >= 5) break;
        await db.query('select public.propose_mission_question($1,$2,$3,$4,$5,$6,$7)', [
          event.missionId,
          question.factKey,
          question.factScope,
          question.question,
          question.recommendedDefault,
          question.blocking,
          question.outcome,
        ]);
      }
      for (const commitment of plan.commitments) await persistCommitment(db, scope, commitment);
      const thread = await db.query(
        'select id from public.threads where mission_id=$1 and counterparty_id is null order by created_at limit 1',
        [event.missionId],
      );
      const threadId = z.uuid().parse(thread.rows[0]?.id);
      await db.query('select public.append_lead_message($1,$2,$3)', [event.missionId, threadId, plan.founderMessage]);
      await db.query('select public.clear_agent_message_stream($1,run_id) from public.agent_message_streams where mission_id=$1', [
        event.missionId,
      ]);
      await appendActivity(
        db,
        scope,
        'planned',
        'Mission Lead updated the plan from current evidence',
        plan.runs.map(r => r.id),
      );
      if (plan.focus?.id)
        await db.query('insert into public.focus_events(mission_id,node_id,actor_id) values($1,$2,$3)', [
          event.missionId,
          plan.focus.id,
          event.authUserId,
        ]);
      return true;
    }),
  );
  if (!committed) return { status: 'paused', started: 0 };
  for (const task of plan.runs) await steps.run(`dispatch-${task.id}`, () => services.dispatch(task));
  return { status: 'planned', started: plan.runs.length };
}

export async function persistRunResult(scope: ActorScope, brief: TaskBrief, output: RunResult): Promise<void> {
  const parsed = RunResultSchema.parse(output);
  await withRole('specialist_role', scope, async db => {
    const saved = await db.query(
      'insert into public.run_results(mission_id,run_id,result) values($1,$2,$3) on conflict(run_id) do nothing returning id',
      [scope.missionId, brief.id, JSON.stringify(redact(parsed))],
    );
    if (!saved.rowCount) return;
    const available = await db.query(
      'select e.id,e.trust,e.kind from public.evidence e where mission_id=$1 and not exists(select from public.stale_marks s where s.node_id=e.id) and not exists(select from public.evidence newer where newer.supersedes_id=e.id)',
      [scope.missionId],
    );
    const ids = new Set(available.rows.map(row => String(row.id)));
    const evidenceTrust = new Map(available.rows.map(row => [String(row.id), { trust: String(row.trust), kind: String(row.kind) }]));
    const mission = (await db.query('select metadata from public.effective_missions where id=$1', [scope.missionId])).rows[0];
    const knowledge = await loadKnowledge(db, JsonObjectSchema.parse(mission?.metadata ?? {}));
    const languages = z.array(z.string()).parse(knowledge.profile.content.languages ?? []);
    for (const evidence of parsed.evidence)
      for (const source of evidence.sourceEvidenceIds)
        if (!ids.has(source)) throw new Error('invariant_violation: generated evidence has nonexistent provenance');
    for (const evidence of parsed.evidence) {
      await db.query('select public.append_evidence($1,$2,$3,$4,$5,$6,$7)', [
        scope.missionId,
        evidence.outcome,
        evidence.kind,
        evidence.trust,
        JSON.stringify(redact(evidence.payload)),
        'document',
        evidence.sourceEvidenceIds.join(','),
      ]);
    }
    for (const artifact of parsed.artifacts) {
      validateArtifactContent(artifact.type, artifact.content, evidenceTrust, languages);
      artifact.content = await persistEditableSources(db, brief.missionId, brief.id, artifact.content);
      await assertAssetReferences(db, brief.missionId, artifact.content);
      for (const source of artifact.evidenceIds)
        if (!ids.has(source)) throw new Error('invariant_violation: artifact has nonexistent evidence');
      let artifactId = artifact.artifactId;
      if (!artifactId) {
        const created = await db.query('select public.create_artifact($1,$2,$3,$4) as id', [
          scope.missionId,
          artifact.type,
          artifact.outcome,
          artifact.title,
        ]);
        artifactId = z.uuid().parse(created.rows[0]?.id);
      }
      const version = await db.query('select public.append_artifact_version($1,$2,$3,$4,$5,$6,$7,$8,$9) as id', [
        scope.missionId,
        artifactId,
        JSON.stringify(redact(artifact.content)),
        artifact.derivedFrom,
        artifact.decisionRefs,
        artifact.evidenceIds,
        [],
        artifact.variationRequest,
        brief.id,
      ]);
      await db.query('select public.set_artifact_status($1,$2,$3)', [scope.missionId, version.rows[0]?.id, 'proposed']);
    }
    for (const commitment of parsed.commitments) await persistCommitment(db, scope, commitment);
    await appendActivity(
      db,
      scope,
      parsed.selfAssessment.complete && parsed.selfAssessment.criteria.every(c => c.met) ? 'proposed' : 'blocked',
      parsed.selfAssessment.complete
        ? 'Specialist output awaits evidence and Lead acceptance'
        : `Specialist needs more work: ${parsed.selfAssessment.gaps.join('; ')}`,
    );
  });
}

async function persistCommitment(db: PoolClient, scope: ActorScope, commitment: RunResult['commitments'][number]): Promise<void> {
  const party = z.uuid().parse(commitment.party);
  if (commitment.inspection) {
    await db.query('select public.open_inspection_commitment($1,$2,$3,$4,$5)', [
      scope.missionId,
      party,
      commitment.inspection.proformaVersionId,
      commitment.inspection.checks,
      commitment.dueAt,
    ]);
  } else
    await db.query('select public.open_commitment($1,$2,$3,$4,$5)', [
      scope.missionId,
      party,
      commitment.direction === 'owed_to_us' ? 'inbound' : 'outbound',
      commitment.description,
      commitment.dueAt,
    ]);
}

export async function drainMissionOutbox(scope: ActorScope, send: (event: MissionEvent) => Promise<void>): Promise<number> {
  return withRole('lead_role', scope, async db => {
    const rows = await db.query('select *from public.lock_pending_outbox($1,100)', [scope.missionId]);
    for (const row of rows.rows) {
      await send(
        MissionEventSchema.parse({
          id: row.id,
          missionId: scope.missionId,
          authUserId: scope.authUserId,
          type: row.type,
          payload: row.payload,
        }),
      );
      await db.query('insert into public.outbox_deliveries(mission_id,outbox_id) values($1,$2) on conflict(outbox_id) do nothing', [
        scope.missionId,
        row.id,
      ]);
    }
    return rows.rowCount ?? 0;
  });
}
