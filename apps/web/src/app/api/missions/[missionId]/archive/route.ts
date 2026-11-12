import { z } from 'zod';
import { cookies } from 'next/headers';
import { withRole, missionArchiveStream, environment, authenticatedArchiveFileReader } from '@lo/runtime';
import { currentActor } from '../../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  const actor = await currentActor();
  if (!actor) return new Response('Authentication required', { status: 401 });
  try {
    const missionId = z.uuid().parse((await params).missionId),
      scope = { authUserId: actor.authUserId, missionId };
    await withRole('founder_role', scope, async db => {
      if (!(await db.query('select id from public.missions where id=$1', [missionId])).rowCount) throw new Error('Mission unavailable');
    });
    const env = environment(),
      authorization = _request.headers.get('authorization'),
      token = actor.local
        ? undefined
        : authorization?.startsWith('Bearer ')
          ? authorization.slice(7)
          : (await cookies()).get('lo-session')?.value;
    const fileReader =
      !actor.local && env.SUPABASE_URL && env.SUPABASE_ANON_KEY && token
        ? authenticatedArchiveFileReader({ origin: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, token, missionId })
        : undefined;
    return new Response(missionArchiveStream(scope, _request.signal, fileReader), {
      headers: {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Content-Disposition': `attachment; filename="mission-${missionId}.ndjson"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch {
    return new Response('Mission unavailable', { status: 404 });
  }
}
