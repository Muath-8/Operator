import { executeApprovedDomainRegistration } from './registrar.js';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { JsonObjectSchema, EffectIntentSchema, type JsonValue, type Result } from '@lo/state';
import {
  AdapterFault,
  ChannelsAdapter,
  PayPalAdapter,
  ShopifyAdapter,
  OpenAIGenerationAdapter,
  BrowserbaseResearchAdapter,
  CdpReadOnlyBrowserDriver,
  BrowserbaseMarketplaceAdapter,
  PlaywrightMarketplaceDriver,
  MarketplaceMessageSchema,
  outboundMessageSchema,
  paymentProposalSchema,
  hashPayload,
  FxConversionSchema,
  type MarketplaceProfile,
  type MarketplaceDriver,
  type AdapterDependencies,
  type Transport,
  type PaymentCorrelation,
} from '@lo/adapters';
import { receiptSchema, type EffectIntent } from '@lo/policy';
import { ProviderStorage, signProviderRouting } from './provider-storage.js';
import { withRole, type ActorScope } from './database.js';
import { TOOL_MANIFESTS, redact } from './security.js';
import type { ToolRegistry } from './model-services.js';
import type { AgentToolHandler } from './agents.js';
import { TaskBriefSchema, type TaskBrief } from './contracts.js';

const value = (raw: unknown): JsonValue => JSON.parse(JSON.stringify(raw)) as JsonValue;
const coreNames = new Set([
  'read_state',
  'read_artifact',
  'read_thread',
  'search_mission',
  'raise_decision',
  'brief_run',
  'validate_spec',
  'check_compatibility',
  'calculate_cost',
  'fx_lookup',
  'validate_claims',
  'schedule_followup',
]);
const referenceInput = z.object({ artifactVersionId: z.uuid(), mandateId: z.uuid().optional() }).strict();
function providerDeps(storage: ProviderStorage, transport?: Transport): AdapterDependencies {
  if (transport && process.env['NODE_ENV'] !== 'test') throw new Error('Test provider transport is forbidden outside tests');
  return { ...storage.dependencies(), ...(transport ? { transport } : {}) };
}
function unavailable(message: string): Result<JsonValue> {
  return { ok: false, error: { code: 'provider_down', message, retryable: false } };
}
function result(raw: unknown): Result<JsonValue> {
  const parsed = z
    .object({ ok: z.boolean(), code: z.string().optional(), message: z.string().optional(), retry: z.string().optional() })
    .passthrough()
    .parse(raw);
  if (parsed.ok) return { ok: true, value: value(raw) };
  const code = z
    .enum(['provider_down', 'rejected', 'rate_limited', 'window_closed', 'needs_approval', 'invariant_violation', 'validation'])
    .catch('provider_down')
    .parse(parsed.code);
  return {
    ok: false,
    error: {
      code,
      message: parsed.message ?? 'Provider operation failed; no completion inferred.',
      retryable: parsed.retry === 'same_key',
    },
  };
}
function handler(description: string, run: (input: Record<string, JsonValue>, task: TaskBrief) => Promise<unknown>): AgentToolHandler {
  return {
    description,
    execute: async (input, task) => {
      try {
        return result(await run(input, task));
      } catch (error) {
        if (error instanceof z.ZodError)
          return {
            ok: false,
            error: { code: 'validation', message: 'Tool input does not match its strict provider contract.', retryable: false },
          };
        if (error instanceof AdapterFault) return result(error.failure);
        return unavailable(
          'Provider service is unavailable or not connected. Configure a scoped encrypted credential, service budget and required account permissions; no external completion was inferred.',
        );
      }
    },
  };
}
function origin(name: 'WEBHOOK_ORIGIN' | 'VOICE_ORIGIN'): URL {
  const raw = process.env[name];
  if (!raw) throw new Error(`provider_down: ${name} required`);
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash)
    throw new Error('validation: provider callback origin must be HTTPS');
  return url;
}
async function storeOutcome(storage: ProviderStorage, raw: unknown): Promise<unknown> {
  const parsed = z
    .object({ ok: z.literal(true), receipt: receiptSchema })
    .passthrough()
    .safeParse(raw);
  if (!parsed.success) return raw;
  const r = parsed.data.receipt;
  const evidenceId = await withRole('policy_role', storage.scope, async db => {
    const receiptId = (
      await db.query(
        "select id from public.provider_receipts where mission_id=$1 and provider=$2 and provider_reference=$3 and operation=$4 and data->>'idempotencyKey'=$5",
        [storage.missionId, r.provider, r.providerId, r.operation, r.idempotencyKey],
      )
    ).rows[0]?.id;
    return z.uuid().parse((await db.query('select public.record_store_outcome($1,$2)id', [storage.missionId, receiptId])).rows[0]?.id);
  });
  const data = JsonObjectSchema.safeParse(parsed.data['data']);
  return { ...parsed.data, data: { ...(data.success ? data.data : {}), evidenceId } };
}
async function artifactEffect(
  storage: ProviderStorage,
  input: Record<string, JsonValue>,
  task: TaskBrief,
  action: string,
  effectClass: EffectIntent['effectClass'],
) {
  const request = referenceInput.parse(input);
  const artifact = await storage.artifact(request.artifactVersionId);
  if (artifact.status !== 'approved')
    throw new AdapterFault({
      ok: false,
      code: 'needs_approval',
      message: 'An approved current immutable artifact is required.',
      retry: 'never',
    });
  const template = JsonObjectSchema.parse(artifact.content['effectIntent']);
  if (template['action'] !== action || template['effectClass'] !== effectClass)
    throw new Error('validation: artifact effect capability mismatch');
  const { action: _action, effectClass: _effect, ...fields } = template;
  const connection = await storage.connection(
    action === 'send_message' ? (fields['channel'] === 'email' ? 'resend' : 'twilio') : action.startsWith('store_') ? 'shopify' : 'paypal',
    typeof fields['instrumentId'] === 'string' ? z.uuid().parse(fields['instrumentId']) : undefined,
  );
  const intent = await storage.buildIntent(
    task.id,
    action,
    effectClass,
    {
      ...fields,
      instrumentId: connection.accountId,
      artifactVersionId: request.artifactVersionId,
      ...(request.mandateId ? { mandateId: request.mandateId } : {}),
    },
    task.budgetAuthority,
  );
  return { intent, payload: artifact.payload };
}
export async function sendProviderMessage(
  storage: ProviderStorage,
  task: TaskBrief,
  input: Record<string, JsonValue>,
  channel: 'email' | 'whatsapp' | 'voice',
  templateOnly = false,
  transport?: Transport,
) {
  const parsed = z
    .object({
      counterpartyId: z.uuid(),
      artifactVersionId: z.uuid().optional(),
      mandateId: z.uuid().optional(),
      text: z.string().optional(),
      translation: z.string().optional(),
      subject: z.string().optional(),
      language: z.enum(['ar', 'en']).default('en'),
      purpose: z
        .enum([
          'introduction',
          'follow_up',
          'quotation_request',
          'sample_status',
          'payment_confirmation',
          'call_scheduling',
          'notification',
        ])
        .default('follow_up'),
      templateId: z.string().optional(),
      templateVariables: z.record(z.string(), z.string()).optional(),
      negotiationMandateId: z.uuid().optional(),
    })
    .strict()
    .parse(input);
  const approved = parsed.artifactVersionId ? await storage.artifact(parsed.artifactVersionId) : null;
  const template = approved ? JsonObjectSchema.parse(approved.content['effectIntent'] ?? {}) : {};
  const selected = typeof template['instrumentId'] === 'string' ? z.uuid().parse(template['instrumentId']) : undefined;
  const connection = await storage.connection(channel === 'email' ? 'resend' : 'twilio', selected);
  const draft = approved
    ? approved.payload
    : {
        channel,
        text: parsed.text,
        translation: parsed.translation,
        language: parsed.language,
        purpose: parsed.purpose,
        subject: parsed.subject,
        templateId: parsed.templateId,
        templateVariables: parsed.templateVariables,
        hasDocument: false,
      };
  const normalized = outboundMessageSchema.parse(draft);
  if (
    normalized.channel !== channel ||
    (templateOnly && !normalized.templateId) ||
    (!templateOnly && channel === 'whatsapp' && normalized.templateId)
  )
    throw new Error('validation: channel capability mismatch');
  const fields: Record<string, JsonValue> = {
    instrumentId: connection.accountId,
    counterpartyId: parsed.counterpartyId,
    channel,
    purpose: normalized.purpose,
    ...(parsed.artifactVersionId ? { artifactVersionId: parsed.artifactVersionId } : {}),
    ...(parsed.mandateId ? { mandateId: parsed.mandateId } : {}),
  };
  let intent = await storage.buildIntent(task.id, 'send_message', 'communicate', fields, task.budgetAuthority);
  // Content also participates in deterministic idempotency, never a user supplied random key.
  intent = { ...intent, idempotencyKey: hashPayload([intent.idempotencyKey, normalized]) };
  if (intent.mode !== 'do' && !intent.approvalToken) {
    const prior = await storage.dependencies().repository.reserveEffect(intent);
    if (!('ok' in prior) && prior.replay) {
      if (prior.status === 'performed' && prior.receipt) {
        await storage.recordOutbound(
          intent,
          { original: normalized.text, translation: normalized.translation, channel },
          prior.receipt.providerId,
        );
        return { ok: true as const, replay: true as const, receipt: prior.receipt };
      }
      return {
        ok: false as const,
        code: 'provider_down' as const,
        message: 'The earlier message outcome is uncertain; reconcile before creating another send.',
        retry: 'reconcile' as const,
      };
    }
    const version = await storage.saveDraft(
      intent.idempotencyKey,
      value(normalized) as Record<string, JsonValue>,
      {
        action: 'send_message',
        effectClass: 'communicate',
        instrumentId: connection.accountId,
        counterpartyId: parsed.counterpartyId,
        channel,
        purpose: normalized.purpose,
      },
      task.id,
    );
    return { ok: true, data: { status: 'draft', artifactVersionId: version, sent: false } };
  }
  const deps = providerDeps(storage, transport);
  const original = deps.secrets;
  let sessionId: string | undefined;
  let recordingConsent = false;
  if (channel === 'voice') {
    if (parsed.negotiationMandateId && !task.budgetAuthority.includes(parsed.negotiationMandateId))
      throw new Error('rejected: negotiation mandate outside task authority');
    const openai = await storage.connection('openai');
    const contact = await storage.contact(parsed.counterpartyId);
    sessionId = await withRole('policy_role', storage.scope, async db =>
      z
        .uuid()
        .parse(
          (
            await db.query('select public.create_voice_session($1,$2,$3,$4,$5,$6,$7,$8,$9)id', [
              storage.missionId,
              task.id,
              parsed.counterpartyId,
              parsed.negotiationMandateId ?? null,
              connection.ref,
              openai.ref,
              normalized.language,
              contact.disclosure,
              intent.mandateId ?? null,
            ])
          ).rows[0]?.id,
        ),
    );
    recordingConsent = await withRole('policy_role', storage.scope, async db =>
      z
        .boolean()
        .parse(
          (
            await db.query('select recording_consent from public.voice_sessions where mission_id=$1 and id=$2', [
              storage.missionId,
              sessionId,
            ])
          ).rows[0]?.recording_consent,
        ),
    );
    if (!(await storage.reserve(storage.missionId, `voice:${sessionId}`, 'openai', 100000)))
      throw new Error('rejected: voice service budget unavailable or this call task already started');
    await storage.reserveVoiceModel(sessionId);
  }
  deps.secrets = {
    resolve: async request => {
      const credential = JsonObjectSchema.parse(await original.resolve(request));
      if (request.provider !== 'twilio') return credential;
      const route = signProviderRouting({
        authUserId: storage.scope.authUserId,
        missionId: storage.missionId,
        credentialRef: connection.ref,
        provider: 'twilio',
        sandboxMode: connection.sandboxMode,
        ...(sessionId ? { voiceSessionId: sessionId } : {}),
      });
      return {
        ...credential,
        statusCallbackUrl: new URL(`/api/webhooks/twilio/${route}`, origin('WEBHOOK_ORIGIN')).href,
        ...(sessionId ? { voiceCallbackUrl: new URL(`/twilio/voice/${route}`, origin('VOICE_ORIGIN')).href, recordingConsent } : {}),
      };
    },
  };
  const sent = await new ChannelsAdapter(deps, {
    get: async (mission, party) => {
      if (mission !== storage.missionId) throw new Error('rejected: contact mission mismatch');
      return storage.contact(party);
    },
  }).send(intent, connection.ref, normalized);
  if (sent.ok) {
    await storage.recordOutbound(
      intent,
      { original: normalized.text, translation: normalized.translation, channel },
      sent.receipt.providerId,
    );
    await storage.recordReference(
      channel === 'email' ? 'resend' : 'twilio',
      sent.receipt.providerId,
      channel === 'voice' ? 'voice_call' : 'message',
      { counterpartyId: parsed.counterpartyId, ...(sessionId ? { voiceSessionId: sessionId } : {}) },
    );
  }
  return sent;
}

