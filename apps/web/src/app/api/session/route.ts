import { isLocalSqliteBackend, localUnavailableResponse } from '../../../lib/local-backend';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { environment } from '@lo/runtime';
import { sameOrigin } from '../../../lib/auth';

export async function POST(request: Request) {
  if (isLocalSqliteBackend()) return localUnavailableResponse();
  if (!sameOrigin(request)) return Response.json({ error: 'Origin denied' }, { status: 403 });
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'Invalid session' }, { status: 400 });
  }
  const parsed = z
    .object({ token: z.string().min(1).max(10000), refreshToken: z.string().min(1).max(10000).optional() })
    .strict()
    .safeParse(body);
  if (!parsed.success) return Response.json({ error: 'Invalid session' }, { status: 400 });
  const env = environment();
  const token = parsed.data.token;
  let valid = false;
  if (env.LO_EXECUTION_MODE === 'local' && env.LO_DEV_AUTH_TOKEN) {
    const a = Buffer.from(token),
      b = Buffer.from(env.LO_DEV_AUTH_TOKEN);
    valid = a.length === b.length && timingSafeEqual(a, b);
  }
  if (!valid && env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false } });
    const result = await client.auth.getUser(token);
    valid = !result.error && !!result.data.user;
  }
  if (!valid) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const jar = await cookies();
  jar.set('lo-session', token, { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/', maxAge: 3600 });
  if (parsed.data.refreshToken)
    jar.set('lo-refresh', parsed.data.refreshToken, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/api/session',
      maxAge: 30 * 86400,
    });
  else
    jar.set('lo-refresh', '', { httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: '/api/session', maxAge: 0 });
  return Response.json({ ok: true });
}
export async function DELETE(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origin denied' }, { status: 403 });
  const jar = await cookies();
  jar.delete('lo-session');
  jar.set('lo-refresh', '', { path: '/api/session', maxAge: 0 });
  return Response.json({ ok: true });
}
