import { describe, expect, it } from 'vitest';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import stylelint from 'stylelint';

/**
 * Tests for the Quality Bar 8 enforcement: scripts/quality/style-tokens.mjs, scripts/quality/copy-lint.mjs
 * and stylelint.config.mjs. Each rule is shown to catch a seeded violation, and the actual production
 * styles, string files and components are checked to be clean.
 */
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const load = <T>(rel: string) => import(/* @vite-ignore */ pathToFileURL(join(root, rel)).href) as Promise<T>;

interface TokenAudit {
  auditTokens(css: string): { errors: string[]; tokens: Set<string> };
  inlineStyleLiterals(file: string, text: string): string[];
  undefinedVariables(files: { file: string; text: string }[], known: Set<string>): string[];
  auditRepository(root: string): { errors: string[]; checked: { css: number; tsx: number; tokens: number } };
}
interface CopyLint {
  parseStrings(text: string): Map<string, string>;
  lintEnglish(strings: Map<string, string>): string[];
  lintArabic(strings: Map<string, string>): string[];
  parity(en: Map<string, string>, ar: Map<string, string>): string[];
  jsxText(file: string, text: string): string[];
  lintRepository(root: string): { errors: string[]; checked: { en: number; ar: number; components: number } };
}

const tokens = (opts: { sizes?: string; extraLight?: string; extraDark?: string; reduced?: boolean } = {}) => `
:root {
  --paper: #ffffff;
  --ink: #1b1c1e;
  --accent: #2d3fa8;
  --accent-wash: #eceefa;
  --accent-line: rgb(45 63 168 / 0.32);
  --t-verified: #1d7449;
  ${opts.sizes ?? '--f1: 12px; --f2: 14px; --f3: 16px; --f4: 19px; --f5: 24px; --f6: 40px;'}
  --fast: 120ms; --base: 180ms; --slow: 240ms;
  ${opts.extraLight ?? ''}
}
[data-theme="dark"] {
  --paper: #191919;
  --ink: #ececec;
  --accent: #98a4f3;
  --accent-wash: rgb(152 164 243 / 0.13);
  --accent-line: rgb(152 164 243 / 0.4);
  --t-verified: #5bbd8f;
  ${opts.extraDark ?? ''}
}
${opts.reduced === false ? '' : '@media (prefers-reduced-motion: reduce) { :root { --fast: 1ms; --base: 1ms; --slow: 1ms; } }'}
`;

