import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PDFDocument, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import bidiFactory from 'bidi-js';

const bidi = bidiFactory();
/** Keep logical strings within directional runs, because fontkit performs Arabic
 * shaping and glyph reversal. Bidi reorders runs, not already-shaped glyphs. */
export function directionalRuns(text: string): { text: string; rtl: boolean }[] {
  if (!text) return [];
  const levels = bidi.getEmbeddingLevels(text),
    indices = Array.from({ length: text.length }, (_, i) => i);
  for (const [start, end] of bidi.getReorderSegments(text, levels))
    indices.splice(start, end - start + 1, ...indices.slice(start, end + 1).reverse());
  const mirrored = bidi.getMirroredCharactersMap(text, levels),
    runs: { text: string; rtl: boolean }[] = [];
  let positions: number[] = [];
  let previous: number | undefined;
  // A nonempty positions array and bidi levels span the original UTF-16 indices.
  const levelAt = (index: number | undefined) => {
    const level = index === undefined ? undefined : levels.levels[index];
    if (level === undefined) throw new Error('Text direction data is incomplete');
    return level;
  };
  const flush = () => {
    if (!positions.length) return;
    const logical = [...positions].sort((a, b) => a - b);
    runs.push({ text: logical.map(i => mirrored.get(i) ?? text[i] ?? '').join(''), rtl: (levelAt(logical[0]) & 1) === 1 });
    positions = [];
  };
  for (const index of indices) {
    const rtl = (levelAt(index) & 1) === 1;
    if (previous !== undefined && (rtl !== ((levelAt(previous) & 1) === 1) || index - previous !== (rtl ? -1 : 1))) flush();
    positions.push(index);
    previous = index;
  }
  flush();
  return runs;
}

export async function launchRecordPdf(markdown: string, fontDirectory = join(process.cwd(), 'assets', 'fonts')): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  pdf.setTitle('Launch Record');
  pdf.setSubject('Complete mission evidence and decision record');
  const [latin, arabic] = await Promise.all(
    ['NotoSans.ttf', 'NotoNaskhArabic.ttf'].map(async name => pdf.embedFont(await readFile(join(fontDirectory, name)), { subset: true })),
  );
  if (!latin || !arabic) throw new Error('Export fonts unavailable');
  const fontFor = (text: string): PDFFont => (/[\u0600-\u08ff\ufb50-\ufdff\ufe70-\ufeff]/u.test(text) ? arabic : latin);
  const supported = new Set([...latin.getCharacterSet(), ...arabic.getCharacterSet()]);
  // Preserve unsupported characters as explicit Unicode code points in the PDF;
  // the attached complete UTF-8 source also preserves the original characters.
  const printable = [...markdown]
    .map(c => (c === '\n' || c === '\t' || supported.has(c.codePointAt(0)!) ? c : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`))
    .join('')
    .replaceAll('\t', '    ');
  const size = 9,
    lineHeight = 16,
    width = 515;
  let page = pdf.addPage([595, 842]),
    y = 802;
  const measure = (text: string) => directionalRuns(text).reduce((n, r) => n + fontFor(r.text).widthOfTextAtSize(r.text, size), 0);
  const draw = (line: string) => {
    if (y < 42) {
      page = pdf.addPage([595, 842]);
      y = 802;
    }
    const runs = directionalRuns(line);
    let x = 40;
    for (const run of runs) {
      const font = fontFor(run.text);
      page.drawText(run.text, { x, y, font, size });
      x += font.widthOfTextAtSize(run.text, size);
    }
    y -= lineHeight;
  };
  for (const sourceLine of printable.split('\n')) {
    let line = '';
    for (const character of sourceLine) {
      if (line && measure(line + character) > width) {
        draw(line);
        line = '';
      }
      line += character;
    }
    draw(line);
  }
  await pdf.attach(new TextEncoder().encode(markdown), 'launch-record.md', {
    mimeType: 'text/markdown',
    description: 'Complete original UTF-8 record',
  });
  return pdf.save();
}
