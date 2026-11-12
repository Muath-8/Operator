import { z } from 'zod';
import { receiptSchema } from '@lo/policy';
import type { Transport } from '@lo/adapters';
import { withRole, type ActorScope } from './database.js';
import { ProviderStorage } from './provider-storage.js';
import { sendProviderMessage } from './provider-tools.js';
import { TaskBriefSchema } from './contracts.js';

const key = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/);
export const ProfessionalTermsSchema = z
  .object({
    professionalId: z.uuid(),
    briefVersionId: z.uuid(),
    quoteEvidenceId: z.uuid(),
    verificationEvidenceIds: z.array(z.uuid()).min(2).max(20),
    amountMinor: z.number().int().safe().positive(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    dueAt: z.iso.datetime(),
    service: z.string().trim().min(1).max(200),
    regulated: z.boolean(),
    language: z.enum(['en', 'ar']).default('en'),
    deliverables: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
            title: z.string().trim().min(1).max(200),
            requiredFields: z.array(key).min(1).max(30),
          })
          .strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();
export const ProfessionalPaymentSchema = z
  .object({ engagementId: z.uuid(), artifactVersionId: z.uuid(), briefVersionId: z.uuid() })
  .strict();
export const ProfessionalDocumentSchema = z
  .object({
    professionalId: z.uuid(),
    briefVersionId: z.uuid(),
    deliverableId: z.string().min(1),
    sourceEvidenceId: z.uuid(),
    fields: z.record(z.string(), z.json()),
  })
  .strict();
export const ProfessionalConfirmationSchema = z
  .object({ engagementId: z.uuid(), deliveryId: z.uuid(), sourceEvidenceIds: z.array(z.uuid()).min(1) })
  .strict();
export const CreateProfessionalEngagementSchema = z
  .object({
    decisionId: z.uuid(),
    artifactVersionId: z.uuid(),
    mandateId: z.uuid().optional(),
    idempotencyKey: z.string().min(16).max(256),
  })
  .strict();
export const ReceiveProfessionalDeliverableSchema = z
  .object({ engagementId: z.uuid(), deliverableId: z.string().min(1).max(80), sourceEvidenceId: z.uuid(), documentVersionId: z.uuid() })
  .strict();
const DispatchSchema = z
  .object({
    engagementId: z.uuid(),
    taskId: z.uuid(),
    professionalId: z.uuid(),
    artifactVersionId: z.uuid(),
    mandateId: z.uuid().nullable(),
  })
  .strict();
export const ProfessionalSnapshotSchema = z
  .object({
    id: z.uuid(),
    sandboxMode: z.boolean(),
    current: z.boolean(),
    professionalId: z.uuid(),
    artifactVersionId: z.uuid(),
    briefVersionId: z.uuid(),
    quoteEvidenceId: z.uuid(),
    started: z.boolean(),
    startReceiptId: z.uuid().nullable(),
    commitmentId: z.uuid().nullable(),
    amountMinor: z.number().int().safe().positive(),
    currency: z.string(),
    paidMinor: z.string().regex(/^\d+$/),
    refundedMinor: z.string().regex(/^\d+$/),
    deliveries: z.array(
      z
        .object({
          id: z.uuid(),
          deliverableId: z.string(),
          documentVersionId: z.uuid(),
          sourceEvidenceId: z.uuid(),
          claimedEvidenceId: z.uuid(),
          confirmed: z.boolean(),
          confirmationEvidenceId: z.uuid().nullable(),
        })
        .strict(),
    ),
    paymentIds: z.array(z.uuid()),
  })
  .strict();
export type ProfessionalSnapshot = z.infer<typeof ProfessionalSnapshotSchema>;

export async function prepareProfessionalEngagement(scope: ActorScope, input: z.input<typeof ProfessionalTermsSchema>): Promise<string> {
  const terms = ProfessionalTermsSchema.parse(input);
  return withRole('specialist_role', scope, async db =>
    z.uuid().parse((await db.query('select public.prepare_professional_engagement($1,$2)id', [scope.missionId, terms])).rows[0]?.id),
  );
}
export async function createProfessionalEngagement(
  scope: ActorScope,
  input: z.input<typeof CreateProfessionalEngagementSchema>,
): Promise<string> {
  const request = CreateProfessionalEngagementSchema.parse(input);
  return withRole('specialist_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.create_professional_engagement($1,$2,$3,$4,$5)id', [
            scope.missionId,
            request.decisionId,
            request.artifactVersionId,
            request.mandateId ?? null,
            request.idempotencyKey,
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function receiveProfessionalDeliverable(
  scope: ActorScope,
  input: z.input<typeof ReceiveProfessionalDeliverableSchema>,
): Promise<string> {
  const request = ReceiveProfessionalDeliverableSchema.parse(input);
  return withRole('specialist_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.receive_professional_deliverable($1,$2,$3,$4,$5)id', [
            scope.missionId,
            request.engagementId,
            request.deliverableId,
            request.documentVersionId,
            request.sourceEvidenceId,
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function confirmProfessionalDeliverable(scope: ActorScope, decisionId: string, artifactVersionId: string): Promise<string> {
  return withRole('founder_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.confirm_professional_deliverable($1,$2,$3)id', [
            scope.missionId,
            z.uuid().parse(decisionId),
            z.uuid().parse(artifactVersionId),
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function registerProfessionalPayment(scope: ActorScope, input: { engagementId: string; paymentId: string }): Promise<string> {
  const request = z.object({ engagementId: z.uuid(), paymentId: z.uuid() }).strict().parse(input);
  return withRole('policy_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.register_professional_payment($1,$2,$3)id', [
            scope.missionId,
            request.engagementId,
            request.paymentId,
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function readProfessionalEngagement(scope: ActorScope, engagementId: string): Promise<ProfessionalSnapshot> {
  return withRole('lead_role', scope, async db =>
    ProfessionalSnapshotSchema.parse(
      (await db.query('select public.professional_engagement_snapshot($1,$2)result', [scope.missionId, z.uuid().parse(engagementId)]))
        .rows[0]?.result,
    ),
  );
}

/** The existing message policy owns consent, modes, approval, reservation,
 * credentials and remote dispatch. This consumer never creates a provider receipt. */
export async function reconcileProfessionalEngagements(
  scope: ActorScope,
  transport?: Transport,
): Promise<{ examined: number; sent: number; held: number }> {
  if (transport && process.env['NODE_ENV'] !== 'test') throw new Error('Synthetic professional transport is forbidden outside tests');
  await withRole('policy_role', scope, db => db.query('select public.reconcile_professional_starts($1)', [scope.missionId]));
  const ids = await withRole('lead_role', scope, async db =>
    (
      await db.query(
        'select e.id from public.professional_engagements e where e.mission_id=$1 and not exists(select from public.professional_starts s where s.engagement_id=e.id)order by e.created_at,e.id limit 100',
        [scope.missionId],
      )
    ).rows.map(r => z.uuid().parse(r.id)),
  );
  const result = { examined: ids.length, sent: 0, held: 0 },
    storage = new ProviderStorage(scope);
  for (const id of ids) {
    let status: 'draft' | 'blocked' | 'ambiguous' = 'blocked',
      reason = 'Current approved professional brief, verification, consent or authority is unavailable.';
    try {
      const next = await withRole('lead_role', scope, async db => {
        const raw = (await db.query('select public.next_professional_engagement($1,$2)result', [scope.missionId, id])).rows[0]?.result;
        return raw === null ? null : DispatchSchema.parse(raw);
      });
      if (next === null) continue;
      const task = TaskBriefSchema.parse({
        id: next.taskId,
        missionId: scope.missionId,
        role: 'operations',
        outcome: 'compliance',
        objective: 'Transmit the exact founder-approved brief to the verified professional',
        constraints: [
          'Only the named qualified professional performs this work',
          'Do not certify, file, sign or amend approved commercial terms',
        ],
        budgetAuthority: next.mandateId ? [next.mandateId] : [],
        deadline: new Date(Date.now() + 300000).toISOString(),
        doneCriteria: ['Actual exact brief provider receipt recorded'],
        evidenceRequired: ['Current approved Engagement cost and professional verification'],
        playbook: { id: 'professional-coordination', version: 1, step: 'approved-brief', source: 'BRD:FR-SPC-01..05' },
        maxToolCalls: 1,
        maxTokens: 256,
        tier: 'small',
        requestedByFounder: false,
        overdueExposure: false,
        unblocks: ['compliance'],
        parentRunId: null,
      });
      const raw: unknown = await sendProviderMessage(
          storage,
          task,
          {
            counterpartyId: next.professionalId,
            artifactVersionId: next.artifactVersionId,
            ...(next.mandateId ? { mandateId: next.mandateId } : {}),
          },
          'email',
          false,
          transport,
        ),
        sent = z
          .object({ ok: z.literal(true), receipt: receiptSchema })
          .passthrough()
          .safeParse(raw);
      if (!sent.success) {
        if (
          z
            .object({ ok: z.literal(true), data: z.object({ status: z.literal('draft') }).passthrough() })
            .passthrough()
            .safeParse(raw).success
        ) {
          status = 'draft';
          reason = 'Guide or Help requires founder review; the professional has not been briefed.';
        } else if (
          z
            .object({ retry: z.literal('reconcile') })
            .passthrough()
            .safeParse(raw).success
        ) {
          status = 'ambiguous';
          reason = 'Provider outcome is uncertain; reconcile the same task without resending.';
        }
      } else {
        await withRole('policy_role', scope, db => db.query('select public.reconcile_professional_starts($1)', [scope.missionId]));
        result.sent++;
        continue;
      }
    } catch {
      status = 'blocked';
    }
    await withRole('policy_role', scope, db =>
      db.query('select public.hold_professional_engagement($1,$2,$3,$4)', [scope.missionId, id, status, reason]),
    );
    result.held++;
  }
  return result;
}
