import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { CdpReadOnlyBrowserDriver } from './browser-driver.js';

/** Actual loopback WebSocket transport, explicit CDP protocol fixture. Does not
 * establish live Browserbase behavior or browser rendering/redirect semantics. */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
type Wire = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
async function protocol(
  options: { navigationError?: boolean; disconnect?: boolean; commandError?: boolean; malformedValue?: boolean; intercept?: boolean } = {},
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback CDP port missing');
  const calls: Wire[] = [];
  server.on('connection', socket => {
    socket.on('message', bytes => {
      const call = JSON.parse(bytes.toString()) as Wire;
      calls.push(call);
      const result = (value: unknown) => socket.send(JSON.stringify({ id: call.id, result: value }));
      if (call.method === 'Target.createTarget') {
        result({ targetId: 'target1' });
        return;
      }
      if (call.method === 'Target.attachToTarget') {
        result({ sessionId: 'session1' });
        return;
      }
      if (call.method === 'Page.enable' && options.commandError) {
        socket.send(JSON.stringify({ id: call.id, error: { message: 'fixture denied' } }));
        return;
      }
      if (call.method === 'Page.navigate') {
        if (options.disconnect) {
          socket.close();
          return;
        }
        if (options.navigationError) {
          result({ errorText: 'Explicit fixture navigation refusal' });
          return;
        }
        result({ frameId: 'frame1' });
        // Malformed/nontext/unrelated events cannot satisfy the page-loaded wait.
        socket.send('{malformed');
        socket.send(Buffer.from('binary payload'));
        socket.send(JSON.stringify({ id: 'not-number' }));
        socket.send(JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'foreign-session' }));
        if (options.intercept) {
          const requests = [
            ['allowed', 'GET', 'https://review.example/path'],
            ['post', 'POST', 'https://review.example/send'],
            ['foreign', 'GET', 'https://foreign.example/path'],
            ['credentials', 'GET', 'https://user:secret@review.example/path'],
            ['port', 'GET', 'https://review.example:444/path'],
            ['http', 'GET', 'http://review.example/path'],
            ['invalid', 'GET', 'not-a-url'],
          ];
          for (const [requestId, method, url] of requests)
            socket.send(
              JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'session1', params: { requestId, request: { method, url } } }),
            );
          socket.send(JSON.stringify({ method: 'Fetch.requestPaused', sessionId: 'session1', params: { malformed: true } }));
        }
        socket.send(JSON.stringify({ method: 'Page.loadEventFired', sessionId: 'session1' }));
        return;
      }
      if (call.method === 'Runtime.evaluate') {
        result(
          options.malformedValue
            ? { result: { value: { title: 'No URL supplied' } } }
            : {
                result: {
                  value: { url: 'https://review.example/path', title: 'Explicit research fixture', text: 'Untrusted external content' },
                },
              },
        );
        return;
      }
      if (call.method === 'Page.captureScreenshot') {
        result({ data: 'synthetic-base64-image' });
        return;
      }
      result({});
    });
  });
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  return { url: `ws://127.0.0.1:${address.port}`, calls };
}
describe('read-only CDP protocol boundary', () => {
  it('permits only exact safe GET requests and owns the extraction expression and screenshot commands', async () => {
    const fixture = await protocol({ intercept: true });
    const result = await new CdpReadOnlyBrowserDriver().read(fixture.url, 'https://review.example/path', ['review.example']);
    expect(result).toEqual({
      url: 'https://review.example/path',
      title: 'Explicit research fixture',
      text: 'Untrusted external content',
      screenshotBase64: 'synthetic-base64-image',
    });
    expect(fixture.calls.filter(call => call.method === 'Fetch.continueRequest').map(call => call.params['requestId'])).toEqual([
      'allowed',
    ]);
    expect(
      fixture.calls
        .filter(call => call.method === 'Fetch.failRequest')
        .map(call => call.params['requestId'])
        .sort(),
    ).toEqual(['credentials', 'foreign', 'http', 'invalid', 'port', 'post']);
    const evaluated = fixture.calls.filter(call => call.method === 'Runtime.evaluate');
    expect(evaluated).toHaveLength(1);
    expect(evaluated[0]?.params).toEqual({
      expression: 'JSON.parse(JSON.stringify({url:location.href,title:document.title,text:document.body?document.body.innerText:""}))',
      returnByValue: true,
    });
    expect(fixture.calls.some(call => /Input\.|DOM\.|submit|click/.test(call.method))).toBe(false);
    expect(fixture.calls.at(-1)?.method).toBe('Target.closeTarget');
  });
  it.each(['navigationError', 'commandError', 'malformedValue'] as const)(
    'rejects %s without producing research evidence and closes its exact target',
    async failure => {
      const fixture = await protocol({ [failure]: true });
      await expect(new CdpReadOnlyBrowserDriver().read(fixture.url, 'https://review.example', ['review.example'])).rejects.toThrow();
      expect(fixture.calls.at(-1)).toMatchObject({ method: 'Target.closeTarget', params: { targetId: 'target1' } });
      if (failure !== 'malformedValue') expect(fixture.calls.some(call => call.method === 'Page.captureScreenshot')).toBe(false);
    },
  );
  it('rejects an in-flight navigation on disconnect without an unhandled load rejection', async () => {
    const fixture = await protocol({ disconnect: true });
    await expect(new CdpReadOnlyBrowserDriver().read(fixture.url, 'https://review.example', ['review.example'])).rejects.toThrow(
      /disconnected/,
    );
    expect(fixture.calls.some(call => call.method === 'Runtime.evaluate')).toBe(false);
  });
});
