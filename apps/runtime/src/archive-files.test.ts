import { createServer } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { archiveFile, authenticatedArchiveFileReader, type ArchiveFile } from './archive-files.js';
import type { ArchiveRecord } from './full-export.js';
const mission = randomUUID();
function file(size = 3): ArchiveFile {
  return {
    id: randomUUID(),
    name: mission + '/folder/ملف.bin',
    metadata: { size, eTag: 'abc123', mimetype: 'application/octet-stream' },
    version: '1',
  };
}
describe('private mission archive bytes', () => {
  it('fetches authenticated scoped bytes through actual HTTP with ETag and bounded chunks', async () => {
    const bytes = Buffer.alloc(150000, 91),
      source = file(bytes.length);
    let calls = 0;
    const server = createServer((request, response) => {
      calls++;
      expect(request.url).toBe(
        '/storage/v1/object/authenticated/mission-files/' + source.name.split('/').map(encodeURIComponent).join('/'),
      );
      expect(request.headers.authorization).toBe('Bearer synthetic-token');
      expect(request.headers.apikey).toBe('synthetic-anon');
      expect(request.headers['if-match']).toBe('"abc123"');
      response.writeHead(200, { etag: '"abc123"', 'content-length': bytes.length });
      response.end(bytes);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw Error('Missing local listener');
    try {
      const records: ArchiveRecord[] = [];
      await archiveFile(
        mission,
        source,
        authenticatedArchiveFileReader({
          origin: `http://127.0.0.1:${address.port}`,
          anonKey: 'synthetic-anon',
          token: 'synthetic-token',
          missionId: mission,
        }),
        async record => {
          records.push(record);
        },
      );
      const chunks = records.filter(r => r.kind === 'file_chunk').map(r => Buffer.from((r.value as { data: string }).data, 'base64'));
      expect(Buffer.concat(chunks)).toEqual(bytes);
      expect(chunks.every(c => c.length <= 65536)).toBe(true);
      expect(records.at(-1)).toMatchObject({
        kind: 'file_complete',
        value: { bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      });
      expect(calls).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve())));
    }
  });
  it.each(['../outside', '%2e%2e/secret', 'folder\\outside'])('rejects invalid scoped name %s before transport', async path => {
    let calls = 0;
    const source = file();
    source.name = path.startsWith('../') ? path : mission + '/' + path;
    await expect(
      archiveFile(
        mission,
        source,
        async () => {
          calls++;
          return new Response('abc');
        },
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(calls).toBe(0);
  });
  it('rejects another mission before transport', async () => {
    await expect(
      archiveFile(
        randomUUID(),
        file(),
        async () => {
          throw Error('Transport should not run');
        },
        async () => undefined,
      ),
    ).rejects.toThrow(/scope/);
  });
  it.each([
    { etag: '"changed"', body: 'abc' },
    { etag: '"abc123"', body: 'ab' },
    { etag: '"abc123"', body: 'abcd' },
  ])('never completes changed or truncated bytes %j', async value => {
    const records: ArchiveRecord[] = [];
    await expect(
      archiveFile(
        mission,
        file(),
        async () => new Response(value.body, { headers: { etag: value.etag } }),
        async row => {
          records.push(row);
        },
      ),
    ).rejects.toThrow();
    expect(records.some(r => r.kind === 'file_complete')).toBe(false);
  });
  it('cancels a stalled body read', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const source = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const run = archiveFile(
      mission,
      file(),
      async () => new Response(source, { headers: { etag: '"abc123"' } }),
      async () => {
        setTimeout(() => controller.abort(), 10);
      },
      controller.signal,
    );
    await expect(run).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
});