describe('style-tokens audit', () => {
  it('accepts the six-size, one-accent system', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    expect(m.auditTokens(tokens()).errors).toEqual([]);
  });

  it('treats formatter quote and spacing changes as the same dark selector', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    expect(m.auditTokens(tokens().replace('[data-theme="dark"]', "[data-theme = 'dark']")).errors).toEqual([]);
    expect(m.auditTokens(tokens().replace('[data-theme="dark"]', '[data-theme="light"]')).errors.join()).toMatch(/has no dark theme value/);
  });

  it('rejects a seventh type size and a changed size', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    const seven = m.auditTokens(
      tokens({ sizes: '--f1: 12px; --f2: 14px; --f3: 16px; --f4: 19px; --f5: 24px; --f6: 40px; --f7: 56px;' }),
    ).errors;
    expect(seven.join()).toMatch(/type scale/);
    const changed = m.auditTokens(tokens({ sizes: '--f1: 12px; --f2: 13px; --f3: 16px; --f4: 19px; --f5: 24px; --f6: 40px;' })).errors;
    expect(changed.join()).toMatch(/type scale/);
  });

  it('rejects a second accent colour and an accent wash of another hue', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    const second = m.auditTokens(tokens({ extraLight: '--highlight: #e0115f;', extraDark: '--highlight: #ff5c8a;' })).errors;
    expect(second.join()).toMatch(/--highlight .*second chromatic/);
    const drift = m.auditTokens(tokens().replace('--accent-wash: #eceefa;', '--accent-wash: #faeeec;')).errors;
    expect(drift.join()).toMatch(/--accent-wash \(light\) drifts/);
  });

  it('requires dark values for colour tokens and reduced-motion collapse', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    expect(m.auditTokens(tokens({ extraLight: '--rule: #e4e4e0;' })).errors.join()).toMatch(/--rule has no dark theme value/);
    expect(m.auditTokens(tokens({ reduced: false })).errors.join()).toMatch(/reduced motion must collapse --fast/);
  });

  it('flags literal design values in inline styles and passes data-driven ones', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    const bad = [
      `<div style={{ inlineSize: 96, blockSize: 48 }} />`,
      `<div style={{ color: '#ff0000' }} />`,
      `<div style={{ marginBlockStart: '12px' }} />`,
      '<tr style={{ animationDelay: `${i * 70}ms` }} />',
      `<div style={{ blockSize: phone ? 200 : 300 }} />`,
    ];
    for (const src of bad) expect(m.inlineStyleLiterals('x.tsx', src), src).not.toEqual([]);
    const good = [
      '<i style={{ inlineSize: `${share}%` }} />',
      `<div style={{ marginBlockStart: 'var(--sp-5)' }} />`,
      `<li style={{ background: c }} />`,
      '<tr style={{ animationDelay: `calc(var(--stagger) * ${i})` }} />',
      `<div style={{ blockSize: height }} />`,
    ];
    for (const src of good) expect(m.inlineStyleLiterals('x.tsx', src), src).toEqual([]);
  });

  it('reports variables that resolve to nothing', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    const errors = m.undefinedVariables([{ file: 'a.css', text: '.x { color: var(--ink); gap: var(--sp-99); }' }], new Set(['--ink']));
    expect(errors).toEqual(['a.css:1 var(--sp-99) is not a token or a declared custom property']);
  });

  it('passes on the actual production styles and components', async () => {
    const m = await load<TokenAudit>('scripts/quality/style-tokens.mjs');
    const result = m.auditRepository(root);
    expect(result.errors).toEqual([]);
    expect(result.checked.css).toBeGreaterThanOrEqual(9);
    expect(result.checked.tsx).toBeGreaterThan(30);
  });
});

describe('copy lint', () => {
  it('parses string modules with escaped quotes', async () => {
    const m = await load<CopyLint>('scripts/quality/copy-lint.mjs');
    const s = m.parseStrings(`export const en = {\n  a: 'It\\'s here',\n  b: "Two {n} items",\n} as const;`);
    expect([...s]).toEqual([
      ['a', "It's here"],
      ['b', 'Two {n} items'],
    ]);
  });

  it('catches title case, all caps, emoji, arrows, bare numbers and vague labels', async () => {
    const m = await load<CopyLint>('scripts/quality/copy-lint.mjs');
    const cases: [string, RegExp][] = [
      ['Approve The Payment', /"The" breaks sentence case/],
      ['Pay NOW', /all-caps "NOW"/],
      ['Approved ✅', /emoji/],
      ['Open money →', /arrow/],
      ['Up to 3', /number 3 has no unit/],
      ['OK', /does not name its action/],
    ];
    for (const [value, re] of cases) expect(m.lintEnglish(new Map([['k', value]])).join(), value).toMatch(re);
  });

  it('allows proper nouns, acronyms, sentence breaks, units and placeholders', async () => {
    const m = await load<CopyLint>('scripts/quality/copy-lint.mjs');
    const ok = new Map([
      ['a', 'Write to your Mission Lead, or press Enter'],
      ['b', 'Export as PDF. Then share it.'],
      ['c', '{n} waiting on you'],
      ['d', 'Three samples, 60 USD each, within 2 days'],
      ['e', '{outcome} R{level} {name}'],
    ]);
    expect(m.lintEnglish(ok)).toEqual([]);
  });

  it('requires matching keys and placeholders, and catches untranslated Arabic', async () => {
    const m = await load<CopyLint>('scripts/quality/copy-lint.mjs');
    const en = new Map([
      ['a', '{n} waiting on you'],
      ['b', 'Send'],
    ]);
    const ar = new Map([['a', '{count} بانتظارك']]);
    const errors = m.parity(en, ar).join('\n');
    expect(errors).toMatch(/ar is missing b/);
    expect(errors).toMatch(/a: placeholders differ/);
    expect(m.lintArabic(new Map([['x', 'Approve the payment now']])).join()).toMatch(/untranslated English/);
    expect(m.lintArabic(new Map([['x', 'افتح PayPal الآن']]))).toEqual([]);
  });

  it('flags literal words in JSX but not expressions or symbols', async () => {
    const m = await load<CopyLint>('scripts/quality/copy-lint.mjs');
    expect(m.jsxText('a.tsx', '<button>Approve</button>')).toEqual(['a.tsx:1 literal text "Approve" (use the string files)']);
    expect(m.jsxText('a.tsx', '<button>{t("approve")}</button><span>·</span><b>12</b>')).toEqual([]);
  });

  it('passes on the actual string files and components', async () => {
    const m = await load<CopyLint>('scripts/quality/copy-lint.mjs');
    const result = m.lintRepository(root);
    expect(result.errors).toEqual([]);
    expect(result.checked.en).toBe(result.checked.ar);
    expect(result.checked.en).toBeGreaterThan(400);
  });
});