export const providerToolRegistry: ToolRegistry = {
  forTask: async (scope, task) => {
    if (scope.missionId !== task.missionId) throw new Error('invariant_violation: provider task scope mismatch');
    const storage = new ProviderStorage(scope);
    const providers: Record<string, AgentToolHandler> = {};
    for (const name of TOOL_MANIFESTS[task.role])
      if (!coreNames.has(name))
        providers[name] = handler(
          `${name}: provider connection is required; unavailable operations return a typed blocked result.`,
          async () => ({
            ok: false,
            code: 'provider_down',
            message: `${name} requires a configured provider integration; use a founder task kit when unavailable.`,
            retry: 'never',
          }),
        );
    providers['send_email'] = handler(
      'Send recorded email inside current task authority. Input {counterpartyId,artifactVersionId?,mandateId?,text?,translation?,subject?,language,purpose}. Guide mode creates a draft.',
      (i, t) => sendProviderMessage(storage, t, i, 'email'),
    );
    providers['send_whatsapp_template'] = handler(
      'Send a recorded pre-approved WhatsApp template, with disclosure on first contact. Input {counterpartyId,artifactVersionId?,mandateId?,text?,translation?,language,purpose,templateId?,templateVariables?}.',
      (i, t) => sendProviderMessage(storage, t, i, 'whatsapp', true),
    );
    providers['send_whatsapp_text'] = handler(
      'Send WhatsApp only inside the verified 24-hour reply window. Same input as email; no template.',
      (i, t) => sendProviderMessage(storage, t, i, 'whatsapp'),
    );
    providers['place_call'] = handler(
      'Initiate a policy-authorized Twilio AI call. Input {counterpartyId,artifactVersionId?,mandateId?,negotiationMandateId?,text?,translation?,language,purpose}. Opening text must begin with recorded AI disclosure.',
      (i, t) => sendProviderMessage(storage, t, i, 'voice'),
    );
    providers['marketplace_message'] = handler(
      'Read a registered Alibaba thread or send its exact approved immutable draft. Input {operation:read|send,counterpartyId,threadId,artifactVersionId?,text?,translation?,language?,purpose?}. Browser context and DOM controls are founder/operator-owned; missing registration blocks. A send timeout must be reconciled by reading, never retried with another task.',
      async (i, t) => {
        const input = z
          .object({
            operation: z.enum(['read', 'send']),
            counterpartyId: z.uuid(),
            accountId: z.uuid().optional(),
            threadId: z.string().min(1).max(160),
            artifactVersionId: z.uuid().optional(),
            text: z.string().optional(),
            translation: z.string().optional(),
            language: z.enum(['en', 'ar']).default('en'),
            purpose: z
              .enum([
                'introduction',
                'follow_up',
                'quotation_request',
                'sample_status',
                'payment_confirmation',
                'call_scheduling',
                'notification',
              ])
              .default('follow_up'),
          })
          .strict()
          .parse(i);
        if (input.operation === 'send' && input.artifactVersionId) return executeMarketplaceMessage(storage, t.id, input.artifactVersionId);
        const { connection, profile } = await storage.marketplaceProfile(input.counterpartyId, input.threadId, input.accountId);
        if (input.operation === 'send') {
          const message = MarketplaceMessageSchema.parse({
              channel: 'marketplace',
              threadId: profile.threadId,
              text: input.text,
              translation: input.translation,
              language: input.language,
              purpose: input.purpose,
            }),
            artifactVersionId = await storage.saveDraft(
              hashPayload([t.id, message]),
              value(message) as Record<string, JsonValue>,
              {
                action: 'marketplace_message',
                effectClass: 'communicate',
                counterpartyId: input.counterpartyId,
                instrumentId: connection.accountId,
                channel: 'marketplace',
                purpose: message.purpose,
              },
              t.id,
            );
          return { ok: true, data: { status: 'draft', artifactVersionId, sent: false } };
        }
        const intent = EffectIntentSchema.parse({
          missionId: t.missionId,
          taskId: t.id,
          action: 'marketplace_read',
          effectClass: 'communicate',
          counterpartyId: input.counterpartyId,
          instrumentId: connection.accountId,
          idempotencyKey: hashPayload([t.id, 'marketplace_read', profile.threadId]),
          mode: 'do',
          sandboxMode: connection.sandboxMode,
        });
        return readMarketplaceThread(storage, intent, connection, profile);
      },
    );
    const research = handler(
      'Read a public allowlisted HTTPS source through a bounded Browserbase session. Input {url:string,timeoutSeconds?:number}. Returned content is untrusted data, not verified claims.',
      async (i, t) => {
        const input = z
          .object({ url: z.string().url(), timeoutSeconds: z.number().int().min(5).max(300).default(30) })
          .strict()
          .parse(i);
        const cached = await storage.researchEvidence(t.id, input.url);
        if (cached) return { ok: true, data: { ...cached, trust: 'claimed', replay: true, kind: 'untrusted_data' } };
        const connection = await storage.connection('browserbase');
        const intent = EffectIntentSchema.parse({
          missionId: t.missionId,
          taskId: t.id,
          action: 'research',
          effectClass: 'communicate',
          counterpartyId: t.missionId,
          idempotencyKey: hashPayload([t.id, input]),
          mode: 'do',
          sandboxMode: connection.sandboxMode,
          newContact: false,
        });
        const fetched = await new BrowserbaseResearchAdapter(storage.dependencies(), storage, new CdpReadOnlyBrowserDriver()).fetchPage(
          intent,
          connection.ref,
          input,
        );
        if (!fetched.ok) return fetched;
        const page = fetched.data;
        const payload = JsonObjectSchema.parse(
          redact({
            title: page.content.title,
            excerpt: page.content.text.slice(0, 8000),
            contentHash: hashPayload(page.content.text),
            fetchedAt: page.provenance.fetchedAt,
            providerReference: page.provenance.sessionId,
          }),
        );
        const evidenceId = await storage.saveResearchEvidence(t.id, page.provenance.url, t.outcome, payload);
        const screenshotId = page.content.screenshotBase64
          ? await storage.saveAsset(page.content.screenshotBase64, 'image/png', `${page.provenance.sessionId}:screenshot`)
          : null;
        return {
          ok: true,
          data: {
            evidenceId,
            kind: 'untrusted_data',
            trust: 'claimed',
            provenance: page.provenance,
            content: payload,
            screenshot: screenshotId ? `asset:${screenshotId}` : null,
            receipt: page.receipt,
          },
        };
      },
    );
    providers['fetch_page'] = research;
    providers['registry_lookup'] = research;
    providers['web_search'] = handler(
      'Research a query through the configured allowlisted search URL. Input {query:string}. Findings remain claimed until independently verified.',
      async (i, t) => {
        const input = z
          .object({ query: z.string().min(2).max(400) })
          .strict()
          .parse(i);
        const settings = await storage.settings('browserbase');
        const template = z.string().url().parse(settings['searchUrlTemplate']);
        const url = template.replace('%QUERY%', encodeURIComponent(input.query));
        return research
          .execute({ url, timeoutSeconds: 30 }, t)
          .then(r => (r.ok ? { ok: true, data: r.value } : { ok: false, ...r.error, retry: 'never' }));
      },
    );
    for (const name of ['domain_check', 'handle_check', 'trademark_screen'])
      providers[name] = handler(
        'Inspect an authoritative configured source without claiming legal availability. Input {url:string}.',
        async (i, t) => {
          const r = await research.execute(i, t);
          return r.ok ? { ok: true, data: r.value } : { ok: false, ...r.error, retry: 'never' };
        },
      );
    providers['generate_image'] = handler(
      'Generate an image using configured allowed model and service budget. Input {prompt,model,size,transparent}. Returns a mission-owned asset reference, never a fake generated result.',
      async (i, t) => {
        const input = z
          .object({
            prompt: z.string().min(1),
            model: z.string(),
            size: z.enum(['1024x1024', '1536x1024', '1024x1536']).default('1024x1024'),
            transparent: z.boolean().default(false),
          })
          .strict()
          .parse(i);
        const connection = await storage.connection('openai');
        const intent = EffectIntentSchema.parse({
          missionId: t.missionId,
          taskId: t.id,
          action: 'generate_image',
          effectClass: 'communicate',
          counterpartyId: t.missionId,
          idempotencyKey: hashPayload([t.id, input]),
          mode: 'do',
          sandboxMode: connection.sandboxMode,
          newContact: false,
        });
        const r = await new OpenAIGenerationAdapter(storage.dependencies(), storage).image(intent, connection.ref, input);
        if (!r.ok) return r;
        const assetId = await storage.saveAsset(r.data.base64, r.data.mimeType, r.data.receipt.providerId);
        return { ok: true, data: { assetId, fileRef: `asset:${assetId}`, mimeType: r.data.mimeType, receipt: r.data.receipt } };
      },
    );
    providers['prepare_payment'] = handler(
      'Prepare a PayPal payer-approval page from an approved immutable payment artifact. Input {artifactVersionId,mandateId?}. Actual capture exists only in the trusted policy callback path.',
      async (i, t) => {
        const prepared = await artifactEffect(storage, i, t, 'payment_capture', 'spend');
        const connection = await storage.connection('paypal', prepared.intent.instrumentId);
        const proposal = paymentProposalSchema.parse(prepared.payload);
        const r = await new PayPalAdapter(storage.dependencies()).prepare(proposal, prepared.intent, connection.ref);
        if (!r.ok) return r;
        await storage.recordReference('paypal', r.data.orderId, 'payment_order', {
          artifactVersionId: prepared.intent.artifactVersionId ?? '',
          counterpartyId: prepared.intent.counterpartyId,
          amountMinor: proposal.amountMinor,
          currency: proposal.currency,
          payeeMerchantId: proposal.payeeMerchantId,
          instrumentId: prepared.intent.instrumentId ?? '',
          taskId: t.id,
          purpose: proposal.purpose,
          ...(prepared.intent.mandateId ? { mandateId: prepared.intent.mandateId } : {}),
        });
        return {
          ok: true,
          data: { orderId: r.data.orderId, approvalUrl: r.data.approvalUrl, status: 'planned', sandboxMode: connection.sandboxMode },
        };
      },
    );
    providers['store_configure'] = handler(
      'Configure a founder-owned store from an approved artifact. Public policy changes require specific publication approval. Input {artifactVersionId,mandateId?}.',
      async (i, t) => {
        const request = referenceInput.parse(i);
        const artifact = await storage.artifact(request.artifactVersionId);
        const kind = JsonObjectSchema.parse(artifact.payload)['kind'];
        const prepared = await artifactEffect(
          storage,
          i,
          t,
          kind === 'shipping' ? 'store_publish_shipping' : kind === 'policy' ? 'store_publish_policy' : 'store_configure',
          ['policy', 'shipping'].includes(String(kind)) ? 'publish' : 'communicate',
        );
        const c = await storage.connection('shopify', prepared.intent.instrumentId);
        return storeOutcome(storage, await new ShopifyAdapter(storage.dependencies()).configure(prepared.intent, c.ref, prepared.payload));
      },
    );
    providers['run_test_order'] = handler(
      'Execute an approved zero-real-spend development-store purchase/refund. Input {artifactVersionId,mandateId?}. Checkout UI and customer email remain separate E2E gates.',
      async (i, t) => {
        const prepared = await artifactEffect(storage, i, t, 'store_test_order', 'spend');
        const c = await storage.connection('shopify', prepared.intent.instrumentId);
        return storeOutcome(storage, await new ShopifyAdapter(storage.dependencies()).testOrder(prepared.intent, c.ref, prepared.payload));
      },
    );
    return Object.fromEntries(
      TOOL_MANIFESTS[task.role]
        .filter(n => !coreNames.has(n))
        .map(n => [
          n,
          providers[n] ??
            handler('Provider unavailable', async () => ({
              ok: false,
              code: 'provider_down',
              message: 'Provider capability unavailable.',
              retry: 'never',
            })),
        ]),
    );
  },
};

