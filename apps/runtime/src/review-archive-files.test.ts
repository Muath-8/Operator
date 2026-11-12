import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { archiveFile } from './archive-files.js';
describe('independent archive resource failure', () => {
  it('cancels the already-open storage body if downstream manifest writing fails', async () => {
    const mission = randomUUID();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      archiveFile(
        mission,
        { id: randomUUID(), name: `${mission}/synthetic.bin`, metadata: { size: 3, eTag: 'explicit-test' } },
        async () => new Response(body, { headers: { etag: '"explicit-test"' } }),
        async () => {
          throw new Error('Explicit synthetic writer failure before first file chunk');
        },
      ),
    ).rejects.toThrow(/writer failure/);
    expect(cancelled).toBe(true);
  });
});
