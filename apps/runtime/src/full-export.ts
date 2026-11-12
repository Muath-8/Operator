import { archiveFile, type ArchiveFileReader } from './archive-files.js';
import { decryptWaitlistEmail } from './demand.js';
import { z } from 'zod';
import { JsonObjectSchema, type JsonValue } from '@lo/state';
import { withRole, type ActorScope } from './database.js';
import { loadKnowledge } from './knowledge.js';
import { redact } from './security.js';
const tableSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
export type ArchiveRecord = {
  kind: 'manifest' | 'row' | 'derived' | 'retained_content' | 'file_manifest' | 'file_chunk' | 'file_complete' | 'complete';
  table?: string;
  value: JsonValue;
};
/** A repeatable-read cursor streams the entire scoped ledger and inline base64
 * assets. The caller controls backpressure; cancellation rolls back and releases
 * the connection. Neither private credentials nor approval token hashes export. */
export async function writeMissionArchive(
  scope: ActorScope,
  emit: (record: ArchiveRecord) => Promise<void>,
  signal?: AbortSignal,
  fileReader?: ArchiveFileReader,
): Promise<void> {
  const missionId = z.uuid().parse(scope.missionId);
  const check = () => {
    if (signal?.aborted) throw new DOMException('Archive cancelled', 'AbortError');
  };
  await withRole(
    'founder_role',
    scope,
    async db => {
      const tables = z
        .array(tableSchema)
        .parse((await db.query('select public.mission_export_tables($1)names', [missionId])).rows[0]?.names);
      const mission = JsonObjectSchema.parse(
        JSON.parse(JSON.stringify((await db.query('select *from public.missions where id=$1', [missionId])).rows[0])),
      );
      const safe = (raw: unknown): JsonValue => {
        const scrub = (value: JsonValue): JsonValue =>
          typeof value === 'string'
            ? String(redact(value))
            : Array.isArray(value)
              ? value.map(scrub)
              : value && typeof value === 'object'
                ? Object.fromEntries(
                    Object.entries(value).map(([key, child]) => [
                      key,
                      /password|secret|api.?key|access.?token|refresh.?token|approval.?token|cookie|quote.?token|credential.?ref|^(?:twilio|openai|browserbase|paypal|shopify|resend|godaddy)_ref$|^token_hash$|^authorization$|^pat$|^encrypted_email$|^email_ciphertext$/i.test(
                        key,
                      )
                        ? '[REDACTED]'
                        : scrub(child),
                    ]),
                  )
                : value;
        return scrub(JSON.parse(JSON.stringify(raw)) as JsonValue);
      };
      check();
      await emit({
        kind: 'manifest',
        value: {
          schemaVersion: 1,
          format: 'launch-operator-mission-ndjson',
          missionId,
          exportedAt: new Date().toISOString(),
          sandboxMode: mission.sandbox_mode ?? true,
          includes: [
            'All mission-scoped public ledger rows',
            'Original messages and translations',
            'Asset bytes and private mission files as base64 with MIME type and SHA-256',
            'Available retained content under current privacy choices',
            'Versioned knowledge',
            'Consented signup email addresses',
          ],
          excludes: [
            'Provider credentials and secret references',
            'Approval token hashes',
            'Expired or opted-out raw retained content',
            'Signup encryption envelopes',
          ],
          consistency: 'PostgreSQL repeatable-read snapshot; private files must match snapshot ETag and size',
        },
      });
      await emit({ kind: 'row', table: 'missions', value: safe(mission) });
      let count = 1;
      for (const table of tables) {
        check();
        await db.query('declare mission_archive_cursor no scroll cursor for select public.mission_export_rows($1,$2) as row', [
          missionId,
          table,
        ]);
        try {
          while (true) {
            check();
            const batch = await db.query(
              table.endsWith('_assets') ? 'fetch forward 1 from mission_archive_cursor' : 'fetch forward 100 from mission_archive_cursor',
            );
            if (!batch.rowCount) break;
            for (const row of batch.rows) {
              check();
              let value = row.row;
              if (table === 'demand_signups') {
                const signup = JsonObjectSchema.parse(value),
                  page = (await db.query('select slug from public.demand_pages where mission_id=$1 and id=$2', [missionId, signup.page_id]))
                    .rows[0];
                if (!page || !signup.consent_at) throw new Error('validation: signup source or consent unavailable');
                value = { ...signup, email: decryptWaitlistEmail(z.string().parse(signup.email_ciphertext), z.string().parse(page.slug)) };
              }
              await emit({ kind: 'row', table, value: safe(value) });
              count++;
            }
          }
        } finally {
          await db.query('close mission_archive_cursor');
        }
      }
      for (const [table, query] of [
        ['counterparties', 'select c.*from public.counterparties c join public.missions m on m.founder_id=c.founder_id where m.id=$1'],
        [
          'founder_accounts',
          'select distinct a.id,a.founder_id,a.provider,a.status,a.scopes,a.created_at from public.founder_accounts a join public.missions m on m.founder_id=a.founder_id where m.id=$1',
        ],
      ] as const) {
        const rows = await db.query(query, [missionId]);
        for (const row of rows.rows) {
          check();
          await emit({ kind: 'row', table, value: safe(row) });
          count++;
        }
      }
      const knowledge = await loadKnowledge(db, JsonObjectSchema.parse(mission.metadata ?? {}));
      await emit({ kind: 'derived', table: 'knowledge', value: safe(knowledge) });
      const retained = await db.query('select id from public.retention_objects where mission_id=$1 order by created_at,id', [missionId]);
      for (const object of retained.rows) {
        check();
        const value = (await db.query('select public.read_retained_content($1,$2)payload', [missionId, object.id])).rows[0]?.payload;
        if (value !== null && value !== undefined)
          await emit({ kind: 'retained_content', value: { objectId: String(object.id), payload: safe(value) } });
      }
      const files = await db.query('select public.mission_export_files($1)file', [missionId]);
      if (files.rowCount && !fileReader) throw Error('Private storage reader is required for a complete archive');
      if (fileReader)
        for (const file of files.rows) {
          check();
          await archiveFile(missionId, file.file, fileReader, emit, signal);
        }
      check();
      await emit({ kind: 'complete', value: { missionId, ledgerRows: count, completedAt: new Date().toISOString() } });
    },
    undefined,
    'snapshot',
    signal,
  );
}
/** Stream only after the route verifies founder ownership, so a denied mission
 * produces an HTTP error rather than a partial download. */
