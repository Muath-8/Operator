import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { EffectIntentSchema, type EffectIntent, type PostgresMissionRepository, type ProviderReceipt } from '@lo/state';
export type { EffectIntent } from '@lo/state';

/** The store performs the authoritative check under a mission/mandate lock. */
export const effectIntentSchema = EffectIntentSchema;
export const failureSchema = z
  .object({
    ok: z.literal(false),
    code: z.enum(['provider_down', 'rejected', 'rate_limited', 'window_closed', 'needs_approval', 'invariant_violation', 'validation']),
    message: z.string(),
    retry: z.enum(['never', 'same_key', 'reconcile']),
    retryAfterMs: z.number().int().nonnegative().optional(),
  })
  .strict();
export type Failure = z.infer<typeof failureSchema>;
export function failure(code: Failure['code'], message: string, retry: Failure['retry'] = 'never'): Failure {
  return { ok: false, code, message, retry };
}
export const receiptCorrelationSchema = z
  .object({
    orderId: z.string().min(1),
    captureId: z.string().min(1).optional(),
    authorizationId: z.string().min(1).optional(),
    authorizationExpiresAt: z.iso.datetime().optional(),
    payeeId: z.string().uuid().optional(),
    payeeMerchantId: z.string().min(1).optional(),
    amountMinor: z.number().int().nonnegative().safe().optional(),
    currency: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict();
export const receiptSchema = z
  .object({
    provider: z.string().min(1),
    providerId: z.string().min(1),
    operation: z.string().min(1),
    timestamp: z.string().datetime(),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    idempotencyKey: z.string().min(1),
    sandboxMode: z.boolean(),
    correlation: receiptCorrelationSchema.optional(),
    outbound: z
      .object({
        channel: z.enum(['email', 'whatsapp', 'sms', 'voice']),
        original: z.string().min(1).max(10000),
        translation: z.string().min(1),
        purpose: z.string().min(1),
        subject: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
    verification: z
      .discriminatedUnion('kind', [
        z
          .object({
            kind: z.literal('store_published'),
            outcome: z.literal('commerce'),
            artifactVersionId: z.uuid(),
            method: z.literal('verified_poll'),
          })
          .strict(),
        z
          .object({
            kind: z.literal('founder_owned_domain'),
            outcome: z.literal('brand'),
            artifactVersionId: z.uuid(),
            method: z.literal('verified_poll'),
          })
          .strict(),
      ])
      .optional(),
  })
  .strict();
export type Receipt = z.infer<typeof receiptSchema>;
export type ProviderResult<T> = { ok: true; data: T; receipt: Receipt } | Failure;
export const alwaysApproveActions = new Set([
  'production_order',
  'place_order',
  'agreement',
  'accept_agreement',
  'publish',
  'store_publish',
  'marketing_publish',
  'legal_filing',
  'registration',
  'mission_end',
  'mission_pivot',
  'final_selection',
  'material_terms',
  'refund',
  'payment_refund',
]);
export const approvalBindingSchema = z
  .object({
    action: z.string(),
    counterpartyId: z.string(),
    amountMinor: z.number().int().nonnegative().safe().optional(),
    currency: z.string().optional(),
    artifactVersionId: z.string().optional(),
  })
  .strict();
export type ApprovalBinding = z.infer<typeof approvalBindingSchema>;
export function bindingHash(intent: ApprovalBinding): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        intent.action,
        intent.counterpartyId,
        intent.amountMinor ?? null,
        intent.currency ?? null,
        intent.artifactVersionId ?? null,
      ]),
    )
    .digest('hex');
}
export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function constantTimeEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export interface Mandate {
  id: string;
  missionId: string;
  effectClass: EffectIntent['effectClass'];
  actions: readonly string[];
  counterparties: readonly string[];
  expiresAt: string;
  revokedAt?: string;
  currency?: string;
  perTransactionMinor?: number;
  totalMinor?: number;
  reservedMinor: number;
  spentMinor: number;
  maxActions?: number;
  usedActions: number;
  channels?: readonly string[];
  purposes?: readonly string[];
  instrumentIds?: readonly string[];
}
export interface PolicySnapshot {
  paused: boolean;
  killed: boolean;
  sandboxMode: boolean;
  missionCurrency: string;
  budgetRemainingMinor: number;
  mandates: readonly Mandate[];
  approval?: { tokenHash: string; bindingHash: string; expiresAt: string; consumed: boolean; revoked: boolean };
  /** Trusted approved-artifact/quote projection; never accepted from the model's effect intent. */
  fxConversions?: readonly {
    artifactVersionId: string;
    amountMinor: number;
    currency: string;
    missionCurrency: string;
    missionAmountMinor: number;
    numerator: number;
    denominator: number;
    source: string;
    observedAt: string;
    expiresAt: string;
  }[];
}
export function previewReservationMinor(i: EffectIntent, state: PolicySnapshot, now = new Date()): number | undefined {
  const amount = i.amountMinor ?? 0;
  if (i.action === 'payment_refund' || i.action === 'payment_authorization_capture') return 0;
  if (i.effectClass !== 'spend' || i.currency === state.missionCurrency) return amount;
  const fx = state.fxConversions?.find(
    q =>
      q.artifactVersionId === i.artifactVersionId &&
      q.amountMinor === amount &&
      q.currency === i.currency &&
      q.missionCurrency === state.missionCurrency &&
      q.source === 'https://www.sama.gov.sa/en-US/Currency/FinExc/pages/currency.aspx' &&
      Date.parse(q.observedAt) <= now.getTime() &&
      Date.parse(q.expiresAt) > now.getTime(),
  );
  if (!fx || ![fx.numerator, fx.denominator, fx.missionAmountMinor].every(Number.isSafeInteger) || fx.numerator <= 0 || fx.denominator <= 0)
    return undefined;
  const converted = (BigInt(amount) * BigInt(fx.numerator) + BigInt(fx.denominator) - 1n) / BigInt(fx.denominator);
  return converted <= BigInt(Number.MAX_SAFE_INTEGER) && Number(converted) === fx.missionAmountMinor ? Number(converted) : undefined;
}
export type PolicyDecision =
  | { kind: 'allow'; source: 'approval' | 'mandate'; mandateId?: string; warning?: 'ceiling_80_percent' }
  | { kind: 'draft'; reason: string }
  | { kind: 'deny'; failure: Failure };
