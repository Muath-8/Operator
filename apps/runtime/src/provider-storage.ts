import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { JsonObjectSchema, EffectIntentSchema, approvalBinding, type JsonValue, type StateRole } from '@lo/state';
import { constantTimeEquals, postgresEffectRepository, type EffectIntent } from '@lo/policy';
import {
  AdapterFault,
  MarketplaceProfileSchema,
  channelStateSchema,
  hashPayload,
  paymentProposalSchema,
  storeConfigurationSchema,
  type AdapterDependencies,
  type PreparationRequest,
  type Provider,
  type SecretStore,
  type ServiceBudgetStore,
  type VerifiedWebhook,
  type WebhookStore,
} from '@lo/adapters';
import { withRole, policyRepository, type ActorScope } from './database.js';
import { createModelMeter, createServiceModelMeter } from './model-meter.js';

const ProviderSchema = z.enum(['paypal', 'twilio', 'resend', 'shopify', 'browserbase', 'openai', 'godaddy']);
const EnvelopeSchema = z.object({ iv: z.string(), ciphertext: z.string(), tag: z.string() }).strict();
const StoredCredentialSchema = z.object({ credential: JsonObjectSchema, settings: JsonObjectSchema.default({}) }).strict();
export function providerEncryptionKey(): Buffer {
  const raw = process.env['PROVIDER_ENCRYPTION_KEY'];
  if (!raw) throw new Error('provider_down: PROVIDER_ENCRYPTION_KEY is required for connected provider services');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('validation: PROVIDER_ENCRYPTION_KEY must encode exactly 32 bytes');
  return key;
}
export function encryptProviderValue(value: unknown, aad: string, key = providerEncryptionKey()): z.infer<typeof EnvelopeSchema> {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { iv: iv.toString('base64'), ciphertext: ciphertext.toString('base64'), tag: cipher.getAuthTag().toString('base64') };
}
export function decryptProviderValue(raw: unknown, aad: string, key = providerEncryptionKey()): unknown {
  const v = EnvelopeSchema.parse(raw);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'base64'));
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(v.ciphertext, 'base64')), decipher.final()]).toString('utf8')) as unknown;
}
export const RoutingSchema = z
  .object({
    authUserId: z.uuid(),
    missionId: z.uuid(),
    credentialRef: z.uuid(),
    provider: ProviderSchema,
    sandboxMode: z.boolean(),
    voiceSessionId: z.uuid().optional(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
export type ProviderRouting = z.infer<typeof RoutingSchema>;
export function signProviderRouting(
  input: Omit<ProviderRouting, 'expiresAt'>,
  expiresAt = Date.now() + 180 * 86400000,
  key = providerEncryptionKey(),
): string {
  const body = Buffer.from(JSON.stringify(RoutingSchema.parse({ ...input, expiresAt }))).toString('base64url');
  return `${body}.${createHmac('sha256', key).update(`provider-routing:${body}`).digest('base64url')}`;
}
export function verifyProviderRouting(token: string, now = Date.now(), key = providerEncryptionKey()): ProviderRouting {
  const [body, signature, ...extra] = token.split('.');
  if (!body || !signature || extra.length) throw new Error('rejected: invalid provider route');
  const expected = createHmac('sha256', key).update(`provider-routing:${body}`).digest('base64url');
  if (!constantTimeEquals(signature, expected)) throw new Error('rejected: invalid provider route');
  const input = RoutingSchema.parse(JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as unknown);
  if (input.expiresAt <= now) throw new Error('rejected: expired provider route');
  return input;
}
export async function storeApprovalToken(scope: ActorScope, approvalId: string, token: string): Promise<void> {
  z.uuid().parse(approvalId);
  z.string().min(32).parse(token);
  await withRole('founder_role', scope, async db => {
    await db.query('select public.store_approval_token($1,$2,$3)', [
      scope.missionId,
      approvalId,
      encryptProviderValue({ token }, `approval:${scope.missionId}:${approvalId}`),
    ]);
  });
}
/** Server-only helper: returns no credential plaintext or token to a model/client. */
export async function provisionProviderCredential(
  scope: ActorScope,
  input: {
    accountId: string;
    provider: Provider;
    sandboxMode: boolean;
    credential: Record<string, JsonValue>;
    settings?: Record<string, JsonValue>;
  },
): Promise<{ ref: string; webhookRoute: string }> {
  const ref = randomUUID();
  const aad = `credential:${scope.missionId}:${input.provider}:${ref}`;
  const encrypted = encryptProviderValue({ credential: input.credential, settings: input.settings ?? {} }, aad);
  await withRole('founder_role', scope, async db => {
    await db.query('select public.store_provider_credential($1,$2,$3,$4,$5,$6)', [
      scope.missionId,
      ref,
      input.accountId,
      input.provider,
      input.sandboxMode,
      encrypted,
    ]);
  });
  return {
    ref,
    webhookRoute: signProviderRouting({
      authUserId: scope.authUserId,
      missionId: z.uuid().parse(scope.missionId),
      credentialRef: ref,
      provider: input.provider,
      sandboxMode: input.sandboxMode,
    }),
  };
}
const ConnectionSchema = z.object({ ref: z.uuid(), accountId: z.uuid(), sandboxMode: z.boolean() });
export class ProviderStorage implements SecretStore, ServiceBudgetStore {
  readonly missionId: string;
  private readonly dispatchTransaction = new AsyncLocalStorage<PoolClient>();
  constructor(
    readonly scope: ActorScope,
    readonly role: StateRole = 'policy_role',
  ) {
    this.missionId = z.uuid().parse(scope.missionId);
  }
  async connection(provider: Provider, accountId?: string) {
    return withRole(this.role, this.scope, async db =>
      ConnectionSchema.parse(
        (await db.query('select public.provider_connection($1,$2,$3)result', [this.missionId, provider, accountId ?? null])).rows[0]
          ?.result,
      ),
    );
  }
  private async envelope(ref: string, provider: Provider, sandboxMode: boolean) {
    const row = await withRole(this.role, this.scope, async db =>
      z
        .object({ encrypted: EnvelopeSchema, accountId: z.uuid(), ref: z.uuid() })
        .parse(
          (await db.query('select public.resolve_provider_credential($1,$2,$3,$4)result', [this.missionId, ref, provider, sandboxMode]))
            .rows[0]?.result,
        ),
    );
    return {
      ...StoredCredentialSchema.parse(decryptProviderValue(row.encrypted, `credential:${this.missionId}:${provider}:${ref}`)),
      accountId: row.accountId,
    };
  }
  async resolve(request: Parameters<SecretStore['resolve']>[0]): Promise<unknown> {
    if (request.missionId !== this.missionId) throw new Error('rejected: credential mission mismatch');
    const stored = await this.envelope(request.ref, request.provider, request.sandboxMode);
    if (request.instrumentId && stored.accountId !== request.instrumentId)
      throw new Error('rejected: credential does not belong to the authorized instrument');
    return { ...stored.credential, missionId: this.missionId, sandboxMode: request.sandboxMode, revoked: false };
  }
  async settings(provider: Provider): Promise<Record<string, JsonValue>> {
    const connection = await this.connection(provider);
    return (await this.envelope(connection.ref, provider, connection.sandboxMode)).settings;
  }
  async settingsFor(ref: string, provider: Provider, sandboxMode: boolean): Promise<Record<string, JsonValue>> {
    return (await this.envelope(ref, provider, sandboxMode)).settings;
  }
  async artifact(
    versionId: string,
  ): Promise<{ status: 'approved' | 'proposed' | 'superseded'; content: Record<string, JsonValue>; payload: unknown }> {
    return withRole(this.role, this.scope, async db => {
      const row = (
        await db.query(
          "with recursive refs(id)as(select $2::uuid union select(v.content#>>'{proformaInvoice,specVersionId}')::uuid from public.artifact_versions v join refs r on r.id=v.id where v.mission_id=$1 and v.content#>>'{proformaInvoice,specVersionId}'is not null)select exists(select from refs r left join public.artifact_versions p on p.id=r.id and p.mission_id=$1 left join public.artifacts a on a.id=p.artifact_id left join lateral(select s.*from public.artifact_statuses s where s.mission_id=$1 and s.artifact_version_id=p.id order by s.created_at desc,s.id desc limit 1)s on true where p.id is null or(r.id<>$2::uuid and a.outcome<>'product')or exists(select from public.artifact_versions n where n.artifact_id=p.artifact_id and n.version_no>p.version_no)or exists(select from public.stale_marks x where x.mission_id=$1 and x.node_id=p.id)or s.status is distinct from 'approved'or not exists(select from public.active_decisions d where d.mission_id=$1 and d.id=s.decision_id))dependency_invalid,v.content,(select case when s.status='approved'and not exists(select from public.active_decisions d where d.mission_id=s.mission_id and d.id=s.decision_id)then 'stale'else s.status end from public.artifact_statuses s where s.mission_id=v.mission_id and s.artifact_version_id=v.id order by s.created_at desc,s.id desc limit 1)status,exists(select from public.stale_marks s where s.mission_id=v.mission_id and s.node_id=v.id)stale,exists(select from public.artifact_versions n where n.artifact_id=v.artifact_id and n.version_no>v.version_no)superseded from public.artifact_versions v where v.mission_id=$1 and v.id=$2",
          [this.missionId, z.uuid().parse(versionId)],
        )
      ).rows[0];
      if (!row) throw new Error('validation: mission-owned artifact version not found');
      const content = JsonObjectSchema.parse(row.content);
      let payload: unknown = content['payload'] ?? content;
      const effect = z.object({ action: z.string(), counterpartyId: z.uuid() }).passthrough().safeParse(content['effectIntent']);
      if (effect.success && effect.data.action === 'payment_capture')
        payload = paymentProposalSchema.parse({
          ...JsonObjectSchema.parse(payload),
          artifactVersionId: versionId,
          artifactStatus: 'approved',
          counterpartyId: effect.data.counterpartyId,
        });
      if (effect.success && ['store_configure', 'store_publish_policy', 'store_publish_shipping'].includes(effect.data.action))
        payload = storeConfigurationSchema.parse({ ...JsonObjectSchema.parse(payload), approvedArtifactVersionId: versionId });
      return {
        status: row.stale || row.superseded || row.dependency_invalid ? 'superseded' : row.status === 'approved' ? 'approved' : 'proposed',
        content,
        payload,
      };
    });
  }
  async marketplaceProfile(counterpartyId: string, threadId: string, accountId?: string) {
    const connection = await this.connection('browserbase', accountId),
      settings = await this.settingsFor(connection.ref, 'browserbase', connection.sandboxMode),
      profiles = z
        .array(MarketplaceProfileSchema)
        .max(50)
        .parse(settings['marketplaceProfiles'] ?? []),
      matches = profiles.filter(p => p.counterpartyId === counterpartyId && p.threadId === threadId);
    if (matches.length !== 1) throw new Error('provider_down: one current registered marketplace thread profile required');
    const profile = matches[0];
    if (!profile) throw new Error('provider_down: missing profile');
    const registered = await withRole(
      'policy_role',
      this.scope,
      async db =>
        (
          await db.query('select public.check_marketplace_thread($1,$2,$3,$4,$5)allowed', [
            this.missionId,
            connection.accountId,
            counterpartyId,
            threadId,
            hashPayload(profile),
          ])
        ).rows[0]?.allowed,
    );
    if (registered !== true) throw new Error('rejected: founder marketplace registration required');
    return { connection, profile };
  }
  async contact(counterpartyId: string) {
    return withRole(this.role, this.scope, async db => {
      const row = (
        await db.query(
          'select c.*,public.counterparty_opted_out($1,c.id)derived_optout from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=$1 and c.id=$2',
          [this.missionId, z.uuid().parse(counterpartyId)],
        )
      ).rows[0];
      if (!row) throw new Error('validation: mission counterparty unavailable');
      const channels = JsonObjectSchema.parse(row.channels),
        verification = JsonObjectSchema.parse(row.verification);
      const templates = (
        await db.query("select content from public.templates where review_status='approved' order by version desc")
      ).rows.flatMap(r => {
        const p = z
          .object({
            providerTemplateId: z.string(),
            language: z.enum(['ar', 'en']),
            purpose: z.string(),
            body: z.string().min(1).max(10000),
          })
          .safeParse(r.content);
        return p.success ? [{ id: p.data.providerTemplateId, language: p.data.language, purpose: p.data.purpose, body: p.data.body }] : [];
      });
      const lastInbound = (
        await db.query(
          "select max(m.created_at)at from public.messages m join public.threads t on t.id=m.thread_id and t.mission_id=m.mission_id where m.mission_id=$1 and t.counterparty_id=$2 and m.direction='inbound' and m.channel='whatsapp'",
          [this.missionId, counterpartyId],
        )
      ).rows[0]?.at;
      const budgetRows = (
        await db.query(
          "select amount_minor from public.money_ledger where mission_id=$1 and kind='envelope'union all select ceiling_total amount_minor from public.mandates where mission_id=$1 union all select ceiling_per amount_minor from public.mandates where mission_id=$1",
          [this.missionId],
        )
      ).rows;
      const missionBudget = (await db.query('select metadata from public.effective_missions where id=$1', [this.missionId])).rows[0]
        ?.metadata;
      const metadata = JsonObjectSchema.parse(missionBudget ?? {});
      const protectedAmounts = [...budgetRows.map(r => Number(r.amount_minor)), Number(metadata['budgetMinor'] ?? 0)].filter(
        n => Number.isSafeInteger(n) && n > 0,
      );
      const protectedFigures = [...new Set(protectedAmounts.flatMap(n => [String(n), (n / 100).toFixed(2)]))];
      const disclosure =
        typeof channels['disclosure'] === 'string'
          ? channels['disclosure']
          : 'I am an AI-assisted agent acting on behalf of the founder. A human founder will confirm binding matters.';
      const localTime = new Date().getUTCHours() + Number(channels['utcOffsetHours'] ?? 0);
      const hour = (localTime + 24) % 24;
      const start = Number(channels['businessHourStart'] ?? 9),
        end = Number(channels['businessHourEnd'] ?? 18);
      return channelStateSchema.parse({
        counterpartyId: row.id,
        optedOut: row.opt_out || row.derived_optout || verification['optedOut'] === true,
        email: channels['email'] ?? null,
        phone: channels['phone'] ?? null,
        phoneVerified: verification['phoneVerified'] === true,
        lastWhatsappInboundAt: lastInbound ? new Date(String(lastInbound)).toISOString() : null,
        localHoursOpen: hour >= start && hour < end,
        senderRegistered: verification['senderRegistered'] === true,
        disclosure,
        founderBudgetFigures: [...protectedFigures, ...z.array(z.string()).catch([]).parse(channels['protectedBudgetFigures'])],
        approvedTemplates: templates,
      });
    });
  }
  async mission() {
    return withRole(this.role, this.scope, async db =>
      z
        .object({ sandbox_mode: z.boolean(), involvement: z.enum(['guide', 'do', 'help']), currency: z.string() })
        .parse(
          (await db.query('select sandbox_mode,involvement,currency from public.effective_missions where id=$1', [this.missionId])).rows[0],
        ),
    );
  }
  async resolveApproval(intent: EffectIntent): Promise<string | undefined> {
    return withRole('policy_role', this.scope, async db => {
      const raw = (await db.query('select public.resolve_approval_token($1,$2)result', [this.missionId, approvalBinding(intent)])).rows[0]
        ?.result;
      if (!raw) return undefined;
      const row = z.object({ approvalId: z.uuid(), encrypted: EnvelopeSchema }).strict().parse(raw);
      return z
        .object({ token: z.string().min(32) })
        .strict()
        .parse(decryptProviderValue(row.encrypted, `approval:${this.missionId}:${row.approvalId}`)).token;
    });
  }
  async buildIntent(
    taskId: string,
    action: string,
    effectClass: EffectIntent['effectClass'],
    fields: Record<string, JsonValue>,
    authority: readonly string[],
  ): Promise<EffectIntent> {
    const mission = await this.mission();
    const chosen = z
      .object({
        counterpartyId: z.uuid(),
        artifactVersionId: z.uuid().optional(),
        amountMinor: z.number().int().nonnegative().safe().optional(),
        currency: z.string().optional(),
        instrumentId: z.uuid().optional(),
        mandateId: z.uuid().optional(),
        purpose: z.string().optional(),
        channel: z.string().optional(),
        newContact: z.boolean().default(false),
      })
      .strict()
      .parse(fields);
    if (effectClass === 'communicate' && ['send_message', 'marketplace_message'].includes(action)) {
      // Caller flags cannot suppress first-contact accounting. Preserve an existing
      // task's reservation identity on replay even after its outbound row is filed.
      chosen.newContact = await withRole('policy_role', this.scope, async db =>
        z.boolean().parse(
          (
            await db.query(
              `
        select coalesce((select (a.intent->>'newContact')::boolean from public.effect_authorizations a
          where a.mission_id=$1 and a.intent->>'taskId'=$2 and a.intent->>'action'=$3
          and a.intent->>'counterpartyId'=$4 and a.intent->>'channel' is not distinct from $5
          and a.intent->>'artifactVersionId' is not distinct from $6
          order by a.created_at,a.id limit 1),not exists(select from public.messages m
          join public.threads t on t.id=m.thread_id and t.mission_id=m.mission_id
          where m.mission_id=$1 and t.counterparty_id=$4::uuid and m.direction='outbound' and m.receipt_id is not null)) value`,
              [this.missionId, taskId, action, chosen.counterpartyId, chosen.channel ?? null, chosen.artifactVersionId ?? null],
            )
          ).rows[0]?.value,
        ),
      );
    }
    if (chosen.mandateId && !authority.includes(chosen.mandateId)) throw new Error('rejected: task has no authority for this mandate');
    const candidate = EffectIntentSchema.parse({
      missionId: this.missionId,
      taskId,
      action,
      effectClass,
      ...chosen,
      mode: mission.involvement,
      sandboxMode: mission.sandbox_mode,
      idempotencyKey: hashPayload([this.missionId, taskId, action, chosen]),
    });
    const mode = await withRole('policy_role', this.scope, async db =>
      z
        .enum(['guide', 'do', 'help'])
        .parse((await db.query('select public.effective_effect_mode($1,$2)mode', [this.missionId, candidate])).rows[0]?.mode),
    );
    const effective = { ...candidate, mode };
    const token = await this.resolveApproval(effective);
    return token ? { ...effective, approvalToken: token } : effective;
  }
  dependencies(context: AdapterDependencies['context'] = { role: 'policy' }): AdapterDependencies {
    return {
      repository: postgresEffectRepository(policyRepository(this.scope), this.missionId),
      secrets: this,
      context,
      preparations: { execute: (request, invoke) => this.executePreparation(request, invoke) },
      allowedCallbackOrigins: [new URL(process.env['APP_ORIGIN'] ?? 'http://127.0.0.1:3000').origin],
      approvedArtifacts: {
        get: async (mission, version) => {
          if (mission !== this.missionId) throw new Error('rejected: artifact mission mismatch');
          const a = await this.artifact(version);
          return { status: a.status, content: a.payload };
        },
      },
    };
  }
  private async serviceDb<T>(work: (db: PoolClient) => Promise<T>): Promise<T> {
    const active = this.dispatchTransaction.getStore();
    return active ? work(active) : withRole('policy_role', this.scope, work);
  }
  async reserveVoiceModel(sessionId: string): Promise<void> {
    if (this.role !== 'policy_role') throw new Error('rejected: only policy service reserves realtime dollars');
    const session = await this.voiceSession(sessionId),
      settings = await this.settingsFor(session.openai_ref, 'openai', (await this.mission()).sandbox_mode),
      model = z.string().min(1).parse(settings['realtimeModel']);
    const credential = z
      .object({ allowedModels: z.array(z.string()) })
      .passthrough()
      .parse(
        await this.resolve({
          missionId: this.missionId,
          ref: session.openai_ref,
          provider: 'openai',
          sandboxMode: (await this.mission()).sandbox_mode,
        }),
      );
    if (!credential.allowedModels.includes(model)) throw new Error('rejected: pinned realtime model not allowed');
    const key = hashPayload(['voice_realtime', hashPayload(['voice-realtime', sessionId]), session.openai_ref]),
      reserved = await createServiceModelMeter(this.scope, session.task_id, model, 'realtime').reserve(key, 100000);
    await withRole('policy_role', this.scope, db =>
      db.query('select public.bind_voice_model_budget($1,$2,$3,$4,$5)', [
        this.missionId,
        sessionId,
        model,
        key,
        JsonObjectSchema.parse(reserved.price),
      ]),
    );
  }
  async executePreparation<T>(request: PreparationRequest, invoke: () => Promise<T>): Promise<T> {
    if (request.intent.missionId !== this.missionId)
      throw new AdapterFault({ ok: false, code: 'rejected', message: 'Service mission scope mismatch.', retry: 'never' });
    const key = hashPayload([request.kind, request.intent.idempotencyKey, request.credentialRef]),
      role = request.kind === 'voice_realtime' ? 'voice_role' : 'policy_role';
    const claim = await withRole(role, this.scope, async db =>
      z
        .object({
          fresh: z.boolean(),
          status: z.enum(['started', 'completed', 'ambiguous']),
          encrypted: EnvelopeSchema.nullable().optional(),
        })
        .parse(
          (
            await db.query('select public.start_provider_dispatch($1,$2,$3,$4,$5,$6,$7,$8,$9)result', [
              this.missionId,
              key,
              request.kind,
              request.provider,
              request.credentialRef,
              request.intent.artifactVersionId ?? null,
              request.requestHash,
              request.intent.taskId,
              request.model ?? null,
            ])
          ).rows[0]?.result,
        ),
    );
    if (!claim.fresh) {
      if (claim.status === 'completed' && claim.encrypted && request.kind !== 'voice_realtime')
        return decryptProviderValue(claim.encrypted, `dispatch:${this.missionId}:${key}`) as T;
      throw new AdapterFault({
        ok: false,
        code: 'provider_down',
        message: 'This service attempt is already started or uncertain; reconcile instead of repeating it.',
        retry: 'reconcile',
      });
    }
    // Reserve dollars outside the held dispatch transaction: the meter uses a
    // separate policy connection and must not deadlock a full dispatch pool.
    const paid =
      request.model && request.kind === 'openai_image'
        ? createServiceModelMeter(this.scope, z.uuid().parse(request.intent.taskId), request.model, 'image')
        : undefined;
    const structured =
      request.model && request.kind === 'openai_structured'
        ? createModelMeter(this.scope, z.uuid().parse(request.intent.taskId), request.model)
        : undefined;
    if (paid) await paid.reserve(key, request.maximumUnits ?? 1);
    if (structured) await structured.reserve(key, request.maximumUnits ?? 0);
    const executed = await withRole(role, this.scope, async db => {
      await db.query('select public.lock_provider_dispatch($1,$2)', [this.missionId, key]);
      return this.dispatchTransaction.run(db, async () => {
        try {
          const value = await invoke();
          await db.query('select public.complete_provider_dispatch($1,$2,$3)', [
            this.missionId,
            key,
            encryptProviderValue(value, `dispatch:${this.missionId}:${key}`),
          ]);
          return { ok: true as const, value };
        } catch (error) {
          await db.query('select public.complete_provider_dispatch($1,$2,null)', [this.missionId, key]);
          return { ok: false as const, error };
        }
      });
    });
    if (paid) await paid.recordUnknown(key);
    if (structured) {
      const response = executed.ok
        ? z
            .object({ usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }) })
            .passthrough()
            .safeParse(executed.value)
        : null;
      await structured.record({
        callKey: key,
        inputTokens: response?.success ? response.data.usage.input_tokens : 0,
        outputTokens: response?.success ? response.data.usage.output_tokens : 0,
        cachedInputTokens: 0,
        totalTokens: response?.success ? response.data.usage.input_tokens + response.data.usage.output_tokens : 0,
      });
    }
    if (!executed.ok) throw executed.error;
    return executed.value;
  }
  async ensureMarketplaceBudget(missionId: string, key: string, units: number): Promise<boolean> {
    if (missionId !== this.missionId) return false;
    return withRole('policy_role', this.scope, async db =>
      z
        .boolean()
        .parse((await db.query('select public.ensure_marketplace_budget($1,$2,$3)allowed', [missionId, key, units])).rows[0]?.allowed),
    );
  }
  async reserve(missionId: string, key: string, provider: 'openai' | 'browserbase', maximumUnits: number): Promise<boolean> {
    if (missionId !== this.missionId) return false;
    return this.serviceDb(async db =>
      z
        .boolean()
        .parse(
          (await db.query('select public.reserve_service_budget($1,$2,$3,$4)result', [missionId, key, provider, maximumUnits])).rows[0]
            ?.result,
        ),
    );
  }
  async complete(missionId: string, key: string, providerId: string, usedUnits: number): Promise<void> {
    if (missionId !== this.missionId) throw new Error('rejected: service mission mismatch');
    await this.serviceDb(async db => {
      await db.query('select public.complete_service_budget($1,$2,$3,$4)', [missionId, key, providerId, usedUnits]);
    });
  }
  async ambiguous(missionId: string, key: string): Promise<void> {
    if (missionId !== this.missionId) throw new Error('rejected: service mission mismatch');
    await this.serviceDb(async db => {
      await db.query('select public.complete_service_budget($1,$2,null,null)', [missionId, key]);
    });
  }
  async recordReference(provider: Provider, reference: string, kind: string, correlation: Record<string, JsonValue>): Promise<void> {
    await withRole('policy_role', this.scope, async db => {
      await db.query('select public.record_provider_reference($1,$2,$3,$4,$5)', [this.missionId, provider, reference, kind, correlation]);
    });
  }
  async reference(provider: Provider, reference: string) {
    return withRole(this.role, this.scope, async db => {
      const row = (
        await db.query(
          'select correlation,kind from public.provider_references where mission_id=$1 and provider=$2 and provider_reference=$3',
          [this.missionId, provider, reference],
        )
      ).rows[0];
      return row ? { kind: String(row.kind), correlation: JsonObjectSchema.parse(row.correlation) } : null;
    });
  }
  webhookStore(type = 'provider.received'): WebhookStore {
    return {
      insertVerified: async (event: VerifiedWebhook) =>
        withRole('ingress_role', this.scope, async db =>
          z
            .object({ eventId: z.uuid(), duplicate: z.boolean(), parked: z.boolean() })
            .parse(
              (
                await db.query('select public.ingest_provider_event($1,$2,$3,$4,$5)result', [
                  this.missionId,
                  event.provider,
                  event.providerEventId,
                  type,
                  JSON.parse(JSON.stringify(event.payload)) as JsonValue,
                ])
              ).rows[0]?.result,
            ),
        ),
    };
  }
  async saveAsset(base64: string, mimeType: string, providerReference: string): Promise<string> {
    return withRole('policy_role', this.scope, async db => {
      const result = await db.query(
        'insert into public.provider_assets(mission_id,mime_type,content_base64,payload_hash,provider_reference)values($1,$2,$3,$4,$5)on conflict(mission_id,provider_reference)do nothing returning id',
        [this.missionId, mimeType, base64, hashPayload(base64), providerReference],
      );
      if (result.rows[0]) return String(result.rows[0].id);
      return String(
        (
          await db.query('select id from public.provider_assets where mission_id=$1 and provider_reference=$2', [
            this.missionId,
            providerReference,
          ])
        ).rows[0]?.id,
      );
    });
  }
  async saveDraft(
    taskKey: string,
    payload: Record<string, JsonValue>,
    effectIntent: Record<string, JsonValue>,
    originatingTaskId?: string,
  ): Promise<string> {
    return withRole('specialist_role', this.scope, async db => {
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.missionId}:${taskKey}`]);
      const prior = (
        await db.query('select artifact_version_id from public.provider_drafts where mission_id=$1 and task_key=$2', [
          this.missionId,
          taskKey,
        ])
      ).rows[0];
      if (prior) return String(prior.artifact_version_id);
      const artifact = (
        await db.query("select public.create_artifact($1,'outbound_message','supply','Outbound message awaiting founder review')id", [
          this.missionId,
        ])
      ).rows[0]?.id;
      const version = (
        await db.query('select public.append_artifact_version($1,$2,$3)id', [
          this.missionId,
          artifact,
          { payload, effectIntent, ...(originatingTaskId ? { originatingTaskId: z.uuid().parse(originatingTaskId) } : {}) },
        ])
      ).rows[0]?.id;
      await db.query("select public.set_artifact_status($1,$2,'proposed')", [this.missionId, version]);
      await db.query('insert into public.provider_drafts(mission_id,task_key,artifact_version_id)values($1,$2,$3)', [
        this.missionId,
        taskKey,
        version,
      ]);
      return z.uuid().parse(version);
    });
  }
  async recordOutbound(
    intent: EffectIntent,
    message: { original: string; translation: string; channel: string },
    providerId: string,
  ): Promise<void> {
    await withRole('policy_role', this.scope, async db => {
      await db.query('select public.record_outbound_message($1,$2,$3,$4,$5,$6,$7)', [
        this.missionId,
        intent.counterpartyId,
        providerId,
        message.channel,
        message.original,
        message.translation,
        intent.mandateId ?? null,
      ]);
    });
  }
  async voiceSession(sessionId: string) {
    return withRole(this.role, this.scope, async db =>
      z
        .object({
          id: z.uuid(),
          mission_id: z.uuid(),
          task_id: z.uuid(),
          counterparty_id: z.uuid(),
          mandate_id: z.uuid().nullable(),
          outreach_mandate_id: z.uuid().nullable(),
          twilio_ref: z.uuid(),
          openai_ref: z.uuid(),
          language: z.enum(['ar', 'en']),
          disclosure: z.string(),
          recording_consent: z.boolean(),
          bounds: JsonObjectSchema,
        })
        .parse(
          (await db.query('select *from public.voice_sessions where mission_id=$1 and id=$2', [this.missionId, z.uuid().parse(sessionId)]))
            .rows[0],
        ),
    );
  }
  async appendVoice(
    sessionId: string,
    kind: 'stream_started' | 'transcript' | 'fact' | 'followup' | 'ended' | 'recording' | 'optout' | 'blocked',
    key: string,
    payload: Record<string, JsonValue>,
  ): Promise<string | null> {
    return withRole(this.role, this.scope, async db => {
      const id = (await db.query('select public.append_voice_event($1,$2,$3,$4,$5)id', [this.missionId, sessionId, kind, key, payload]))
        .rows[0]?.id;
      return id ? z.uuid().parse(id) : null;
    });
  }
  async withVoiceOutput(sessionId: string, send: () => void): Promise<boolean> {
    return withRole('voice_role', this.scope, async db => {
      const allowed = z
        .boolean()
        .parse((await db.query('select public.voice_output_allowed($1,$2)allowed', [this.missionId, sessionId])).rows[0]?.allowed);
      if (allowed) send();
      return allowed;
    });
  }
  async bindVoiceCall(sessionId: string, callSid: string): Promise<void> {
    await withRole('voice_role', this.scope, async db => {
      await db.query('select public.bind_voice_call($1,$2,$3)', [this.missionId, sessionId, callSid]);
    });
  }
  async researchEvidence(taskId: string, url: string): Promise<{ evidenceId: string; payload: Record<string, JsonValue> } | null> {
    return withRole('specialist_role', this.scope, async db => {
      const r = (
        await db.query(
          'select e.id,e.payload from public.provider_research r join public.evidence e on e.id=r.evidence_id and e.mission_id=r.mission_id where r.mission_id=$1 and r.task_key=$2',
          [this.missionId, hashPayload([taskId, url])],
        )
      ).rows[0];
      return r ? { evidenceId: z.uuid().parse(r.id), payload: JsonObjectSchema.parse(r.payload) } : null;
    });
  }
  async saveResearchEvidence(taskId: string, url: string, outcome: string, payload: Record<string, JsonValue>): Promise<string> {
    return withRole('specialist_role', this.scope, async db => {
      const key = hashPayload([taskId, url]);
      await db.query('select pg_advisory_xact_lock(hashtextextended($1,0))', [`${this.missionId}:${key}`]);
      const prior = (
        await db.query('select evidence_id from public.provider_research where mission_id=$1 and task_key=$2', [this.missionId, key])
      ).rows[0];
      if (prior) return String(prior.evidence_id);
      const e = (
        await db.query("select public.append_evidence($1,$2,'research','claimed',$3,'url',$4)id", [this.missionId, outcome, payload, url])
      ).rows[0]?.id;
      await db.query('insert into public.provider_research(mission_id,task_key,evidence_id,url)values($1,$2,$3,$4)', [
        this.missionId,
        key,
        e,
        url,
      ]);
      return z.uuid().parse(e);
    });
  }
}
