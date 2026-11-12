import { afterEach, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import {
  BrowserbaseMarketplaceAdapter,
  MarketplaceProfileSchema,
  marketplaceUrlAllowed,
  type MarketplaceProfile,
  type MarketplaceDriver,
} from './marketplace.js';
import { PlaywrightMarketplaceDriver } from './marketplace-driver.js';
import { MemoryEffectRepository } from '../../policy/src/testing.js';
import type { EffectIntent, PolicySnapshot } from '@lo/policy';
import type { Transport } from './core.js';

const mission = randomUUID(),
  party = randomUUID(),
  mandate = randomUUID(),
  version = randomUUID(),
  account = randomUUID(),
  url = 'https://message.alibaba.com/thread/EXPLICIT_TEST',
  sendUrl = 'https://message.alibaba.com/api/test-message';
function profile(): MarketplaceProfile {
  return MarketplaceProfileSchema.parse({
    platform: 'alibaba',
    contextId: randomUUID(),
    founderAccountLabel: 'Explicit test-only founder context',
    counterpartyId: party,
    threadId: 'EXPLICIT_TEST',
    url,
    allowedHosts: ['message.alibaba.com'],
    timeoutSeconds: 30,
    accountSelector: '#account',
    accountText: 'Explicit test founder',
    identitySelector: '#identity',
    identityText: 'Explicit test supplier',
    composerSelector: '#composer',
    sendSelector: '#send',
    messageSelector: '.message',
    bodySelector: '.body',
    messageIdAttribute: 'data-id',
    directionAttribute: 'data-direction',
    outboundValue: 'out',
    inboundValue: 'in',
    sendUrl,
    sendFormat: 'json',
    textField: 'text',
    threadField: 'thread',
    readPostUrls: [],
    reviewedAt: new Date().toISOString(),
    sandboxThread: true,
  });
}
let launched: Browser | undefined;
afterEach(async () => {
  await launched?.close().catch(() => undefined);
  launched = undefined;
});
async function fixture(
  options: {
    wrongIdentity?: boolean;
    wrongBody?: boolean;
    badEndpoint?: boolean;
    endpointOverride?: string;
    cacheEcho?: boolean;
    noPersistence?: boolean;
  } = {},
) {
  launched = await chromium.launch({ headless: true });
  const context = await launched.newContext();
  let posts = 0;
  const messages = [{ id: 'INBOUND_1', text: 'Supplier reply: sample costs are claimed until confirmed.', direction: 'in' }];
  const fixtureRoute: Parameters<typeof context.route>[1] = async route => {
    const request = route.request();
    if (request.method() === 'POST') {
      posts++;
      const body = request.postDataJSON() as { text: string; thread: string };
      if (!options.noPersistence) messages.push({ id: `OUT_${posts}`, text: body.text, direction: 'out' });
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, id: `OUT_${posts}` }) });
      return;
    }
    const html = `<!doctype html><html><body><div id="account">Explicit test founder</div><div id="identity">${options.wrongIdentity ? 'Other supplier' : 'Explicit test supplier'}</div><div id="messages">${messages.map(m => `<div class="message" data-id="${m.id}" data-direction="${m.direction}"><span class="body">${m.text}</span></div>`).join('')}</div><textarea id="composer"></textarea><button id="send">Send</button><script>document.getElementById('send').onclick=async()=>{const text=document.getElementById('composer').value;await fetch('${options.endpointOverride ?? (options.badEndpoint ? 'https://message.alibaba.com/api/payment' : sendUrl)}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:'EXPLICIT_TEST',text:${options.wrongBody ? '"Unreviewed price acceptance"' : 'text'}})});const row=document.createElement('div');row.className='message';row.dataset.id='OUT_1';row.dataset.direction='out';const body=document.createElement('span');body.className='body';body.innerText=text;row.appendChild(body);document.getElementById('messages').appendChild(row);};</script></body></html>`;
    let servedHtml = html;
    if (options.cacheEcho) {
      servedHtml = html
        .replace(
          '<script>',
          "<script>const cached=localStorage.getItem('fixture-optimistic');if(cached){const row=document.createElement('div');row.className='message';row.dataset.id='OUT_1';row.dataset.direction='out';const body=document.createElement('span');body.className='body';body.innerText=cached;row.appendChild(body);document.getElementById('messages').appendChild(row);}",
        )
        .replace(
          "const text=document.getElementById('composer').value;",
          "const text=document.getElementById('composer').value;localStorage.setItem('fixture-optimistic',text);",
        );
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: servedHtml });
  };
  await context.route('**/*', fixtureRoute);
  const createContext = launched.newContext.bind(launched);
  launched.newContext = async options => {
    const next = await createContext(options);
    await next.route('**/*', fixtureRoute);
    return next;
  };
  return {
    driver: new PlaywrightMarketplaceDriver(async () => {
      if (!launched) throw new Error('Missing test browser');
      return launched;
    }),
    posts: () => posts,
  };
}
function intent(): EffectIntent {
  return {
    missionId: mission,
    taskId: randomUUID(),
    action: 'marketplace_message',
    effectClass: 'communicate',
    counterpartyId: party,
    artifactVersionId: version,
    instrumentId: account,
    channel: 'marketplace',
    purpose: 'follow_up',
    idempotencyKey: randomUUID(),
    mode: 'do',
    sandboxMode: true,
    mandateId: mandate,
    newContact: false,
  };
}
function repository() {
  const state: PolicySnapshot = {
    paused: false,
    killed: false,
    sandboxMode: true,
    missionCurrency: 'SAR',
    budgetRemainingMinor: 0,
    mandates: [
      {
        id: mandate,
        missionId: mission,
        effectClass: 'communicate',
        actions: ['marketplace_message'],
        counterparties: [party],
        channels: ['marketplace'],
        purposes: ['follow_up'],
        instrumentIds: [account],
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        reservedMinor: 0,
        spentMinor: 0,
        maxActions: 3,
        usedActions: 0,
      },
    ],
  };
  return { state, repository: new MemoryEffectRepository(state, 'test') };
}
function harness(driver: MarketplaceDriver, approved = true) {
  const p = profile(),
    i = intent(),
    message = {
      channel: 'marketplace' as const,
      threadId: p.threadId,
      text: 'Reviewed nonbinding sample enquiry.',
      translation: 'Reviewed nonbinding sample enquiry.',
      language: 'en' as const,
      purpose: 'follow_up' as const,
    },
    { state, repository: repo } = repository(),
    keys = new Set<string>();
  let sessions = 0;
  const adapter = new BrowserbaseMarketplaceAdapter(
    {
      repository: repo,
      secrets: {
        resolve: async () => ({
          missionId: mission,
          sandboxMode: true,
          revoked: false,
          apiKey: 'explicit-test-only',
          projectId: 'explicit-test',
          allowedHosts: p.allowedHosts,
          maxSessionSeconds: 60,
        }),
      },
      context: { role: 'sourcing' },
      approvedArtifacts: { get: async () => ({ status: approved ? 'approved' : 'proposed', content: message }) },
      transport: async r => {
        if (r.url.endsWith('/v1/sessions')) {
          sessions++;
          return { status: 201, headers: {}, body: { id: randomUUID(), connectUrl: 'wss://connect.browserbase.com/explicit-test' } };
        }
        return { status: 200, headers: {}, body: {} };
      },
    },
    {
      reserve: async (_m, key) => {
        if (keys.has(key)) return false;
        keys.add(key);
        return true;
      },
      complete: async () => undefined,
      ambiguous: async () => undefined,
    },
    {
      get: async () => ({
        counterpartyId: party,
        optedOut: false,
        email: null,
        phone: null,
        phoneVerified: false,
        lastWhatsappInboundAt: null,
        localHoursOpen: true,
        senderRegistered: false,
        disclosure: 'I am an AI-assisted agent.',
        founderBudgetFigures: [],
        approvedTemplates: [],
      }),
    },
    driver,
  );
  return { adapter, state, repo, p, i, message, sessions: () => sessions };
}
describe('FR-COM-03 actual Playwright marketplace boundary; explicit local browser/provider fixtures', () => {
  it('sends only the reviewed text, reloads and verifies its stable provider ID, captures a PNG and replays without another session', async () => {
    const browser = await fixture(),
      i = intent(),
      p = profile(),
      message = {
        channel: 'marketplace' as const,
        threadId: p.threadId,
        text: 'Please confirm the sample lead time in writing.',
        translation: 'Please confirm the sample lead time in writing.',
        language: 'en' as const,
        purpose: 'follow_up' as const,
      },
      { repository: repo } = repository();
    let sessions = 0,
      releases = 0;
    const keys = new Set<string>();
    const transport: Transport = async r => {
      if (r.url.endsWith('/v1/sessions')) {
        sessions++;
        return { status: 201, headers: {}, body: { id: randomUUID(), connectUrl: 'wss://connect.browserbase.com/explicit-test' } };
      }
      releases++;
      return { status: 200, headers: {}, body: {} };
    };
    const adapter = new BrowserbaseMarketplaceAdapter(
      {
        repository: repo,
        secrets: {
          resolve: async () => ({
            missionId: mission,
            sandboxMode: true,
            revoked: false,
            apiKey: 'explicit-test-only',
            projectId: 'explicit-test',
            allowedHosts: p.allowedHosts,
            maxSessionSeconds: 60,
          }),
        },
        context: { role: 'sourcing' },
        approvedArtifacts: { get: async () => ({ status: 'approved', content: message }) },
        transport,
      },
      {
        reserve: async (_m, key) => {
          if (keys.has(key)) return false;
          keys.add(key);
          return true;
        },
        complete: async () => undefined,
        ambiguous: async () => undefined,
      },
      {
        get: async () => ({
          counterpartyId: party,
          optedOut: false,
          email: null,
          phone: null,
          phoneVerified: false,
          lastWhatsappInboundAt: null,
          localHoursOpen: true,
          senderRegistered: false,
          disclosure: 'I am an AI-assisted agent.',
          founderBudgetFigures: [],
          approvedTemplates: [],
        }),
      },
      browser.driver,
    );
    const sent = await adapter.send(i, 'explicit-test-ref', message, p);
    if (!sent.ok) throw new Error(JSON.stringify(sent));
    expect(sent).toMatchObject({ ok: true, data: { messageId: 'alibaba:EXPLICIT_TEST:OUT_1' } });
    if (!sent.ok || !('data' in sent)) throw new Error('Missing fixture receipt');
    expect(Buffer.from(sent.data.screenshotBase64, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(await adapter.send(i, 'explicit-test-ref', message, p)).toMatchObject({ ok: true, replay: true });
    expect(browser.posts()).toBe(1);
    expect(sessions).toBe(1);
    expect(releases).toBe(1);
  });
  it('a mismatched registered supplier prevents every send request', async () => {
    const browser = await fixture({ wrongIdentity: true });
    await expect(browser.driver.visit('wss://connect.browserbase.com/test', profile(), 'Reviewed message')).rejects.toThrow(/identity/);
    expect(browser.posts()).toBe(0);
  });
  it('intercepts a payment endpoint even when the rendered send button invokes it', async () => {
    const browser = await fixture({ badEndpoint: true });
    await expect(browser.driver.visit('wss://connect.browserbase.com/test', profile(), 'Reviewed message')).rejects.toThrow();
    expect(browser.posts()).toBe(0);
  }, 20000);
  it.each(['/p%61yments/capture', '/api/payments%2Fcapture', '/ord%65rs/create', '/p%2561yments/capture', '/bad%zz', '/api/%00message'])(
    'rejects encoded/ambiguous protected endpoint registration %s',
    path => {
      const endpoint = `https://message.alibaba.com${path}`;
      expect(marketplaceUrlAllowed(new URL(endpoint))).toBe(false);
      expect(MarketplaceProfileSchema.safeParse({ ...profile(), sendUrl: endpoint }).success).toBe(false);
    },
  );
  it.each(['/p%61yments/capture', '/ord%65rs/create'])(
    'actual browser intercepts encoded financial request %s before HTTP',
    async path => {
      const browser = await fixture({ endpointOverride: `https://message.alibaba.com${path}` });
      await expect(browser.driver.visit('wss://connect.browserbase.com/test', profile(), 'Reviewed message')).rejects.toThrow();
      expect(browser.posts()).toBe(0);
    },
    20000,
  );
  it('intercepts actual wire text changed by page code before the provider request', async () => {
    const browser = await fixture({ wrongBody: true });
    await expect(browser.driver.visit('wss://connect.browserbase.com/test', profile(), 'Reviewed message')).rejects.toThrow();
    expect(browser.posts()).toBe(0);
  }, 20000);
  it('an optimistic DOM echo without persistence is ambiguous and never a receipt', async () => {
    const browser = await fixture({ noPersistence: true });
    await expect(browser.driver.visit('wss://connect.browserbase.com/test', profile(), 'Reviewed message')).rejects.toThrow(/persisted/);
    expect(browser.posts()).toBe(1);
  });
  it('a successful-looking acknowledgement and localStorage echo still require persistence in a fresh pre-send context', async () => {
    const browser = await fixture({ noPersistence: true, cacheEcho: true });
    await expect(browser.driver.visit('wss://connect.browserbase.com/test', profile(), 'Reviewed message')).rejects.toThrow(/persisted/);
    expect(browser.posts()).toBe(1);
  });
  it('a failed persistence check followed by retry never sends a second marketplace message', async () => {
    const browser = await fixture({ noPersistence: true }),
      test = harness(browser.driver);
    expect(await test.adapter.send(test.i, 'explicit-test', test.message, test.p)).toMatchObject({ ok: false, retry: 'reconcile' });
    expect(await test.adapter.send(test.i, 'explicit-test', test.message, test.p)).toMatchObject({ ok: false, retry: 'reconcile' });
    expect(browser.posts()).toBe(1);
    expect(test.sessions()).toBe(1);
    expect([...test.repo.reservations.values()].map(r => r.status)).toEqual(['ambiguous']);
  });
  it('pause and an unapproved artifact both block before browser session creation', async () => {
    for (const paused of [true, false]) {
      const test = harness(
        {
          visit: async () => {
            throw new Error('Browser must not be invoked');
          },
        },
        paused,
      );
      test.state.paused = paused;
      expect((await test.adapter.send(test.i, 'explicit-test', test.message, test.p)).ok).toBe(false);
      expect(test.sessions()).toBe(0);
    }
  });
  it('rejects off-marketplace hosts and stale operator DOM profiles', () => {
    expect(MarketplaceProfileSchema.safeParse({ ...profile(), url: 'https://evil.example/thread' }).success).toBe(false);
    expect(MarketplaceProfileSchema.safeParse({ ...profile(), reviewedAt: '2020-01-01T00:00:00Z' }).success).toBe(false);
  });
});
