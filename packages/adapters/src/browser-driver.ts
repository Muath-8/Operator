import { z } from 'zod';
import { failure } from '@lo/policy';
import { AdapterFault, parse } from './core.js';
import type { ReadOnlyBrowserDriver } from './research.js';

/** Minimal CDP driver. The program owns all protocol commands; model text is never evaluated. */
export class CdpReadOnlyBrowserDriver implements ReadOnlyBrowserDriver {
  async read(connectUrl: string, url: string, allowedHosts: readonly string[]) {
    const socket = new WebSocket(connectUrl);
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason: Error) => void }>();
    let counter = 0;
    let sessionId = '';
    let targetId = '';
    let loadResolve: (() => void) | undefined;
    let loadReject: ((reason: Error) => void) | undefined;
    const command = (method: string, params: Record<string, unknown> = {}, session?: string): Promise<unknown> =>
      new Promise((resolve, reject) => {
        const id = ++counter;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
      });
    const rejectPending = () => {
      for (const item of pending.values()) item.reject(new Error('Browser session disconnected.'));
      pending.clear();
      loadReject?.(new Error('Browser session disconnected.'));
    };
    const timeout = setTimeout(() => {
      rejectPending();
      socket.close();
    }, 30_000);
    socket.addEventListener('close', rejectPending);
    socket.addEventListener('error', rejectPending);
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string') return;
      let raw: unknown;
      try {
        raw = JSON.parse(event.data) as unknown;
      } catch {
        return;
      }
      const parsed = z
        .object({
          id: z.number().optional(),
          result: z.unknown().optional(),
          error: z.unknown().optional(),
          method: z.string().optional(),
          params: z.record(z.string(), z.unknown()).optional(),
          sessionId: z.string().optional(),
        })
        .safeParse(raw);
      if (!parsed.success) return;
      const message = parsed.data;
      if (message.id !== undefined) {
        const item = pending.get(message.id);
        pending.delete(message.id);
        if (item) {
          if (message.error) item.reject(new Error('Browser protocol operation failed.'));
          else item.resolve(message.result);
        }
        return;
      }
      if (message.sessionId !== sessionId) return;
      if (message.method === 'Page.loadEventFired') loadResolve?.();
      if (message.method === 'Fetch.requestPaused') {
        const request = z
          .object({ requestId: z.string(), request: z.object({ method: z.string(), url: z.string() }) })
          .safeParse(message.params);
        if (!request.success) return;
        let allowed = false;
        try {
          const u = new URL(request.data.request.url);
          allowed =
            request.data.request.method === 'GET' &&
            u.protocol === 'https:' &&
            !u.username &&
            !u.password &&
            !u.port &&
            allowedHosts.includes(u.hostname);
        } catch {
          allowed = false;
        }
        void command(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          { requestId: request.data.requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) },
          sessionId,
        ).catch(() => {
          socket.close();
        });
      }
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener('open', () => resolve(), { once: true });
        socket.addEventListener('error', () => reject(new Error('Browser connection failed.')), { once: true });
        socket.addEventListener('close', () => reject(new Error('Browser connection closed.')), { once: true });
      });
      targetId = parse(z.object({ targetId: z.string() }), await command('Target.createTarget', { url: 'about:blank' })).targetId;
      sessionId = parse(z.object({ sessionId: z.string() }), await command('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      await command('Page.enable', {}, sessionId);
      await command('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId);
      const loaded = new Promise<void>((resolve, reject) => {
        loadResolve = resolve;
        loadReject = reject;
      });
      // Register a rejection handler before navigation can fail, avoiding an unhandled load rejection.
      void loaded.catch(() => undefined);
      const navigation = parse(
        z.object({ errorText: z.string().optional() }).passthrough(),
        await command('Page.navigate', { url }, sessionId),
      );
      if (navigation.errorText) throw new AdapterFault(failure('provider_down', 'Research navigation failed.'));
      await loaded;
      loadReject = undefined;
      const result = parse(
        z.object({ result: z.object({ value: z.object({ url: z.string().url(), title: z.string(), text: z.string() }) }) }),
        await command(
          'Runtime.evaluate',
          {
            expression:
              'JSON.parse(JSON.stringify({url:location.href,title:document.title,text:document.body?document.body.innerText:""}))',
            returnByValue: true,
          },
          sessionId,
        ),
      );
      const screenshot = parse(
        z.object({ data: z.string() }),
        await command('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false }, sessionId),
      );
      return { ...result.result.value, screenshotBase64: screenshot.data };
    } finally {
      if (targetId && socket.readyState === WebSocket.OPEN) await command('Target.closeTarget', { targetId });
      clearTimeout(timeout);
      socket.close();
      rejectPending();
    }
  }
}
