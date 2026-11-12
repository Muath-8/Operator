import { z } from 'zod';
import { withRole, type ActorScope } from './database.js';

export const MissionPrivacySchema = z
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
/** Metadata only; raw recordings, transcripts and traces never enter the general
 * mission projection or a model context through this founder-only endpoint. */
export async function readMissionPrivacy(scope: ActorScope) {
  return withRole('founder_role', scope, async db => {
    const enabled = (await db.query('select public.trace_export_allowed($1)enabled', [scope.missionId])).rows[0]?.enabled;
    const objects = await db.query(
      `select o.id,o.kind,o.source_reference as "sourceReference",o.created_at as "createdAt",o.expires_at as "expiresAt",
   coalesce((select c.keep from public.retention_choices c where c.object_id=o.id order by c.created_at desc,c.id desc limit 1),false)kept,
   public.read_retained_content($1,o.id)is not null as available
   from public.retention_objects o where o.mission_id=$1 order by o.created_at desc,o.id`,
      [scope.missionId],
    );
    return MissionPrivacySchema.parse({
      traceRetentionEnabled: enabled,
      externalTraceExportConfigured: process.env.OPENAI_TRACE_EXPORT_ENABLED === 'true',
      retentionDays: 90,
      objects: JSON.parse(JSON.stringify(objects.rows)),
    });
  });
}
