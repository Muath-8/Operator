import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Static audits that gate the interface (Quality Bar 8 and invariants I-14, I-15):
 * category words, token-only CSS, logical properties, six type sizes, no `any` in the contract.
 */
const SRC = fileURLToPath(new URL('..', import.meta.url));
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap(n => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const owned = ['components', 'i18n', 'styles']
  .flatMap(d => walk(join(SRC, d)))
  .concat([
    join(SRC, 'ui-contract.ts'),
    join(SRC, 'app', 'globals.css'),
    join(SRC, 'app', 'layout.tsx'),
    join(SRC, 'app', 'error.tsx'),
    join(SRC, 'app', '(workspace)', 'loading.tsx'),
    join(SRC, 'app', 'login', 'page.tsx'),
    join(SRC, 'app', 'onboarding', 'page.tsx'),
    join(SRC, 'app', 'validation', '[slug]', 'page.tsx'),
  ]);
const code = owned.filter(f => /\.(tsx?|css)$/.test(f) && !/\.test\.tsx?$/.test(f));
const css = code.filter(f => f.endsWith('.css'));
const read = (f: string) => readFileSync(f, 'utf8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('I-15: no product category outside seed data', () => {
  it('renderers, chrome strings and styles name no category', () => {
    const words = /\b(bottles?|perfumes?|straps?|candles?|jars?|watch|fragrance|parfum|tables? top)\b/i;
    const hits = code.flatMap(f =>
      stripComments(read(f))
        .split('\n')
        .map((l, i) => ({ f: relative(SRC, f), i: i + 1, l }))
        .filter(x => words.test(x.l)),
    );
    expect(hits).toEqual([]);
  });
});

describe('design tokens (Quality Bar 8)', () => {
  const tokens = read(join(SRC, 'styles', 'tokens.css'));
  const others = css.filter(f => !f.endsWith('tokens.css'));

  it('has exactly six type sizes: 12 / 14 / 16 / 19 / 24 / 40', () => {
    const sizes = [...tokens.matchAll(/--f(\d):\s*(\d+)px/g)].map(m => Number(m[2]));
    expect(sizes).toEqual([12, 14, 16, 19, 24, 40]);
  });

  it('has one accent per theme', () => {
    expect([...tokens.matchAll(/--accent:/g)]).toHaveLength(2);
  });

  it('component CSS uses no literal colours', () => {
    const hits = others.flatMap(f =>
      stripComments(read(f))
        .split('\n')
        .map((l, i) => ({ f: relative(SRC, f), i: i + 1, l }))
        .filter(x => /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/.test(x.l)),
    );
    expect(hits).toEqual([]);
  });

  it('component CSS sets font sizes only through the six tokens', () => {
    const hits = others.flatMap(f =>
      stripComments(read(f))
        .split('\n')
        .map((l, i) => ({ f: relative(SRC, f), i: i + 1, l }))
        .filter(x => /font-size\s*:/.test(x.l) && !/font-size\s*:\s*(var\(--f[1-6]\)|inherit)/.test(x.l)),
    );
    expect(hits).toEqual([]);
  });

  it('component CSS uses only token durations', () => {
    const hits = others.flatMap(f =>
      stripComments(read(f))
        .split('\n')
        .map((l, i) => ({ f: relative(SRC, f), i: i + 1, l }))
        .filter(x => /(transition|animation)(-duration)?\s*:/.test(x.l) && /\b\d*\.?\d+m?s\b/.test(x.l.replace(/0\.001ms/g, ''))),
    );
    expect(hits).toEqual([]);
  });

  it('uses logical properties only (RTL)', () => {
    const physical =
      /(^|[\s;{])(margin|padding|border)-(left|right)\b|(^|[\s;{])(left|right)\s*:|text-align\s*:\s*(left|right)|float\s*:\s*(left|right)/;
    const hits = css.flatMap(f =>
      stripComments(read(f))
        .split('\n')
        .map((l, i) => ({ f: relative(SRC, f), i: i + 1, l }))
        .filter(x => physical.test(x.l)),
    );
    expect(hits).toEqual([]);
  });
});

describe('contract', () => {
  it('has no any and requires trust on every figure (I-14)', () => {
    const c = stripComments(read(join(SRC, 'ui-contract.ts')));
    expect(/\bany\b/.test(c)).toBe(false);
    expect(c).toMatch(
      /interface Figure \{[\s\S]*?readonly trust: GlyphTrust;[\s\S]*?readonly source: SourceRef;[\s\S]*?readonly observedAt: IsoDateTime;/,
    );
    expect(c).toMatch(/interface Money \{\s*readonly amountMinor: number;\s*readonly currency: string;\s*\}/);
  });

  it('components never hold sample data defaults', () => {
    const hits = code.filter(f => /\.tsx?$/.test(f) && /fixture/i.test(stripComments(read(f))));
    expect(hits.map(f => relative(SRC, f))).toEqual([]);
  });
});
