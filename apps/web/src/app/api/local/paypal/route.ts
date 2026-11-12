import { z } from 'zod';
import { currentActor, sameOrigin } from '../../../../lib/auth';
import { isLocalSqliteBackend } from '../../../../lib/local-backend';
import { readJsonBody } from '../../../../lib/request-body';
import { localPayPalStatus, createLocalPayPalOrder, captureLocalPayPalOrder } from '@lo/runtime/local-paypal';

export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'private, no-store' };
const Input = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), requestId: z.uuid() }).strict(),
  z.object({ action: z.literal('capture'), orderId: z.string().regex(/^[A-Za-z0-9-]{1,64}$/) }).strict(),
]);
export async function GET(): Promise<Response> {
  if (!isLocalSqliteBackend()) return new Response('Not found', { status: 404 });
  if (!(await currentActor())) return new Response('Sign in to continue', { status: 401 });
  return Response.json({ ...localPayPalStatus(), sandbox: true, amount: '1.00', currency: 'USD' }, { headers });
}
export async function POST(request: Request): Promise<Response> {
  if (!isLocalSqliteBackend()) return new Response('Not found', { status: 404 });
  if (!sameOrigin(request)) return new Response('Origin denied', { status: 403 });
  const actor = await currentActor();
  if (!actor) return new Response('Sign in to continue', { status: 401 });
  try {
    const input = Input.parse(await readJsonBody(request, 4096));
    const result =
      input.action === 'create'
        ? await createLocalPayPalOrder(actor.authUserId, input.requestId)
        : await captureLocalPayPalOrder(actor.authUserId, input.orderId);
    return Response.json({ ok: true, sandbox: true, ...result }, { headers });
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error:
          error instanceof z.ZodError
            ? 'Invalid checkout request.'
            : 'Sandbox checkout could not be confirmed. Check the local server configuration and retry the same request. No successful payment is claimed.',
      },
      { status: error instanceof z.ZodError ? 400 : 503, headers },
    );
  }
}
