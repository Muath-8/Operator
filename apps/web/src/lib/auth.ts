import { isLocalSqliteBackend } from './local-backend';
import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { cookies, headers } from 'next/headers';
import { environment } from '@lo/runtime';

export async function currentActor(): Promise<{ authUserId: string; local: boolean } | null> {
  const env = environment();
  const requestHeaders = await headers();
  const jar = await cookies();
  const authorization = requestHeaders.get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : jar.get('lo-session')?.value;
  if (!token) return null;
  if (env.LO_EXECUTION_MODE === 'local' && env.LO_DEV_FOUNDER_ID && env.LO_DEV_AUTH_TOKEN) {
    const a = Buffer.from(token),
      b = Buffer.from(env.LO_DEV_AUTH_TOKEN);
    if (a.length === b.length && timingSafeEqual(a, b)) return { authUserId: env.LO_DEV_FOUNDER_ID, local: true };
  }
  // SQLite testing never authenticates against a hosted identity provider.
  if (isLocalSqliteBackend()) return null;
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.auth.getUser(token);
  return !error && data.user ? { authUserId: data.user.id, local: false } : null;
}
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  return origin === environment().APP_ORIGIN;
}