/** Pure preview only; never authorizes execution without the atomic repository reservation. */
export function evaluatePolicy(raw: unknown, state: PolicySnapshot, now = new Date()): PolicyDecision {
  const parsed = effectIntentSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'deny', failure: failure('validation', 'Invalid effect intent.') };
  const i = parsed.data;
  if (state.killed || state.paused) return { kind: 'deny', failure: failure('rejected', 'Mission paused or global effects stopped.') };
  if (i.sandboxMode !== state.sandboxMode)
    return { kind: 'deny', failure: failure('invariant_violation', 'Environment does not match mission.') };
  if (i.mode === 'guide' && i.effectClass === 'communicate' && !i.approvalToken)
    return { kind: 'draft', reason: 'Guide mode prepares a draft for founder review.' };
  if (i.mode === 'help' && i.effectClass === 'communicate' && !i.approvalToken)
    return { kind: 'draft', reason: 'Help mode requires a reviewed draft before sending.' };
  const reserved = previewReservationMinor(i, state, now);
  if (reserved === undefined)
    return { kind: 'deny', failure: failure('needs_approval', 'A current approved authoritative FX conversion is required.') };
  const a = state.approval;
  if (
    i.approvalToken &&
    a &&
    !a.consumed &&
    !a.revoked &&
    Date.parse(a.expiresAt) > now.getTime() &&
    constantTimeEquals(a.tokenHash, tokenHash(i.approvalToken)) &&
    constantTimeEquals(a.bindingHash, bindingHash(i))
  ) {
    if (reserved > state.budgetRemainingMinor)
      return { kind: 'deny', failure: failure('needs_approval', 'Approved budget would be exceeded.') };
    return { kind: 'allow', source: 'approval' };
  }
  if (i.approvalToken || alwaysApproveActions.has(i.action) || i.effectClass === 'publish' || i.effectClass === 'bind')
    return { kind: 'deny', failure: failure('needs_approval', 'A valid specific single-use approval is required.') };
  const m = state.mandates.find(
    m =>
      m.id === i.mandateId &&
      m.missionId === i.missionId &&
      !m.revokedAt &&
      Date.parse(m.expiresAt) > now.getTime() &&
      m.effectClass === i.effectClass &&
      m.actions.includes(i.action) &&
      m.counterparties.includes(i.counterpartyId) &&
      (m.maxActions === undefined || m.usedActions < m.maxActions) &&
      (!i.channel || !!m.channels?.includes(i.channel)) &&
      (!i.purpose || !!m.purposes?.includes(i.purpose)) &&
      (!i.instrumentId || !!m.instrumentIds?.includes(i.instrumentId)),
  );
  if (!m) return { kind: 'deny', failure: failure('needs_approval', 'No current mandate covers this action and counterparty.') };
  if (i.effectClass === 'spend') {
    const n = reserved;
    if (
      m.currency !== state.missionCurrency ||
      m.perTransactionMinor === undefined ||
      m.totalMinor === undefined ||
      n > m.perTransactionMinor ||
      n + m.reservedMinor + m.spentMinor > m.totalMinor ||
      n > state.budgetRemainingMinor
    )
      return { kind: 'deny', failure: failure('needs_approval', 'Spend exceeds the mandate, mission currency or budget.') };
    return {
      kind: 'allow',
      source: 'mandate',
      mandateId: m.id,
      ...(n + m.reservedMinor + m.spentMinor >= m.totalMinor * 0.8 ? { warning: 'ceiling_80_percent' as const } : {}),
    };
  }
  return { kind: 'allow', source: 'mandate', mandateId: m.id };
}

