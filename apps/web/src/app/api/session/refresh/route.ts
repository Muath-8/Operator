import { isLocalSqliteBackend } from '../../../../lib/local-backend';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { environment } from '@lo/runtime';
import { sameOrigin } from '../../../../lib/auth';
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return new Response('Origin denied', { status: 403 });
  const env = environment(),
    jar = await cookies();
  if (isLocalSqliteBackend()) return new Response('Use local sign-in again', { status: 401 });
  const refresh = jar.get('lo-refresh')?.value;
  if (!refresh || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return new Response('Sign in again', { status: 401 });
  const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.refreshSession({ refresh_token: refresh });
  if (error || !data.session) return new Response('Sign in again', { status: 401 });
  const options = { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax' as const };
  jar.set('lo-session', data.session.access_token, { ...options, path: '/', maxAge: data.session.expires_in });
  jar.set('lo-refresh', data.session.refresh_token, { ...options, path: '/api/session', maxAge: 30 * 86400 });
  return Response.json({ ok: true });
}
