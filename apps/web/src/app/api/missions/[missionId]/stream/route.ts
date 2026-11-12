import { z } from 'zod';
import { readMessageDrafts } from '@lo/runtime';
import { currentActor } from '../../../../../lib/auth';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
/** Short-lived authenticated SSE. Each packet replaces ephemeral drafts, so a
 * reconnect cannot duplicate words. Final messages arrive through ledger sync. */
export async function GET(request: Request, context: { params: Promise<{ missionId: string }> }) {
  const actor = await currentActor();
  if (!actor) return Response.json({ error: 'Authentication required' }, { status: 401 });
  const mission = z.uuid().safeParse((await context.params).missionId);
  if (!mission.success) return Response.json({ error: 'Invalid mission identifier' }, { status: 400 });
  const scope = { authUserId: actor.authUserId, missionId: mission.data };
  let initial;
  try {
    initial = await readMessageDrafts(scope);
  } catch {
    return Response.json({ error: 'Mission unavailable' }, { status: 404 });
  }
  const encoder = new TextEncoder(),
    started = Date.now();
  let stopped = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let previous = '';
      let data = initial;
      try {
        while (!stopped && !request.signal.aborted && Date.now() - started < 25000) {
          const json = JSON.stringify({ missionId: mission.data, drafts: data });
          if (json !== previous) {
            controller.enqueue(encoder.encode(`data: ${json}\n\n`));
            previous = json;
          }
          await new Promise<void>(resolve => {
            const done = () => {
              clearTimeout(timer);
              request.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = setTimeout(done, 300);
            request.signal.addEventListener('abort', done, { once: true });
          });
          if (stopped || request.signal.aborted) break;
          data = await readMessageDrafts(scope);
        }
      } catch {
        if (!stopped && !request.signal.aborted) controller.enqueue(encoder.encode('event: unavailable\ndata: {}\n\n'));
      } finally {
        if (!stopped) controller.close();
      }
    },
    cancel() {
      stopped = true;
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'private, no-store, no-transform', 'X-Accel-Buffering': 'no' },
  });
}
