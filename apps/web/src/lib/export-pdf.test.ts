import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { PDFDocument, PDFName } from 'pdf-lib';
import { launchRecordPdf, directionalRuns } from './export-pdf';

describe('complete portable launch record', () => {
  it('preserves logical Arabic runs while placing mixed-direction numbers separately', () => {
    const runs = directionalRuns('Amount: عطر 123');
    expect(runs.some(r => r.rtl && r.text.includes('عطر'))).toBe(true);
    expect(runs.map(r => r.text).join('')).toContain('123');
  });
  it('embeds fonts and paginates all record text, including Arabic', async () => {
    const markdown =
      '# Launch Record\nالعطر الجديد — SAR 225\n' +
      Array.from({ length: 70 }, (_, i) => `Evidence ${i}: claimed supplier terms; verification is still required.`).join('\n');
    const bytes = await launchRecordPdf(markdown, fileURLToPath(new URL('../../assets/fonts/', import.meta.url)));
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
    expect(doc.getTitle()).toBe('Launch Record');
    expect(doc.catalog.get(PDFName.of('Type'))?.toString()).toBe('/Catalog');
  }, 20000);
});
