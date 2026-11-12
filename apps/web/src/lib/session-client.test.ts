import { afterEach, describe, it, expect, vi } from 'vitest';
import { renewSession, sessionFetch, tokenRefreshDelay } from './session-client';
afterEach(() => vi.unstubAllGlobals());
describe('session transport recovery', () => {
  it('coalesces simultaneous renewals and retries the unchanged mutation body after 401', async () => {
    let finish!: (response: Response) => void;
    const response = new Promise<Response>(resolve => {
      finish = resolve;
    });
    const transport = vi.fn().mockReturnValue(response);
    vi.stubGlobal('fetch', transport);
    const first = renewSession(),
      second = renewSession();
    expect(transport).toHaveBeenCalledTimes(1);
    finish(new Response('{}'));
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    transport
      .mockReset()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockResolvedValueOnce(new Response('{}'))
      .mockResolvedValueOnce(new Response('{"ok":true}'));
    const init = { method: 'POST', body: JSON.stringify({ idempotencyKey: 'same-key' }) };
    expect((await sessionFetch('/api/commands', init)).ok).toBe(true);
    expect(transport.mock.calls[0]).toEqual(transport.mock.calls[2]);
  });
  it('does not resend an unauthorized request when renewal fails', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 401 }))
      .mockRejectedValueOnce(new Error('network'));
    vi.stubGlobal('fetch', transport);
    expect((await sessionFetch('/api/commands')).status).toBe(401);
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('bounds token scheduling hints without trusting them for authorization', () => {
    const token = `a.${btoa(JSON.stringify({ exp: 1000 }))}.signature`;
    expect(tokenRefreshDelay(token, 900000)).toBe(40000);
    expect(tokenRefreshDelay(token, 2000000)).toBe(1000);
    expect(tokenRefreshDelay('invalid', 0)).toBe(60000);
  });
});
