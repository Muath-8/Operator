import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  executeGuarded,
  failure,
  type EffectIntent,
  type EffectRepository,
  type Failure,
  type ProviderResult,
  type Receipt,
  type ToolContext,
} from '@lo/policy';

export type Provider = 'paypal' | 'twilio' | 'resend' | 'shopify' | 'browserbase' | 'openai' | 'godaddy';
export interface CredentialRequest {
  ref: string;
  missionId: string;
  provider: Provider;
  sandboxMode: boolean;
  instrumentId?: string;
}
/** Secret manager must reject revoked references and enforce mission, provider and environment ownership. */
export interface SecretStore {
  resolve(request: CredentialRequest): Promise<unknown>;
}
export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
export const fetchTransport: Transport = async r => {
  const res = await fetch(r.url, {
    method: r.method,
    headers: r.headers,
    ...(r.body === undefined ? {} : { body: r.body }),
    redirect: 'error',
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    body = null;
  }
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()), body };
};
export interface ApprovedArtifactStore {
  get(missionId: string, versionId: string): Promise<{ status: 'approved' | 'proposed' | 'superseded'; content: unknown }>;
}
export interface PreparationRequest {
  provider: Provider;
  kind: 'paypal_order' | 'openai_image' | 'openai_structured' | 'browserbase_research' | 'voice_realtime' | 'registrar_quote';
  credentialRef: string;
  intent: EffectIntent;
  requestHash: string;
  model?: string;
  maximumUnits?: number;
}
/** Durable pre-effect/service claim and locked mission/platform/account recheck through the external invocation. */
export interface PreparationDispatch {
  execute<T>(request: PreparationRequest, invoke: () => Promise<T>): Promise<T>;
}
export interface AdapterDependencies {
  repository: EffectRepository;
  secrets: SecretStore;
  transport?: Transport;
  context: ToolContext;
  now?: () => Date;
  approvedArtifacts?: ApprovedArtifactStore;
  allowedCallbackOrigins?: readonly string[];
  preparations?: PreparationDispatch;
}
export class AdapterFault extends Error {
  constructor(readonly failure: Failure) {
    super(failure.message);
  }
}
export const credentialBaseSchema = { sandboxMode: z.boolean(), missionId: z.string().min(1), revoked: z.literal(false) };
export class Boundary {
  readonly transport: Transport;
  constructor(readonly deps: AdapterDependencies) {
    this.transport = deps.transport ?? fetchTransport;
  }
  now(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
  async preparation<T>(request: PreparationRequest, invoke: () => Promise<T>): Promise<{ ok: true; data: T } | Failure> {
    return this.read(async () => {
      if (!this.deps.preparations) throw new AdapterFault(failure('rejected', 'A durable preparation/service dispatch lease is required.'));
      return this.deps.preparations.execute(request, invoke);
    });
  }
  async approvedInput(intent: Pick<EffectIntent, 'missionId' | 'artifactVersionId'>, content: unknown): Promise<void> {
    if (!intent.artifactVersionId || !this.deps.approvedArtifacts)
      throw new AdapterFault(failure('needs_approval', 'Approved immutable artifact is required.'));
    const artifact = await this.deps.approvedArtifacts.get(intent.missionId, intent.artifactVersionId);
    if (artifact.status !== 'approved' || hashPayload(artifact.content) !== hashPayload(content))
      throw new AdapterFault(failure('needs_approval', 'Input differs from the approved artifact version.'));
  }
  async credential<T>(
    provider: Provider,
    ref: string,
    intent: Pick<EffectIntent, 'missionId' | 'sandboxMode' | 'instrumentId'>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    let raw: unknown;
    try {
      raw = await this.deps.secrets.resolve({
        ref,
        provider,
        missionId: intent.missionId,
        sandboxMode: intent.sandboxMode,
        ...(intent.instrumentId ? { instrumentId: intent.instrumentId } : {}),
      });
    } catch {
      throw new AdapterFault(failure('rejected', 'Credential unavailable or revoked.'));
    }
    const base = z.object(credentialBaseSchema).passthrough().safeParse(raw);
    const parsed = schema.safeParse(raw);
    if (!base.success || !parsed.success || base.data.missionId !== intent.missionId || base.data.sandboxMode !== intent.sandboxMode)
      throw new AdapterFault(failure('rejected', 'Credential scope or environment mismatch.'));
    return parsed.data;
  }
  async http(request: HttpRequest, mutating: boolean): Promise<HttpResponse> {
    let response: HttpResponse;
    try {
      response = await this.transport(request);
    } catch {
      throw new AdapterFault(
        failure('provider_down', 'Provider transport failed; outcome must be reconciled.', mutating ? 'reconcile' : 'same_key'),
      );
    }
    if (response.status >= 200 && response.status < 300) return response;
    const retry = mutating && response.status >= 500 ? 'reconcile' : 'never';
    throw new AdapterFault(
      failure(
        response.status === 429 ? 'rate_limited' : response.status >= 500 ? 'provider_down' : 'rejected',
        `Provider returned HTTP ${response.status}.`,
        retry,
      ),
    );
  }
  receipt(
    provider: Provider,
    providerId: string,
    intent: Pick<EffectIntent, 'action' | 'idempotencyKey' | 'sandboxMode'>,
    payload: unknown,
    correlation?: Receipt['correlation'],
    verification?: Receipt['verification'],
  ): Receipt {
    return {
      provider,
      providerId,
      operation: intent.action,
      timestamp: this.now(),
      payloadHash: hashPayload(payload),
      idempotencyKey: intent.idempotencyKey,
      sandboxMode: intent.sandboxMode,
      ...(correlation ? { correlation } : {}),
      ...(verification ? { verification } : {}),
    };
  }
  async effect<T>(
    intent: EffectIntent,
    action: string,
    effectClass: EffectIntent['effectClass'],
    invoke: () => Promise<{ data: T; receipt: Receipt }>,
  ): Promise<ProviderResult<T> | { ok: true; replay: true; receipt: Receipt }> {
    if (intent.action !== action || intent.effectClass !== effectClass)
      return failure('validation', 'Tool operation does not match authorized action and effect class.');
    return executeGuarded(intent, this.deps.context, this.deps.repository, async () => {
      try {
        const r = await invoke();
        return { ok: true, ...r };
      } catch (error) {
        return error instanceof AdapterFault ? error.failure : failure('validation', 'Provider response failed validation.', 'reconcile');
      }
    });
  }
  async read<T>(invoke: () => Promise<T>): Promise<{ ok: true; data: T } | Failure> {
    try {
      return { ok: true, data: await invoke() };
    } catch (error) {
      return error instanceof AdapterFault ? error.failure : failure('validation', 'Provider response failed validation.');
    }
  }
}
function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;
}
export function hashPayload(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(value)) ?? 'null')
    .digest('hex');
}
export function jsonBody(value: unknown): string {
  return JSON.stringify(value);
}
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new AdapterFault(failure('validation', 'Provider boundary validation failed.', 'reconcile'));
  return r.data;
}
/** Logs must accept only explicitly selected ids; this helper is for diagnostic strings. */
export function redact(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === 'string')
    return secrets.reduce((s, key) => (key ? s.split(key).join('[REDACTED]') : s), value).replace(/Bearer\s+[^\s]+/gi, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map(v => redact(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        /secret|token|authorization|password|api.?key|credential/i.test(k) ? '[REDACTED]' : redact(v, secrets),
      ]),
    );
  return value;
}
export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export function requireBoundAmount(
  intent: EffectIntent,
  amountMinor: number,
  currency: string,
  artifactVersionId: string,
  counterpartyId: string,
): void {
  if (
    intent.amountMinor !== amountMinor ||
    intent.currency !== currency ||
    intent.artifactVersionId !== artifactVersionId ||
    intent.counterpartyId !== counterpartyId
  )
    throw new AdapterFault(failure('invariant_violation', 'Payment does not match the authorized amount, currency, payee and artifact.'));
}
