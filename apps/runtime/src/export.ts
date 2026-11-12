import { JsonObjectSchema, type JsonValue } from '@lo/state';
import { redact } from './security.js';
import { zipSync, strToU8, type Zippable } from 'fflate';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { validateEditableSvg } from './editable-assets.js';
const exportTables = [
  'mission',
  'status',
  'engagement',
  'founder_accounts',
  'decisions',
  'decision_resolutions',
  'decision_supersessions',
  'artifacts',
  'artifact_versions',
  'artifact_statuses',
  'evidence',
  'commitments',
  'inspection_commitments',
  'commitment_states',
  'money_ledger',
  'decision_moments',
  'decision_moment_items',
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
  'marketplace_thread_bindings',
  'sourcing_campaigns',
  'sourcing_campaign_recipients',
  'sourcing_campaign_deliveries',
  'sourcing_campaign_holds',
  'sourcing_campaign_shortlists',
  'sourcing_campaign_samples',
  'sourcing_campaign_proformas',
  'sourcing_campaign_inspections',
  'authorization_followups',
  'refund_claims',
  'voice_confirmation_obligations',
  'voice_confirmation_drafts',
  'generated_launch_records',
  'current_financial_plan',
  'payments',
  'payment_states',
  'activity',
  'dependencies',
  'stale_marks',
  'mandates',
  'mandate_revocations',
  'readiness',
] as const;
export function buildLaunchRecord(snapshot: Record<string, JsonValue>): Record<string, JsonValue> {
  const record: Record<string, JsonValue> = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    warning: 'A ledger export records what is known. It does not certify launch readiness or legal compliance.',
  };
  for (const table of exportTables) if (snapshot[table] !== undefined) record[table] = snapshot[table];
  const mission = JsonObjectSchema.parse(snapshot.mission);
  record.ownership = { ownerFounderId: mission.founder_id ?? null, externalAccountsRemainFounderOwned: true };
  // Raw messages, provider credentials, personal contact fields and approval
  // tokens are deliberately absent from the business Launch Record.
  return JsonObjectSchema.parse(redact(record));
}
export function launchRecordMarkdown(record: Record<string, JsonValue>): string {
  const sections = ['# Launch Record', '', `Exported: ${String(record.exportedAt)}`, '', String(record.warning), ''];
  for (const key of exportTables)
    if (record[key] !== undefined)
      sections.push(`## ${key.replaceAll('_', ' ')}`, '', '```json', JSON.stringify(record[key], null, 2), '```', '');
  return sections.join('\n');
}
export function launchRecordArchive(record: Record<string, JsonValue>, assets: unknown): Uint8Array {
  const rows = z
    .array(
      z.object({
        id: z.uuid(),
        mime_type: z.enum(['image/svg+xml', 'image/png', 'image/jpeg']),
        content_base64: z.string().max(28_000_000),
      }),
    )
    .parse(assets);
  const files: Zippable = {
    'Launch Record.json': strToU8(JSON.stringify(record, null, 2)),
    'Launch Record.md': strToU8(launchRecordMarkdown(record)),
  };
  const manifest = [];
  const identities = new Map<string, string>();
  let bytes = 0;
  for (const asset of rows) {
    const data = Buffer.from(asset.content_base64, 'base64');
    const digest = createHash('sha256').update(data).digest('hex'),
      identity = `${asset.mime_type}:${digest}`;
    const prior = identities.get(asset.id);
    if (prior) {
      if (prior !== identity) throw new Error('validation: conflicting asset identity in archive');
      continue;
    }
    identities.set(asset.id, identity);
    bytes += data.length;
    if (bytes > 100_000_000) throw new Error('validation: asset archive exceeds bounded export size; download sources individually');
    if (asset.mime_type === 'image/svg+xml') validateEditableSvg(data.toString('utf8'));
    else if (
      asset.mime_type === 'image/png'
        ? !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : !data.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    )
      throw new Error('validation: invalid image source');
    const path = `assets/${asset.id}.${asset.mime_type === 'image/svg+xml' ? 'svg' : asset.mime_type === 'image/png' ? 'png' : 'jpg'}`;
    files[path] = [data, { level: asset.mime_type === 'image/svg+xml' ? 6 : 0 }];
    manifest.push({ id: asset.id, path, mimeType: asset.mime_type, sha256: createHash('sha256').update(data).digest('hex') });
  }
  files['assets/manifest.json'] = strToU8(JSON.stringify(manifest, null, 2));
  return zipSync(files, { level: 6 });
}
