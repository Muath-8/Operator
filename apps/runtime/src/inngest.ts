import { reconcileDomainRegistrations } from './registrar.js';
import { Inngest } from 'inngest';
import { z } from 'zod';
import { JsonObjectSchema } from '@lo/state';

import { withRole, type ActorScope } from './database.js';
import {
  appendActivity,
  drainMissionOutbox,
  loadMissionSnapshot,
  missionTick,
  persistRunResult,
  MissionEventSchema,
  type MissionEvent,
} from './engine.js';
import { createModelServices } from './model-services.js';
import {
  providerToolRegistry,
  reconcileProviderPayments,
  reconcileVoiceConfirmations,
  reconcileMarketplaceInbox,
} from './provider-tools.js';
import { TaskBriefSchema } from './contracts.js';
import type { DurableSteps } from './agents.js';
import { reconcileApprovedEffects } from './approved-effects.js';
import { runtimeMissionScopes } from './scheduler.js';
import { reportOperatorHealth } from './operations.js';
import { reconcileCommitmentChases } from './chase.js';
import { reportOperationalError } from './telemetry.js';
import { reconcileProfessionalEngagements } from './professional.js';
import { reconcileSourcingCampaigns } from './sourcing-campaign.js';
import { reconcileNotifications } from './notification-service.js';