/** Invoked only after signed PayPal approval/capture ingress or a founder-approved server command. */
export async function captureApprovedPayPalOrder(scope: ActorScope, orderId: string, transport?: Transport): Promise<Result<JsonValue>> {
  try {
    const storage = new ProviderStorage(scope);
    const reference = await storage.reference('paypal', orderId);
    if (!reference || reference.kind !== 'payment_order') return unavailable('PayPal order is not correlated to this mission.');
    const c = reference.correlation;
    const current = await storage.artifact(z.uuid().parse(c['artifactVersionId']));
    const connection = await storage.connection('paypal', z.uuid().parse(c['instrumentId']));
    const intent = await storage.buildIntent(
      z.uuid().parse(c['taskId']),
      'payment_capture',
      'spend',
      {
        counterpartyId: z.uuid().parse(c['counterpartyId']),
        artifactVersionId: z.uuid().parse(c['artifactVersionId']),
        instrumentId: z.uuid().parse(c['instrumentId']),
        amountMinor: z.number().int().positive().parse(c['amountMinor']),
        currency: z.string().parse(c['currency']),
        purpose: z.string().parse(c['purpose']),
        ...(typeof c['mandateId'] === 'string' ? { mandateId: c['mandateId'] } : {}),
      },
      typeof c['mandateId'] === 'string' ? [c['mandateId']] : [],
    );
    const expected: PaymentCorrelation = {
      orderId,
      artifactVersionId: intent.artifactVersionId,
      payeeMerchantId: z.string().parse(c['payeeMerchantId']),
      amountMinor: intent.amountMinor ?? 0,
      currency: intent.currency ?? '',
      sandboxMode: connection.sandboxMode,
    };
    const adapter = new PayPalAdapter(providerDeps(storage, transport));
    const stored = await withRole(
      'policy_role',
      scope,
      async db =>
        (
          await db.query(
            "select provider_reference from public.provider_receipts where mission_id=$1 and provider='paypal'and operation='payment_capture'and data->>'orderId'=$2",
            [scope.missionId, orderId],
          )
        ).rows[0],
    );
    const pending = !stored
      ? await withRole(
          'policy_role',
          scope,
          async db =>
            (
              await db.query(
                "select a.id,a.intent from public.effect_authorizations a where a.mission_id=$1 and a.intent->>'taskId'=$2 and a.intent->>'artifactVersionId'=$3 and a.intent->>'action'='payment_capture'and(select status from public.effect_states s where s.authorization_id=a.id order by created_at desc,id desc limit 1)in('started','ambiguous')limit 1",
                [scope.missionId, intent.taskId, intent.artifactVersionId],
              )
            ).rows[0],
        )
      : undefined;
    let recoveredId: string | undefined;
    if (pending) {
      const previous = EffectIntentSchema.parse(pending.intent),
        verified =
          paymentProposalSchema.parse(current.payload).intent === 'AUTHORIZE'
            ? await adapter.verifyAuthorization(previous, connection.ref, expected)
            : await adapter.verify(previous, connection.ref, expected);
      if (verified.ok) {
        await storage.dependencies().repository.completeEffect(String(pending.id), verified.data.receipt);
        recoveredId = verified.data.receipt.providerId;
      }
    }
    if (!stored && !recoveredId && current.status !== 'approved')
      return {
        ok: false,
        error: {
          code: 'needs_approval',
          message: 'Payment source is stale; only an already performed effect may be reconciled.',
          retryable: false,
        },
      };
    const executed =
      stored || recoveredId
        ? { ok: true as const, receipt: { providerId: recoveredId ?? z.string().parse(stored?.provider_reference) } }
        : await adapter.execute(intent, connection.ref, expected);
    if (!executed.ok) return result(executed);
    await storage.recordReference('paypal', executed.receipt.providerId, 'payment_capture', {
      orderId,
      artifactVersionId: intent.artifactVersionId ?? '',
      counterpartyId: intent.counterpartyId,
    });
    if (paymentProposalSchema.parse(current.payload).intent === 'AUTHORIZE') {
      const paymentId = await withRole('policy_role', scope, async db => {
        const receipt = (
          await db.query(
            "select id from public.provider_receipts where mission_id=$1 and provider='paypal'and provider_reference=$2 and operation='payment_capture'",
            [scope.missionId, executed.receipt.providerId],
          )
        ).rows[0]?.id;
        return String((await db.query('select public.register_payment_authorization($1,$2)id', [scope.missionId, receipt])).rows[0]?.id);
      });
      const finalState = await withRole(
        'policy_role',
        scope,
        async db =>
          (
            await db.query(
              'select state from public.payment_states where mission_id=$1 and payment_id=$2 order by created_at desc,id desc limit 1',
              [scope.missionId, paymentId],
            )
          ).rows[0]?.state,
      );
      return {
        ok: true,
        value: {
          status: finalState === 'captured' ? 'verified' : finalState === 'refunded' ? 'refunded' : 'authorized',
          paymentId,
          authorizationId: executed.receipt.providerId,
          spent: finalState === 'captured' || finalState === 'refunded',
          sandboxMode: expected.sandboxMode,
        },
      };
    }
    const verified = await adapter.verify(intent, connection.ref, { ...expected, captureId: executed.receipt.providerId });
    if (!verified.ok) return result(verified);
    const payment = await withRole('policy_role', scope, async db => {
      const r = (
        await db.query(
          'select authorization_id,id from public.provider_receipts where mission_id=$1 and provider=$2 and provider_reference=$3 and operation=$4',
          [scope.missionId, 'paypal', executed.receipt.providerId, 'payment_capture'],
        )
      ).rows[0];
      if (!r) throw new Error('invariant_violation: capture receipt missing');
      return {
        receiptId: z.uuid().parse(r.id),
        paymentId: z
          .uuid()
          .parse((await db.query("select public.prepare_payment($1,$2,'paypal')id", [scope.missionId, r.authorization_id])).rows[0]?.id),
      };
    });
    const event = await storage
      .webhookStore('payment.verified_poll')
      .insertVerified({
        provider: 'paypal',
        providerEventId: `verified-poll:${executed.receipt.providerId}`,
        signatureVerified: true,
        payload: {
          paymentId: payment.paymentId,
          payeeId: intent.counterpartyId,
          providerReference: executed.receipt.providerId,
          orderId,
          amountMinor: expected.amountMinor,
          currency: expected.currency,
          sandboxMode: expected.sandboxMode,
        },
        payloadHash: hashPayload(verified.data),
        receivedAt: new Date().toISOString(),
      });
    await withRole('policy_role', scope, async db => {
      await db.query('select public.confirm_payment($1,$2,$3,$4)', [scope.missionId, payment.paymentId, payment.receiptId, event.eventId]);
    });
    return {
      ok: true,
      value: {
        status: 'verified',
        paymentId: payment.paymentId,
        captureId: executed.receipt.providerId,
        sandboxMode: expected.sandboxMode,
      },
    };
  } catch {
    return unavailable(
      'Payment remains pending; provider configuration, correlation or verification is unavailable. Reconcile the existing order before retry.',
    );
  }
}

