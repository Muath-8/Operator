import { z } from 'zod';
import { currentActor } from '../../../../lib/auth';
import { readSnapshot } from '../../../../lib/snapshot';
import { projectMission } from '../../../../lib/projection';

export async function GET(_request: Request, context: { params: Promise<{ missionId: string }> }) {
  const actor = await currentActor();
  if (!actor) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const parsed = z.uuid().safeParse((await context.params).missionId);
  if (!parsed.success) return Response.json({ error: 'Invalid mission identifier' }, { status: 400 });
  try {
    return Response.json(
      {
        view: projectMission(await readSnapshot(actor.authUserId, parsed.data)),
      },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error: unknown) {
    const code = z.object({ code: z.string() }).safeParse(error);
    return Response.json(
      { error: 'Mission unavailable' },
      {
        status: code.success && ['42501', 'P0002'].includes(code.data.code) ? 404 : 503,
      },
    );
  }
}
