import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { ArchiveRecord } from './full-export.js';

export const ArchiveFileSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  metadata: z
    .object({
      eTag: z.string().optional(),
      etag: z.string().optional(),
      size: z.number().int().nonnegative().safe(),
      mimetype: z.string().optional(),
    })
    .passthrough(),
  version: z.string().nullable().optional(),
});
export type ArchiveFile = z.infer<typeof ArchiveFileSchema>;
export type ArchiveFileReader = (file: ArchiveFile, signal?: AbortSignal) => Promise<Response>;
function scopedPath(missionId: string, name: string): string {
  const parts = name.split('/');
  if (
    parts[0] !== z.uuid().parse(missionId) ||
    parts.length < 2 ||
    parts.some(part => !part || part === '.' || part === '..' || /[\\\u0000-\u001f\u007f%]/.test(part))
  )
    throw Error('validation: archive file path is outside mission scope');
  return parts.map(encodeURIComponent).join('/');
}
function etag(file: ArchiveFile): string {
  const tag = file.metadata.eTag ?? file.metadata.etag;
  if (!tag || !/^"?[a-zA-Z0-9_-]+"?$/.test(tag)) throw Error('validation: immutable storage ETag is required');
  return tag.startsWith('"') ? tag : `"${tag}"`;
}
/** Uses only the caller's verified founder JWT; no service key or signed URL.
 * Object versions must still match the database snapshot. Redirects cannot leak
 * the session token to another origin. */
export function authenticatedArchiveFileReader(config: {
  origin: string;
  anonKey: string;
  token: string;
  missionId: string;
}): ArchiveFileReader {
  const origin = new URL(config.origin);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
  )
    throw Error('validation: storage origin unavailable');
  return async (file, signal) =>
    fetch(new URL('/storage/v1/object/authenticated/mission-files/' + scopedPath(config.missionId, file.name), origin), {
      headers: { authorization: `Bearer ${config.token}`, apikey: config.anonKey, 'if-match': etag(file), 'accept-encoding': 'identity' },
      redirect: 'error',
      cache: 'no-store',
      signal,
    });
}
export async function archiveFile(
  missionId: string,
  raw: unknown,
  reader: ArchiveFileReader,
  emit: (record: ArchiveRecord) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const file = ArchiveFileSchema.parse(raw);
  scopedPath(missionId, file.name);
  const expectedTag = etag(file);
  signal?.throwIfAborted();
  const response = await reader(file, signal);
  const actualTag = response.headers.get('etag');
  const length = response.headers.get('content-length'),
    encoding = response.headers.get('content-encoding');
  if (
    !response.ok ||
    !response.body ||
    actualTag !== expectedTag ||
    (length !== null && Number(length) !== file.metadata.size) ||
    (encoding !== null && encoding !== 'identity')
  ) {
    await response.body?.cancel();
    throw Error('Archive file unavailable or changed since snapshot');
  }
  const stream = response.body.getReader(),
    hash = createHash('sha256');
  let total = 0,
    index = 0;
  const abort = () => {
    void stream.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await emit({
      kind: 'file_manifest',
      value: {
        id: file.id,
        bucket: 'mission-files',
        name: file.name,
        size: file.metadata.size,
        mimeType: file.metadata.mimetype ?? 'application/octet-stream',
        etag: expectedTag,
        version: file.version ?? null,
        encoding: 'base64-chunks',
      },
    });
    for (;;) {
      signal?.throwIfAborted();
      const next = await stream.read();
      signal?.throwIfAborted();
      if (next.done) break;
      for (let offset = 0; offset < next.value.length; offset += 65536) {
        signal?.throwIfAborted();
        const chunk = next.value.subarray(offset, offset + 65536);
        total += chunk.byteLength;
        if (total > file.metadata.size) throw Error('Archive file exceeds snapshot size');
        hash.update(chunk);
        await emit({ kind: 'file_chunk', value: { id: file.id, index: index++, data: Buffer.from(chunk).toString('base64') } });
      }
    }
    if (total !== file.metadata.size) throw Error('Archive file was truncated');
    await emit({ kind: 'file_complete', value: { id: file.id, bytes: total, chunks: index, sha256: hash.digest('hex') } });
  } finally {
    signal?.removeEventListener('abort', abort);
    await stream.cancel();
    stream.releaseLock();
  }
}
