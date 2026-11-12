import { z } from 'zod';
import { isLocalSqliteBackend } from '../../../lib/local-backend';
import { after } from 'next/server';
import { readJsonBody } from '../../../lib/request-body';
import { executeFounderCommand } from '@lo/runtime';
import { currentActor, sameOrigin } from '../../../lib/auth';
import { flushOutbox } from '@lo/runtime/inngest';
import { prepareApprovedPayPalOrder } from '@lo/runtime/provider-tools';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json(
      { ok: false, error: { code: 'forbidden', message: 'Request origin is not allowed', retryable: false } },
      { status: 403 },
    );
  const actor = await currentActor();
  if (!actor)
    return Response.json({ ok: false, error: { code: 'forbidden', message: 'Sign in to continue', retryable: false } }, { status: 401 });
  try {
    const raw: unknown = await readJsonBody(request, 65536);
    if (isLocalSqliteBackend()) {
      const { executeLocalCommand } = await import('@lo/runtime/local');
      const result = await executeLocalCommand(actor.authUserId, raw);
      return Response.json(result, {
        status: result.ok ? 200 : result.error.code === 'conflict' ? 409 : result.error.code === 'unavailable' ? 503 : 400,
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }
    const result = await executeFounderCommand(actor.authUserId, raw);
    // The outbox is durable even when the local Inngest service is unavailable.
    const { missionId } = z.object({ missionId: z.uuid() }).parse(raw);
    if (result.paymentVersionId && result.commandId) {
      const payment = await prepareApprovedPayPalOrder(
        { authUserId: actor.authUserId, missionId },
        result.paymentVersionId,
        result.commandId,
      );
      if (!payment.ok)
        return Response.json(
          {
            ok: false,
            error: {
              code: 'unavailable',
              message: 'Your decision is saved. The payment approval page is unavailable; retry this request to continue.',
              retryable: true,
            },
          },
          { status: 503 },
        );
      const prepared = z.object({ approvalUrl: z.url() }).passthrough().parse(payment.value);
      return Response.json({ ...result, redirectUrl: prepared.approvalUrl });
    }
    after(async () => {
      try {
        await flushOutbox({ authUserId: actor.authUserId, missionId });
      } catch {
        console.warn('runtime_dispatch_pending', { missionId });
      }
    });
    return Response.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : '';
    const code =
      error instanceof z.ZodError
        ? 'validation'
        : message.includes('conflict')
          ? 'conflict'
          : message.includes('needs_approval')
            ? 'needs_approval'
            : message.includes('validation')
              ? 'validation'
              : 'unavailable';
    return Response.json(
      {
        ok: false,
        error: {
          code,
          message:
            code === 'unavailable'
              ? 'The command could not be committed. Refresh and retry with the same request.'
              : code === 'validation'
                ? 'The command does not match the required input.'
                : message,
          retryable: code === 'unavailable',
        },
      },
      { status: code === 'unavailable' ? 503 : 409 },
    );
  }
}
