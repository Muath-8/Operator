import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  env: {} as Record<string, unknown>,
  headers: new Headers(),
  values: new Map<string, string>(),
  getUser: vi.fn(),
  refresh: vi.fn(),
  set: vi.fn(),
  remove: vi.fn(),
  client: vi.fn(),
}));
vi.mock('@lo/runtime', () => ({ environment: () => state.env }));
vi.mock('next/headers', () => ({
  headers: async () => state.headers,
  cookies: async () => ({
    get: (name: string) => (state.values.has(name) ? { value: state.values.get(name) } : undefined),
    set: state.set,
    delete: state.remove,
  }),
}));
vi.mock('@supabase/supabase-js', () => ({ createClient: state.client }));
import { currentActor, sameOrigin } from './auth';
import { POST, DELETE } from '../app/api/session/route';
import { POST as refresh } from '../app/api/session/refresh/route';
import { POST as local } from '../app/api/session/local/route';
import { GET as realtime } from '../app/api/realtime-token/route';
const origin = 'http://127.0.0.1:3000',
  founder = '00000000-0000-4000-8000-000000000001';
const request = (body: unknown, from = origin) =>
  new Request(`${origin}/api/session`, {
    method: 'POST',
    headers: { origin: from, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.clearAllMocks();
  state.env = {
    LO_EXECUTION_MODE: 'local',
    APP_ORIGIN: origin,
    LO_DEV_FOUNDER_ID: founder,
    LO_DEV_AUTH_TOKEN: 'explicit-local-fixture-token',
    NODE_ENV: 'test',
  };
  state.headers = new Headers();
  state.values.clear();
  state.client.mockReturnValue({ auth: { getUser: state.getUser, refreshSession: state.refresh } });
  state.getUser.mockResolvedValue({ data: { user: null }, error: { message: 'Synthetic denied' } });
  state.refresh.mockResolvedValue({ data: { session: null }, error: { message: 'Synthetic denied' } });
});
afterEach(() => vi.restoreAllMocks());

describe('independent verified identity and session cookie boundaries', () => {
  it('requires a token and accepts an exact local token only in local execution mode', async () => {
    expect(await currentActor()).toBeNull();
    state.values.set('lo-session', 'wrong');
    expect(await currentActor()).toBeNull();
    state.values.set('lo-session', 'explicit-local-fixture-token');
    expect(await currentActor()).toEqual({ authUserId: founder, local: true });
    state.env.LO_EXECUTION_MODE = 'production';
    expect(await currentActor()).toBeNull();
  });
  it('verifies a bearer through Supabase and does not trust an unverified cookie in its place', async () => {
    state.env.SUPABASE_URL = 'https://example.supabase.co';
    state.env.SUPABASE_ANON_KEY = 'public-test-key';
    state.values.set('lo-session', 'explicit-local-fixture-token');
    state.headers.set('authorization', 'Bearer hosted-token');
    expect(await currentActor()).toBeNull();
    expect(state.getUser).toHaveBeenCalledWith('hosted-token');
    state.getUser.mockResolvedValue({ data: { user: { id: founder } }, error: null });
    expect(await currentActor()).toEqual({ authUserId: founder, local: false });
    expect(state.client).toHaveBeenCalledWith('https://example.supabase.co', 'public-test-key', {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  });
  it('requires the exact configured Origin, including scheme and port', () => {
    expect(sameOrigin(request({}))).toBe(true);
    for (const from of ['https://127.0.0.1:3000', 'http://127.0.0.1:3001', 'https://attacker.test', 'null'])
      expect(sameOrigin(request({}, from))).toBe(false);
    expect(sameOrigin(new Request(origin))).toBe(false);
  });
  it('does not set cookies for foreign origins, malformed JSON, empty/oversized/extra session fields or rejected credentials', async () => {
    expect((await POST(request({ token: 'explicit-local-fixture-token' }, 'https://attacker.test'))).status).toBe(403);
    expect((await POST(new Request(origin, { method: 'POST', headers: { origin }, body: '{broken' }))).status).toBe(400);
    for (const body of [{}, { token: '' }, { token: 'a'.repeat(10001) }, { token: 'explicit-local-fixture-token', unexpected: true }])
      expect((await POST(request(body))).status).toBe(400);
    expect((await POST(request({ token: 'wrong' }))).status).toBe(401);
    expect(state.set).not.toHaveBeenCalled();
  });
  it('sets HttpOnly bounded cookies after actual token verification, with refresh token restricted to session endpoints', async () => {
    state.env.NODE_ENV = 'production';
    expect((await POST(request({ token: 'explicit-local-fixture-token', refreshToken: 'synthetic-refresh' }))).status).toBe(200);
    expect(state.set).toHaveBeenCalledWith('lo-session', 'explicit-local-fixture-token', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
    });
    expect(state.set).toHaveBeenCalledWith('lo-refresh', 'synthetic-refresh', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/api/session',
      maxAge: 30 * 86400,
    });
  });
  it('uses hosted getUser verification when a token is not the local credential', async () => {
    state.env.SUPABASE_URL = 'https://example.supabase.co';
    state.env.SUPABASE_ANON_KEY = 'public-test-key';
    state.getUser.mockResolvedValue({ data: { user: { id: founder } }, error: null });
    expect((await POST(request({ token: 'verified-hosted-token' }))).status).toBe(200);
    expect(state.getUser).toHaveBeenCalledWith('verified-hosted-token');
    expect(state.set).toHaveBeenCalledWith(
      'lo-session',
      'verified-hosted-token',
      expect.objectContaining({ httpOnly: true, secure: false }),
    );
  });
  it('clears a previous refresh credential when a newly verified session provides only an access token', async () => {
    state.values.set('lo-refresh', 'previous-account-refresh');
    state.env.SUPABASE_URL = 'https://example.supabase.co';
    state.env.SUPABASE_ANON_KEY = 'public-test-key';
    state.getUser.mockResolvedValue({ data: { user: { id: founder } }, error: null });
    expect((await POST(request({ token: 'new-account-access' }))).status).toBe(200);
    expect(state.set).toHaveBeenCalledWith('lo-refresh', '', expect.objectContaining({ path: '/api/session', maxAge: 0 }));
  });
  it('clears both cookie scopes only for the configured origin', async () => {
    expect((await DELETE(request({}, 'https://attacker.test'))).status).toBe(403);
    expect(state.remove).not.toHaveBeenCalled();
    expect((await DELETE(request({}))).status).toBe(200);
    expect(state.remove).toHaveBeenCalledWith('lo-session');
    expect(state.set).toHaveBeenCalledWith('lo-refresh', '', { path: '/api/session', maxAge: 0 });
  });
  it('refuses missing refresh credentials, foreign origins and failed hosted renewal without rotating cookies', async () => {
    expect((await refresh(request({}, 'https://attacker.test'))).status).toBe(403);
    expect((await refresh(request({}))).status).toBe(401);
    state.values.set('lo-refresh', 'old-refresh');
    state.env.SUPABASE_URL = 'https://example.supabase.co';
    state.env.SUPABASE_ANON_KEY = 'public-test-key';
    expect((await refresh(request({}))).status).toBe(401);
    expect(state.set).not.toHaveBeenCalled();
  });
  it('rotates both cookie scopes after a verified hosted refresh', async () => {
    state.env.SUPABASE_URL = 'https://example.supabase.co';
    state.env.SUPABASE_ANON_KEY = 'public-test-key';
    state.env.NODE_ENV = 'production';
    state.values.set('lo-refresh', 'old-refresh');
    state.refresh.mockResolvedValue({
      data: { session: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 900 } },
      error: null,
    });
    expect((await refresh(request({}))).status).toBe(200);
    expect(state.refresh).toHaveBeenCalledWith({ refresh_token: 'old-refresh' });
    expect(state.set).toHaveBeenCalledWith('lo-session', 'new-access', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 900,
    });
    expect(state.set).toHaveBeenCalledWith('lo-refresh', 'new-refresh', expect.objectContaining({ path: '/api/session', httpOnly: true }));
  });
  it('never exposes a local token endpoint in production', async () => {
    state.env.LO_EXECUTION_MODE = 'production';
    expect((await local(request({}))).status).toBe(403);
    expect(state.set).not.toHaveBeenCalled();
  });
  it('allows local sign-in only with the complete explicit development configuration', async () => {
    expect((await local(request({}))).status).toBe(200);
    expect(state.set).toHaveBeenCalledWith('lo-session', 'explicit-local-fixture-token', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
    });
    state.set.mockClear();
    state.env.NODE_ENV = 'production';
    expect((await local(request({}))).status).toBe(403);
    state.env.NODE_ENV = 'test';
    delete state.env.LO_DEV_FOUNDER_ID;
    expect((await local(request({}))).status).toBe(403);
    expect(state.set).not.toHaveBeenCalled();
  });
  it('returns a realtime token only for a verified hosted session', async () => {
    expect((await realtime()).status).toBe(401);
    state.values.set('lo-session', 'explicit-local-fixture-token');
    expect((await realtime()).status).toBe(401);
    state.env.LO_EXECUTION_MODE = 'production';
    state.env.SUPABASE_URL = 'https://example.supabase.co';
    state.env.SUPABASE_ANON_KEY = 'public-test-key';
    state.getUser.mockResolvedValue({ data: { user: { id: founder } }, error: null });
    const response = await realtime();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: 'explicit-local-fixture-token' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    state.headers.set('authorization', 'Bearer verified-header-token');
    expect(await (await realtime()).json()).toEqual({ token: 'verified-header-token' });
  });
});
