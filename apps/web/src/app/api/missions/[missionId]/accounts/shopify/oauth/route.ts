import { z } from 'zod';
import { startShopifyAccountOAuth } from '@lo/runtime/accounts';
import { currentActor, sameOrigin } from '../../../../../../../lib/auth';
export async function POST(request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json({ ok: false, error: { code: 'rejected', message: 'Origin denied', retryable: false } }, { status: 403 });
  const actor = await currentActor();
  if (!actor)
    return Response.json({ ok: false, error: { code: 'rejected', message: 'Authentication required', retryable: false } }, { status: 401 });
  try {
    const { missionId } = z.object({ missionId: z.uuid() }).parse(await params);
    const body = await request.text();
    if (body.length > 2048) throw new Error('Input too large');
    const result = await startShopifyAccountOAuth({ authUserId: actor.authUserId, missionId }, JSON.parse(body) as unknown);
    return Response.json(result, { status: result.ok ? 200 : 503, headers: { 'Cache-Control': 'private, no-store' } });
  } catch {
    return Response.json(
      { ok: false, error: { code: 'validation', message: 'Invalid Shopify install request', retryable: false } },
      { status: 422 },
    );
  }
}
