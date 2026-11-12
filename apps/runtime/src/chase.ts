import { z } from 'zod';
import { receiptSchema } from '@lo/policy';
import { withRole, type ActorScope } from './database.js';
import { ProviderStorage } from './provider-storage.js';
import { sendProviderMessage } from './provider-tools.js';
import { TaskBriefSchema } from './contracts.js';

const AttemptSchema = z
  .object({
    escalate: z.literal(false),
    chaseId: z.uuid(),
    attemptId: z.uuid(),
    taskId: z.uuid(),
    partyId: z.uuid(),
    channel: z.enum(['email', 'whatsapp']),
    body: z.string().min(1),
    mandateId: z.uuid().nullable(),
    language: z.enum(['ar', 'en']),
  })
  .strict();
const NextSchema = z.union([AttemptSchema, z.object({ escalate: z.literal(true), chaseId: z.uuid() }).strict()]).nullable();
export interface ChaseConfiguration {
  commitmentId: string;
  originMessageId: string;
  alternateChannel?: 'email' | 'whatsapp';
  mandateId?: string;
  comparisonVersionId?: string;
  intervalHours?: number;
}
export async function configureCommitmentChase(scope: ActorScope, input: ChaseConfiguration): Promise<string> {
  const value = z
    .object({
      commitmentId: z.uuid(),
      originMessageId: z.uuid(),
      alternateChannel: z.enum(['email', 'whatsapp']).optional(),
      mandateId: z.uuid().optional(),
      comparisonVersionId: z.uuid().optional(),
      intervalHours: z.number().int().min(1).max(168).optional(),
    })
    .strict()
    .parse(input);
  return withRole('lead_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.configure_commitment_chase($1,$2,$3,$4,$5,$6,$7)id', [
            scope.missionId,
            value.commitmentId,
            value.originMessageId,
            value.alternateChannel ?? null,
            value.mandateId ?? null,
            value.comparisonVersionId ?? null,
            value.intervalHours ?? 24,
          ])
        ).rows[0]?.id,
      ),
  );
}
/** Explicitly configured chases only. Lead may bind a recorded inbound thread,
 * verified alternate, authority and evidence-ranked comparison through the RPC.
 * The scheduler never guesses consent, a supplier ranking or a spending scope. */
export async function reconcileCommitmentChases(
  scope: ActorScope,
): Promise<{ examined: number; sent: number; held: number; escalated: number }> {
  await withRole('policy_role', scope, db => db.query('select public.reconcile_commitment_chase_receipts($1)', [scope.missionId]));
  const missionId = z.uuid().parse(scope.missionId),
    storage = new ProviderStorage(scope),
    ids = await withRole('lead_role', scope, async db =>
      (
        await db.query(
          'select ch.id from public.commitment_chases ch where ch.mission_id=$1 and not exists(select from public.commitment_chase_escalations e where e.chase_id=ch.id)order by ch.created_at,ch.id limit 100',
          [missionId],
        )
      ).rows.map(row => z.uuid().parse(row.id)),
    );
  const summary = { examined: ids.length, sent: 0, held: 0, escalated: 0 };
  for (const id of ids) {
    const next = await withRole('lead_role', scope, async db =>
      NextSchema.parse((await db.query('select public.next_commitment_chase($1,$2)result', [missionId, id])).rows[0]?.result),
    );
    if (next === null) {
      summary.held++;
      continue;
    }
    if (next.escalate) {
      const result = await withRole(
        'lead_role',
        scope,
        async db => (await db.query('select public.escalate_commitment_chase($1,$2)result', [missionId, id])).rows[0]?.result,
      );
      if (result !== null) summary.escalated++;
      else summary.held++;
      continue;
    }
    let status: 'sent' | 'blocked' | 'draft' | 'failed' | 'ambiguous' = 'blocked',
      reason = 'Provider or current channel authority unavailable.',
      receiptId: string | null = null;
    try {
      const contact = await storage.contact(next.partyId),
        text = `${contact.disclosure}\n${next.body}`;
      const task = TaskBriefSchema.parse({
        id: next.taskId,
        missionId,
        role: 'operations',
        outcome: 'supply',
        objective: 'Follow up on the recorded overdue commitment without agreeing terms',
        constraints: ['No offer, acceptance, order, budget disclosure or supplier substitution'],
        budgetAuthority: next.mandateId ? [next.mandateId] : [],
        deadline: new Date(Date.now() + 300000).toISOString(),
        doneCriteria: ['Record the exact written message and provider receipt'],
        evidenceRequired: ['Current channel policy and outreach authority'],
        playbook: { id: 'commitment-chase', version: 1, step: 'written-follow-up', source: 'https://www.twilio.com/docs/messaging' },
        maxToolCalls: 1,
        maxTokens: 256,
        tier: 'small',
        requestedByFounder: false,
        overdueExposure: true,
        unblocks: ['supply'],
        parentRunId: null,
      });
      const raw: unknown = await sendProviderMessage(
        storage,
        task,
        {
          counterpartyId: next.partyId,
          ...(next.mandateId ? { mandateId: next.mandateId } : {}),
          text,
          translation: text,
          subject: next.language === 'ar' ? 'متابعة التحديث المستحق' : 'Follow-up on the outstanding update',
          language: next.language,
          purpose: 'follow_up',
        },
        next.channel,
      );
      const sent = z
        .object({ ok: z.literal(true), receipt: receiptSchema })
        .passthrough()
        .safeParse(raw);
      if (sent.success) {
        const r = sent.data.receipt;
        receiptId = await withRole('policy_role', scope, async db =>
          z
            .uuid()
            .parse(
              (
                await db.query(
                  "select id from public.provider_receipts where mission_id=$1 and provider=$2 and provider_reference=$3 and operation='send_message'and data->>'idempotencyKey'=$4",
                  [missionId, r.provider, r.providerId, r.idempotencyKey],
                )
              ).rows[0]?.id,
            ),
        );
        status = 'sent';
        reason = 'Matching provider receipt and recorded written message.';
      } else if (
        z
          .object({ ok: z.literal(true), data: z.object({ status: z.literal('draft') }).passthrough() })
          .passthrough()
          .safeParse(raw).success
      ) {
        status = 'draft';
        reason = 'Founder review required; draft is not a sent follow-up.';
      } else {
        const failed = z
          .object({ retry: z.enum(['never', 'same_key', 'reconcile']).optional() })
          .passthrough()
          .safeParse(raw);
        status = failed.success && failed.data.retry === 'reconcile' ? 'ambiguous' : 'blocked';
        reason =
          status === 'ambiguous'
            ? 'Earlier provider outcome requires reconciliation; no next chase stage.'
            : 'Current channel policy or authority blocked the send.';
      }
    } catch {
      status = 'blocked';
      reason = 'Provider or current channel authority unavailable.';
    }
    await withRole('policy_role', scope, db =>
      db.query('select public.record_commitment_chase_result($1,$2,$3,$4,$5)', [missionId, next.attemptId, status, reason, receiptId]),
    );
    if (status === 'sent') summary.sent++;
    else summary.held++;
  }
  return summary;
}
