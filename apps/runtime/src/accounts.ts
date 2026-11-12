import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JsonObjectSchema, type Result } from '@lo/state';
import {
  Boundary,
  MarketplaceProfileSchema,
  hashPayload,
  completeShopifyOAuth,
  probeProviderConnection,
  shopifyAuthorizationUrl,
  validateProviderCredential,
  type Transport,
  type ShopifyOAuthConfig,
} from '@lo/adapters';
import { withRole, type ActorScope } from './database.js';
import { environment } from './config.js';
import { encryptProviderValue, ProviderStorage } from './provider-storage.js';

const ProviderSchema = z.enum(['paypal', 'twilio', 'resend', 'shopify', 'browserbase', 'openai', 'godaddy']);
const ModeSchema = z.enum(['local', 'sandbox', 'live']);
const ConnectSchema = z
  .object({
    provider: ProviderSchema,
    credential: JsonObjectSchema,
    settings: JsonObjectSchema.default({}),
    founderAttestsOwnership: z.literal(true),
    mode: ModeSchema,
    allowUnverified: z.boolean().default(false),
    serviceBudgetUnits: z.number().int().positive().safe().optional(),
  })
  .strict();
const VerificationSchema = z.object({
  status: z.enum(['authenticated', 'unverified']),
  checkedAt: z.iso.datetime(),
  reason: z.string().nullable(),
  ownership: z.literal('founder_attested'),
});
export const SafeProviderAccountSchema = z
  .object({
    accountId: z.uuid(),
    counterpartyId: z.uuid().nullable(),
    provider: ProviderSchema,
    status: z.enum(['connected', 'revoked']),
    sandboxMode: z.boolean(),
    verification: VerificationSchema,
    scopes: z.array(z.string()),
    createdAt: z.iso.datetime(),
  })
  .strict();
