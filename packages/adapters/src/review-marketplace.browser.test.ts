import { describe, it, expect } from 'vitest';
import { chromium, type Browser } from 'playwright-core';
import { randomUUID } from 'node:crypto';
import { MarketplaceProfileSchema } from './marketplace.js';
import { PlaywrightMarketplaceDriver } from './marketplace-driver.js';

/** Independent real-browser negative. All URLs are intercepted synthetic
 * fixtures; no Alibaba account, message or real network request is used. */
describe('independent marketplace persistence proof', () => {
  it.each([false, true])(
    'does not turn a localStorage-only echo into persistence when registered provider ACK success=%s',
    async success => {
      let browser: Browser | undefined,
        posts = 0;
      const text = 'Explicit synthetic approved nonbinding follow-up',
        url = 'https://message.alibaba.com/thread/LOCAL_CACHE_PROBE',
        sendUrl = 'https://message.alibaba.com/api/send-test';
      try {
        browser = await chromium.launch({ headless: true });
        const founderContext = await browser.newContext();
        const fixture: Parameters<typeof founderContext.route>[1] = async route => {
          if (route.request().method() === 'POST') {
            posts++;
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({ ok: success, id: 'LOCAL_CACHE_ONLY_1', error: 'Explicit synthetic provider stores zero messages' }),
            });
            return;
          }
          const html = `<!doctype html><html><body><div id="account">Synthetic founder</div><div id="supplier">Synthetic supplier</div><div id="messages"></div><textarea id="composer"></textarea><button id="send">Send</button><script>
    function echo(value){const row=document.createElement('div');row.className='message';row.dataset.id='LOCAL_CACHE_ONLY_1';row.dataset.direction='out';const body=document.createElement('span');body.className='body';body.innerText=value;row.appendChild(body);document.getElementById('messages').appendChild(row);}
    const cached=localStorage.getItem('optimistic-unconfirmed-message');if(cached)echo(cached);
    document.getElementById('send').onclick=async()=>{const value=document.getElementById('composer').value;await fetch('${sendUrl}',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({thread:'LOCAL_CACHE_PROBE',text:value})});localStorage.setItem('optimistic-unconfirmed-message',value);echo(value);};
    </script></body></html>`;
          await route.fulfill({ status: 200, contentType: 'text/html', body: html });
        };
        await founderContext.route('**/*', fixture);
        const createContext = browser.newContext.bind(browser);
        browser.newContext = async options => {
          const context = await createContext(options);
          await context.route('**/*', fixture);
          return context;
        };
        const profile = MarketplaceProfileSchema.parse({
          platform: 'alibaba',
          contextId: randomUUID(),
          founderAccountLabel: 'Synthetic founder context',
          counterpartyId: randomUUID(),
          threadId: 'LOCAL_CACHE_PROBE',
          url,
          allowedHosts: ['message.alibaba.com'],
          timeoutSeconds: 30,
          accountSelector: '#account',
          accountText: 'Synthetic founder',
          identitySelector: '#supplier',
          identityText: 'Synthetic supplier',
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
        const connected = browser;
        let rejected = false;
        try {
          await new PlaywrightMarketplaceDriver(async () => connected).visit('wss://explicit-local-test.browserbase.com', profile, text);
        } catch {
          rejected = true;
        }
        expect({ rejected, posts, serverPersistedMessages: 0 }).toEqual({ rejected: true, posts: 1, serverPersistedMessages: 0 });
      } finally {
        await browser?.close().catch(() => undefined);
      }
    },
    20000,
  );
});
