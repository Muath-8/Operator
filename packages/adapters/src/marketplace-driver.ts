import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright-core';
import { AdapterFault } from './core.js';
import { failure } from '@lo/policy';
import { marketplaceUrlAllowed, type MarketplaceDriver, type MarketplaceProfile, type MarketplaceObservedMessage } from './marketplace.js';
function responseField(raw: unknown, path: readonly string[]): unknown {
  let value = raw;
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

/** No model JavaScript, selectors or navigation. Only the registered thread's
 * composer/send control is actionable; all other writes are intercepted. */
export class PlaywrightMarketplaceDriver implements MarketplaceDriver {
  constructor(private readonly testConnect?: () => Promise<Browser>) {
    if (testConnect && process.env['NODE_ENV'] !== 'test') throw new Error('Test browser injection is forbidden outside tests');
  }
  async visit(connectUrl: string, p: MarketplaceProfile, text?: string) {
    const browser = await (this.testConnect ? this.testConnect() : chromium.connectOverCDP(connectUrl, { timeout: 15000 }));
    const founderContext = browser.contexts()[0];
    if (!founderContext) {
      await browser.close();
      throw new AdapterFault(failure('rejected', 'Founder browser context unavailable.'));
    }
    const { context, initialState } = await (async () => {
      try {
        const state = await founderContext.storageState({ indexedDB: true });
        for (const existing of founderContext.pages()) await existing.close();
        const initialState = {
          cookies: state.cookies.filter(c =>
            p.allowedHosts.some(h => h === c.domain.replace(/^\./, '') || h.endsWith(c.domain.startsWith('.') ? c.domain : '.' + c.domain)),
          ),
          origins: state.origins.filter(o => p.allowedHosts.includes(new URL(o.origin).hostname)),
        };
        return {
          initialState,
          context: await browser.newContext({ storageState: initialState, serviceWorkers: 'block', acceptDownloads: false }),
        };
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw error;
      }
    })();
    let page: Page | undefined, verificationContext: BrowserContext | undefined;
    let allowedSend = false,
      sentRequests = 0;
    let blockedWrite = false;
    const allowed = (request: Request): boolean => {
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        return false;
      }
      if (!marketplaceUrlAllowed(url) || !p.allowedHosts.includes(url.hostname)) return false;
      if (request.method() === 'GET' || request.method() === 'HEAD') return request.resourceType() !== 'document' || url.href === p.url;
      if (request.method() !== 'POST') return false;
      if (p.readPostUrls.includes(url.href)) return text === undefined || !allowedSend;
      if (!allowedSend || url.href !== p.sendUrl || sentRequests !== 0 || text === undefined) return false;
      try {
        const raw = request.postData() ?? '';
        if (raw.length > 30000) return false;
        const form = p.sendFormat === 'form' ? new URLSearchParams(raw) : null,
          body: unknown = form ? Object.fromEntries(form) : (JSON.parse(raw) as unknown);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
        const fields = body as Record<string, unknown>,
          keys = [p.textField, p.threadField, ...Object.keys(p.staticSendFields), ...p.securityFieldNames];
        if (
          Object.keys(fields).length !== keys.length ||
          Object.keys(fields).some(k => !keys.includes(k)) ||
          (form && [...form].length !== keys.length)
        )
          return false;
        if (
          fields[p.textField] !== text ||
          fields[p.threadField] !== p.threadId ||
          Object.entries(p.staticSendFields).some(([k, v]) => fields[k] !== v) ||
          p.securityFieldNames.some(k => typeof fields[k] !== 'string' || String(fields[k]).length < 1 || String(fields[k]).length > 4096)
        )
          return false;
        if (
          !form &&
          keys.some(k => (raw.match(new RegExp('"' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\s*:', 'g')) ?? []).length !== 1)
        )
          return false;
        sentRequests++;
        return true;
      } catch {
        return false;
      }
    };
    const route: Parameters<typeof context.route>[1] = async routed => {
      if (allowed(routed.request())) await routed.fallback();
      else {
        if (!['GET', 'HEAD'].includes(routed.request().method())) blockedWrite = true;
        await routed.abort('blockedbyclient');
      }
    };
    const observe = async (current: Page): Promise<MarketplaceObservedMessage[]> => {
      const rows = current.locator(p.messageSelector),
        count = await rows.count();
      if (count > 500) throw new AdapterFault(failure('rejected', 'Marketplace thread exceeds the bounded message window.'));
      const result: MarketplaceObservedMessage[] = [];
      for (let i = 0; i < count; i++) {
        const row = rows.nth(i),
          id = await row.getAttribute(p.messageIdAttribute),
          direction = await row.getAttribute(p.directionAttribute),
          body = await row.locator(p.bodySelector).innerText();
        if (!id || id.length > 160 || body.length > 10000 || ![p.outboundValue, p.inboundValue].includes(direction ?? ''))
          throw new AdapterFault(failure('rejected', 'Marketplace DOM profile no longer identifies bounded provider messages.'));
        result.push({ messageId: id, text: body, direction: direction === p.outboundValue ? 'outbound' : 'inbound' });
      }
      return result;
    };
    try {
      // A pre-existing context tab must not perform background account mutations.
      for (const existing of context.pages()) await existing.close();
      await context.route('**/*', route);
      await context.routeWebSocket('**/*', socket => socket.close());
      page = await context.newPage();
      page.setDefaultTimeout(Math.min(20000, p.timeoutSeconds * 1000));
      page.on('dialog', dialog => {
        void dialog.dismiss();
      });
      page.on('popup', popup => {
        void popup.close();
      });
      page.on('download', download => {
        void download.cancel();
      });
      await page.goto(p.url, { waitUntil: 'domcontentloaded' });
      const assertIdentity = async () => {
        const current = page;
        if (!current) throw new Error('Browser page unavailable');
        if (
          (await current.locator(p.accountSelector).count()) !== 1 ||
          (await current.locator(p.accountSelector).innerText()).trim() !== p.accountText
        )
          throw new AdapterFault(failure('rejected', 'Marketplace founder account identity differs from the registration.'));
        if (
          current.url() !== p.url ||
          (await current.locator(p.identitySelector).count()) !== 1 ||
          (await current.locator(p.identitySelector).innerText()).trim() !== p.identityText
        )
          throw new AdapterFault(failure('rejected', 'Marketplace thread identity differs from the founder registration.'));
      };
      await assertIdentity();
      const before = await observe(page);
      let messageId: string | undefined;
      if (text !== undefined) {
        if ((await page.locator(p.composerSelector).count()) !== 1 || (await page.locator(p.sendSelector).count()) !== 1)
          throw new AdapterFault(failure('rejected', 'Reviewed composer/send controls are unavailable.'));
        await page.locator(p.composerSelector).fill(text);
        await assertIdentity();
        allowedSend = true;
        const response = page.waitForResponse(r => r.url() === p.sendUrl && r.request().method() === 'POST', { timeout: 15000 });
        void response.catch(() => undefined);
        await page.locator(p.sendSelector).click({ noWaitAfter: true });
        const sent = await response;
        if (!sent.ok() || sentRequests !== 1 || blockedWrite)
          throw new AdapterFault(failure('provider_down', 'Marketplace send outcome is ambiguous; no retry is permitted.', 'reconcile'));
        let acknowledgement: unknown;
        try {
          acknowledgement = await sent.json();
        } catch {
          throw new AdapterFault(
            failure(
              'provider_down',
              'Marketplace response has no registered JSON acknowledgement; reconcile without resending.',
              'reconcile',
            ),
          );
        }
        const acknowledgedId = responseField(acknowledgement, p.responseMessageIdPath),
          providerId =
            typeof acknowledgedId === 'string'
              ? acknowledgedId
              : typeof acknowledgedId === 'number' && Number.isSafeInteger(acknowledgedId)
                ? String(acknowledgedId)
                : '';
        if (
          responseField(acknowledgement, p.responseSuccessPath) !== p.responseSuccessValue ||
          !/^[A-Za-z0-9_.:-]{1,160}$/.test(providerId)
        )
          throw new AdapterFault(
            failure(
              'provider_down',
              'Marketplace did not acknowledge a successful provider message ID; reconcile without resending.',
              'reconcile',
            ),
          );
        allowedSend = false;
        await page.close();
        // Verification gets the PRE-SEND authentication snapshot in another isolated
        // context: no optimistic localStorage/IndexedDB/HTTP cache can survive send.
        verificationContext = await browser.newContext({ storageState: initialState, serviceWorkers: 'block', acceptDownloads: false });
        await verificationContext.route('**/*', route);
        await verificationContext.routeWebSocket('**/*', socket => socket.close());
        page = await verificationContext.newPage();
        page.setDefaultTimeout(Math.min(20000, p.timeoutSeconds * 1000));
        page.on('dialog', dialog => {
          void dialog.dismiss();
        });
        page.on('popup', popup => {
          void popup.close();
        });
        page.on('download', download => {
          void download.cancel();
        });
        await page.goto(p.url, { waitUntil: 'domcontentloaded' });
        await assertIdentity();
        try {
          await page.waitForFunction(
            ({ selector, attribute, id }) => Array.from(document.querySelectorAll(selector)).some(e => e.getAttribute(attribute) === id),
            { selector: p.messageSelector, attribute: p.messageIdAttribute, id: providerId },
            { timeout: 15000 },
          );
        } catch {
          throw new AdapterFault(
            failure('provider_down', 'No unique persisted marketplace message ID; reconcile without resending.', 'reconcile'),
          );
        }
        const after = await observe(page),
          matches = after.filter(
            m =>
              m.messageId === providerId &&
              m.direction === 'outbound' &&
              m.text === text &&
              !before.some(old => old.messageId === m.messageId),
          );
        if (matches.length !== 1)
          throw new AdapterFault(
            failure('provider_down', 'No unique persisted marketplace message ID; reconcile without resending.', 'reconcile'),
          );
        messageId = providerId;
      }
      const messages = await observe(page),
        screenshotBase64 = (await page.screenshot({ type: 'png', fullPage: false })).toString('base64');
      return { url: page.url(), messages, screenshotBase64, ...(messageId ? { sentMessageId: messageId } : {}) };
    } finally {
      if (page) await page.close().catch(() => undefined);
      await verificationContext?.close().catch(() => undefined);
      await context.unroute('**/*', route).catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }
}