export async function prepareApprovedPayPalOrder(
  scope: ActorScope,
  artifactVersionId: string,
  taskId: string,
  transport?: Transport,
): Promise<Result<JsonValue>> {
  try {
    z.uuid().parse(taskId);
    const storage = new ProviderStorage(scope);
    const artifact = await storage.artifact(z.uuid().parse(artifactVersionId));
    if (artifact.status !== 'approved')
      return {
        ok: false,
        error: { code: 'needs_approval', message: 'A current approved payment artifact is required.', retryable: false },
      };
    const template = JsonObjectSchema.parse(artifact.content['effectIntent']);
    if (template['action'] !== 'payment_capture' || template['effectClass'] !== 'spend')
      return {
        ok: false,
        error: { code: 'validation', message: 'Artifact is not an explicit payment capture proposal.', retryable: false },
      };
    const { action: _action, effectClass: _class, ...fields } = template;
    const c = await storage.connection(
      'paypal',
      typeof fields['instrumentId'] === 'string' ? z.uuid().parse(fields['instrumentId']) : undefined,
    );
    const proposal = paymentProposalSchema.parse(artifact.payload);
    const intent = await storage.buildIntent(
      taskId,
      'payment_capture',
      'spend',
      { ...fields, artifactVersionId, instrumentId: fields['instrumentId'] ?? c.accountId },
      [],
    );
    const appOrigin = new URL(process.env['APP_ORIGIN'] ?? 'http://127.0.0.1:3000');
    const callback = new URL(proposal.returnUrl);
    if (
      callback.origin !== appOrigin.origin ||
      callback.pathname !== '/api/payments/return' ||
      callback.searchParams.get('mission') !== storage.missionId
    )
      return {
        ok: false,
        error: { code: 'validation', message: 'Payment return callback must match this mission on the configured app.', retryable: false },
      };
    const r = await new PayPalAdapter(providerDeps(storage, transport)).prepare(proposal, intent, c.ref);
    if (!r.ok) return result(r);
    await storage.recordReference('paypal', r.data.orderId, 'payment_order', {
      artifactVersionId,
      counterpartyId: intent.counterpartyId,
      amountMinor: proposal.amountMinor,
      currency: proposal.currency,
      payeeMerchantId: proposal.payeeMerchantId,
      instrumentId: intent.instrumentId ?? '',
      taskId,
      purpose: proposal.purpose,
    });
    return { ok: true, value: { orderId: r.data.orderId, approvalUrl: r.data.approvalUrl, status: 'planned', sandboxMode: c.sandboxMode } };
  } catch {
    return unavailable(
      'Payment preparation requires a connected scoped PayPal account and an approved immutable proposal with valid callback URLs.',
    );
  }
}

