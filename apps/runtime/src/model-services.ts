import { readFile } from 'node:fs/promises';
import type { Model } from '@openai/agents';

import { z } from 'zod';
import { JsonObjectSchema, type JsonValue, type Result } from '@lo/state';
import { executeAgentRun, type AgentToolHandler, type DurableSteps } from './agents.js';
import {
  PlanDeltaSchema,
  RunResultSchema,
  TaskBriefSchema,
  type TaskBrief,
  type Role,
  type RunResult,
  type PlanDelta,
} from './contracts.js';
import { environment } from './config.js';
import { withRole, type ActorScope } from './database.js';
import { initializeTelemetry, reportOperationalError } from './telemetry.js';
import { createModelMeter } from './model-meter.js';
import { contentHash } from './security.js';
import type { EngineServices, MissionEvent } from './engine.js';
import { createCoreTools } from './core-tools.js';
import { taskKnowledge } from './knowledge.js';
import { createMessagePublisher } from './message-stream.js';
import { createSourcingTools } from './sourcing-tools.js';
import { missionTraceExportAllowed } from './maintenance.js';

function objects(value: JsonValue | undefined): Record<string, JsonValue>[] {
  return z.array(JsonObjectSchema).catch([]).parse(value);
}
function stableId(input: string): string {
  const hash = contentHash(input);
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
export interface ToolRegistry {
  forTask(scope: ActorScope, task: TaskBrief): Promise<Record<string, AgentToolHandler>>;
}
export function createModelServices(
  scope: ActorScope,
  registry: ToolRegistry,
  dispatch: (brief: TaskBrief) => Promise<void>,
  testModelForTask?: (brief: TaskBrief) => Model,
): EngineServices {
  if (testModelForTask && process.env.NODE_ENV !== 'test')
    throw new Error('validation: scenario test model factory is forbidden outside tests');
  const env = environment();
  initializeTelemetry('runtime');
  const routing = {
    frontier: env.MODEL_FRONTIER ?? '',
    mid: env.MODEL_MID ?? '',
    small: env.MODEL_SMALL ?? '',
    realtime: env.MODEL_REALTIME ?? '',
    reviewer: env.MODEL_REVIEWER ?? '',
  };
  const run = async (task: TaskBrief, snapshot: Record<string, JsonValue>, steps: DurableSteps, extra?: Record<string, JsonValue>) => {
    let result: Result<RunResult | PlanDelta>;
    try {
      const roleCard = await readFile(new URL(`../roles/${task.role}.md`, import.meta.url), 'utf8');
      const playbook = await withRole(task.role === 'lead' ? 'lead_role' : 'specialist_role', scope, db => taskKnowledge(db, task));
      const decisions = objects(snapshot.decisions),
        resolutions = objects(snapshot.decision_resolutions),
        supersessions = objects(snapshot.decision_supersessions),
        stale = objects(snapshot.stale_marks);
      const approved = decisions.filter(
        d =>
          resolutions.some(r => r.decision_id === d.id && ['approve', 'choose'].includes(String(r.response))) &&
          !supersessions.some(s => s.previous_id === d.id) &&
          !stale.some(s => s.node_id === d.id),
      );
      const versions = objects(snapshot.artifact_versions)
        .slice(-30)
        .map(v => ({ id: v.id ?? null, artifactId: v.artifact_id ?? null, content: JSON.stringify(v.content).slice(0, 1000) }));
      const messages = objects(snapshot.messages)
        .filter(m => m.direction === 'inbound')
        .slice(-8);
      const tools = { ...(await registry.forTask(scope, task)), ...createCoreTools(scope), ...createSourcingTools(scope, task, steps) };
      result = await executeAgentRun({
        ...(testModelForTask ? { testModel: testModelForTask(task) } : {}),
        runId: task.id,
        routing,
        steps,
        tools,
        apiKey: env.OPENAI_API_KEY,
        traceExportAllowed: process.env.OPENAI_TRACE_EXPORT_ENABLED === 'true' && (await missionTraceExportAllowed(scope)),
        ...(task.role === 'lead' ? { onModelText: createMessagePublisher(scope, task.id) } : {}),
        modelMeter: createModelMeter(scope, task.id, task.role === 'reviewer' ? routing.reviewer : routing[task.tier]),
        context: {
          missionId: task.missionId,
          roleCard,
          missionBrief: JSON.stringify({
            mission: snapshot.mission,
            knownFacts: snapshot.conversation_facts,
            knowledge: snapshot.knowledge,
            playbook,
            readiness: snapshot.readiness,
            questions: snapshot.mission_questions,
            answers: snapshot.question_answers,
            activeRuns: objects(snapshot.runs).filter(r => !objects(snapshot.run_results).some(done => done.run_id === r.id)),
            request: extra ?? null,
          }),
          bindingDecisions: approved,
          task,
          artifacts: versions,
          commitmentsAndEvents: [
            ...objects(snapshot.commitments).slice(-12),
            ...objects(snapshot.events).slice(-8),
            ...objects(snapshot.command_requests).slice(-8),
            ...objects(snapshot.run_results).slice(-4),
          ],
          counterparty: messages.map(m => ({
            provenance: { evidenceId: z.uuid().parse(m.id), source: `message:${String(m.id)}`, receivedAt: String(m.created_at) },
            content: String(m.original),
            classification: 'untrusted_data' as const,
          })),
        },
        recordProgress: async (step, phase, label) => {
          await withRole(task.role === 'lead' ? 'lead_role' : 'specialist_role', scope, d =>
            d.query('select public.record_run_progress($1,$2,$3,$4,$5)', [scope.missionId, task.id, step, phase, label]),
          );
        },
        recordTelemetry: async telemetry => {
          await withRole(task.role === 'lead' ? 'lead_role' : 'specialist_role', scope, async db => {
            await db.query(
              'insert into public.run_telemetry(mission_id,run_id,role,tier,model,context_hash,tokens,tool_calls,elapsed_ms) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
              [
                task.missionId,
                task.id,
                task.role,
                task.tier,
                telemetry.model,
                telemetry.contextHash,
                telemetry.tokens,
                telemetry.toolCalls,
                telemetry.elapsedMs,
              ],
            );
          });
        },
      });
    } catch (error) {
      const validation = error instanceof z.ZodError || (error instanceof Error && error.message.startsWith('validation:'));
      result = {
        ok: false,
        error: {
          code: validation ? 'validation' : 'provider_down',
          message: validation
            ? 'Run configuration failed validation; no work completed'
            : 'Run preparation is unavailable; no work completed',
          retryable: !validation,
        },
      };
    }
    if (!result.ok && task.role === 'lead')
      await withRole('lead_role', scope, d => d.query('select public.clear_agent_message_stream($1,$2)', [scope.missionId, task.id]));
    if (!result.ok)
      reportOperationalError(new Error(`${result.error.code}: agent run failed`), {
        service: 'runtime',
        operation: 'agent_run',
        missionId: scope.missionId,
        runId: task.id,
        role: task.role,
        tier: task.tier,
      });
    if (task.role === 'lead' || task.role === 'reviewer' || !result.ok) {
      await steps.run(`${task.id}:record-final-outcome`, () =>
        withRole(task.role === 'lead' ? 'lead_role' : 'specialist_role', scope, async db => {
          await db.query('insert into public.run_results(mission_id,run_id,result) values($1,$2,$3) on conflict(run_id) do nothing', [
            task.missionId,
            task.id,
            JSON.stringify(result.ok ? { status: 'proposed', output: result.value } : { status: 'failed', error: result.error }),
          ]);
        }),
      );
    }
    return result;
  };
  const internalBrief = async (id: string, role: Role, objective: string): Promise<TaskBrief> => {
    const task = TaskBriefSchema.parse({
      id,
      missionId: scope.missionId,
      role,
      outcome: 'brand',
      objective,
      constraints: ['Binding decisions cannot be changed silently', 'No inferred external success'],
      budgetAuthority: [],
      deadline: new Date(Date.now() + 300000).toISOString(),
      doneCriteria: ['Ground each proposed action in current ledgers', 'Respect unresolved approvals and evidence gaps'],
      evidenceRequired: ['current mission ledgers'],
      playbook: { id: 'mission-control', version: 1, step: role, source: 'https://openai.github.io/openai-agents-js/' },
      maxToolCalls: role === 'lead' ? 20 : 10,
      maxTokens: role === 'lead' ? 30000 : 16000,
      tier: role === 'lead' ? 'frontier' : 'mid',
      requestedByFounder: role === 'lead',
      overdueExposure: false,
      unblocks: [],
      parentRunId: null,
    });
    await withRole('lead_role', scope, async db => {
      await db.query(
        'insert into public.runs(id,mission_id,role,brief,context_pack_hash,model_tier,status) values($1,$2,$3,$4,$5,$6,$7) on conflict(id) do nothing',
        [id, scope.missionId, role, task, contentHash(task), task.tier, 'scheduled'],
      );
    });
    return task;
  };
  return {
    plan: async (snapshot, event: MissionEvent, steps) => {
      const task = await steps.run('lead-brief', () =>
        internalBrief(
          stableId(`${event.missionId}:${event.id}:lead`),
          'lead',
          'Reconcile this event against the six current outcomes and return the next bounded plan.',
        ),
      );
      const result = await run(task, snapshot, steps, { event: value(event) });
      if (!result.ok) return result;
      return { ok: true, value: PlanDeltaSchema.parse(result.value) };
    },
    run: async (task, snapshot, steps) => {
      const result = await run(task, snapshot, steps);
      if (!result.ok) return result;
      return { ok: true, value: RunResultSchema.parse(result.value) };
    },
    review: async (output, snapshot, steps) => {
      const id = stableId(`${scope.missionId}:review:${contentHash(output)}`);
      const task = await steps.run(`review-brief-${id}`, () =>
        internalBrief(
          id,
          'reviewer',
          'Adversarially verify this proposed decision. Inspect only its output and source ledgers. Missing evidence is a defect.',
        ),
      );
      const result = await run(task, snapshot, steps, { decision: value(output) });
      if (!result.ok) return { accepted: false, defects: [result.error.message] };
      const report = RunResultSchema.parse(result.value);
      const evidence = objects(snapshot.evidence),
        stale = objects(snapshot.stale_marks);
      const validIds = new Set(
        evidence.filter(e => !stale.some(s => s.node_id === e.id) && !evidence.some(newer => newer.supersedes_id === e.id)).map(e => e.id),
      );
      const defects = [...report.selfAssessment.gaps];
      for (const required of task.doneCriteria)
        if (
          !report.selfAssessment.criteria.some(
            c => c.criterion === required && c.met && c.evidenceIds.length > 0 && c.evidenceIds.every(id => validIds.has(id)),
          )
        )
          defects.push(`Missing evidence-backed criterion: ${required}`);
      for (const criterion of report.selfAssessment.criteria)
        if (!criterion.met || criterion.evidenceIds.some(id => !validIds.has(id)))
          defects.push(`Unproven review criterion: ${criterion.criterion}`);
      return { accepted: report.selfAssessment.complete && defects.length === 0, defects };
    },
    dispatch,
  };
}
function value(data: unknown): JsonValue {
  return JSON.parse(JSON.stringify(data)) as JsonValue;
}
