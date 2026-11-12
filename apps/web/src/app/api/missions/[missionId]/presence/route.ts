import { z } from 'zod';
import { withRole } from '@lo/runtime';
import { currentActor, sameOrigin } from '../../../../../lib/auth';
import { readJsonBody } from '../../../../../lib/request-body';
export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return new Response('Origin denied', { status: 403 });
  const actor = await currentActor();
  if (!actor) return new Response('Sign in required', { status: 401 });
  try {
    const missionId = z.uuid().parse((await params).missionId),
      { active } = z
        .object({ active: z.boolean() })
        .strict()
        .parse(await readJsonBody(request, 1024));
    await withRole('founder_role', { authUserId: actor.authUserId, missionId }, async db => {
      await db.query('select public.record_founder_presence($1,$2)', [missionId, active]);
    });
    return new Response(null, { status: 204 });
  } catch {
    return new Response('Presence could not be recorded', { status: 400 });
  }
}
