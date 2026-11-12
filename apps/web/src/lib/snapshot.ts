import { z } from 'zod';
import { isLocalSqliteBackend } from './local-backend';
import { JsonObjectSchema, type JsonValue } from '@lo/state';
import { ledgerVersion, withRole, loadKnowledge } from '@lo/runtime';

export type Row = Record<string, JsonValue>;
export function rows(snapshot: Row, key: string): Row[] {
  return z.array(JsonObjectSchema).parse(snapshot[key] ?? []);
}
export function str(row: Row, key: string, fallback = ''): string {
  return typeof row[key] === 'string' ? row[key] : fallback;
}
export function num(row: Row, key: string, fallback = 0): number {
  const n = Number(row[key]);
  return Number.isFinite(n) ? n : fallback;
}
export function obj(row: Row, key: string): Row {
  return JsonObjectSchema.parse(row[key] ?? {});
}
export function latest(values: Row[]): Row | undefined {
  return [...values].sort(
    (a, b) => str(b, 'created_at').localeCompare(str(a, 'created_at')) || str(b, 'id').localeCompare(str(a, 'id')),
  )[0];
}
export async function readSnapshot(authUserId: string, missionId: string): Promise<Row> {
  if (isLocalSqliteBackend()) {
    const { readLocalSnapshot } = await import('@lo/runtime/local');
    return JsonObjectSchema.parse(await readLocalSnapshot(authUserId, missionId));
  }
  return withRole(
    'founder_role',
    { authUserId, missionId },
    async db => {
      const result = await db.query('select public.mission_snapshot($1::uuid) as value', [missionId]);
      const snapshot = JsonObjectSchema.parse(result.rows[0]?.value);
      snapshot['knowledge'] = JSON.parse(JSON.stringify(await loadKnowledge(db, obj(obj(snapshot, 'mission'), 'metadata')))) as JsonValue;
      for (const table of [
        'command_requests',
        'mission_questions',
        'question_answers',
        'inspection_commitments',
        'financial_plans',
        'cost_estimates',
        'cost_acceptances',
        'mission_obstacles',
        'obstacle_resolutions',
        'readiness_observations',
        'commitment_chases',
        'commitment_chase_attempts',
        'commitment_chase_results',
        'commitment_chase_escalations',
        'payment_authorizations',
        'authorization_obligations',
        'authorization_followups',
        'refund_claims',
        'voice_confirmation_obligations',
        'voice_confirmation_drafts',
        'decision_moments',
        'decision_moment_items',
        'glossary_first_uses',
        'generated_launch_records',
        'command_results',
        'notification_events',
        'founder_preferences',
        'run_results',
        'run_progress',
        'runtime_ticks',
        'sourcing_campaigns',
        'sourcing_campaign_recipients',
        'sourcing_campaign_deliveries',
        'sourcing_campaign_holds',
        'sourcing_campaign_shortlists',
        'sourcing_campaign_samples',
        'sourcing_campaign_proformas',
        'sourcing_campaign_inspections',
        'optional_step_choices',
        'registrar_quotes',
        'domain_registrations',
        'professional_proposals',
        'professional_engagements',
        'professional_starts',
        'professional_deliveries',
        'professional_confirmations',
        'professional_payments',
        'professional_holds',

        'provider_receipts',
        'effect_authorizations',
        'mission_transitions',
      ]) {
        const extra = await db.query(`select * from public.${table} where mission_id=$1 order by created_at,id`, [missionId]);
        // pg Date objects are normalized at this serialization boundary.
        snapshot[table] = JsonObjectSchema.array().parse(JSON.parse(JSON.stringify(extra.rows)));
      }
      const parties = await db.query(
        'select c.*from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=$1',
        [missionId],
      );
      snapshot['counterparties'] = JsonObjectSchema.array().parse(JSON.parse(JSON.stringify(parties.rows)));
      const accounts = await db.query(
        'select a.id,a.provider,a.status,a.scopes,a.created_at from public.founder_accounts a join public.missions m on m.founder_id=a.founder_id where m.id=$1',
        [missionId],
      );
      snapshot['founder_accounts'] = JsonObjectSchema.array().parse(JSON.parse(JSON.stringify(accounts.rows)));
      snapshot['glossary_terms'] = JSON.parse(
        JSON.stringify((await db.query('select *from public.glossary_terms order by id')).rows),
      ) as JsonValue;
      snapshot['mandate_usage'] = JSON.parse(
        JSON.stringify(
          (await db.query('select id as mandate_id,public.mandate_usage($1,id)usage from public.mandates where mission_id=$1', [missionId]))
            .rows,
        ),
      ) as JsonValue;
      snapshot['ledger_version'] = await ledgerVersion(db, missionId);
      snapshot['engagement'] = JsonObjectSchema.parse(
        (await db.query('select public.mission_engagement($1)value', [missionId])).rows[0]?.value,
      );
      snapshot['current_financial_plan'] = (await db.query('select public.current_financial_plan($1)id', [missionId])).rows[0]?.id ?? null;
      return snapshot;
    },
    undefined,
    'snapshot',
  );
}
export async function listMissionIds(authUserId: string): Promise<string[]> {
  if (isLocalSqliteBackend()) {
    const { listLocalMissionIds } = await import('@lo/runtime/local');
    return z.array(z.uuid()).parse(await listLocalMissionIds(authUserId));
  }
  return withRole('founder_role', { authUserId }, async db => {
    const result = await db.query('select id from public.missions order by created_at,id');
    return z
      .array(z.object({ id: z.uuid() }))
      .parse(result.rows)
      .map(row => row.id);
  });
}
