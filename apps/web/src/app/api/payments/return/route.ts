import { z } from 'zod';
import { currentActor } from '../../../../lib/auth';
import { captureApprovedPayPalOrder } from '@lo/runtime/provider-tools';
import { flushOutbox } from '@lo/runtime/inngest';
import { environment } from '@lo/runtime';
export async function GET(request: Request): Promise<Response> {
  const actor = await currentActor();
  if (!actor) return Response.redirect(new URL('/login', environment().APP_ORIGIN));
  const query = new URL(request.url).searchParams;
  const parsed = z
    .object({ mission: z.uuid(), token: z.string().regex(/^[A-Za-z0-9-]{5,100}$/) })
    .safeParse({ mission: query.get('mission'), token: query.get('token') });
  if (!parsed.success) return new Response('Invalid payment return', { status: 400 });
  const scope = { authUserId: actor.authUserId, missionId: parsed.data.mission };
  const result = await captureApprovedPayPalOrder(scope, parsed.data.token);
  try {
    await flushOutbox(scope);
  } catch {
    console.warn('runtime_dispatch_pending', { missionId: scope.missionId });
  }
  const destination = new URL('/', environment().APP_ORIGIN);
  destination.searchParams.set('mission', scope.missionId);
  destination.searchParams.set('payment', result.ok ? 'verified' : 'pending');
  return Response.redirect(destination, 303);
}
