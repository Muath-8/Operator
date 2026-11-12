import { isLocalSqliteBackend } from '../../lib/local-backend';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { environment } from '@lo/runtime';
import { currentActor } from '../../lib/auth';
import { listMissionIds, readSnapshot } from '../../lib/snapshot';
import { projectMission, projectMissionSummary, parseTarget } from '../../lib/projection';
import { WorkspaceClient } from '../../lib/WorkspaceClient';
export const dynamic = 'force-dynamic';
export default async function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const actor = await currentActor();
  if (!actor) redirect('/login');
  const ids = await listMissionIds(actor.authUserId);
  if (!ids.length) redirect('/onboarding');
  const params = await searchParams;
  const requested = z.uuid().safeParse(params.mission);
  const missionId = requested.success && ids.includes(requested.data) ? requested.data : ids[0];
  if (!missionId) redirect('/onboarding');
  const views = await Promise.all(ids.map(async id => projectMission(await readSnapshot(actor.authUserId, id))));
  const view = views.find(item => item.missionId === missionId);
  if (!view) throw new Error('Mission snapshot unavailable');
  const env = environment();
  const jar = await cookies();
  let initialTarget = null;
  try {
    if (typeof params.target === 'string' && params.target.length < 2000) initialTarget = parseTarget(JSON.parse(params.target));
  } catch {
    /* Ignore malformed deep links; mission authorization still applies. */
  }
  return (
    <WorkspaceClient
      initialView={view}
      initialTarget={initialTarget}
      initialTheme={jar.get('lo-theme')?.value === 'dark' ? 'dark' : 'light'}
      initialLanguage={jar.get('lo-lang')?.value === 'ar' ? 'ar' : 'en'}
      initialMissions={views.map(projectMissionSummary)}
      local={actor.local}
      localBackend={isLocalSqliteBackend() ? 'sqlite' : undefined}
      localAi={env.LO_LOCAL_AI}
      supabaseUrl={env.SUPABASE_URL}
      supabaseAnonKey={env.SUPABASE_ANON_KEY}
    />
  );
}
