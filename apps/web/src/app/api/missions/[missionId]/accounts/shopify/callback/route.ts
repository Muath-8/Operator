import { z } from 'zod';
import { completeShopifyAccountOAuth } from '@lo/runtime/accounts';
import { environment } from '@lo/runtime';
import { currentActor } from '../../../../../../../lib/auth';
export async function GET(request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  const actor = await currentActor();
  if (!actor)
    return Response.json({ ok: false, error: { code: 'rejected', message: 'Authentication required', retryable: false } }, { status: 401 });
  try {
    const { missionId } = z.object({ missionId: z.uuid() }).parse(await params);
    const result = await completeShopifyAccountOAuth({ authUserId: actor.authUserId, missionId }, new URL(request.url));
    if (!result.ok)
      return Response.json(result, { status: 422, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
    return Response.redirect(new URL(`/?mission=${missionId}&accountConnected=shopify`, environment().APP_ORIGIN), 303);
  } catch {
    return Response.json(
      {
        ok: false,
        error: { code: 'rejected', message: 'Shopify connection could not be completed; restart installation', retryable: false },
      },
      { status: 422, headers: { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } },
    );
  }
}
