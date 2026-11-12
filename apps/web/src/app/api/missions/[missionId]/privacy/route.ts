import { z } from 'zod';
import { readMissionPrivacy } from '@lo/runtime';
import { currentActor } from '../../../../../lib/auth';
export const dynamic = 'force-dynamic';
export async function GET(_request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  const actor = await currentActor();
  if (!actor) return new Response('Authentication required', { status: 401 });
  try {
    return Response.json(await readMissionPrivacy({ authUserId: actor.authUserId, missionId: z.uuid().parse((await params).missionId) }), {
      headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return new Response('Mission unavailable', { status: 404 });
  }
}
