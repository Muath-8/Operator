import { cookies } from 'next/headers';
import { environment } from '@lo/runtime';
import { sameOrigin } from '../../../../lib/auth';
export async function POST(request: Request): Promise<Response> {
  const env = environment();
  if (
    !sameOrigin(request) ||
    env.LO_EXECUTION_MODE !== 'local' ||
    env.NODE_ENV === 'production' ||
    !env.LO_DEV_AUTH_TOKEN ||
    !env.LO_DEV_FOUNDER_ID
  )
    return new Response('Local sign-in unavailable', { status: 403 });
  const jar = await cookies();
  jar.set('lo-refresh', '', { httpOnly: true, secure: false, sameSite: 'lax', path: '/api/session', maxAge: 0 });
  jar.set('lo-session', env.LO_DEV_AUTH_TOKEN, { httpOnly: true, secure: false, sameSite: 'lax', path: '/', maxAge: 3600 });
  return Response.json({ ok: true });
}
