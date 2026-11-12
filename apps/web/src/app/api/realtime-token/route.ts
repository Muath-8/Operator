import { cookies, headers } from 'next/headers';
import { currentActor } from '../../../lib/auth';
export async function GET(): Promise<Response> {
  const actor = await currentActor();
  if (!actor || actor.local) return Response.json({ error: 'A Supabase session is required' }, { status: 401 });
  const authorization = (await headers()).get('authorization');
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : (await cookies()).get('lo-session')?.value;
  return Response.json({ token }, { headers: { 'Cache-Control': 'no-store', Vary: 'Cookie, Authorization' } });
}
