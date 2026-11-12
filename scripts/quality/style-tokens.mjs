#!/usr/bin/env node
/**
 * Token audit (Quality Bar 8, "Design tokens"): the checks stylelint cannot express.
 *
 *   node scripts/quality/style-tokens.mjs            audit the production web styles and components
 *   node scripts/quality/style-tokens.mjs --json     same, machine-readable
 *
 * 1. Exactly six type sizes (--f1..--f6 = 12/14/16/19/24/40 px) and no other font-size token.
 * 2. One accent: every chromatic colour token is the accent family, a trust colour (--t-*) or a plate
 *    material (--mat-*); the accent wash and line are the accent's own hue in both themes.
 * 3. Theme parity: every colour token is defined in light (:root) and dark ([data-theme="dark"]).
 * 4. Reduced motion collapses the three durations.
 * 5. Every var(--x) used by component CSS or TSX resolves to a token, a local custom property, a
 *    runtime property set by a component, or a next/font variable.
 * 6. Inline styles in TSX hold no literal colour, pixel size or duration (data-driven values allowed).
 *
 * Exit code 1 when any error is found. Pure functions are exported for tests.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TYPE_SCALE = [12, 14, 16, 19, 24, 40];
const ACCENT_FAMILY = new Set(['--accent', '--on-accent', '--accent-wash', '--accent-line']);
const CHROMATIC_FAMILIES = [/^--t-/, /^--mat-/];
const RUNTIME_PREFIXES = ['--font-'];

/** Custom property declarations inside the first block whose selector matches. */
function blockDecls(css, selectorRe) {
  const out = new Map();
  const re = new RegExp(`${selectorRe.source}\\s*\\{([^}]*)\\}`, 'g');
  for (const m of css.matchAll(re)) {
    for (const d of (m[1] ?? '').matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) out.set(d[1], d[2].trim());
  }
  return out;
}

export function parseTokens(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const motion = clean.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\}\s*\}/);
  return {
    light: blockDecls(clean.replace(/@media[\s\S]*$/, ''), /:root/),
    dark: blockDecls(clean, /\[data-theme\s*=\s*["\x27]dark["\x27]\]/),
    reduced: motion ? blockDecls(motion[1] + '}', /:root/) : new Map(),
  };
}

/** sRGB channels 0-255 from #rgb, #rrggbb or rgb(r g b / a); null when not a literal colour. */
export function rgbOf(value) {
  const v = value.trim().toLowerCase();
  let m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (m) {
    const h = m[1].length === 3 ? [...m[1]].map(c => c + c).join('') : m[1];
    return [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16));
  }
  m = v.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const chroma = rgb => (Math.max(...rgb) - Math.min(...rgb)) / 255;
