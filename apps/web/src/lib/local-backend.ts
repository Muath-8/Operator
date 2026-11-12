/** Explicit development backend selection. Never silently changes the PostgreSQL path. */
export function isLocalSqliteBackend(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.LO_STORAGE_BACKEND !== 'sqlite') return false;
  if (env.LO_EXECUTION_MODE !== 'local' || env.NODE_ENV === 'production')
    throw new Error('SQLite testing requires local, nonproduction execution');
  return true;
}
export function localApiSupported(path: string, method: string): boolean {
  if (path === '/api/local/paypal' || path.startsWith('/api/local/paypal/')) return true;
  if (path === '/api/session/local') return method === 'POST';
  if (path === '/api/session') return method === 'DELETE';
  if (path === '/api/session/refresh') return method === 'POST';
  if (path === '/api/commands' || path === '/api/missions/create') return method === 'POST';
  return method === 'GET' && (path === '/api/missions' || /^\/api\/missions\/[0-9a-f-]{36}$/i.test(path));
}
export function localUnavailableResponse(): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: 'unavailable',
        message: 'This action is unavailable in local SQLite testing. No provider action or production database fallback was performed.',
        retryable: false,
      },
    },
    { status: 503, headers: { 'Cache-Control': 'private, no-store' } },
  );
}