/** Safe verified-poll fallback; known performed receipts are read without reissuing captures. */
export async function reconcileProviderPayments(scope: ActorScope, transport?: Transport): Promise<void> {
  const rows = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          "select provider_reference from public.provider_references r where mission_id=$1 and provider='paypal'and kind='payment_order'and not exists(select from public.payments p join public.payment_states s on s.payment_id=p.id where p.mission_id=r.mission_id and s.state='captured'and exists(select from public.provider_receipts pr where pr.authorization_id=p.authorization_id and pr.data->>'orderId'=r.provider_reference))order by created_at limit 20",
          [scope.missionId],
        )
      ).rows,
  );
  for (const row of rows) await captureApprovedPayPalOrder(scope, String(row.provider_reference), transport);
  await reconcileAuthorizationCaptures(scope, transport);
  await reconcileProviderRefunds(scope, transport);
}

async function reconcileProviderRefunds(scope: ActorScope, transport?: Transport): Promise<void> {
  const storage = new ProviderStorage(scope);
  const uncertain = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          "select a.id,a.intent,p.instrument_id,p.amount_minor,p.currency,p.sandbox_mode,p.artifact_version_id,original.provider_reference,original.data from public.refund_claims claim join public.effect_authorizations a on a.id=claim.effect_authorization_id join public.payments p on p.id=claim.payment_id join public.payment_states settled on settled.payment_id=p.id and settled.state='captured'join public.provider_receipts original on original.id=settled.receipt_id where claim.mission_id=$1 and not exists(select from public.provider_receipts done where done.authorization_id=a.id)and(select status from public.effect_states es where es.authorization_id=a.id order by created_at desc,id desc limit 1)in('started','ambiguous')limit 20",
          [scope.missionId],
        )
      ).rows,
  );
  for (const item of uncertain)
    try {
      const previous = EffectIntentSchema.parse(item.intent),
        connection = await storage.connection('paypal', String(item.instrument_id)),
        data = JsonObjectSchema.parse(item.data),
        known = await withRole('policy_role', scope, async db =>
          (
            await db.query(
              "select provider_reference from public.provider_receipts where mission_id=$1 and provider='paypal'and operation='payment_refund'",
              [scope.missionId],
            )
          ).rows.map(r => String(r.provider_reference)),
        );
      const recovered = await new PayPalAdapter(providerDeps(storage, transport)).findVerifiedRefund(
        previous,
        connection.ref,
        {
          orderId: z.string().parse(data['orderId']),
          captureId: String(item.provider_reference),
          artifactVersionId: String(item.artifact_version_id),
          payeeMerchantId: z.string().parse(data['payeeMerchantId']),
          amountMinor: Number(item.amount_minor),
          currency: String(item.currency),
          sandboxMode: z.boolean().parse(item.sandbox_mode),
        },
        known,
      );
      if (recovered.ok) await storage.dependencies().repository.completeEffect(String(item.id), recovered.data.receipt);
    } catch {
      console.warn('refund_recovery_pending', { missionId: scope.missionId, authorizationId: String(item.id) });
    }
  const receipts = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          "select r.id from public.provider_receipts r where r.mission_id=$1 and r.provider='paypal'and r.operation='payment_refund'and not exists(select from public.payment_refunds f where f.receipt_id=r.id)limit 20",
          [scope.missionId],
        )
      ).rows,
  );
  for (const receipt of receipts)
    try {
      await withRole('policy_role', scope, async db => {
        await db.query('select public.register_payment_refund($1,$2)', [scope.missionId, receipt.id]);
      });
    } catch {
      console.warn('refund_registration_pending', { missionId: scope.missionId, receiptId: String(receipt.id) });
    }
  const refunds = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          'select f.id,f.provider_refund_id,f.amount_minor,a.intent,r.data,p.amount_minor original_amount,p.artifact_version_id original_version,p.payee_id,p.currency,p.sandbox_mode from public.payment_refunds f join public.effect_authorizations a on a.id=f.authorization_id join public.provider_receipts r on r.id=f.receipt_id join public.payments p on p.id=f.payment_id where f.mission_id=$1 and not exists(select from public.refund_confirmations c where c.refund_id=f.id)limit 20',
          [scope.missionId],
        )
      ).rows,
  );
  for (const row of refunds)
    try {
      const intent = EffectIntentSchema.parse(row.intent),
        data = JsonObjectSchema.parse(row.data),
        connection = await storage.connection('paypal', intent.instrumentId);
      const expected: PaymentCorrelation = {
        orderId: z.string().parse(data['orderId']),
        captureId: z.string().parse(data['captureId']),
        artifactVersionId: z.uuid().parse(row.original_version),
        payeeMerchantId: z.string().parse(data['payeeMerchantId']),
        amountMinor: Number(row.original_amount),
        currency: z.string().parse(row.currency),
        sandboxMode: z.boolean().parse(row.sandbox_mode),
      };
      const verified = await new PayPalAdapter(providerDeps(storage, transport)).verifyRefund(
        intent,
        connection.ref,
        expected,
        String(row.provider_refund_id),
        Number(row.amount_minor),
      );
      if (!verified.ok) continue;
      const event = await storage
        .webhookStore('payment.refund_verified_poll')
        .insertVerified({
          provider: 'paypal',
          providerEventId: `verified-refund:${String(row.provider_refund_id)}`,
          payload: {
            refundId: String(row.id),
            providerReference: String(row.provider_refund_id),
            orderId: expected.orderId,
            captureId: expected.captureId ?? '',
            payeeId: String(row.payee_id),
            amountMinor: Number(row.amount_minor),
            currency: expected.currency,
            sandboxMode: expected.sandboxMode,
          },
          payloadHash: hashPayload(verified.data),
          receivedAt: new Date().toISOString(),
          signatureVerified: true,
        });
      await withRole('policy_role', scope, async db => {
        await db.query('select public.confirm_payment_refund($1,$2,$3)', [scope.missionId, row.id, event.eventId]);
      });
    } catch {
      console.warn('refund_verification_pending', { missionId: scope.missionId, refundId: String(row.id) });
    }
}

