import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  ApprovalBindingSchema,
  AuthorizationSchema,
  DecisionPacketSchema,
  EffectIntentSchema,
  ProviderReceiptSchema,
  type ApprovalBinding,
  type Authorization,
  type DecisionPacket,
  type EffectIntent,
  type ProviderReceipt,
  type Result,
  type TypedError,
} from './schemas.js';

/** Minimal structural interface implemented by pg.Client/PoolClient. Use a role-scoped
 * JWT connection: this repository never requests service_role or BYPASSRLS. */
export interface SqlConnection {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
export interface SqlLease extends SqlConnection {
  release(): void;
}
export type StateRole = 'founder_role' | 'lead_role' | 'specialist_role' | 'policy_role' | 'ingress_role' | 'voice_role';
export function hashApprovalToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
export function approvalBinding(intent: EffectIntent): ApprovalBinding {
  return ApprovalBindingSchema.parse({
    action: intent.action,
    counterpartyId: intent.counterpartyId,
    amountMinor: intent.amountMinor ?? null,
    currency: intent.currency ?? null,
    artifactVersionId: intent.artifactVersionId ?? null,
  });
}
export function mapDatabaseError(error: unknown): TypedError {
  if (error instanceof z.ZodError) return { code: 'validation', message: error.issues.map(i => i.message).join('; '), retryable: false };
  const candidate = z.object({ code: z.string().optional(), message: z.string().optional() }).safeParse(error);
  const message = candidate.success ? (candidate.data.message ?? 'Database operation failed') : 'Database operation failed';
  const code = message.includes('needs_approval')
    ? 'needs_approval'
    : candidate.success && candidate.data.code === '22023'
      ? 'validation'
      : 'invariant_violation';
  return { code, message: message.slice(0, 500), retryable: candidate.success && ['40001', '40P01'].includes(candidate.data.code ?? '') };
}
export class PostgresMissionRepository {
  constructor(
    private readonly db: SqlConnection,
    private readonly acquireLease?: () => Promise<SqlLease>,
  ) {}
  /** Lease factory supplies a pinned connection with scoped role/JWT and no open
   * transaction. Persist the dispatch claim first, then retain locks through the
   * call. A process crash can never roll the durable claim back to reserved. */
  async withDispatchLock<T>(
    missionId: string,
    authorizationId: string,
    callback: (repository: PostgresMissionRepository, authorization: Authorization) => Promise<T>,
  ): Promise<Result<T>> {
    if (!this.acquireLease)
      return {
        ok: false,
        error: { code: 'invariant_violation', message: 'Dispatch requires a pinned transaction lease factory', retryable: false },
      };
    let lease: SqlLease | undefined;
    try {
      lease = await this.acquireLease();
      const identity = await lease.query("select current_setting('role') as role,current_setting('request.jwt.claims',true) as claims");
      const role = z
        .enum(['founder_role', 'lead_role', 'specialist_role', 'policy_role', 'ingress_role', 'voice_role'])
        .parse(identity.rows[0]?.['role']);
      const claims = z.string().min(1).parse(identity.rows[0]?.['claims']);
      const beginScoped = async () => {
        await lease?.query('begin');
        await lease?.query(`set local role ${role}`);
        await lease?.query("select set_config('request.jwt.claims',$1,true)", [claims]);
      };
      await beginScoped();
      const scoped = new PostgresMissionRepository(lease);
      const authorization = await scoped.beginEffect(missionId, authorizationId);
      if (!authorization.ok) {
        await lease.query('rollback');
        return authorization;
      }
      if (authorization.value.status !== 'started' || authorization.value.replay) {
        await lease.query('rollback');
        return {
          ok: false,
          error: {
            code: 'invariant_violation',
            message: 'Effect already dispatched; reconcile the existing authorization',
            retryable: false,
          },
        };
      }
      await lease.query('commit'); // durable claim survives a crash during the HTTP call
      await beginScoped();
      const locked = await scoped.beginEffect(missionId, authorizationId);
      if (!locked.ok) {
        await lease.query('rollback');
        return locked;
      }
      if (locked.value.status !== 'started') {
        await lease.query('rollback');
        return {
          ok: false,
          error: {
            code: 'invariant_violation',
            message: 'Dispatch no longer available; reconcile existing authorization',
            retryable: false,
          },
        };
      }
      const value = await callback(scoped, authorization.value);
      await lease.query('commit');
      return { ok: true, value };
    } catch (error: unknown) {
      if (lease) await lease.query('rollback');
      return { ok: false, error: mapDatabaseError(error) };
    } finally {
      lease?.release();
    }
  }
  private async call<T>(sql: string, parameters: unknown[] | (() => unknown[]), parse: (value: unknown) => T): Promise<Result<T>> {
    try {
      const result = await this.db.query(sql, typeof parameters === 'function' ? parameters() : parameters);
      return { ok: true, value: parse(result.rows[0]?.['result']) };
    } catch (error: unknown) {
      return { ok: false, error: mapDatabaseError(error) };
    }
  }
  reserveEffect(raw: EffectIntent): Promise<Result<Authorization>> {
    return this.call(
      'select public.reserve_effect($1::uuid,$2::jsonb,$3::text) as result',
      () => {
        const intent = EffectIntentSchema.parse(raw);
        const { approvalToken, ...safeIntent } = intent;
        return [intent.missionId, JSON.stringify(safeIntent), approvalToken ? hashApprovalToken(approvalToken) : null];
      },
      value => AuthorizationSchema.parse(value),
    );
  }
  beginEffect(missionId: string, authorizationId: string): Promise<Result<Authorization>> {
    return this.call('select public.begin_effect($1::uuid,$2::uuid) as result', [missionId, authorizationId], v =>
      AuthorizationSchema.parse(v),
    );
  }
  completeEffect(missionId: string, authorizationId: string, receipt: ProviderReceipt): Promise<Result<Authorization>> {
    return this.call(
      'select public.complete_effect($1::uuid,$2::uuid,$3::jsonb) as result',
      () => [missionId, authorizationId, JSON.stringify(ProviderReceiptSchema.parse(receipt))],
      v => AuthorizationSchema.parse(v),
    );
  }
  failEffect(missionId: string, authorizationId: string, ambiguous: boolean, reason: string): Promise<Result<Authorization>> {
    return this.call(
      'select public.fail_effect($1::uuid,$2::uuid,$3::boolean,$4::text) as result',
      [missionId, authorizationId, ambiguous, reason],
      v => AuthorizationSchema.parse(v),
    );
  }
  resolveDecision(
    missionId: string,
    decisionId: string,
    response: 'approve' | 'choose' | 'reject' | 'defer' | 'question',
    optionId: string | null = null,
  ): Promise<Result<string>> {
    return this.call(
      'select public.resolve_decision($1::uuid,$2::uuid,$3::text,$4::text) as result',
      [missionId, decisionId, response, optionId],
      v => z.uuid().parse(v),
    );
  }
  proposeDecision(
    missionId: string,
    kind: string,
    packet: DecisionPacket,
    outcome: string | null = null,
    gate: string | null = null,
    supersedesId: string | null = null,
  ): Promise<Result<string>> {
    return this.call(
      'select public.propose_decision($1::uuid,$2::text,$3::jsonb,$4::text,$5::text,$6::uuid) as result',
      () => [missionId, kind, JSON.stringify(DecisionPacketSchema.parse(packet)), outcome, gate, supersedesId],
      v => z.uuid().parse(v),
    );
  }
  issueApproval(
    missionId: string,
    decisionId: string,
    binding: ApprovalBinding,
    token: string,
    expiresAt: string,
  ): Promise<Result<string>> {
    return this.call(
      'select public.issue_approval($1::uuid,$2::uuid,$3::jsonb,$4::text,$5::timestamptz) as result',
      () => [missionId, decisionId, JSON.stringify(ApprovalBindingSchema.parse(binding)), hashApprovalToken(token), expiresAt],
      v => z.uuid().parse(v),
    );
  }
  revokeMandate(missionId: string, mandateId: string): Promise<Result<string>> {
    return this.call('select public.revoke_mandate($1::uuid,$2::uuid) as result', [missionId, mandateId], v => z.uuid().parse(v));
  }
  confirmPayment(missionId: string, paymentId: string, receiptId: string, confirmationEventId: string): Promise<Result<string>> {
    return this.call(
      'select public.confirm_payment($1::uuid,$2::uuid,$3::uuid,$4::uuid) as result',
      [missionId, paymentId, receiptId, confirmationEventId],
      v => z.uuid().parse(v),
    );
  }
  getEffectReceipt(missionId: string, authorizationId: string): Promise<Result<ProviderReceipt | null>> {
    return this.call('select public.effect_receipt($1::uuid,$2::uuid) as result', [missionId, authorizationId], v =>
      ProviderReceiptSchema.nullable().parse(v),
    );
  }
  snapshot(missionId: string): Promise<Result<Record<string, unknown>>> {
    return this.call('select public.mission_snapshot($1::uuid) as result', [missionId], v => z.record(z.string(), z.unknown()).parse(v));
  }
  createMission(
    founderId: string,
    type: 'discover' | 'launch',
    goalBrief: string,
    currency: string,
    sandboxMode: boolean,
    metadata: Record<string, unknown> = {},
  ): Promise<Result<string>> {
    return this.call(
      'select public.create_mission($1::uuid,$2::text,$3::text,$4::text,$5::boolean,$6::jsonb) as result',
      [founderId, type, goalBrief, currency, sandboxMode, JSON.stringify(metadata)],
      v => z.uuid().parse(v),
    );
  }
  transitionMission(
    missionId: string,
    status: 'active' | 'paused' | 'ended',
    terminalDecisionId: string | null = null,
    closingRecordVersionId: string | null = null,
  ): Promise<Result<string>> {
    return this.call(
      'select public.transition_mission($1::uuid,$2::text,$3::uuid,$4::uuid) as result',
      [missionId, status, terminalDecisionId, closingRecordVersionId],
      v => z.uuid().parse(v),
    );
  }
  appendFounderMessage(missionId: string, threadId: string, text: string): Promise<Result<string>> {
    return this.call('select public.append_founder_message($1::uuid,$2::uuid,$3::text) as result', [missionId, threadId, text], v =>
      z.uuid().parse(v),
    );
  }
  appendLeadMessage(missionId: string, threadId: string, text: string): Promise<Result<string>> {
    return this.call('select public.append_lead_message($1::uuid,$2::uuid,$3::text) as result', [missionId, threadId, text], v =>
      z.uuid().parse(v),
    );
  }
  readiness(missionId: string): Promise<Result<unknown[]>> {
    return this.call("select coalesce(jsonb_agg(r),'[]'::jsonb) as result from public.readiness($1::uuid) r", [missionId], v =>
      z.array(z.unknown()).parse(v),
    );
  }
}
