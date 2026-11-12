import { z } from 'zod';
import { withRole, validateEditableSvg } from '@lo/runtime';
import { currentActor } from '../../../../../../lib/auth';

export async function GET(_request: Request, { params }: { params: Promise<{ missionId: string; assetId: string }> }): Promise<Response> {
  const actor = await currentActor();
  if (!actor) return new Response('Authentication required', { status: 401 });
  try {
    const input = z.object({ missionId: z.uuid(), assetId: z.uuid() }).parse(await params);
    const asset = await withRole(
      'founder_role',
      { authUserId: actor.authUserId, missionId: input.missionId },
      async db =>
        (
          await db.query(
            'select mime_type,content_base64 from public.provider_assets where mission_id=$1 and id=$2 union all select mime_type,content_base64 from public.editable_assets where mission_id=$1 and id=$2',
            [input.missionId, input.assetId],
          )
        ).rows[0],
    );
    if (!asset) return new Response('Asset not found', { status: 404 });
    const parsed = z
      .object({ mime_type: z.enum(['image/png', 'image/jpeg', 'image/svg+xml']), content_base64: z.string().max(28_000_000) })
      .parse(asset);
    const data = Buffer.from(parsed.content_base64, 'base64');
    const valid =
      parsed.mime_type === 'image/svg+xml'
        ? !!validateEditableSvg(data.toString('utf8'))
        : parsed.mime_type === 'image/png'
          ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
          : data.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    if (!valid) return new Response('Invalid image artifact', { status: 422 });
    return new Response(data, {
      headers: {
        'Content-Type': parsed.mime_type,
        'Content-Length': String(data.length),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'; sandbox; frame-ancestors 'none'",
        ...(parsed.mime_type === 'image/svg+xml' ? { 'Content-Disposition': `attachment; filename="${input.assetId}.svg"` } : {}),
      },
    });
  } catch {
    return new Response('Asset unavailable', { status: 404 });
  }
}