describe('stylelint config', () => {
  const configFile = join(root, 'stylelint.config.mjs');
  const lint = async (code: string, file = 'apps/web/src/styles/page.css') => {
    const r = await stylelint.lint({ code, codeFilename: join(root, file), configFile });
    return (r.results[0]?.warnings ?? []).map(w => w.rule);
  };

  it('rejects literal colours, lengths, durations, physical properties and raw type values', async () => {
    expect(await lint('.a { color: #fff; }')).toContain('color-no-hex');
    expect(await lint('.a { color: red; }')).toContain('color-named');
    expect(await lint('.a { background: rgb(0 0 0 / 0.2); }')).toContain('function-disallowed-list');
    expect(await lint('.a { gap: 6px; }')).toContain('unit-disallowed-list');
    expect(await lint('.a { transition: opacity 200ms; }')).toContain('unit-disallowed-list');
    expect(await lint('.a { margin-left: var(--sp-2); }')).toContain('property-disallowed-list');
    expect(await lint('.a { width: 100%; }')).toContain('property-disallowed-list');
    expect(await lint('.a { text-align: left; }')).toContain('declaration-property-value-disallowed-list');
    expect(await lint('.a { z-index: 50; }')).toContain('declaration-property-value-disallowed-list');
    expect(await lint('.a { font-size: 13px; }')).toContain('declaration-property-value-allowed-list');
    expect(await lint('.a { font-size: var(--f7); }')).toContain('declaration-property-value-allowed-list');
  });

  it('accepts tokens, logical properties and px media queries', async () => {
    expect(
      await lint(
        '@media (max-width: 899px) { .a { gap: var(--sp-2); margin-inline-start: var(--sp-1); font-size: var(--f2); z-index: 2; } }',
      ),
    ).toEqual([]);
  });

  it('lets only tokens.css hold literals', async () => {
    expect(await lint(':root { --paper: #ffffff; --f1: 12px; --fast: 120ms; }', 'apps/web/src/styles/tokens.css')).toEqual([]);
  });

  it('passes on the actual production stylesheets', async () => {
    const r = await stylelint.lint({ files: ['apps/web/src/**/*.css'], cwd: root, configFile });
    const problems = r.results.flatMap(x => x.warnings.map(w => `${x.source}:${w.line} ${w.text}`));
    expect(problems).toEqual([]);
    expect(r.results.length).toBeGreaterThanOrEqual(10);
  });
});
