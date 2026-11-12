import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { isLocalSqliteBackend, localApiSupported } from './local-backend';
import { proxy } from '../proxy';
const local = { NODE_ENV: 'test' as const, LO_EXECUTION_MODE: 'local', LO_STORAGE_BACKEND: 'sqlite' };
afterEach(() => vi.unstubAllEnvs());
describe('explicit local SQLite boundary', () => {
  it('selects SQLite only for explicit local nonproduction execution', () => {
    expect(isLocalSqliteBackend(local)).toBe(true);
    expect(isLocalSqliteBackend({ ...local, LO_STORAGE_BACKEND: 'postgres' })).toBe(false);
    expect(() => isLocalSqliteBackend({ ...local, NODE_ENV: 'production' })).toThrow();
    expect(() => isLocalSqliteBackend({ ...local, LO_EXECUTION_MODE: 'sandbox' })).toThrow();
  });
  it('permits only integrated session, snapshot and command paths plus the separate sandbox payment route', () => {
    for (const [path, method] of [
      ['/api/session/local', 'POST'],
      ['/api/session', 'DELETE'],
      ['/api/missions', 'GET'],
      ['/api/missions/create', 'POST'],
      ['/api/missions/11111111-1111-4111-8111-111111111111', 'GET'],
      ['/api/commands', 'POST'],
      ['/api/local/paypal/config', 'GET'],
    ])
      expect(localApiSupported(path ?? '', method ?? '')).toBe(true);
    for (const [path, method] of [
      ['/api/session', 'POST'],
      ['/api/missions', 'POST'],
      ['/api/realtime-token', 'GET'],
      ['/api/inngest', 'POST'],
      ['/api/webhooks/twilio/token', 'POST'],
      ['/api/payments/return', 'GET'],
      ['/api/missions/11111111-1111-4111-8111-111111111111/archive', 'GET'],
      ['/api/missions/11111111-1111-4111-8111-111111111111/accounts', 'GET'],
      ['/api/missions/11111111-1111-4111-8111-111111111111/deletion', 'DELETE'],
      ['/api/validation/slug', 'POST'],
    ])
      expect(localApiSupported(path ?? '', method ?? '')).toBe(false);
  });
  it('rejects unsupported APIs before handlers with an honest unavailability response, without affecting PostgreSQL', async () => {
    vi.stubEnv('LO_STORAGE_BACKEND', 'sqlite');
    vi.stubEnv('LO_EXECUTION_MODE', 'local');
    const denied = proxy(new NextRequest('http://127.0.0.1:3100/api/inngest', { method: 'POST' }));
    expect(denied.status).toBe(503);
    expect(await denied.json()).toMatchObject({ ok: false, error: { code: 'unavailable', retryable: false } });
    expect(proxy(new NextRequest('http://127.0.0.1:3100/api/missions')).headers.get('x-middleware-next')).toBe('1');
    vi.stubEnv('LO_STORAGE_BACKEND', 'postgres');
    expect(proxy(new NextRequest('http://127.0.0.1:3100/api/inngest')).headers.get('x-middleware-next')).toBe('1');
  });
});
