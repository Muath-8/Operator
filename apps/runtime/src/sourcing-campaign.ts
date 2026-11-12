import { z } from 'zod';
import { outboundMessageSchema, type Transport } from '@lo/adapters';
import { receiptSchema } from '@lo/policy';
import { withRole, type ActorScope } from './database.js';
import { ProviderStorage } from './provider-storage.js';
import { sendProviderMessage } from './provider-tools.js';
import { TaskBriefSchema } from './contracts.js';

export const RfqRequestSchema = z
  .object({
    specVersionId: z.uuid(),
    quantityMin: z.number().int().positive().max(999999999),
    quantityMax: z.number().int().positive().max(999999999),
    targetDate: z.iso.datetime(),
    artworkVersionIds: z.array(z.uuid()).max(30),
    language: z.enum(['en', 'ar']),
    subject: z.string().trim().min(1).max(200),
  })
  .strict()
  .refine(v => v.quantityMax >= v.quantityMin, 'Quantity maximum must cover minimum');
export const RfqArtifactSchema = z.object({ rfq: RfqRequestSchema, payload: outboundMessageSchema }).strict();
export const CampaignRecipientSchema = z
  .object({ supplierId: z.uuid(), verificationEvidenceIds: z.array(z.uuid()).min(2).max(20), mandateId: z.uuid() })
  .strict();
export const CreateCampaignSchema = z
  .object({
    rfqVersionId: z.uuid(),
    recipients: z.array(CampaignRecipientSchema).min(1).max(50),
    idempotencyKey: z.string().min(16).max(256),
    exceptionEvidenceId: z.uuid().optional(),
  })
  .strict();
export const SampleOrderSchema = z.object({ campaignId: z.uuid(), supplierId: z.uuid(), specVersionId: z.uuid() }).strict();
export const CampaignPaymentSchema = SampleOrderSchema.extend({
  stage: z.enum(['deposit', 'balance']),
  proformaVersionId: z.uuid(),
  inspectionCommitmentId: z.uuid().optional(),
})
  .strict()
  .refine(v => v.stage !== 'balance' || v.inspectionCommitmentId !== undefined, 'Balance requires exact inspection');
export const CampaignCountExceptionSchema = z
  .object({
    riskAccepted: z.literal(true),
    exception: z.literal('rfq_candidate_count'),
    rfqVersionId: z.uuid(),
    supplierIds: z.array(z.uuid()).min(1).max(7),
    sourceEvidenceIds: z.array(z.uuid()).min(1),
  })
  .strict();
export const CampaignInspectionConfirmationSchema = z
  .object({
    campaignId: z.uuid(),
    commitmentId: z.uuid(),
    result: z.enum(['clean', 'failed']),
    sourceEvidenceIds: z.array(z.uuid()).min(1),
  })
  .strict();
export const SourcingCampaignSnapshotSchema = z
  .object({
    sandboxMode: z.boolean(),
    id: z.uuid(),
    rfqVersionId: z.uuid(),
    specVersionId: z.uuid(),
    current: z.boolean(),
    recipientCount: z.number().int().nonnegative(),
    sentCount: z.number().int().nonnegative(),
    shortlistCurrent: z.boolean(),
    shortlistedSupplierIds: z.array(z.uuid()),
    paidSampleSupplierCount: z.number().int().nonnegative(),
    proformaVersionId: z.uuid().nullable(),
    inspectionCommitmentId: z.uuid().nullable(),
    exceptionEvidenceId: z.uuid().nullable(),
  })
  .strict();
export type SourcingCampaignSnapshot = z.infer<typeof SourcingCampaignSnapshotSchema>;