async function reconcileAuthorizationCaptures(scope: ActorScope, transport?: Transport): Promise<void> {
  const storage = new ProviderStorage(scope);
  const uncertain = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          "select a.id,a.intent,pa.order_id,p.artifact_version_id,p.instrument_id,p.amount_minor,p.currency,p.sandbox_mode,original.data from public.authorization_followups f join public.effect_authorizations a on a.id=f.effect_authorization_id join public.payment_authorizations pa on pa.id=f.source_authorization_id join public.payments p on p.id=pa.payment_id join public.provider_receipts original on original.id=pa.receipt_id where f.mission_id=$1 and f.action='payment_authorization_capture'and not exists(select from public.provider_receipts done where done.authorization_id=a.id)and(select status from public.effect_states es where es.authorization_id=a.id order by created_at desc,id desc limit 1)in('started','ambiguous')limit 20",
          [scope.missionId],
        )
      ).rows,
  );
  for (const item of uncertain)
    try {
      const previous = EffectIntentSchema.parse(item.intent),
        connection = await storage.connection('paypal', String(item.instrument_id)),
        data = JsonObjectSchema.parse(item.data),
        verified = await new PayPalAdapter(providerDeps(storage, transport)).verify(previous, connection.ref, {
          orderId: String(item.order_id),
          artifactVersionId: String(item.artifact_version_id),
          payeeMerchantId: z.string().parse(data['payeeMerchantId']),
          amountMinor: Number(item.amount_minor),
          currency: String(item.currency),
          sandboxMode: z.boolean().parse(item.sandbox_mode),
        });
      if (verified.ok) await storage.dependencies().repository.completeEffect(String(item.id), verified.data.receipt);
    } catch {
      console.warn('authorization_capture_recovery_pending', { missionId: scope.missionId, authorizationId: String(item.id) });
    }
  const rows = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          "select r.id receipt_id,r.provider_reference,r.data,a.intent,pa.order_id,p.id payment_id,p.artifact_version_id,p.payee_id,p.instrument_id,p.amount_minor,p.currency,p.sandbox_mode from public.provider_receipts r join public.authorization_followups f on f.effect_authorization_id=r.authorization_id and f.action='payment_authorization_capture'join public.effect_authorizations a on a.id=r.authorization_id join public.payment_authorizations pa on pa.id=f.source_authorization_id join public.payments p on p.id=pa.payment_id where r.mission_id=$1 and r.operation='payment_authorization_capture'and not exists(select from public.money_ledger m where m.receipt_id=r.id and m.kind='spent')limit 20",
          [scope.missionId],
        )
      ).rows,
  );
  for (const row of rows)
    try {
      const intent = EffectIntentSchema.parse(row.intent),
        data = JsonObjectSchema.parse(row.data),
        connection = await storage.connection('paypal', String(row.instrument_id));
      const expected: PaymentCorrelation = {
        orderId: String(row.order_id),
        captureId: String(row.provider_reference),
        artifactVersionId: String(row.artifact_version_id),
        payeeMerchantId: z.string().parse(data['payeeMerchantId']),
        amountMinor: Number(row.amount_minor),
        currency: String(row.currency),
        sandboxMode: z.boolean().parse(row.sandbox_mode),
      };
      const verified = await new PayPalAdapter(providerDeps(storage, transport)).verify(intent, connection.ref, expected);
      if (!verified.ok) continue;
      const paymentId = await withRole('policy_role', scope, async db =>
        String((await db.query('select public.payment_for_capture($1,$2)id', [scope.missionId, row.receipt_id])).rows[0]?.id),
      );
      const event = await storage
        .webhookStore('payment.verified_poll')
        .insertVerified({
          provider: 'paypal',
          providerEventId: `verified-poll:${String(row.provider_reference)}`,
          signatureVerified: true,
          payload: {
            paymentId,
            payeeId: String(row.payee_id),
            providerReference: String(row.provider_reference),
            orderId: String(row.order_id),
            amountMinor: Number(row.amount_minor),
            currency: String(row.currency),
            sandboxMode: z.boolean().parse(row.sandbox_mode),
          },
          payloadHash: hashPayload(verified.data),
          receivedAt: new Date().toISOString(),
        });
      await withRole('policy_role', scope, db =>
        db.query('select public.confirm_payment($1,$2,$3,$4)', [scope.missionId, paymentId, row.receipt_id, event.eventId]),
      );
    } catch {
      console.warn('authorization_capture_verification_pending', { missionId: scope.missionId, receiptId: String(row.receipt_id) });
    }
}

export async function processVoiceWrittenConfirmation(
  scope: ActorScope,
  sessionId: string,
  transport?: Transport,
): Promise<Result<JsonValue>> {
  try {
    const storage = new ProviderStorage(scope);
    const session = await storage.voiceSession(sessionId);
    const data = await withRole('policy_role', scope, async db => {
      const events = (
        await db.query(
          'select kind,event_key,payload from public.voice_session_events where mission_id=$1 and session_id=$2 order by created_at',
          [scope.missionId, sessionId],
        )
      ).rows;
      const task = TaskBriefSchema.parse(
        (await db.query('select brief from public.runs where mission_id=$1 and id=$2', [scope.missionId, session.task_id])).rows[0]?.brief,
      );
      return { events, task };
    });
    if (!data.events.some(e => e.kind === 'ended'))
      return { ok: false, error: { code: 'validation', message: 'Call has not ended.', retryable: false } };
    const ended = JsonObjectSchema.parse(data.events.find(e => e.kind === 'ended')?.payload ?? {});
    const usage = z.number().int().nonnegative().max(100000).safeParse(ended['usedTokens']);
    if (usage.success) await storage.complete(storage.missionId, `voice:${sessionId}`, `voice:${sessionId}`, usage.data);
    else await storage.ambiguous(storage.missionId, `voice:${sessionId}`);
    await withRole('policy_role', scope, db => db.query('select public.reconcile_voice_confirmations($1)', [scope.missionId]));
    const fulfilled = await withRole('policy_role', scope, async db =>
      Boolean(
        (
          await db.query(
            "select o.session_id from public.voice_confirmation_obligations o join public.commitment_states cs on cs.commitment_id=o.commitment_id and cs.status='closed'where o.mission_id=$1 and o.session_id=$2",
            [scope.missionId, sessionId],
          )
        ).rows[0],
      ),
    );
    if (fulfilled) return { ok: true, value: { status: 'already_processed' } };
    const facts = data.events.filter(e => e.kind === 'fact').map(e => JSON.stringify(e.payload));
    const intro =
      session.language === 'ar'
        ? 'سجل مكتوب للمكالمة: المعلومات التالية ادعاءات شفهية وليست موافقة على طلب إنتاج أو دفع. يرجى تأكيدها أو تصحيحها كتابة. أي التزام يحتاج موافقة المؤسس.'
        : 'Written call record: these are claimed verbal statements, not acceptance of a production order or payment. Please confirm or correct them in writing. Binding commitments require founder approval.';
    const text = `${session.disclosure}\n\n${intro}\n${facts.length ? facts.join('\n') : 'No commercial terms were confirmed on the call.'}`;
    const bodyHash = createHash('sha256').update(text).digest('hex');
    await withRole('policy_role', scope, db =>
      db.query('select public.plan_voice_confirmation($1,$2,$3,null)', [scope.missionId, sessionId, bodyHash]),
    );
    const linked = await withRole(
      'policy_role',
      scope,
      async db =>
        (
          await db.query(
            'select artifact_version_id from public.voice_confirmation_drafts where mission_id=$1 and session_id=$2 order by created_at desc limit 1',
            [scope.missionId, sessionId],
          )
        ).rows[0],
    );
    if (linked) {
      const approved = await storage.artifact(String(linked.artifact_version_id));
      if (approved.status !== 'approved')
        return { ok: true, value: { status: 'draft', artifactVersionId: String(linked.artifact_version_id), sent: false } };
    }
    const sent = await sendProviderMessage(
      storage,
      data.task,
      {
        counterpartyId: session.counterparty_id,
        ...(session.outreach_mandate_id ? { mandateId: session.outreach_mandate_id } : {}),
        text,
        translation: text,
        language: session.language,
        purpose: 'follow_up',
        subject: session.language === 'ar' ? 'تأكيد مكتوب للمكالمة' : 'Written confirmation of our call',
      },
      'email',
      false,
      transport,
    );
    if (!sent.ok) return result(sent);
    if ('data' in sent && 'status' in sent.data && sent.data.status === 'draft') {
      const version = z.uuid().parse(sent.data.artifactVersionId);
      await withRole('policy_role', scope, db =>
        db.query('select public.plan_voice_confirmation($1,$2,$3,$4)', [scope.missionId, sessionId, bodyHash, version]),
      );
      return result(sent);
    }
    await withRole('policy_role', scope, async db => {
      await db.query('select public.reconcile_voice_confirmations($1)', [scope.missionId]);
      await db.query('select public.reconcile_commitment_chase_receipts($1)', [scope.missionId]);
      await db.query('select public.reconcile_sourcing_campaign_deliveries($1)', [scope.missionId]);
    });
    return result(sent);
  } catch {
    return unavailable('Written confirmation remains due; connected email, current channel authority and the call record are required.');
  }
}

export async function reconcileVoiceConfirmations(scope: ActorScope): Promise<void> {
  const rows = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          "select id from public.voice_sessions v where v.mission_id=$1 and exists(select from public.voice_session_events e where e.session_id=v.id and e.kind='ended')and not exists(select from public.voice_session_events e where e.session_id=v.id and e.event_key='written-confirmation')order by v.created_at limit 20",
          [scope.missionId],
        )
      ).rows,
  );
  for (const row of rows) await processVoiceWrittenConfirmation(scope, String(row.id));
}

