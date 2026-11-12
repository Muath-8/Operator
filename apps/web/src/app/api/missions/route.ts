import { currentActor } from '../../../lib/auth';
import { listMissionIds, readSnapshot } from '../../../lib/snapshot';
import { projectMission, projectMissionSummary } from '../../../lib/projection';

export async function GET() {
  const actor = await currentActor();
  if (!actor) return Response.json({ error: 'Authentication required' }, { status: 401 });
  try {
    const ids = await listMissionIds(actor.authUserId);
    const missions = await Promise.all(
      ids.map(async id => projectMissionSummary(projectMission(await readSnapshot(actor.authUserId, id)))),
    );
    return Response.json({ missions }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json({ error: 'Mission data is temporarily unavailable' }, { status: 503 });
  }
}
