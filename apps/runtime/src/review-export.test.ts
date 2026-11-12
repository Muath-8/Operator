import { describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { launchRecordArchive, buildLaunchRecord, launchRecordMarkdown } from './export.js';
const svg = (text: string) => `<svg xmlns="http://www.w3.org/2000/svg"><text>${text}</text></svg>`;
const asset = (id: string, text: string) => ({
  id,
  mime_type: 'image/svg+xml' as const,
  content_base64: Buffer.from(svg(text)).toString('base64'),
});
function requiredFile(files: ReturnType<typeof unzipSync>, path: string): Uint8Array {
  const data = files[path];
  if (!data) throw new Error(`Expected exported source is absent: ${path}`);
  return data;
}
describe('independent portable archive integrity', () => {
  it('deduplicates the same source identity to one honest manifest entry', () => {
    const id = randomUUID(),
      source = asset(id, 'first'),
      files = unzipSync(launchRecordArchive({}, [source, source]));
    const manifest = JSON.parse(strFromU8(requiredFile(files, 'assets/manifest.json')));
    expect(manifest).toHaveLength(1);
    for (const row of manifest) expect(row.sha256).toBe(createHash('sha256').update(requiredFile(files, row.path)).digest('hex'));
  });
  it('rejects conflicting content for one identity rather than overwriting bytes under an obsolete digest', () => {
    const id = randomUUID();
    expect(() => launchRecordArchive({}, [asset(id, 'original'), asset(id, 'different')])).toThrow(/duplicate|conflict|identity/i);
  });
  it('preserves literal text and prevents archive path and executable SVG input', () => {
    const id = randomUUID(),
      files = unzipSync(launchRecordArchive({}, [asset(id, '&lt;literal&gt;')]));
    expect(strFromU8(requiredFile(files, `assets/${id}.svg`))).toContain('&lt;literal&gt;');
    for (const bad of [
      { ...asset(id, 'ok'), id: '../escape' },
      { ...asset(id, 'ok'), content_base64: Buffer.from('<!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64') },
    ])
      expect(() => launchRecordArchive({}, [bad])).toThrow();
  });
  it('keeps raw conversations and credentials out of all record formats', () => {
    const record = buildLaunchRecord({
      mission: { id: randomUUID(), founder_id: randomUUID() },
      messages: [{ original: 'PRIVATE CONVERSATION' }],
      provider_secrets: [{ apiKey: 'PRIVATE CREDENTIAL' }],
      artifacts: [{ title: 'Source ``` literal heading' }],
    });
    const files = unzipSync(launchRecordArchive(record, []));
    for (const value of [JSON.stringify(record), launchRecordMarkdown(record), strFromU8(requiredFile(files, 'Launch Record.json'))]) {
      expect(value).not.toContain('PRIVATE CONVERSATION');
      expect(value).not.toContain('PRIVATE CREDENTIAL');
    }
  });
});
