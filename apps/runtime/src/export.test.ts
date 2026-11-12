import { describe, it, expect } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { unzipSync, strFromU8 } from 'fflate';
import { launchRecordArchive, buildLaunchRecord } from './export.js';
const required = (files: Record<string, Uint8Array>, path: string): Uint8Array => {
  const value = files[path];
  if (!value) throw new Error(`Missing archive entry ${path}`);
  return value;
};
describe('portable source archive', () => {
  it('preserves editable source and manifest digest with redacted business record', () => {
    const id = randomUUID(),
      svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L5 5"/></svg>',
      record = buildLaunchRecord({
        mission: { id: randomUUID(), founder_id: randomUUID() },
        messages: [{ original: 'private contact' }],
        provider_secrets: ['secret'],
      });
    const files = unzipSync(
      launchRecordArchive(record, [{ id, mime_type: 'image/svg+xml', content_base64: Buffer.from(svg).toString('base64') }]),
    );
    expect(strFromU8(required(files, `assets/${id}.svg`))).toBe(svg);
    const manifest = JSON.parse(strFromU8(required(files, 'assets/manifest.json')));
    expect(manifest[0].sha256).toBe(createHash('sha256').update(svg).digest('hex'));
    expect(strFromU8(required(files, 'Launch Record.json'))).not.toContain('private contact');
    expect(files['Launch Record.md']).toBeDefined();
  });
  it('rejects hostile SVG, mislabeled binary, and unsafe archive paths', () => {
    for (const asset of [
      {
        id: randomUUID(),
        mime_type: 'image/svg+xml',
        content_base64: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>').toString('base64'),
      },
      { id: randomUUID(), mime_type: 'image/png', content_base64: Buffer.from('not png').toString('base64') },
      { id: '../../escape', mime_type: 'image/jpeg', content_base64: 'AA==' },
    ])
      expect(() => launchRecordArchive({}, [asset])).toThrow();
  });
});
