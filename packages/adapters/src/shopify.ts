import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { constantTimeEquals, failure, type EffectIntent } from '@lo/policy';
import { AdapterFault, Boundary, credentialBaseSchema, jsonBody, parse, type AdapterDependencies } from './core.js';

export const shopDomainSchema = z.string().regex(/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/);
const gidSchema = z.string().regex(/^gid:\/\/shopify\/[A-Za-z]+\/\d+$/);
const credentialSchema = z
  .object({
    ...credentialBaseSchema,
    accessToken: z.string().min(1),
    shopDomain: shopDomainSchema,
    apiVersion: z.string().regex(/^20\d\d-(01|04|07|10)$/),
    developmentStore: z.boolean(),
    ownerFounderId: z.string().uuid(),
    counterpartyId: z.string().uuid(),
  })
  .strict();
export { credentialSchema as ShopifyCredentialSchema };
const errorsSchema = z.array(z.object({ message: z.string(), field: z.array(z.string()).nullable().optional() }));
export const storeConfigurationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('product'),
      title: z.string().min(1),
      descriptionHtml: z.string(),
      vendor: z.string(),
      productType: z.string(),
      approvedArtifactVersionId: z.string().uuid(),
    })
    .strict(),
  z.object({ kind: z.literal('page'), title: z.string().min(1), body: z.string(), approvedArtifactVersionId: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal('policy'),
      policyType: z.enum(['PRIVACY_POLICY', 'REFUND_POLICY', 'TERMS_OF_SERVICE', 'SHIPPING_POLICY']),
      body: z.string().min(1),
      approvedArtifactVersionId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('shipping'),
      name: z.string().min(1),
      countryCode: z.string().regex(/^[A-Z]{2}$/),
      rateName: z.string().min(1),
      amount: z.string().regex(/^\d+\.\d{2}$/),
      currency: z.string().regex(/^[A-Z]{3}$/),
      locationIds: z.array(gidSchema).min(1).max(10),
      variantIds: z.array(gidSchema).min(1).max(100),
      quoteEvidenceId: z.string().uuid(),
      approvedArtifactVersionId: z.string().uuid(),
    })
    .strict(),
]);
export class ShopifyAdapter {
  readonly boundary: Boundary;
  constructor(deps: AdapterDependencies) {
    this.boundary = new Boundary(deps);
  }
  private async credential(ref: string, intent: EffectIntent) {
    const c = await this.boundary.credential('shopify', ref, intent, credentialSchema);
    if (c.counterpartyId !== intent.counterpartyId || (intent.sandboxMode && !c.developmentStore))
      throw new AdapterFault(failure('rejected', 'Store credential does not match founder-owned authorized store or dev environment.'));
    return c;
  }
  private async graphql(c: z.infer<typeof credentialSchema>, query: string, variables: unknown, key: string, mutating: boolean) {
    const r = await this.boundary.http(
      {
        url: `https://${c.shopDomain}/admin/api/${c.apiVersion}/graphql.json`,
        method: 'POST',
        headers: { 'X-Shopify-Access-Token': c.accessToken, 'Content-Type': 'application/json', 'X-Operator-Idempotency-Key': key },
        body: jsonBody({ query, variables }),
      },
      mutating,
    );
    const envelope = parse(
      z.object({ data: z.record(z.string(), z.unknown()).optional(), errors: z.array(z.object({ message: z.string() })).optional() }),
      r.body,
    );
    if (envelope.errors?.length || !envelope.data)
      throw new AdapterFault(failure('rejected', 'Shopify GraphQL operation rejected.', mutating ? 'reconcile' : 'never'));
    return envelope.data;
  }
  configure(intent: EffectIntent, credentialRef: string, raw: unknown) {
    const parsed = storeConfigurationSchema.safeParse(raw);
    if (!parsed.success) return Promise.resolve(failure('validation', 'Invalid store configuration.'));
    // shopPolicyUpdate immediately changes public policy text, unlike draft products/pages.
    const publishes = parsed.data.kind === 'policy' || parsed.data.kind === 'shipping';
    return this.boundary.effect(
      intent,
      parsed.data.kind === 'shipping' ? 'store_publish_shipping' : publishes ? 'store_publish_policy' : 'store_configure',
      publishes ? 'publish' : 'communicate',
      async () => {
        const input = parse(storeConfigurationSchema, raw);
        if (input.approvedArtifactVersionId !== intent.artifactVersionId)
          throw new AdapterFault(failure('invariant_violation', 'Store content differs from approved artifact version.'));
        await this.boundary.approvedInput(intent, input);
        const c = await this.credential(credentialRef, intent);
        let query: string;
        let variables: unknown;
        let operation: string;
        if (input.kind === 'product') {
          operation = 'productCreate';
          query =
            'mutation Configure($product:ProductCreateInput!){productCreate(product:$product){product{id status} userErrors{field message}}}';
          variables = {
            product: {
              title: input.title,
              descriptionHtml: input.descriptionHtml,
              vendor: input.vendor,
              productType: input.productType,
              status: 'DRAFT',
            },
          };
        } else if (input.kind === 'page') {
          operation = 'pageCreate';
          query = 'mutation Configure($page:PageCreateInput!){pageCreate(page:$page){page{id isPublished} userErrors{field message}}}';
          variables = { page: { title: input.title, body: input.body, isPublished: false } };
        } else if (input.kind === 'policy') {
          operation = 'shopPolicyUpdate';
          query =
            'mutation Configure($shopPolicy:ShopPolicyInput!){shopPolicyUpdate(shopPolicy:$shopPolicy){shopPolicy{id type} userErrors{field message}}}';
          variables = { shopPolicy: { type: input.policyType, body: input.body } };
        } else {
          operation = 'deliveryProfileCreate';
          query =
            'mutation Configure($profile:DeliveryProfileInput!){deliveryProfileCreate(profile:$profile){profile{id} userErrors{field message}}}';
          variables = {
            profile: {
              name: input.name,
              variantsToAssociate: input.variantIds,
              locationGroupsToCreate: [
                {
                  locationsToAdd: input.locationIds,
                  zonesToCreate: [
                    {
                      name: input.countryCode,
                      countries: [{ code: input.countryCode }],
                      methodDefinitionsToCreate: [
                        { name: input.rateName, rateDefinition: { price: { amount: input.amount, currencyCode: input.currency } } },
                      ],
                    },
                  ],
                },
              ],
            },
          };
        }
        const data = await this.graphql(c, query, variables, intent.idempotencyKey, true);
        const result = parse(z.object({ userErrors: errorsSchema }).passthrough(), data[operation]);
        if (result.userErrors.length) throw new AdapterFault(failure('rejected', 'Shopify rejected store configuration.'));
        const entity = parse(
          z.object({ id: gidSchema }).passthrough(),
          result['product'] ?? result['page'] ?? result['shopPolicy'] ?? result['profile'],
        );
        if ((input.kind === 'product' && entity['status'] !== 'DRAFT') || (input.kind === 'page' && entity['isPublished'] !== false))
          throw new AdapterFault(failure('invariant_violation', 'Store draft unexpectedly became public.', 'reconcile'));
        return {
          data: { id: entity.id, kind: input.kind, draft: input.kind === 'product' || input.kind === 'page' },
          receipt: this.boundary.receipt('shopify', entity.id, intent, data),
        };
      },
    );
  }
  publish(intent: EffectIntent, credentialRef: string, productId: string, publicationId: string, sourceVersionId?: string) {
    return this.boundary.effect(intent, 'store_publish', 'publish', async () => {
      parse(gidSchema, productId);
      parse(gidSchema, publicationId);
      const c = await this.credential(credentialRef, intent);
      await this.boundary.approvedInput(intent, { productId, publicationId });
      if (!sourceVersionId || !this.boundary.deps.approvedArtifacts)
        throw new AdapterFault(failure('needs_approval', 'Publication requires the exact approved draft source.'));
      parse(z.uuid(), sourceVersionId);
      const source = await this.boundary.deps.approvedArtifacts.get(intent.missionId, sourceVersionId),
        draft = parse(storeConfigurationSchema, source.content);
      if (source.status !== 'approved' || draft.kind !== 'product' || draft.approvedArtifactVersionId !== sourceVersionId)
        throw new AdapterFault(failure('needs_approval', 'Publication draft source is not current and approved.'));
      const live = await this.graphql(
        c,
        'query ReviewedProduct($id:ID!){product(id:$id){id title descriptionHtml vendor productType}}',
        { id: productId },
        intent.idempotencyKey + ':review-copy',
        false,
      );
      const current = parse(
        z.object({ id: gidSchema, title: z.string(), descriptionHtml: z.string(), vendor: z.string(), productType: z.string() }),
        live['product'],
      );
      if (
        current.id !== productId ||
        current.title !== draft.title ||
        current.descriptionHtml !== draft.descriptionHtml ||
        current.vendor !== draft.vendor ||
        current.productType !== draft.productType
      )
        throw new AdapterFault(
          failure('needs_approval', 'The live product copy changed after approval; review a new version before publication.'),
        );
      const activated = await this.graphql(
        c,
        'mutation Activate($product:ProductUpdateInput!){productUpdate(product:$product){product{id status} userErrors{field message}}}',
        { product: { id: productId, status: 'ACTIVE' } },
        `${intent.idempotencyKey}:activate`,
        true,
      );
      const active = parse(
        z.object({ userErrors: errorsSchema, product: z.object({ id: gidSchema, status: z.literal('ACTIVE') }).nullable() }),
        activated['productUpdate'],
      );
      if (active.userErrors.length || active.product?.id !== productId)
        throw new AdapterFault(failure('rejected', 'Shopify could not activate the specifically approved product.', 'reconcile'));
      const data = await this.graphql(
        c,
        'mutation Publish($id:ID!,$input:[PublicationInput!]!){publishablePublish(id:$id,input:$input){publishable{publicationCount} userErrors{field message}}}',
        { id: productId, input: [{ publicationId }] },
        intent.idempotencyKey,
        true,
      );
      const result = parse(
        z.object({ userErrors: errorsSchema, publishable: z.object({ publicationCount: z.number() }).nullable() }),
        data['publishablePublish'],
      );
      if (result.userErrors.length || !result.publishable)
        throw new AdapterFault(
          failure('rejected', 'Shopify publication rejected; product activation requires reconciliation.', 'reconcile'),
        );
      const polled = await this.graphql(
        c,
        'query VerifyPublication($id:ID!,$publicationId:ID!){product(id:$id){id status publishedOnPublication(publicationId:$publicationId)}}',
        { id: productId, publicationId },
        `${intent.idempotencyKey}:verify`,
        false,
      );
      const product = parse(
        z.object({ id: gidSchema, status: z.literal('ACTIVE'), publishedOnPublication: z.literal(true) }),
        polled['product'],
      );
      if (product.id !== productId)
        throw new AdapterFault(failure('invariant_violation', 'Published product reference mismatch.', 'reconcile'));
      return {
        data: { productId, publicationId, status: 'published' as const, confirmationSource: 'verified_poll' as const },
        receipt: this.boundary.receipt('shopify', productId, intent, { activated, published: data, verified: polled }, undefined, {
          kind: 'store_published',
          outcome: 'commerce',
          artifactVersionId: parse(z.string().uuid(), intent.artifactVersionId),
          method: 'verified_poll',
        }),
      };
    });
  }
  /** A real dev-store test purchase/refund. Checkout UI and email delivery remain separate E2E gates. */
  testOrder(intent: EffectIntent, credentialRef: string, raw: unknown) {
    return this.boundary.effect(intent, 'store_test_order', 'spend', async () => {
      const input = parse(
        z.object({ variantId: gidSchema, amount: z.string().regex(/^\d+\.\d{2}$/), currency: z.string().regex(/^[A-Z]{3}$/) }).strict(),
        raw,
      );
      await this.boundary.approvedInput(intent, input);
      const c = await this.credential(credentialRef, intent);
      if (!intent.sandboxMode || !c.developmentStore || intent.amountMinor !== 0 || input.currency !== intent.currency)
        throw new AdapterFault(failure('rejected', 'Test orders require a sandbox mission, dev store and zero real spend.'));
      const data = await this.graphql(
        c,
        'mutation Test($order:OrderCreateOrderInput!){orderCreate(order:$order){order{id test displayFinancialStatus transactions{id kind status gateway amountSet{shopMoney{amount currencyCode}}}} userErrors{field message}}}',
        {
          order: {
            test: true,
            currency: input.currency,
            lineItems: [{ variantId: input.variantId, quantity: 1 }],
            transactions: [
              {
                kind: 'SALE',
                status: 'SUCCESS',
                gateway: 'bogus',
                amountSet: { shopMoney: { amount: input.amount, currencyCode: input.currency } },
              },
            ],
          },
        },
        `${intent.idempotencyKey}:purchase`,
        true,
      );
      const txSchema = z.object({
        id: gidSchema,
        kind: z.string(),
        status: z.string(),
        gateway: z.string(),
        amountSet: z.object({ shopMoney: z.object({ amount: z.string(), currencyCode: z.string() }) }),
      });
      const result = parse(
        z.object({
          userErrors: errorsSchema,
          order: z
            .object({ id: gidSchema, test: z.literal(true), displayFinancialStatus: z.string(), transactions: z.array(txSchema) })
            .nullable(),
        }),
        data['orderCreate'],
      );
      const order = result.order;
      const tx = order?.transactions.find(t => t.kind === 'SALE' && t.status === 'SUCCESS');
      if (
        result.userErrors.length ||
        !order ||
        !tx ||
        order.displayFinancialStatus !== 'PAID' ||
        Number(tx.amountSet.shopMoney.amount) !== Number(input.amount) ||
        tx.amountSet.shopMoney.currencyCode !== input.currency
      )
        throw new AdapterFault(failure('invariant_violation', 'Dev-store purchase was not confirmed.', 'reconcile'));
      const refunded = await this.graphql(
        c,
        'mutation Refund($input:RefundInput!){refundCreate(input:$input){refund{id transactions(first:10){nodes{id kind status}}} userErrors{field message}}}',
        {
          input: {
            orderId: order.id,
            transactions: [{ orderId: order.id, parentId: tx.id, kind: 'REFUND', gateway: tx.gateway, amount: input.amount }],
            notify: false,
          },
        },
        `${intent.idempotencyKey}:refund`,
        true,
      );
      const refund = parse(
        z.object({
          userErrors: errorsSchema,
          refund: z
            .object({
              id: gidSchema,
              transactions: z.object({ nodes: z.array(z.object({ id: gidSchema, kind: z.string(), status: z.string() })) }),
            })
            .nullable(),
        }),
        refunded['refundCreate'],
      );
      if (
        refund.userErrors.length ||
        !refund.refund ||
        !refund.refund.transactions.nodes.some(t => t.kind === 'REFUND' && t.status === 'SUCCESS')
      )
        throw new AdapterFault(failure('invariant_violation', 'Dev-store refund was not confirmed.', 'reconcile'));
      return {
        data: {
          orderId: order.id,
          refundId: refund.refund.id,
          purchaseConfirmed: true,
          refundConfirmed: true,
          checkoutUiVerified: false,
          emailDeliveryVerified: false,
          sandboxMode: true,
        },
        receipt: this.boundary.receipt('shopify', order.id, intent, { purchase: data, refund: refunded }),
      };
    });
  }
}
export interface ShopifyOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: readonly string[];
}
export interface ShopifyOAuthStore {
  /** Consumes the random CSRF state once, verifying mission, expected shop, expiry and callback URI. */
  consumeState(state: string, shop: string): Promise<{ missionId: string; credentialRef: string } | null>;
  saveToken(credentialRef: string, token: string, scope: string, expiresIn: number | null): Promise<void>;
}
export function shopifyAuthorizationUrl(shop: string, state: string, config: ShopifyOAuthConfig): string {
  parse(shopDomainSchema, shop);
  parse(z.string().min(32), state);
  const redirect = new URL(config.redirectUri);
  if (redirect.protocol !== 'https:') throw new Error('OAuth redirect must use HTTPS.');
  return `https://${shop}/admin/oauth/authorize?${new URLSearchParams({ client_id: config.clientId, scope: config.scopes.join(','), redirect_uri: redirect.href, state })}`;
}
export async function completeShopifyOAuth(callback: URL, config: ShopifyOAuthConfig, store: ShopifyOAuthStore, boundary: Boundary) {
  return boundary.read(async () => {
    const values = parse(
      z
        .object({
          shop: shopDomainSchema,
          code: z.string().min(1),
          state: z.string().min(32),
          hmac: z.string().regex(/^[a-f0-9]{64}$/),
          timestamp: z.string().regex(/^\d+$/),
        })
        .passthrough(),
      Object.fromEntries(callback.searchParams),
    );
    if (Math.abs(Date.now() / 1000 - Number(values.timestamp)) > 300)
      throw new AdapterFault(failure('rejected', 'Expired Shopify OAuth callback.'));
    if ([...new Set(callback.searchParams.keys())].some(k => callback.searchParams.getAll(k).length !== 1))
      throw new AdapterFault(failure('rejected', 'Duplicate OAuth parameters.'));
    const message = [...callback.searchParams.entries()]
      .filter(([k]) => k !== 'hmac' && k !== 'signature')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    if (!constantTimeEquals(createHmac('sha256', config.clientSecret).update(message).digest('hex'), values.hmac))
      throw new AdapterFault(failure('rejected', 'Invalid Shopify OAuth HMAC.'));
    const owner = await store.consumeState(values.state, values.shop);
    if (!owner) throw new AdapterFault(failure('rejected', 'Invalid or consumed OAuth state.'));
    const r = await boundary.http(
      {
        url: `https://${values.shop}/admin/oauth/access_token`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: jsonBody({ client_id: config.clientId, client_secret: config.clientSecret, code: values.code }),
      },
      true,
    );
    const token = parse(z.object({ access_token: z.string().min(1), scope: z.string(), expires_in: z.number().optional() }), r.body);
    if (config.scopes.some(s => !token.scope.split(',').includes(s)))
      throw new AdapterFault(failure('rejected', 'Shopify did not grant required scopes.'));
    await store.saveToken(owner.credentialRef, token.access_token, token.scope, token.expires_in ?? null);
    return { missionId: owner.missionId, credentialRef: owner.credentialRef, connected: true };
  });
}