export interface EffectReservation {
  authorizationId: string;
  status: 'reserved' | 'started' | 'performed' | 'failed' | 'ambiguous';
  replay: boolean;
  receipt?: Receipt;
}
/** Methods must be durable/atomic, tenant scoped, and recheck pause, revoke, credentials and kill on begin. */
export interface EffectRepository {
  reserveEffect(intent: EffectIntent): Promise<EffectReservation | Failure>;
  beginEffect(authorizationId: string): Promise<{ ok: true } | Failure>;
  completeEffect(authorizationId: string, receipt: Receipt): Promise<void>;
  failEffect(authorizationId: string, ambiguous: boolean): Promise<void>;
  /** Linearizes dispatch against pause/revoke/kill through provider invocation and receipt persistence. */
  withDispatch<T>(authorizationId: string, invoke: (scoped: EffectRepository) => Promise<T>): Promise<T | Failure>;
}
/** Adapt the shared state repository without losing mission scoping or receipt validation. */
export function postgresEffectRepository(repository: PostgresMissionRepository, missionId: string): EffectRepository {
  const convert = (e: { code: Failure['code']; message: string; retryable: boolean }): Failure =>
    failure(e.code, e.message, e.retryable ? 'same_key' : 'never');
  return {
    async reserveEffect(intent) {
      if (intent.missionId !== missionId) return failure('rejected', 'Mission scope mismatch.');
      const r = await repository.reserveEffect(intent);
      if (!r.ok) return convert(r.error);
      if (r.value.replay && r.value.status === 'performed') {
        const stored = await repository.getEffectReceipt(missionId, r.value.authorizationId);
        if (!stored.ok) return convert(stored.error);
        if (stored.value) {
          const d = stored.value.data;
          const correlation = d['orderId']
            ? receiptCorrelationSchema.safeParse({
                orderId: d['orderId'],
                captureId: d['captureId'],
                authorizationId: d['authorizationId'],
                authorizationExpiresAt: d['authorizationExpiresAt'],
                payeeId: d['payeeId'],
                payeeMerchantId: d['payeeMerchantId'],
                amountMinor: d['amountMinor'],
                currency: d['currency'],
              })
            : null;
          const verification = d['verifiedKind']
            ? {
                kind: d['verifiedKind'],
                outcome: d['verifiedOutcome'],
                artifactVersionId: d['verifiedArtifactVersionId'],
                method: d['verificationMethod'],
              }
            : undefined;
          const parsed = receiptSchema.safeParse({
            provider: stored.value.provider,
            providerId: stored.value.providerReference,
            operation: stored.value.operation,
            sandboxMode: stored.value.sandboxMode,
            timestamp: d['timestamp'],
            payloadHash: d['payloadHash'],
            idempotencyKey: d['idempotencyKey'],
            ...(correlation?.success ? { correlation: correlation.data } : {}),
            ...(verification ? { verification } : {}),
            ...(d['outbound'] ? { outbound: d['outbound'] } : {}),
          });
          if (parsed.success) return { ...r.value, receipt: parsed.data };
        }
        return failure('invariant_violation', 'Performed effect is missing its original receipt.', 'reconcile');
      }
      return { ...r.value };
    },
    async beginEffect(id) {
      const r = await repository.beginEffect(missionId, id);
      return r.ok ? { ok: true } : convert(r.error);
    },
    async completeEffect(id, receipt) {
      const correlation = receipt.correlation
        ? Object.fromEntries(
            Object.entries(receipt.correlation).filter((entry): entry is [string, string | number] => entry[1] !== undefined),
          )
        : {};
      const verified: Record<string, string> = receipt.verification
        ? {
            verifiedKind: receipt.verification.kind,
            verifiedOutcome: receipt.verification.outcome,
            verifiedArtifactVersionId: receipt.verification.artifactVersionId,
            verificationMethod: receipt.verification.method,
          }
        : {};
      const stored: ProviderReceipt = {
        provider: receipt.provider,
        providerReference: receipt.providerId,
        operation: receipt.operation,
        sandboxMode: receipt.sandboxMode,
        data: {
          timestamp: receipt.timestamp,
          payloadHash: receipt.payloadHash,
          idempotencyKey: receipt.idempotencyKey,
          ...correlation,
          ...verified,
          ...(receipt.outbound ? { outbound: receipt.outbound } : {}),
        },
      };
      const r = await repository.completeEffect(missionId, id, stored);
      if (!r.ok) throw new Error('Receipt persistence failed.');
    },
    async failEffect(id, ambiguous) {
      const r = await repository.failEffect(
        missionId,
        id,
        ambiguous,
        ambiguous ? 'Provider outcome unknown.' : 'Provider rejected operation.',
      );
      if (!r.ok) throw new Error('Effect failure persistence failed.');
    },
    async withDispatch(id, invoke) {
      const r = await repository.withDispatchLock(missionId, id, async scoped => invoke(postgresEffectRepository(scoped, missionId)));
      return r.ok ? r.value : convert(r.error);
    },
  };
}
export interface ToolContext {
  role:
    'lead' | 'finance' | 'sourcing' | 'commerce' | 'brand' | 'product' | 'compliance' | 'voice' | 'operations' | 'extraction' | 'policy';
}
export function roleCanExecute(role: ToolContext['role'], effect: EffectIntent['effectClass']): boolean {
  if (['voice', 'operations', 'extraction'].includes(role) && ['spend', 'publish', 'bind'].includes(effect)) return false;
  return (effect !== 'spend' && effect !== 'publish' && effect !== 'bind') || role === 'policy';
}
/** The only external effect entry point. Started/ambiguous effects never blindly re-execute. */
export async function executeGuarded<T>(
  raw: unknown,
  context: ToolContext,
  repository: EffectRepository,
  invoke: (intent: EffectIntent) => Promise<ProviderResult<T>>,
): Promise<ProviderResult<T> | { ok: true; replay: true; receipt: Receipt }> {
  const p = effectIntentSchema.safeParse(raw);
  if (!p.success) return failure('validation', 'Invalid effect intent.');
  if (!roleCanExecute(context.role, p.data.effectClass)) return failure('rejected', 'Role has no capability for this external effect.');
  try {
    const r = await repository.reserveEffect(p.data);
    if ('ok' in r) return r;
    if (r.replay) {
      if (r.status === 'performed' && r.receipt) return { ok: true, replay: true, receipt: r.receipt };
      return failure('provider_down', 'Effect is already reserved or outcome is unresolved; reconcile before proceeding.', 'reconcile');
    }
    return repository.withDispatch(r.authorizationId, async scoped => {
      let result: ProviderResult<T>;
      try {
        result = await invoke(p.data);
      } catch {
        await scoped.failEffect(r.authorizationId, true);
        return failure('provider_down', 'Provider outcome is unknown.', 'reconcile');
      }
      if (!result.ok) {
        await scoped.failEffect(r.authorizationId, result.retry === 'reconcile');
        return result;
      }
      const receipt = receiptSchema.safeParse(result.receipt);
      if (
        !receipt.success ||
        receipt.data.operation !== p.data.action ||
        receipt.data.idempotencyKey !== p.data.idempotencyKey ||
        receipt.data.sandboxMode !== p.data.sandboxMode
      ) {
        await scoped.failEffect(r.authorizationId, true);
        return failure('invariant_violation', 'No matching provider receipt; action cannot be recorded performed.', 'reconcile');
      }
      await scoped.completeEffect(r.authorizationId, receipt.data);
      return result;
    });
  } catch {
    return failure('provider_down', 'Authorization or receipt persistence unavailable; reconcile before retry.', 'reconcile');
  }
}
