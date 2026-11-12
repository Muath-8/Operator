import { z } from 'zod';
import { revokeProviderAccount } from '@lo/runtime/accounts';
import { currentActor, sameOrigin } from '../../../../../../lib/auth';
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ missionId: string; accountId: string }> },
): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json({ ok: false, error: { code: 'rejected', message: 'Origin denied', retryable: false } }, { status: 403 });
  const actor = await currentActor();
  if (!actor)
    return Response.json({ ok: false, error: { code: 'rejected', message: 'Authentication required', retryable: false } }, { status: 401 });
  const input = z.object({ missionId: z.uuid(), accountId: z.uuid() }).safeParse(await params);
  if (!input.success)
    return Response.json({ ok: false, error: { code: 'validation', message: 'Invalid account scope', retryable: false } }, { status: 422 });
  const result = await revokeProviderAccount({ authUserId: actor.authUserId, missionId: input.data.missionId }, input.data.accountId);
  return Response.json(result, { status: result.ok ? 200 : 404, headers: { 'Cache-Control': 'private, no-store' } });
}