export async function prepareRfq(
  scope: ActorScope,
  input: z.input<typeof RfqRequestSchema>,
): Promise<{ artifactVersionId: string; content: z.infer<typeof RfqArtifactSchema> }> {
  const { specVersionId, ...brief } = RfqRequestSchema.parse(input);
  return withRole('specialist_role', scope, async db => {
    const id = z
      .uuid()
      .parse((await db.query('select public.prepare_sourcing_rfq($1,$2,$3)id', [scope.missionId, specVersionId, brief])).rows[0]?.id);
    return {
      artifactVersionId: id,
      content: RfqArtifactSchema.parse(
        (await db.query('select content from public.artifact_versions where mission_id=$1 and id=$2', [scope.missionId, id])).rows[0]
          ?.content,
      ),
    };
  });
}
export async function createSourcingCampaign(scope: ActorScope, input: z.input<typeof CreateCampaignSchema>): Promise<string> {
  const value = CreateCampaignSchema.parse(input),
    recipients = value.recipients
      .map(r => ({ ...r, verificationEvidenceIds: [...r.verificationEvidenceIds].sort() }))
      .sort((a, b) => a.supplierId.localeCompare(b.supplierId));
  return withRole('specialist_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.create_sourcing_campaign($1,$2,$3,$4,$5)id', [
            scope.missionId,
            value.rfqVersionId,
            JSON.stringify(recipients),
            value.idempotencyKey,
            value.exceptionEvidenceId ?? null,
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function readSourcingCampaign(scope: ActorScope, campaignId: string): Promise<SourcingCampaignSnapshot> {
  return withRole('lead_role', scope, async db =>
    SourcingCampaignSnapshotSchema.parse(
      (await db.query('select public.sourcing_campaign_snapshot($1,$2)result', [scope.missionId, z.uuid().parse(campaignId)])).rows[0]
        ?.result,
    ),
  );
}
export async function shortlistCampaign(
  scope: ActorScope,
  input: { campaignId: string; comparisonVersionId: string; supplierIds: string[] },
): Promise<string> {
  const v = z
    .object({ campaignId: z.uuid(), comparisonVersionId: z.uuid(), supplierIds: z.array(z.uuid()).min(3).max(5) })
    .strict()
    .parse(input);
  return withRole('specialist_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.shortlist_sourcing_campaign($1,$2,$3,$4)id', [
            scope.missionId,
            v.campaignId,
            v.comparisonVersionId,
            v.supplierIds,
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function registerCampaignSample(
  scope: ActorScope,
  input: { campaignId: string; paymentId: string; expectedArrival: string; trackingReference: string },
): Promise<string> {
  const v = z
    .object({
      campaignId: z.uuid(),
      paymentId: z.uuid(),
      expectedArrival: z.iso.datetime(),
      trackingReference: z.string().trim().min(1).max(500),
    })
    .strict()
    .parse(input);
  return withRole('policy_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.register_sourcing_campaign_sample($1,$2,$3,$4,$5)id', [
            scope.missionId,
            v.campaignId,
            v.paymentId,
            v.expectedArrival,
            v.trackingReference,
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function linkCampaignProforma(scope: ActorScope, campaignId: string, proformaVersionId: string): Promise<string> {
  return withRole('specialist_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.link_sourcing_campaign_proforma($1,$2,$3)id', [
            scope.missionId,
            z.uuid().parse(campaignId),
            z.uuid().parse(proformaVersionId),
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function linkCampaignInspection(scope: ActorScope, campaignId: string, commitmentId: string): Promise<string> {
  return withRole('specialist_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.link_sourcing_campaign_inspection($1,$2,$3)id', [
            scope.missionId,
            z.uuid().parse(campaignId),
            z.uuid().parse(commitmentId),
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function confirmCampaignException(scope: ActorScope, decisionId: string, versionId: string): Promise<string> {
  return withRole('founder_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.confirm_sourcing_campaign_exception($1,$2,$3)id', [
            scope.missionId,
            z.uuid().parse(decisionId),
            z.uuid().parse(versionId),
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function confirmCampaignInspection(scope: ActorScope, decisionId: string, versionId: string): Promise<string> {
  return withRole('founder_role', scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.confirm_sourcing_campaign_inspection($1,$2,$3)id', [
            scope.missionId,
            z.uuid().parse(decisionId),
            z.uuid().parse(versionId),
          ])
        ).rows[0]?.id,
      ),
  );
}

const DispatchSchema = z
  .object({
    recipientId: z.uuid(),
    campaignId: z.uuid(),
    taskId: z.uuid(),
    supplierId: z.uuid(),
    mandateId: z.uuid(),
    rfqVersionId: z.uuid(),
    dispatchVersionId: z.uuid(),
  })
  .strict();
/** The only external operation is the existing guarded message capability.
 * Exact approved payload, current channel policy, mode and single-use/mandate
 * authority are rechecked by the provider boundary. Synthetic HTTP is test-only. */
export async function reconcileSourcingCampaigns(
  scope: ActorScope,
  transport?: Transport,
): Promise<{ examined: number; sent: number; held: number }> {
  if (transport && process.env['NODE_ENV'] !== 'test') throw new Error('validation: synthetic RFQ transport forbidden outside tests');
  const missionId = z.uuid().parse(scope.missionId),
    storage = new ProviderStorage(scope);
  await withRole('policy_role', scope, db => db.query('select public.reconcile_outbound_receipts($1)', [missionId]));
  await withRole('policy_role', scope, db => db.query('select public.reconcile_sourcing_campaign_deliveries($1)', [missionId]));
  const ids = await withRole('lead_role', scope, async db =>
    (
      await db.query(
        'select r.id from public.sourcing_campaign_recipients r where r.mission_id=$1 and not exists(select from public.sourcing_campaign_deliveries d where d.recipient_id=r.id)order by r.created_at,r.id limit 100',
        [missionId],
      )
    ).rows.map(r => z.uuid().parse(r.id)),
  );
  const result = { examined: ids.length, sent: 0, held: 0 };
  for (const recipientId of ids) {
    let status: 'draft' | 'blocked' | 'ambiguous' = 'blocked',
      reason = 'Current RFQ, supplier, channel or outreach authority unavailable.';
    try {
      const next = await withRole('lead_role', scope, async db => {
        const raw = (await db.query('select public.next_sourcing_campaign_recipient($1,$2)result', [missionId, recipientId])).rows[0]
          ?.result;
        return raw === null ? null : DispatchSchema.parse(raw);
      });
      if (next === null) continue;
      const task = TaskBriefSchema.parse({
        id: next.taskId,
        missionId,
        role: 'operations',
        outcome: 'supply',
        objective: 'Send the identical founder-approved RFQ to this verified supplier',
        constraints: ['Use exact RFQ; no personalisation, terms acceptance, order or founder budget disclosure'],
        budgetAuthority: [next.mandateId],
        deadline: new Date(Date.now() + 300000).toISOString(),
        doneCriteria: ['Record the exact immutable RFQ and real provider receipt'],
        evidenceRequired: ['Approved specification, RFQ, verified supplier and outreach mandate'],
        playbook: {
          id: 'practitioner-sourcing',
          version: 1,
          step: 'identical-rfq-fanout',
          source: 'https://www.epicsourcing.co/epic-guide/how-to-buy-from-alibaba',
        },
        maxToolCalls: 1,
        maxTokens: 256,
        tier: 'small',
        requestedByFounder: false,
        overdueExposure: false,
        unblocks: ['supply'],
        parentRunId: null,
      });
      const raw: unknown = await sendProviderMessage(
          storage,
          task,
          { counterpartyId: next.supplierId, artifactVersionId: next.dispatchVersionId, mandateId: next.mandateId },
          'email',
          false,
          transport,
        ),
        sent = z
          .object({ ok: z.literal(true), receipt: receiptSchema })
          .passthrough()
          .safeParse(raw);
      if (sent.success) {
        const receipt = sent.data.receipt;
        await withRole('policy_role', scope, async db => {
          const id = z
            .uuid()
            .parse(
              (
                await db.query(
                  "select id from public.provider_receipts where mission_id=$1 and provider=$2 and provider_reference=$3 and operation='send_message'and data->>'idempotencyKey'=$4",
                  [missionId, receipt.provider, receipt.providerId, receipt.idempotencyKey],
                )
              ).rows[0]?.id,
            );
          await db.query('select public.record_sourcing_campaign_delivery($1,$2,$3)', [missionId, recipientId, id]);
        });
        result.sent++;
        continue;
      }
      if (
        z
          .object({ ok: z.literal(true), data: z.object({ status: z.literal('draft') }).passthrough() })
          .passthrough()
          .safeParse(raw).success
      ) {
        status = 'draft';
        reason = 'Guide or Help requires founder review; draft is not delivered.';
      } else if (
        z
          .object({ retry: z.literal('reconcile') })
          .passthrough()
          .safeParse(raw).success
      ) {
        status = 'ambiguous';
        reason = 'Provider outcome uncertain; reconcile the same task before any new send.';
      }
    } catch {
      status = 'blocked';
    }
    await withRole('policy_role', scope, db =>
      db.query('select public.hold_sourcing_campaign_recipient($1,$2,$3,$4)', [missionId, recipientId, status, reason]),
    );
    result.held++;
  }
  return result;
}