function hue([r, g, b]) {
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

export function auditTokens(css) {
  const errors = [];
  const { light, dark, reduced } = parseTokens(css);

  const sizes = [...light.keys()].filter(k => /^--f\d+$/.test(k));
  const px = sizes.map(k => Number((light.get(k) ?? '').replace(/px$/, '')));
  if (sizes.length !== TYPE_SCALE.length || TYPE_SCALE.some((s, i) => px[i] !== s)) {
    errors.push(
      `type scale must be exactly ${TYPE_SCALE.join('/')} px as --f1..--f6; found ${sizes.map((k, i) => `${k}=${px[i]}`).join(', ') || 'none'}`,
    );
  }
  for (const [k, v] of light) {
    if (/^--(font-size|fs|text)-/.test(k) || (/px$/.test(v) && /^--(type|size)-/.test(k)))
      errors.push(`${k}: only --f1..--f6 may define type sizes`);
  }

  for (const [theme, map] of [
    ['light', light],
    ['dark', dark],
  ]) {
    for (const [k, v] of map) {
      const rgb = rgbOf(v);
      if (!rgb || chroma(rgb) < 0.12) continue;
      if (ACCENT_FAMILY.has(k) || CHROMATIC_FAMILIES.some(re => re.test(k))) continue;
      errors.push(`${k} (${theme}) is a second chromatic colour; the system has one accent (UX 9)`);
    }
    const accent = rgbOf(map.get('--accent') ?? '');
    for (const k of ['--accent-wash', '--accent-line']) {
      const rgb = rgbOf(map.get(k) ?? '');
      if (accent && rgb && chroma(rgb) >= 0.03 && Math.abs(hue(rgb) - hue(accent)) > 6)
        errors.push(`${k} (${theme}) drifts from the accent hue`);
    }
  }

  for (const [k, v] of light) {
    if (rgbOf(v) && !dark.has(k)) errors.push(`${k} has no dark theme value`);
  }
  for (const k of dark.keys()) if (!light.has(k)) errors.push(`${k} is defined only in the dark theme`);

  for (const k of ['--fast', '--base', '--slow']) {
    if (!reduced.has(k)) errors.push(`reduced motion must collapse ${k}`);
  }
  return { errors, tokens: new Set([...light.keys(), ...dark.keys()]) };
}

/** Custom properties declared outside tokens.css (component-local) and set at runtime from TSX. */
export function localProperties(cssFiles, tsxFiles) {
  const names = new Set();
  for (const { text } of cssFiles) for (const m of text.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gi)) names.add(m[1]);
  for (const { text } of tsxFiles) {
    for (const m of text.matchAll(/setProperty\(\s*['"](--[a-z0-9-]+)['"]/g)) names.add(m[1]);
    for (const m of text.matchAll(/\[\s*['"](--[a-z0-9-]+)['"]\s+as\s+string\s*\]/g)) names.add(m[1]);
    for (const m of text.matchAll(/['"](--[a-z0-9-]+)['"]\s*:/g)) names.add(m[1]);
  }
  return names;
}

export function undefinedVariables(files, known) {
  const errors = [];
  for (const { file, text } of files) {
    for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      const name = m[1];
      if (known.has(name) || RUNTIME_PREFIXES.some(p => name.startsWith(p))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      errors.push(`${file}:${line} var(${name}) is not a token or a declared custom property`);
    }
  }
  return errors;
}

const SIZE_PROP =
  /^(inlineSize|blockSize|minInlineSize|maxInlineSize|minBlockSize|maxBlockSize|width|height|margin\w*|padding\w*|inset\w*|gap|rowGap|columnGap|fontSize|lineHeight|letterSpacing|borderRadius|top|left|right|bottom)$/;

/** The `{{ ... }}` object bodies of JSX style props, balanced across nested braces and template literals. */
function styleBodies(text) {
  const out = [];
  for (const m of text.matchAll(/style=\{\{/g)) {
    const start = (m.index ?? 0) + m[0].length;
    const end = scanToClose(text, start);
    if (end > 0) out.push({ index: m.index ?? 0, body: text.slice(start, end) });
  }
  return out;
}

/** Index of the `}` closing the object that starts at `start`, honouring strings, templates and `${}`. */
function scanToClose(text, start) {
  const stack = []; // '{', '(', '[', '`', '${', "'", '"'
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (c === '\\') i++;
      else if (c === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (c === '\\') i++;
      else if (c === '`') stack.pop();
      else if (c === '$' && text[i + 1] === '{') {
        stack.push('${');
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`' || c === '{' || c === '(' || c === '[') stack.push(c);
    else if (c === '}' || c === ')' || c === ']') {
      if (!stack.length) return c === '}' ? i : -1;
      stack.pop();
    }
  }
  return -1;
}

/** Top-level `prop: value` pairs of an object body. */
function pairs(body) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    cur += c;
    if (quote) {
      if (c === '\\') cur += body[++i] ?? '';
      else if (c === quote) quote = '';
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    else if ('{(['.includes(c)) depth++;
    else if ('})]'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      parts.push(cur.slice(0, -1));
      cur = '';
    }
  }
  if (cur.trim()) parts.push(cur);
  return parts.map(p => p.match(/^\s*\[?\s*['"]?([\w-]+)['"]?(?:\s+as\s+string)?\s*\]?\s*:\s*([\s\S]*)$/)).filter(Boolean);
}

/** Literal design values inside JSX style objects. Interpolated (data-driven) template literals pass. */
export function inlineStyleLiterals(file, text) {
  const errors = [];
  for (const m of styleBodies(text)) {
    const line = text.slice(0, m.index).split('\n').length;
    for (const p of pairs(m.body)) {
      const [, prop, raw] = p;
      const value = raw.trim();
      if (/^['"]/.test(value)) {
        const s = value.slice(1, -1);
        if (/#[0-9a-f]{3,8}\b|\b(rgb|hsl)a?\(/i.test(s)) errors.push(`${file}:${line} ${prop}: literal colour ${value}`);
        if (/\d(px|rem|em)\b/.test(s)) errors.push(`${file}:${line} ${prop}: literal size ${value}`);
        if (/\d(ms|s)\b/.test(s)) errors.push(`${file}:${line} ${prop}: literal duration ${value}`);
      } else if (/^\d+(\.\d+)?$/.test(value) && SIZE_PROP.test(prop) && value !== '0') {
        errors.push(`${file}:${line} ${prop}: literal size ${value}`);
      } else if (/^`/.test(value)) {
        const fixed = value.replace(/\$\{[^}]*\}/g, '');
        if (/\d(px|ms|s)\b/.test(fixed) || /\$\{[^}]*\b\d{2,}\b[^}]*\}(ms|s)\b/.test(value))
          errors.push(`${file}:${line} ${prop}: literal value in ${value}`);
      } else if (/^[^?]*\?\s*\d+\s*:\s*\d+/.test(value) && SIZE_PROP.test(prop)) {
        errors.push(`${file}:${line} ${prop}: literal sizes in ${value}`);
      }
    }
  }
  return errors;
}

function walk(dir, ext, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.some(e => name.endsWith(e)) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

export function auditRepository(root) {
  const web = join(root, 'apps', 'web', 'src');
  const read = f => ({ file: relative(root, f).replaceAll('\\', '/'), text: readFileSync(f, 'utf8') });
  const tokensFile = join(web, 'styles', 'tokens.css');
  const css = walk(web, ['.css'])
    .filter(f => resolve(f) !== resolve(tokensFile))
    .map(read);
  const tsx = walk(web, ['.tsx']).map(read);
  const { errors, tokens } = auditTokens(readFileSync(tokensFile, 'utf8'));
  const known = new Set([...tokens, ...localProperties(css, tsx)]);
  errors.push(...undefinedVariables([...css, ...tsx], known));
  for (const f of tsx) errors.push(...inlineStyleLiterals(f.file, f.text));
  return { errors, checked: { css: css.length + 1, tsx: tsx.length, tokens: tokens.size } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const result = auditRepository(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const e of result.errors) console.error(`style-tokens: ${e}`);
    console.log(
      `style-tokens: ${result.errors.length} error(s); ${result.checked.tokens} tokens, ${result.checked.css} stylesheets, ${result.checked.tsx} components checked`,
    );
  }
  process.exit(result.errors.length ? 1 : 0);
}