async function readMarketplaceThread(
  storage: ProviderStorage,
  intent: EffectIntent,
  connection: { ref: string; accountId: string },
  profile: MarketplaceProfile,
  test?: { driver: MarketplaceDriver; transport: Transport },
) {
  if (test && process.env['NODE_ENV'] !== 'test') throw new Error('Test marketplace driver is forbidden outside tests');
  const read = await new BrowserbaseMarketplaceAdapter(
    providerDeps(storage, test?.transport),
    storage,
    { get: async () => storage.contact(profile.counterpartyId) },
    test?.driver ?? new PlaywrightMarketplaceDriver(),
  ).read(intent, connection.ref, profile);
  if (!read.ok) return read;
  const observed = read.data,
    imported = await withRole('policy_role', storage.scope, async db =>
      Number(
        (
          await db.query('select public.record_marketplace_inbound($1,$2,$3,$4,$5,$6,$7)count', [
            storage.missionId,
            connection.accountId,
            profile.counterpartyId,
            profile.threadId,
            hashPayload(profile),
            observed.sessionId,
            JSON.stringify(observed.messages),
          ])
        ).rows[0]?.count,
      ),
    );
  const assetId = await storage.saveAsset(observed.screenshotBase64, 'image/png', `${observed.sessionId}:marketplace-read`),
    evidenceIds = await withRole('policy_role', storage.scope, async db =>
      (
        await db.query(
          "select id from public.evidence where mission_id=$1 and kind='marketplace_reply'and payload->>'counterpartyId'=$2 and payload->>'threadKey'=$3 order by created_at desc limit 500",
          [storage.missionId, profile.counterpartyId, profile.threadId],
        )
      ).rows.map(row => z.uuid().parse(row.id)),
    );
  return {
    ok: true as const,
    data: {
      threadId: profile.threadId,
      imported,
      evidenceIds,
      messages: observed.messages,
      trust: 'claimed',
      screenshot: `asset:${assetId}`,
    },
  };
}
/** Default-off paid inbox polling. Each configured account explicitly chooses
 *15..1440minutes. Database claims prevent concurrent or crash-loop duplicates. */
export async function reconcileMarketplaceInbox(
  scope: ActorScope,
  test?: { driver: MarketplaceDriver; transport: Transport },
): Promise<{ examined: number; polled: number; imported: number; blocked: number }> {
  if (test && process.env['NODE_ENV'] !== 'test') throw new Error('Test marketplace driver is forbidden outside tests');
  const storage = new ProviderStorage(scope),
    candidates: { accountId: string; partyId: string; threadId: string; last: number; minutes: number }[] = [];
  let configurationBlocked = 0;
  const accounts = await withRole(
    'policy_role',
    scope,
    async db =>
      (
        await db.query(
          "select distinct b.account_id from public.marketplace_thread_bindings b join public.founder_accounts a on a.id=b.account_id where b.mission_id=$1 and a.status='connected'and not exists(select from public.account_revocations r where r.account_id=a.id)",
          [scope.missionId],
        )
      ).rows,
  );
  for (const account of accounts)
    try {
      const accountId = z.uuid().parse(account.account_id),
        connection = await storage.connection('browserbase', accountId),
        settings = await storage.settingsFor(connection.ref, 'browserbase', connection.sandboxMode);
      if (settings['marketplacePollMinutes'] === undefined) continue;
      const minutes = z.number().int().min(15).max(1440).parse(settings['marketplacePollMinutes']),
        bindings = await withRole(
          'policy_role',
          scope,
          async db =>
            (
              await db.query(
                'select distinct b.counterparty_id,b.thread_key,(select max(p.created_at)from public.marketplace_poll_attempts p where p.mission_id=b.mission_id and p.account_id=b.account_id and p.counterparty_id=b.counterparty_id and p.thread_key=b.thread_key)last_poll from public.marketplace_thread_bindings b where b.mission_id=$1 and b.account_id=$2 and not public.counterparty_opted_out($1,b.counterparty_id)',
                [scope.missionId, accountId],
              )
            ).rows,
        );
      for (const binding of bindings) {
        const last = binding.last_poll ? new Date(String(binding.last_poll)).getTime() : 0;
        if (Date.now() - last >= minutes * 60000)
          candidates.push({
            accountId,
            partyId: z.uuid().parse(binding.counterparty_id),
            threadId: z.string().parse(binding.thread_key),
            last,
            minutes,
          });
      }
    } catch {
      configurationBlocked++;
    }
  let polled = 0,
    imported = 0,
    blocked = configurationBlocked;
  for (const candidate of candidates.sort((a, b) => a.last - b.last).slice(0, 3))
    try {
      const { connection, profile } = await storage.marketplaceProfile(candidate.partyId, candidate.threadId, candidate.accountId),
        key = hashPayload([
          storage.missionId,
          candidate.accountId,
          candidate.threadId,
          Math.floor(Date.now() / (candidate.minutes * 60000)),
        ]),
        claimed = await withRole(
          'policy_role',
          scope,
          async db =>
            (
              await db.query('select public.claim_marketplace_poll($1,$2,$3,$4,$5,$6,$7)claimed', [
                scope.missionId,
                candidate.accountId,
                candidate.partyId,
                candidate.threadId,
                hashPayload(profile),
                candidate.minutes,
                key,
              ])
            ).rows[0]?.claimed,
        );
      if (!claimed) continue;
      const taskId = `${key.slice(0, 8)}-${key.slice(8, 12)}-4${key.slice(13, 16)}-a${key.slice(17, 20)}-${key.slice(20, 32)}`,
        intent = EffectIntentSchema.parse({
          missionId: storage.missionId,
          taskId,
          action: 'marketplace_read',
          effectClass: 'communicate',
          counterpartyId: candidate.partyId,
          instrumentId: candidate.accountId,
          idempotencyKey: key,
          mode: 'do',
          sandboxMode: connection.sandboxMode,
        }),
        read = await readMarketplaceThread(storage, intent, connection, profile, test);
      if (read.ok) {
        polled++;
        imported += read.data.imported;
      } else blocked++;
    } catch {
      blocked++;
    }
  return { examined: Math.min(candidates.length, 3), polled, imported, blocked };
}

async function executeMarketplaceMessage(storage: ProviderStorage, taskId: string, versionId: string) {
  const artifact = await storage.artifact(versionId);
  if (artifact.status !== 'approved')
    return { ok: false, code: 'needs_approval', message: 'Current approved marketplace message required.', retry: 'never' };
  const message = MarketplaceMessageSchema.parse(artifact.payload),
    template = z
      .object({
        action: z.literal('marketplace_message'),
        effectClass: z.literal('communicate'),
        counterpartyId: z.uuid(),
        instrumentId: z.uuid(),
        channel: z.literal('marketplace'),
        purpose: z.string(),
      })
      .strict()
      .parse(artifact.content['effectIntent']);
  const { connection, profile } = await storage.marketplaceProfile(template.counterpartyId, message.threadId, template.instrumentId),
    intent = await storage.buildIntent(
      taskId,
      'marketplace_message',
      'communicate',
      {
        counterpartyId: template.counterpartyId,
        instrumentId: connection.accountId,
        artifactVersionId: versionId,
        channel: 'marketplace',
        purpose: message.purpose,
      },
      [],
    ),
    sent = await new BrowserbaseMarketplaceAdapter(
      storage.dependencies(),
      storage,
      { get: async () => storage.contact(template.counterpartyId) },
      new PlaywrightMarketplaceDriver(),
    ).send(intent, connection.ref, message, profile);
  if (!sent.ok) return sent;
  await withRole('policy_role', storage.scope, db =>
    db.query('select public.record_marketplace_outbound($1,$2,$3,$4,$5)', [
      storage.missionId,
      intent.counterpartyId,
      sent.receipt.providerId,
      message.text,
      message.translation,
    ]),
  );
  if ('data' in sent) {
    const assetId = await storage.saveAsset(sent.data.screenshotBase64, 'image/png', `${sent.data.sessionId}:marketplace-send`);
    return { ...sent, data: { messageId: sent.data.messageId, threadId: message.threadId, screenshot: `asset:${assetId}` } };
  }
  return sent;
}

