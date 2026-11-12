import { z } from 'zod';
import { cookies } from 'next/headers';
import { createClient } from '@supabase/supabase-js';
import { environment, withRole } from '@lo/runtime';
import { currentActor, sameOrigin } from '../../../../../lib/auth';
import { readSnapshot, rows, str } from '../../../../../lib/snapshot';
export async function GET(_request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  const actor = await currentActor();
  if (!actor) return new Response('Authentication required', { status: 401 });
  try {
    const snapshot = await readSnapshot(actor.authUserId, z.uuid().parse((await params).missionId));
    return Response.json(
      {
        retainedAccounts: rows(snapshot, 'founder_accounts').map(a => ({
          id: str(a, 'id'),
          label: str(a, 'provider'),
          detail: 'Founder-owned external account; revoking access does not close it.',
        })),
        retainedExternalAssets: rows(snapshot, 'provider_receipts')
          .filter(e => ['marketing_publish', 'store_publish', 'store_publish_policy'].includes(str(e, 'operation')))
          .map(e => ({
            id: str(e, 'id'),
            label: str(e, 'operation'),
            detail: `${str(e, 'provider')}: ${str(e, 'provider_reference')}. This published asset remains with its provider.`,
          })),
        notice: 'External accounts, domains, stores and supplier assets remain yours. Mission records and private files will be removed.',
      },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return new Response('Mission not found', { status: 404 });
  }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ missionId: string }> }): Promise<Response> {
  if (!sameOrigin(request)) return new Response('Origin denied', { status: 403 });
  const actor = await currentActor();
  if (!actor) return new Response('Authentication required', { status: 401 });
  try {
    const missionId = z.uuid().parse((await params).missionId);
    z.object({ confirm: z.literal(true), understandExternalAssetsRemain: z.literal(true) })
      .strict()
      .parse(await request.json());
    const scope = { authUserId: actor.authUserId, missionId };
    const deletionId = await withRole('founder_role', scope, async db =>
      z.uuid().parse((await db.query('select public.request_mission_deletion($1) as id', [missionId])).rows[0]?.id),
    );
    const env = environment();
    if (!actor.local) {
      if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) throw new Error('Storage configuration required');
      const token = (await cookies()).get('lo-session')?.value;
      if (!token) throw new Error('Session required');
      const client = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
        global: { headers: { Authorization: `Bearer ${token}` } },
        auth: { persistSession: false },
      });
      const paths: string[] = [];
      const collect = async (prefix: string): Promise<void> => {
        let offset = 0;
        for (;;) {
          const { data, error } = await client.storage.from('mission-files').list(prefix, { limit: 100, offset });
          if (error) throw error;
          for (const object of data) {
            const path = `${prefix}/${object.name}`;
            if (object.id) paths.push(path);
            else await collect(path);
          }
          if (data.length < 100) break;
          offset += 100;
        }
      };
      await collect(missionId);
      for (let index = 0; index < paths.length; index += 100) {
        const { error } = await client.storage.from('mission-files').remove(paths.slice(index, index + 100));
        if (error) throw error;
      }
    }
    const receiptId = await withRole('founder_role', scope, async db =>
      z.uuid().parse((await db.query('select public.erase_mission($1,$2) as id', [missionId, deletionId])).rows[0]?.id),
    );
    return Response.json({ ok: true, receiptId, externalAccountsRetained: true });
  } catch {
    return Response.json(
      { ok: false, error: 'Deletion has not completed. Refresh the mission to check its current state before retrying.' },
      { status: 409 },
    );
  }
}
