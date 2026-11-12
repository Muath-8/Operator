import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { bindingHash, tokenHash, type EffectIntent, type PolicySnapshot } from '@lo/policy';
import { MemoryEffectRepository } from '../../../packages/policy/src/testing';
import { ShopifyAdapter } from '../../../packages/adapters/src/shopify';
import type { AdapterDependencies } from '../../../packages/adapters/src/core';

describe('independent Shopify current-copy publication boundary (protocol fixture)', () => {
  it.each(['title', 'descriptionHtml', 'vendor', 'productType'])('holds changed live %s before any publication mutation', async field => {
    const missionId = randomUUID(),
      party = randomUUID(),
      version = randomUUID(),
      source = randomUUID(),
      token = 'synthetic-explicit-approval'.repeat(3),
      productId = 'gid://shopify/Product/1',
      publicationId = 'gid://shopify/Publication/2';
    const intent: EffectIntent = {
      missionId,
      taskId: randomUUID(),
      action: 'store_publish',
      effectClass: 'publish',
      counterpartyId: party,
      artifactVersionId: version,
      idempotencyKey: randomUUID(),
      mode: 'do',
      sandboxMode: true,
      newContact: false,
      approvalToken: token,
    };
    const snapshot: PolicySnapshot = {
      paused: false,
      killed: false,
      sandboxMode: true,
      missionCurrency: 'SAR',
      budgetRemainingMinor: 0,
      mandates: [],
      approval: {
        tokenHash: tokenHash(token),
        bindingHash: bindingHash(intent),
        expiresAt: '2099-01-01T00:00:00.000Z',
        consumed: false,
        revoked: false,
      },
    };
    const draft = {
      kind: 'product',
      title: 'Approved neutral fragrance',
      descriptionHtml: '<p>Floral notes</p>',
      vendor: 'Approved vendor',
      productType: 'Fragrance',
      approvedArtifactVersionId: source,
    };
    let mutations = 0;
    const dependencies: AdapterDependencies = {
      repository: new MemoryEffectRepository(snapshot, 'test'),
      context: { role: 'policy' },
      secrets: {
        resolve: async () => ({
          missionId,
          sandboxMode: true,
          revoked: false,
          accessToken: 'synthetic-no-provider-key',
          shopDomain: 'synthetic.myshopify.com',
          apiVersion: '2026-10',
          developmentStore: true,
          ownerFounderId: randomUUID(),
          counterpartyId: party,
        }),
      },
      approvedArtifacts: {
        get: async (_mission, id) => ({ status: 'approved', content: id === source ? draft : { productId, publicationId } }),
      },
      transport: async request => {
        const body = JSON.parse(request.body ?? '{}') as { query: string };
        if (body.query.startsWith('mutation')) mutations++;
        return { status: 200, headers: {}, body: { data: { product: { id: productId, ...draft, [field]: 'Unapproved changed copy' } } } };
      },
    };
    expect(await new ShopifyAdapter(dependencies).publish(intent, 'synthetic-ref', productId, publicationId, source)).toMatchObject({
      ok: false,
      code: 'needs_approval',
    });
    expect(mutations).toBe(0);
  });
});
