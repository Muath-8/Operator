import { z } from 'zod';
import { launchRecordPdf } from '../../../../../lib/export-pdf';
import { currentActor } from '../../../../../lib/auth';
import { readSnapshot } from '../../../../../lib/snapshot';
import { buildLaunchRecord, launchRecordMarkdown, launchRecordArchive, withRole } from '@lo/runtime';
export async function GET(request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  const actor = await currentActor();
  if (!actor) return new Response('Authentication required', { status: 401 });
  try {
    const missionId = z.uuid().parse((await params).missionId);
    const format = z.enum(['json', 'markdown', 'pdf', 'zip']).parse(new URL(request.url).searchParams.get('format') ?? 'json');
    const record = buildLaunchRecord(await readSnapshot(actor.authUserId, missionId));
    const headers = {
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="launch-record-${missionId}.${format === 'markdown' ? 'md' : format}"`,
    };
    if (format === 'json')
      return new Response(JSON.stringify(record, null, 2), { headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' } });
    if (format === 'zip') {
      const assets = await withRole(
        'founder_role',
        { authUserId: actor.authUserId, missionId },
        async db =>
          (
            await db.query(
              'select id,mime_type,content_base64 from public.editable_assets where mission_id=$1 union all select id,mime_type,content_base64 from public.provider_assets where mission_id=$1',
              [missionId],
            )
          ).rows,
      );
      return new Response(new Uint8Array(launchRecordArchive(record, assets)), {
        headers: { ...headers, 'Content-Type': 'application/zip' },
      });
    }
    const markdown = launchRecordMarkdown(record);
    if (format === 'markdown') return new Response(markdown, { headers: { ...headers, 'Content-Type': 'text/markdown; charset=utf-8' } });
    return new Response(new Uint8Array(await launchRecordPdf(markdown)), { headers: { ...headers, 'Content-Type': 'application/pdf' } });
  } catch {
    return new Response('Record unavailable', { status: 404 });
  }
}
