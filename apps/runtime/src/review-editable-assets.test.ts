import { describe, it, expect, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { validateEditableSvg, assertAssetReferences } from './editable-assets.js';
const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${body}</svg>`;

describe('independent inert editable SVG and reference review (I-9/I-11/I-12, FR-ART-05)', () => {
  it.each([
    '<script>alert(1)</script>',
    '<foreignObject><div>Active HTML</div></foreignObject>',
    '<rect onload="alert(1)"/>',
    '<image href="https://example.test/image.png"/>',
    '<a href="javascript:alert(1)"><text>open</text></a>',
    '<use href="#anything"/>',
    '<path fill="url(https://example.test/paint.svg)"/>',
    '<path fill="url(//example.test/paint.svg)"/>',
    '<path fill="url(data:image/svg+xml,evil)"/>',
    '<path fill="j&#97;vascript:alert(1)"/>',
    '<g xmlns="http://www.w3.org/1999/xhtml"><text>wrong namespace</text></g>',
    '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><path/></svg>',
    '<style>@import "https://example.test/style"</style>',
    '<animate attributeName="href" to="https://example.test/"/>',
  ])('rejects active or remote content: %s', body => {
    expect(() => validateEditableSvg(svg(body))).toThrow();
  });
  it('rejects external URLs whose CSS function name and protocol are escaped', () => {
    const source = svg(String.raw`<path d="M0 0L10 10" fill="u\72l(\68ttps://example.test/paint.svg)"/>`);
    expect(() => validateEditableSvg(source)).toThrow();
  });
  it('rejects DTDs and processing instructions before they can become external entity reads', () => {
    expect(() => validateEditableSvg(`<!DOCTYPE svg SYSTEM "https://example.test/external.dtd">${svg('<path/>')}`)).toThrow();
    expect(() => validateEditableSvg(`<?xml-stylesheet href="https://example.test/style.css"?>${svg('<path/>')}`)).toThrow();
  });
  it('accepts internal gradient paint and literal text without making them active markup', () => {
    const source = svg(
      '<defs><linearGradient id="paint"><stop offset="0" stop-color="#000000"/></linearGradient></defs><path d="M0 0L20 20" fill="url(#paint)"/><text>&lt;script&gt;literal&lt;/script&gt;</text>',
    );
    expect(validateEditableSvg(source)).toBe(source);
  });
  it('does not skip asset references hidden inside arrays of arrays', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(
      assertAssetReferences({ query } as unknown as PoolClient, randomUUID(), { groups: [[{ sourceAssetIds: [randomUUID()] }]] }),
    ).rejects.toThrow(/missing|foreign/);
    expect(query).toHaveBeenCalled();
  });
});
