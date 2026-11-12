import { z } from 'zod';
import { listProviderAccounts } from '@lo/runtime/accounts';
import { currentActor } from '../../../../../lib/auth';
export async function GET(_request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  const actor = await currentActor();
  if (!actor)
    return Response.json({ ok: false, error: { code: 'rejected', message: 'Authentication required', retryable: false } }, { status: 401 });
  const input = z.object({ missionId: z.uuid() }).safeParse(await params);
  if (!input.success)
    return Response.json({ ok: false, error: { code: 'validation', message: 'Invalid mission', retryable: false } }, { status: 422 });
  const result = await listProviderAccounts({ authUserId: actor.authUserId, missionId: input.data.missionId });
  return Response.json(result, { status: result.ok ? 200 : 404, headers: { 'Cache-Control': 'private, no-store' } });
}
