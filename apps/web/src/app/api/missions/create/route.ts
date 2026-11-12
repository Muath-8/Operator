import { z } from 'zod';
import { isLocalSqliteBackend } from '../../../../lib/local-backend';
import { after } from 'next/server';
import { readJsonBody } from '../../../../lib/request-body';
import { environment, ledgerVersion, withRole } from '@lo/runtime';
import { currentActor, sameOrigin } from '../../../../lib/auth';
import { flushOutbox } from '@lo/runtime/inngest';
export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request))
    return Response.json({ ok: false, error: { code: 'forbidden', message: 'Origin denied', retryable: false } }, { status: 403 });
  const actor = await currentActor();
  if (!actor)
    return Response.json(
      { ok: false, error: { code: 'forbidden', message: 'Sign in to start a mission', retryable: false } },
      { status: 401 },
    );
  try {
    const input = z
      .object({ kind: z.literal('createMission'), idempotencyKey: z.string().min(16).max(256) })
      .strict()
      .parse(await readJsonBody(request, 4096));
    if (isLocalSqliteBackend()) {
      const { createLocalMission } = await import('@lo/runtime/local');
      return Response.json(
        { ok: true, ...(await createLocalMission(actor.authUserId, input)) },
        { headers: { 'Cache-Control': 'private, no-store' } },
      );
    }
    const created = await withRole('founder_role', { authUserId: actor.authUserId }, async db => {
      const result = await db.query('select public.start_mission($1,$2) as id', [
        input.idempotencyKey,
        environment().LO_EXECUTION_MODE !== 'production',
      ]);
      const missionId = z.uuid().parse(result.rows[0]?.id);
      return { ok: true as const, missionId, ledgerVersion: await ledgerVersion(db, missionId) };
    });
    after(async () => {
      try {
        await flushOutbox({ authUserId: actor.authUserId, missionId: created.missionId });
      } catch {
        console.warn('runtime_dispatch_pending', { missionId: created.missionId });
      }
    });
    return Response.json(created);
  } catch (error) {
    return Response.json(
      {
        ok: false,
        error: {
          code: error instanceof z.ZodError ? 'validation' : 'unavailable',
          message: 'Mission creation could not be committed. Retry the same request.',
          retryable: !(error instanceof z.ZodError),
        },
      },
      { status: 503 },
    );
  }
}