export type SafeProviderAccount = z.infer<typeof SafeProviderAccountSchema>;
const unavailable = <T>(code: 'validation' | 'rejected' | 'provider_down', message: string): Result<T> => ({
  ok: false,
  error: { code, message, retryable: false },
});
function safeFailure<T>(error: unknown): Result<T> {
  return unavailable(
    error instanceof z.ZodError ? 'validation' : 'provider_down',
    error instanceof z.ZodError
      ? 'Provider connection input failed validation.'
      : 'Provider account operation is unavailable in this founder/mission scope.',
  );
}
async function mission(scope: ActorScope) {
  z.uuid().parse(scope.missionId);
  return withRole('founder_role', scope, async db =>
    z
      .object({ founder_id: z.uuid(), sandbox_mode: z.boolean() })
      .parse((await db.query('select founder_id,sandbox_mode from public.missions where id=$1', [scope.missionId])).rows[0]),
  );
}
function validateMode(mode: z.infer<typeof ModeSchema>, sandbox: boolean): void {
  const env = environment();
  if (mode === 'live' ? sandbox || env.LO_EXECUTION_MODE !== 'production' : !sandbox || mode !== env.LO_EXECUTION_MODE)
    throw new Error('rejected: explicit provisioning mode does not match mission and runtime');
}
/** Server/operator entry point. Plaintext exists only in this call, the read-only probe and authenticated encryption. */
export async function connectProviderAccount(scope: ActorScope, raw: unknown, transport?: Transport): Promise<Result<SafeProviderAccount>> {
  try {
    const input = ConnectSchema.parse(raw),
      owner = await mission(scope);
    const marketplaceProfiles =
      input.provider === 'browserbase' && input.settings['marketplaceProfiles']
        ? z.array(MarketplaceProfileSchema).max(50).parse(input.settings['marketplaceProfiles'])
        : [];
    validateMode(input.mode, owner.sandbox_mode);
    if (input.serviceBudgetUnits && !['openai', 'browserbase'].includes(input.provider))
      return unavailable('validation', 'Service budgets apply only to OpenAI or Browserbase.');
    const party = ['shopify', 'godaddy'].includes(input.provider) ? randomUUID() : null;
    // Scope/environment/ownership are server-owned fields and cannot be supplied by the credential file.
    for (const key of ['missionId', 'sandboxMode', 'revoked', 'ownerFounderId', 'counterpartyId'])
      if (key in input.credential) return unavailable('validation', 'Credential file must omit server-owned scope and ownership fields.');
    const credential = validateProviderCredential(input.provider, {
      ...input.credential,
      missionId: scope.missionId,
      sandboxMode: owner.sandbox_mode,
      revoked: false,
      ...(party ? { ownerFounderId: owner.founder_id, counterpartyId: party } : {}),
    });
    const probe = await probeProviderConnection(input.provider, credential, transport);
    if (!probe.ok) return probe;
    if (probe.value.status === 'unverified' && !input.allowUnverified)
      return unavailable(
        'rejected',
        'The read-only provider check is incomplete. Fix provider setup or explicitly allow an unverified connection; no verification will be claimed.',
      );
    const ref = randomUUID(),
      encrypted = encryptProviderValue({ credential, settings: input.settings }, `credential:${scope.missionId}:${input.provider}:${ref}`);
    const accountId = await withRole('founder_role', scope, async db => {
      const id = z
        .uuid()
        .parse(
          (
            await db.query('select public.connect_provider_account($1,$2,$3,$4,$5,$6,$7,$8)id', [
              scope.missionId,
              input.provider,
              probe.value.grantedScopes,
              ref,
              encrypted,
              probe.value,
              party,
              input.provider === 'shopify'
                ? credential['shopDomain']
                : input.provider === 'godaddy'
                  ? 'Founder-owned GoDaddy account'
                  : null,
            ])
          ).rows[0]?.id,
        );
      if (input.serviceBudgetUnits)
        await db.query('select public.configure_service_budget($1,$2,$3)', [scope.missionId, input.provider, input.serviceBudgetUnits]);
      for (const profile of marketplaceProfiles)
        await db.query('select public.register_marketplace_thread($1,$2,$3,$4,$5)', [
          scope.missionId,
          id,
          profile.counterpartyId,
          profile.threadId,
          hashPayload(profile),
        ]);
      return id;
    });
    const listed = await listProviderAccounts(scope);
    if (!listed.ok) return listed;
    const account = listed.value.accounts.find(a => a.accountId === accountId);
    return account
      ? { ok: true, value: account }
      : unavailable(
          'provider_down',
          'Connection committed, but its safe account summary could not be read. Refresh the account list before connecting again.',
        );
  } catch (error) {
    return safeFailure(error);
  }
}
export async function listProviderAccounts(scope: ActorScope): Promise<Result<{ accounts: SafeProviderAccount[] }>> {
  try {
    await mission(scope);
    return {
      ok: true,
      value: {
        accounts: await withRole('founder_role', scope, async db =>
          (
            await db.query(
              'select c.account_id,c.counterparty_id,c.provider,c.sandbox_mode,c.verification,c.created_at,a.scopes,exists(select from public.account_revocations r where r.account_id=a.id)revoked from public.provider_account_connections c join public.founder_accounts a on a.id=c.account_id where c.mission_id=$1 order by c.created_at,c.id',
              [scope.missionId],
            )
          ).rows.map(row =>
            SafeProviderAccountSchema.parse({
              accountId: row.account_id,
              counterpartyId: row.counterparty_id,
              provider: row.provider,
              status: row.revoked ? 'revoked' : 'connected',
              sandboxMode: row.sandbox_mode,
              verification: VerificationSchema.parse(row.verification),
              scopes: row.scopes,
              createdAt: new Date(String(row.created_at)).toISOString(),
            }),
          ),
        ),
      },
    };
  } catch (error) {
    return safeFailure(error);
  }
}
export async function revokeProviderAccount(
  scope: ActorScope,
  accountId: string,
): Promise<Result<{ accountId: string; status: 'revoked'; revokedAt: string; externalAssetsRetained: true }>> {
  try {
    z.uuid().parse(accountId);
    const owner = await mission(scope);
    return await withRole('founder_role', scope, async db => {
      const exists = (
        await db.query('select account_id from public.provider_account_connections where mission_id=$1 and account_id=$2', [
          scope.missionId,
          accountId,
        ])
      ).rows[0];
      if (!exists) return unavailable('rejected', 'The provider account is unavailable in this mission.');
      await db.query('select public.revoke_account($1,$2)', [owner.founder_id, accountId]);
      const at = (await db.query('select created_at from public.account_revocations where account_id=$1', [accountId])).rows[0]?.created_at;
      return {
        ok: true,
        value: { accountId, status: 'revoked', revokedAt: new Date(String(at)).toISOString(), externalAssetsRetained: true },
      };
    });
  } catch (error) {
    return safeFailure(error);
  }
}
function oauthConfig(scope: ActorScope): ShopifyOAuthConfig {
  const env = environment(),
    origin = new URL(env.APP_ORIGIN);
  if (origin.protocol !== 'https:') throw new Error('Shopify OAuth requires a public HTTPS app origin');
  return {
    clientId: z.string().min(1).parse(process.env['SHOPIFY_CLIENT_ID']),
    clientSecret: z.string().min(1).parse(process.env['SHOPIFY_CLIENT_SECRET']),
    scopes: z
      .string()
      .min(1)
      .parse(process.env['SHOPIFY_OAUTH_SCOPES'])
      .split(',')
      .map(x => x.trim())
      .filter(Boolean),
    redirectUri: new URL(`/api/missions/${scope.missionId}/accounts/shopify/callback`, origin).href,
  };
}
export async function startShopifyAccountOAuth(scope: ActorScope, raw: unknown): Promise<Result<{ authorizationUrl: string }>> {
  try {
    const input = z
      .object({ shopDomain: z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/), founderAttestsOwnership: z.literal(true) })
      .strict()
      .parse(raw);
    await mission(scope);
    const config = oauthConfig(scope),
      state = randomBytes(32).toString('hex');
    await withRole('founder_role', scope, async db => {
      await db.query('select public.create_shopify_oauth_state($1,$2,$3)', [
        scope.missionId,
        createHash('sha256').update(state).digest('hex'),
        input.shopDomain,
      ]);
    });
    return { ok: true, value: { authorizationUrl: shopifyAuthorizationUrl(input.shopDomain, state, config) } };
  } catch (error) {
    return safeFailure(error);
  }
}
export async function completeShopifyAccountOAuth(
  scope: ActorScope,
  callback: URL,
  transport?: Transport,
): Promise<Result<SafeProviderAccount>> {
  try {
    const config = oauthConfig(scope),
      owner = await mission(scope);
    if (callback.origin + callback.pathname !== config.redirectUri) return unavailable('rejected', 'Unexpected Shopify callback URI.');
    let connected: Result<SafeProviderAccount> | undefined;
    const storage = new ProviderStorage(scope),
      boundary = new Boundary({ ...storage.dependencies(), ...(transport ? { transport } : {}) });
    const response = await completeShopifyOAuth(
      callback,
      config,
      {
        consumeState: async (state, shop) => {
          try {
            await withRole('founder_role', scope, async db => {
              await db.query('select public.consume_shopify_oauth_state($1,$2,$3)', [
                scope.missionId,
                createHash('sha256').update(state).digest('hex'),
                shop,
              ]);
            });
            return { missionId: z.uuid().parse(scope.missionId), credentialRef: randomUUID() };
          } catch {
            return null;
          }
        },
        saveToken: async (_ref, token, _scopes, expiresIn) => {
          if (expiresIn !== null)
            throw new Error('Expiring Shopify tokens require a refresh-token flow; no unusable permanent connection will be stored.');
          const env = environment();
          connected = await connectProviderAccount(
            scope,
            {
              provider: 'shopify',
              credential: {
                accessToken: token,
                shopDomain: callback.searchParams.get('shop'),
                apiVersion: z
                  .string()
                  .regex(/^20\d\d-(01|04|07|10)$/)
                  .parse(process.env['SHOPIFY_API_VERSION']),
                developmentStore: owner.sandbox_mode,
              },
              mode: owner.sandbox_mode ? (env.LO_EXECUTION_MODE === 'local' ? 'local' : 'sandbox') : 'live',
              founderAttestsOwnership: true,
            },
            transport,
          );
          if (!connected.ok) throw new Error('Shopify account connection failed.');
        },
      },
      boundary,
    );
    if (!response.ok) return unavailable('rejected', response.message);
    return connected ?? unavailable('provider_down', 'Shopify token exchange did not produce a connected account.');
  } catch (error) {
    return safeFailure(error);
  }
}
