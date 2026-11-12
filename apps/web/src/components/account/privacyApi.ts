import { z } from 'zod';
import { sessionFetch } from '../../lib/session-client';

/** Strict metadata boundary: raw retained bodies never enter component state. */
const PrivacySchema = z
  .object({
    traceRetentionEnabled: z.boolean(),
    externalTraceExportConfigured: z.boolean(),
    retentionDays: z.literal(90),
    objects: z.array(
      z
        .object({
          id: z.uuid(),
          kind: z.enum(['recording', 'transcript', 'trace']),
          sourceReference: z.string(),
          createdAt: z.iso.datetime(),
          expiresAt: z.iso.datetime(),
          kept: z.boolean(),
          available: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type MissionPrivacy = z.infer<typeof PrivacySchema>;
export async function fetchPrivacy(missionId: string, signal: AbortSignal): Promise<MissionPrivacy> {
  const response = await sessionFetch(`/api/missions/${encodeURIComponent(missionId)}/privacy`, { cache: 'no-store', signal });
  if (!response.ok) throw new Error('Privacy unavailable');
  return PrivacySchema.parse(await response.json());
}
