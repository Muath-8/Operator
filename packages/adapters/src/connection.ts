import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JsonObjectSchema, type JsonValue, type Result } from '@lo/state';
import { PayPalCredentialSchema } from './paypal.js';
import { TwilioCredentialSchema, ResendCredentialSchema } from './channels.js';
import { ShopifyCredentialSchema } from './shopify.js';
import { OpenAICredentialSchema } from './generation.js';
import { BrowserbaseCredentialSchema } from './research.js';
import { GoDaddyCredentialSchema, godaddyBase } from './godaddy.js';
import { fetchTransport, hashPayload, type Provider, type Transport, type HttpRequest } from './core.js';

export const PROVIDER_CREDENTIAL_SCHEMAS: Readonly<Record<Provider, z.ZodType<unknown>>> = {
  paypal: PayPalCredentialSchema,
  twilio: TwilioCredentialSchema,
  resend: ResendCredentialSchema,
  shopify: ShopifyCredentialSchema,
  openai: OpenAICredentialSchema,
  browserbase: BrowserbaseCredentialSchema,
  godaddy: GoDaddyCredentialSchema,
};
export function validateProviderCredential(provider: Provider, raw: unknown): Record<string, JsonValue> {
  return JsonObjectSchema.parse(PROVIDER_CREDENTIAL_SCHEMAS[provider].parse(raw));
}
export interface ConnectionProbe {
  status: 'authenticated' | 'unverified';
  providerAccountId: string | null;
  grantedScopes: string[];
  checkedAt: string;
  payloadHash: string | null;
  reason: string | null;
  ownership: 'founder_attested';
}
/** Read-only account authentication check. Never sends a message, creates an order or claims legal/KYC verification. */
export async function probeProviderConnection(
  provider: Provider,
  raw: unknown,
  transport: Transport = fetchTransport,
): Promise<Result<ConnectionProbe>> {
  try {
    validateProviderCredential(provider, raw);
    let responseBody: unknown;
    let providerAccountId: string | null = null;
    let grantedScopes: string[] = [];
    let status: ConnectionProbe['status'] = 'authenticated';
    let reason: string | null = null;
    const request = async (input: HttpRequest) => {
      const response = await transport({ ...input, headers: { ...input.headers, 'X-Operator-Idempotency-Key': randomUUID() } });
      if (response.status === 403) {
        status = 'unverified';
        reason =
          'This restricted credential cannot perform the read-only account check; no connectivity or domain verification is claimed.';
        return null;
      }
      if (response.status < 200 || response.status >= 300) throw new Error(response.status === 401 ? 'rejected' : 'provider_down');
      return response.body;
    };
    if (provider === 'paypal') {
      const c = PayPalCredentialSchema.parse(raw);
      responseBody = await request({
        url: `https://api-m.${c.sandboxMode ? 'sandbox.' : ''}paypal.com/v1/oauth2/token`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });
      if (responseBody) {
        const token = z
          .object({ access_token: z.string().min(1), app_id: z.string().optional(), scope: z.string().optional() })
          .parse(responseBody);
        providerAccountId = token.app_id ?? null;
        grantedScopes = (token.scope ?? '').split(' ').filter(Boolean);
        responseBody = { appId: providerAccountId, scopes: grantedScopes };
      }
    } else if (provider === 'twilio') {
      const c = TwilioCredentialSchema.parse(raw);
      responseBody = await request({
        url: `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}.json`,
        method: 'GET',
        headers: { Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}` },
      });
      if (responseBody) {
        const account = z.object({ sid: z.string(), status: z.string() }).parse(responseBody);
        if (account.sid !== c.accountSid || account.status !== 'active') throw new Error('rejected');
        providerAccountId = account.sid;
        grantedScopes = ['account_authenticated'];
      }
    } else if (provider === 'resend') {
      const c = ResendCredentialSchema.parse(raw);
      responseBody = await request({
        url: 'https://api.resend.com/domains',
        method: 'GET',
        headers: { Authorization: `Bearer ${c.apiKey}` },
      });
      if (responseBody) {
        const domains = z.object({ data: z.array(z.object({ id: z.string(), name: z.string(), status: z.string() })) }).parse(responseBody);
        const senderDomain = c.from.match(/@([^>\s]+)>?$/)?.[1];
        const own = domains.data.find(d => d.name === senderDomain);
        if (own?.status === 'verified') {
          providerAccountId = own.id;
          grantedScopes = ['verified_sender_domain'];
        } else {
          status = 'unverified';
          reason = 'API authenticated, but the sending domain was not returned as verified. Complete DNS/domain setup before sending.';
        }
      }
    } else if (provider === 'shopify') {
      const c = ShopifyCredentialSchema.parse(raw);
      responseBody = await request({
        url: `https://${c.shopDomain}/admin/api/${c.apiVersion}/graphql.json`,
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': c.accessToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: 'query Connection{shop{id myshopifyDomain plan{partnerDevelopment}} currentAppInstallation{accessScopes{handle}}}',
        }),
      });
      if (responseBody) {
        const parsed = z
          .object({
            data: z.object({
              shop: z.object({ id: z.string(), myshopifyDomain: z.string(), plan: z.object({ partnerDevelopment: z.boolean() }) }),
              currentAppInstallation: z.object({ accessScopes: z.array(z.object({ handle: z.string() })) }),
            }),
          })
          .parse(responseBody);
        if (parsed.data.shop.myshopifyDomain !== c.shopDomain || (c.sandboxMode && !parsed.data.shop.plan.partnerDevelopment))
          throw new Error('rejected');
        providerAccountId = parsed.data.shop.id;
        grantedScopes = parsed.data.currentAppInstallation.accessScopes.map(s => s.handle);
      }
    } else if (provider === 'browserbase') {
      const c = BrowserbaseCredentialSchema.parse(raw);
      responseBody = await request({
        url: `https://api.browserbase.com/v1/projects/${encodeURIComponent(c.projectId)}`,
        method: 'GET',
        headers: { 'X-BB-API-Key': c.apiKey },
      });
      if (responseBody) {
        const project = z.object({ id: z.string() }).parse(responseBody);
        if (project.id !== c.projectId) throw new Error('rejected');
        providerAccountId = project.id;
        grantedScopes = ['project_authenticated'];
      }
    } else if (provider === 'godaddy') {
      const c = GoDaddyCredentialSchema.parse(raw);
      responseBody = await request({
        url: `${godaddyBase(c.sandboxMode)}/v3/domains/check-availability?domain=example.com`,
        method: 'GET',
        headers: { Authorization: `Bearer ${c.pat}` },
      });
      if (responseBody) {
        const availability = z
          .object({ domain: z.literal('example.com'), available: z.boolean() })
          .passthrough()
          .parse(responseBody);
        responseBody = { domain: availability.domain, available: availability.available };
        providerAccountId = null;
        grantedScopes = ['domain_read_authenticated'];
        reason =
          'PAT authenticated by a read-only availability check. Account principal, registrant and billing ownership remain founder-attested; purchase scope and billing eligibility are checked at quote/execute.';
      }
    } else {
      const c = OpenAICredentialSchema.parse(raw);
      responseBody = await request({
        url: 'https://api.openai.com/v1/models',
        method: 'GET',
        headers: { Authorization: `Bearer ${c.apiKey}` },
      });
      if (responseBody) {
        const models = z.object({ data: z.array(z.object({ id: z.string() })) }).parse(responseBody);
        if (c.allowedModels.some(model => !models.data.some(m => m.id === model))) {
          status = 'unverified';
          reason = 'API authenticated, but one or more explicitly allowed model IDs are unavailable to this key.';
        }
        providerAccountId = null;
        grantedScopes = ['models_authenticated'];
        responseBody = { availableAllowedModels: c.allowedModels.filter(model => models.data.some(m => m.id === model)) };
      }
    }
    return {
      ok: true,
      value: {
        status,
        providerAccountId,
        grantedScopes,
        checkedAt: new Date().toISOString(),
        payloadHash: responseBody === null || responseBody === undefined ? null : hashPayload(responseBody),
        reason,
        ownership: 'founder_attested',
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code:
          error instanceof z.ZodError
            ? 'validation'
            : error instanceof Error && error.message === 'rejected'
              ? 'rejected'
              : 'provider_down',
        message: 'Provider account authentication failed or is unavailable. No connected/verified result was inferred.',
        retryable: false,
      },
    };
  }
}