export function missionArchiveStream(
  scope: ActorScope,
  requestSignal?: AbortSignal,
  fileReader?: ArchiveFileReader,
): ReadableStream<Uint8Array> {
  const cancellation = new AbortController(),
    encoder = new TextEncoder();
  let resume: (() => void) | undefined;
  let stopped = false;
  const cancel = () => {
    stopped = true;
    cancellation.abort();
    resume?.();
    resume = undefined;
  };
  requestSignal?.addEventListener('abort', cancel, { once: true });
  if (requestSignal?.aborted) cancel();
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const emit = async (record: ArchiveRecord) => {
          while (!stopped && (controller.desiredSize ?? 0) <= 0)
            await new Promise<void>(resolve => {
              resume = resolve;
            });
          if (stopped) throw new DOMException('Archive cancelled', 'AbortError');
          controller.enqueue(encoder.encode(JSON.stringify(record) + '\n'));
        };
        void writeMissionArchive(scope, emit, cancellation.signal, fileReader)
          .then(() => {
            if (!stopped) controller.close();
          })
          .catch(() => {
            if (!stopped) controller.error(new Error('Mission archive interrupted; no complete record was emitted.'));
          })
          .finally(() => requestSignal?.removeEventListener('abort', cancel));
      },
      pull() {
        resume?.();
        resume = undefined;
      },
      cancel() {
        cancel();
      },
    },
    { highWaterMark: 1 },
  );
}
