import { z } from 'zod';
import { JsonObjectSchema } from '@lo/state';
import { withRole } from '@lo/runtime';
import { currentActor } from '../../../../../lib/auth';
export async function GET(_request: Request, context: { params: Promise<{ missionId: string }> }) {
  const actor = await currentActor();
  if (!actor) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const parsed = z.uuid().safeParse((await context.params).missionId);
  if (!parsed.success) return Response.json({ error: 'Invalid mission identifier' }, { status: 400 });
  try {
    const report = await withRole('founder_role', { authUserId: actor.authUserId, missionId: parsed.data }, async db =>
      JsonObjectSchema.parse((await db.query('select public.mission_business_metrics($1)report', [parsed.data])).rows[0]?.report),
    );
    return Response.json(report, {
      headers: {
        'Cache-Control': 'private, no-store',
        'Content-Disposition': `attachment; filename="mission-${parsed.data}-metrics.json"`,
      },
    });
  } catch {
    return Response.json({ error: 'Mission metrics unavailable' }, { status: 404 });
  }
}