export const inngest = new Inngest({ id: 'launch-operator', eventKey: process.env.INNGEST_EVENT_KEY });
export async function sendMissionEvent(event: MissionEvent): Promise<void> {
  await inngest.send({ id: event.id, name: 'mission/tick', data: MissionEventSchema.parse(event) });
}
export async function flushOutbox(scope: ActorScope): Promise<number> {
  return drainMissionOutbox(scope, sendMissionEvent);
}
function services(scope: ActorScope) {
  return createModelServices(scope, providerToolRegistry, async brief => {
    await inngest.send({
      id: `run:${brief.id}`,
      name: 'mission/specialist',
      data: { missionId: scope.missionId, authUserId: scope.authUserId, runId: brief.id },
    });
  });
}
export const missionFunction = inngest.createFunction(
  { id: 'mission-tick', triggers: { event: 'mission/tick' }, concurrency: { limit: 1, key: 'event.data.missionId' }, retries: 4 },
  async ({ event, step }) => {
    const data = MissionEventSchema.parse(event.data);
    const scope = { missionId: data.missionId, authUserId: data.authUserId };
    const durable: DurableSteps = { run: async <T>(id: string, work: () => Promise<T>) => (await step.run(id, work)) as T };
    await step.run('execute-approved-effects', () => reconcileApprovedEffects(scope));
    await step.run('reconcile-payment-confirmations', () => reconcileProviderPayments(scope));
    await step.run('reconcile-voice-confirmations', () => reconcileVoiceConfirmations(scope));
    await step.run('reconcile-marketplace-inbox', () => reconcileMarketplaceInbox(scope));
    await step.run('measure-active-validation-pages', () =>
      withRole('policy_role', scope, async db => {
        const pages = await db.query('select id from public.demand_pages where mission_id=$1', [scope.missionId]);
        for (const page of pages.rows) await db.query('select public.measure_demand($1,$2)', [scope.missionId, page.id]);
      }),
    );
    const result = await missionTick(data, durable, services(scope));
    await step.run('reconcile-domain-registrations', () => reconcileDomainRegistrations(scope));
    await step.run('reconcile-professional-engagements', () => reconcileProfessionalEngagements(scope));
    await step.run('reconcile-sourcing-campaigns', () => reconcileSourcingCampaigns(scope));
    await step.run('reconcile-commitment-chases', () => reconcileCommitmentChases(scope));
    await step.run('deliver-due-notifications', () => reconcileNotifications(scope));
    const due = await step.run('collect-open-commitments', () =>
      withRole('lead_role', scope, async db =>
        (
          await db.query(
            "select c.id,c.due_at from public.commitments c where c.mission_id=$1 and not exists(select from public.commitment_states s where s.commitment_id=c.id and s.status='closed') order by c.due_at limit 100",
            [data.missionId],
          )
        ).rows.map(row => ({ id: z.uuid().parse(row.id), dueAt: new Date(String(row.due_at)).toISOString() })),
      ),
    );
    for (const commitment of due)
      await step.sendEvent(`schedule-${commitment.id}`, {
        id: `due:${commitment.id}`,
        name: 'mission/follow-up',
        data: {
          id: `due:${commitment.id}`,
          missionId: data.missionId,
          authUserId: data.authUserId,
          dueAt: commitment.dueAt,
          type: 'commitment.due',
          payload: { commitmentId: commitment.id },
        },
      });
    await step.run('flush-produced-events', () => flushOutbox(scope));
    return result;
  },
);
export const specialistFunction = inngest.createFunction(
  {
    id: 'specialist-run',
    triggers: { event: 'mission/specialist' },
    concurrency: [
      { limit: 4, key: 'event.data.missionId' },
      { limit: 1, key: 'event.data.runId' },
    ],
    retries: 3,
  },
  async ({ event, step }) => {
    const data = z.object({ missionId: z.uuid(), authUserId: z.uuid(), runId: z.uuid() }).strict().parse(event.data);
    const scope = { missionId: data.missionId, authUserId: data.authUserId };
    const durable: DurableSteps = { run: async <T>(id: string, work: () => Promise<T>) => (await step.run(id, work)) as T };
    const brief = await step.run('load-durable-brief', () =>
      withRole('specialist_role', scope, async db => {
        const r = await db.query('select brief from public.runs where mission_id=$1 and id=$2', [data.missionId, data.runId]);
        return TaskBriefSchema.parse(r.rows[0]?.brief);
      }),
    );
    if (['lead', 'voice'].includes(brief.role)) throw new Error('validation: invalid specialist role');
    const snapshot = await step.run('load-run-context', () => loadMissionSnapshot(scope));
    if (snapshot.status === 'paused' || snapshot.status === 'ended') return { status: snapshot.status };
    const result = await services(scope).run(brief, JsonObjectSchema.parse(snapshot), durable);
    if (!result.ok) {
      await step.run('record-run-failure', () =>
        withRole('specialist_role', scope, db => appendActivity(db, scope, 'failed', result.error.message, [data.runId])),
      );
      await step.run('notify-run-failure', () => reconcileNotifications(scope));
      return { status: 'failed', error: result.error.code };
    }
    await step.run('persist-run-result', () => persistRunResult(scope, brief, result.value));
    await step.sendEvent('wake-lead', {
      id: `result:${brief.id}`,
      name: 'mission/tick',
      data: {
        id: `result:${brief.id}`,
        missionId: data.missionId,
        authUserId: data.authUserId,
        type: 'run.completed',
        payload: { runId: data.runId },
      },
    });
    return { status: 'proposed', runId: data.runId };
  },
);
export const dueFunction = inngest.createFunction(
  { id: 'mission-follow-up', triggers: { event: 'mission/follow-up' }, retries: 3 },
  async ({ event, step }) => {
    const data = z
      .object({
        missionId: z.uuid(),
        authUserId: z.uuid(),
        id: z.string(),
        dueAt: z.iso.datetime(),
        type: z.string(),
        payload: JsonObjectSchema,
      })
      .strict()
      .parse(event.data);
    await step.sleepUntil('wait-until-due', data.dueAt);
    await step.run('reconcile-before-follow-up', () => sendMissionEvent(data));
    return { status: 'queued' };
  },
);
export const reconciliationFunction = inngest.createFunction(
  { id: 'reconcile-outbox-and-provider-confirmations', triggers: { cron: '* * * * *' }, concurrency: 1, retries: 3 },
  async ({ step }) => {
    const scopes = await step.run('list-routing-scopes', () => runtimeMissionScopes());
    let delivered = 0;
    const failures: string[] = [];
    for (const scope of scopes) {
      try {
        await step.run(`approved-effects-${scope.missionId}`, () => reconcileApprovedEffects(scope));
        delivered += await step.run(`outbox-${scope.missionId}`, () => flushOutbox(scope));
        await step.run(`payments-${scope.missionId}`, () => reconcileProviderPayments(scope));
        await step.run(`voice-confirmations-${scope.missionId}`, () => reconcileVoiceConfirmations(scope));
        await step.run(`marketplace-inbox-${scope.missionId}`, () => reconcileMarketplaceInbox(scope));
        await step.run(`registrations-${scope.missionId}`, () => reconcileDomainRegistrations(scope));
        await step.run(`professionals-${scope.missionId}`, () => reconcileProfessionalEngagements(scope));
        await step.run(`sourcing-campaigns-${scope.missionId}`, () => reconcileSourcingCampaigns(scope));
        await step.run(`chases-${scope.missionId}`, () => reconcileCommitmentChases(scope));
        await step.run(`notifications-${scope.missionId}`, () => reconcileNotifications(scope));
      } catch (error) {
        failures.push(scope.missionId ?? '');
        reportOperationalError(error instanceof Error ? error : new Error('reconciliation failed'), {
          service: 'runtime',
          operation: 'mission_reconciliation',
          missionId: scope.missionId,
        });
      }
    }
    if (failures.length)
      throw new Error(`provider_down: reconciliation failed for ${failures.length} missions; completed missions retain their checkpoints`);
    return { missions: scopes.length, delivered };
  },
);
export const operationsFunction = inngest.createFunction(
  { id: 'operator-health', triggers: { cron: '*/5 * * * *' }, concurrency: 1, retries: 2 },
  async ({ step }) => step.run('measure-and-report', () => reportOperatorHealth()),
);
export const runtimeFunctions = [missionFunction, specialistFunction, dueFunction, reconciliationFunction, operationsFunction];