/** Trusted founder-command path; never part of a model's tool manifest. */
export async function executeApprovedProviderEffect(
  scope: ActorScope,
  artifactVersionId: string,
  taskId: string,
  transport?: Transport,
): Promise<Result<JsonValue>> {
  try {
    await withRole('policy_role', scope, db => db.query('select public.reconcile_outbound_receipts($1)', [scope.missionId]));
    const storage = new ProviderStorage(scope);
    const artifact = await storage.artifact(artifactVersionId);
    if (artifact.status !== 'approved')
      return {
        ok: false,
        error: { code: 'needs_approval', message: 'The external effect artifact is not approved and current.', retryable: false },
      };
    if (JsonObjectSchema.parse(artifact.content['effectIntent'])['action'] === 'send_message') {
      const previous = await withRole(
        'policy_role',
        scope,
        async db =>
          (
            await db.query(
              "select intent->>'taskId' task_id from public.effect_authorizations where mission_id=$1 and intent->>'artifactVersionId'=$2 and intent->>'action'='send_message'order by created_at,id limit 1",
              [scope.missionId, artifactVersionId],
            )
          ).rows[0]?.task_id,
      );
      // Existing attempts keep their exact replay identity; newly approved drafts
      // retain the originating workflow task so its dispatch guards still apply.
      if (previous !== undefined) taskId = z.uuid().parse(previous);
      else if (artifact.content['originatingTaskId'] !== undefined) taskId = z.uuid().parse(artifact.content['originatingTaskId']);
      else if (artifact.content['professionalEngagement']) {
        const registered = await withRole(
          'policy_role',
          scope,
          async db =>
            (
              await db.query('select task_id from public.professional_engagements where mission_id=$1 and artifact_version_id=$2', [
                scope.missionId,
                artifactVersionId,
              ])
            ).rows[0]?.task_id,
        );
        if (registered !== undefined) taskId = z.uuid().parse(registered);
      }
    }
    if (JsonObjectSchema.parse(artifact.content['effectIntent'])['action'] === 'registration')
      return executeApprovedDomainRegistration(scope, artifactVersionId, taskId, transport);
    if (JsonObjectSchema.parse(artifact.content['effectIntent'])['action'] === 'marketplace_message')
      return result(await executeMarketplaceMessage(storage, taskId, artifactVersionId));
    const template = JsonObjectSchema.parse(artifact.content['effectIntent']);
    const action = z.string().parse(template['action']);
    const effectClass = z.enum(['communicate', 'publish', 'spend', 'bind']).parse(template['effectClass']);
    const { action: _a, effectClass: _e, ...fields } = template;
    const selected = await storage.connection(
      action === 'send_message'
        ? fields['channel'] === 'email'
          ? 'resend'
          : 'twilio'
        : action.startsWith('store_')
          ? 'shopify'
          : 'paypal',
      typeof fields['instrumentId'] === 'string' ? z.uuid().parse(fields['instrumentId']) : undefined,
    );
    const intent = await storage.buildIntent(
      z.uuid().parse(taskId),
      action,
      effectClass,
      { ...fields, instrumentId: selected.accountId, artifactVersionId },
      [],
    );
    if (action === 'send_message') {
      let task = TaskBriefSchema.parse({
        id: taskId,
        missionId: scope.missionId,
        role: 'operations',
        outcome: 'supply',
        objective: 'Send the exact founder-approved immutable message',
        constraints: [],
        budgetAuthority: [],
        deadline: new Date(Date.now() + 300000).toISOString(),
        doneCriteria: ['Record a provider receipt'],
        evidenceRequired: ['approved message'],
        playbook: { id: 'approved-message', version: 1, step: 'send', source: 'https://www.twilio.com/docs/messaging' },
        maxToolCalls: 1,
        maxTokens: 256,
        tier: 'small',
        requestedByFounder: true,
        overdueExposure: false,
        unblocks: [],
        parentRunId: null,
      });
      const message = outboundMessageSchema.parse(artifact.payload);
      if (message.channel === 'voice') {
        const original = z.uuid().parse(artifact.content['originatingTaskId']);
        task = await withRole('policy_role', scope, async db =>
          TaskBriefSchema.parse(
            (await db.query('select brief from public.runs where mission_id=$1 and id=$2', [scope.missionId, original])).rows[0]?.brief,
          ),
        );
      }
      const linked = await withRole(
        'policy_role',
        scope,
        async db =>
          (
            await db.query(
              'select d.session_id from public.voice_confirmation_drafts d join public.artifact_versions old on old.id=d.artifact_version_id join public.artifact_versions current on current.artifact_id=old.artifact_id where d.mission_id=$1 and current.id=$2 limit 1',
              [scope.missionId, artifactVersionId],
            )
          ).rows[0],
      );
      if (linked)
        await withRole('policy_role', scope, db =>
          db.query('select public.plan_voice_confirmation($1,$2,$3,$4)', [
            scope.missionId,
            linked.session_id,
            createHash('sha256').update(message.text).digest('hex'),
            artifactVersionId,
          ]),
        );
      if (!['email', 'whatsapp', 'voice'].includes(message.channel))
        return unavailable('This approved channel needs its dedicated capability.');
      const sent = await sendProviderMessage(
        storage,
        task,
        { counterpartyId: intent.counterpartyId, artifactVersionId, language: message.language, purpose: message.purpose },
        message.channel as 'email' | 'whatsapp' | 'voice',
        Boolean(message.templateId),
        transport,
      );
      await withRole('policy_role', scope, async db => {
        await db.query('select public.reconcile_voice_confirmations($1)', [scope.missionId]);
        await db.query('select public.reconcile_commitment_chase_receipts($1)', [scope.missionId]);
        await db.query('select public.reconcile_sourcing_campaign_deliveries($1)', [scope.missionId]);
        await db.query('select public.reconcile_professional_starts($1)', [scope.missionId]);
      });
      return result(sent);
    }
    if (action === 'store_publish') {
      const input = z.object({ productId: z.string(), publicationId: z.string() }).strict().parse(artifact.payload);
      const c = await storage.connection('shopify', intent.instrumentId);
      return result(
        await storeOutcome(
          storage,
          await new ShopifyAdapter(providerDeps(storage, transport)).publish(
            intent,
            c.ref,
            input.productId,
            input.publicationId,
            z.object({ sourceVersionId: z.uuid() }).passthrough().parse(artifact.content['contentReview']).sourceVersionId,
          ),
        ),
      );
    }
    if (['store_publish_policy', 'store_publish_shipping'].includes(action)) {
      const c = await storage.connection('shopify', intent.instrumentId);
      return result(
        await storeOutcome(storage, await new ShopifyAdapter(providerDeps(storage, transport)).configure(intent, c.ref, artifact.payload)),
      );
    }
    if (['payment_refund', 'payment_authorization_capture', 'payment_authorization_void'].includes(action)) {
      const expected = z
        .object({
          orderId: z.string(),
          captureId: z.string().optional(),
          artifactVersionId: z.uuid().optional(),
          payeeMerchantId: z.string(),
          amountMinor: z.number().int().positive(),
          currency: z.string(),
          sandboxMode: z.boolean(),
          authorizationId: z.string().optional(),
          conversion: FxConversionSchema.optional(),
        })
        .strict()
        .parse(artifact.payload);
      const c = await storage.connection('paypal', intent.instrumentId);
      const adapter = new PayPalAdapter(providerDeps(storage, transport));
      if (action === 'payment_refund') {
        const reversed = await adapter.reverse(intent, c.ref, expected);
        if (!reversed.ok) return result(reversed);
        await reconcileProviderRefunds(scope, transport);
        const confirmed = await withRole('policy_role', scope, async db =>
          Boolean(
            (
              await db.query(
                'select f.id from public.payment_refunds f join public.refund_confirmations c on c.refund_id=f.id where f.mission_id=$1 and f.provider_refund_id=$2',
                [scope.missionId, reversed.receipt.providerId],
              )
            ).rows[0],
          ),
        );
        return {
          ok: true,
          value: {
            status: confirmed ? 'refunded_verified' : 'pending_verification',
            refundReference: reversed.receipt.providerId,
            receipt: reversed.receipt,
          },
        };
      }
      if (!expected.authorizationId)
        return { ok: false, error: { code: 'validation', message: 'The approved authorization reference is missing.', retryable: false } };
      const performed =
        action === 'payment_authorization_capture'
          ? await adapter.captureAuthorization(intent, c.ref, expected, expected.authorizationId)
          : await adapter.voidAuthorization(intent, c.ref, expected, expected.authorizationId);
      if (!performed.ok) return result(performed);
      if (action === 'payment_authorization_capture') await reconcileAuthorizationCaptures(scope, transport);
      else
        await withRole('policy_role', scope, async db => {
          const receipt = (
            await db.query('select id from public.provider_receipts where mission_id=$1 and provider_reference=$2 and operation=$3', [
              scope.missionId,
              performed.receipt.providerId,
              action,
            ])
          ).rows[0]?.id;
          await db.query('select public.register_authorization_void($1,$2)', [scope.missionId, receipt]);
        });
      return result(performed);
    }
    return {
      ok: false,
      error: {
        code: 'validation',
        message: 'This approved action requires its founder task kit or a supported dedicated policy capability.',
        retryable: false,
      },
    };
  } catch {
    return unavailable(
      'Approved provider execution is blocked by configuration, current evidence or provider verification. Approval is retained in the ledger; no performed result was inferred.',
    );
  }
}
