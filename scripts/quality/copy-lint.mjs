#!/usr/bin/env node
/**
 * Copy lint (Quality Bar 8, "Copy"; UX 6.1) over the interface string files and component markup.
 *
 *   node scripts/quality/copy-lint.mjs          lint apps/web/src/i18n/{en,ar}.ts and component/route JSX text
 *   node scripts/quality/copy-lint.mjs --json   same, machine-readable
 *
 * English: sentence case (no Title Case beyond proper nouns), no all-caps words beyond known
 * acronyms, units on numbers, no vague button labels.
 * Both languages: no emoji, no arrows, identical keys and identical {placeholders} per key, no
 * untranslated English runs in Arabic.
 * Components: no literal user-facing words in JSX text (chrome lives in the string files).
 * Glossary wrapping of business terms is enforced in components (Term) and in review, not here.
 *
 * Exit code 1 when any error is found. Pure functions are exported for tests.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACRONYMS = new Set([
  'PDF',
  'JSON',
  'ZIP',
  'SMS',
  'CSV',
  'URL',
  'ID',
  'VAT',
  'SKU',
  'MOQ',
  'FX',
  'API',
  'QR',
  'UTC',
  'AI',
  'EN',
  'AR',
  'HS',
  'DDP',
  'EXW',
  'FOB',
  'ETA',
  'SAR',
  'USD',
]);
/** Proper nouns and named keys that keep their capital mid-sentence. */
export const PROPER = new Set([
  'Launch',
  'Operator',
  'Mission',
  'Lead',
  'Record',
  'Shopify',
  'PayPal',
  'Stripe',
  'Twilio',
  'Resend',
  'Supabase',
  'WhatsApp',
  'Instagram',
  'TikTok',
  'Google',
  'Meta',
  'Arabic',
  'English',
  'Saudi',
  'Riyadh',
  'Enter',
  'Esc',
  'Tab',
  'Shift',
  'Space',
  'Markdown',
  'Central',
  'Bank',
  'I',
]);
const VAGUE = new Set(['ok', 'okay', 'submit', 'click here', 'yes', 'no', 'go', 'continue', 'done']);
const UNIT_NEXT = /^\s*(%|[A-Za-z؀-ۿ]|\{)/;
const EMOJI = /\p{Extended_Pictographic}/u;
const ARROWS = /[←-⇿⟰-⟿⤀-⥿⬀-⬯➔-➿]/;

/** key -> value for `key: 'value',` lines of a string module (single, double or backtick quotes). */
export function parseStrings(text) {
  const out = new Map();
  for (const m of text.matchAll(/^\s*([A-Za-z_][\w]*)\s*:\s*(['"`])((?:\\.|(?!\2).)*)\2\s*,?\s*$/gm)) {
    out.set(m[1], m[3].replace(/\\(['"`\\])/g, '$1'));
  }
  return out;
}

export const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
const words = s =>
  s
    .replace(/\{\w+\}/g, ' ')
    .split(/[^A-Za-zÀ-ɏ'’-]+/)
    .filter(Boolean);

function sharedChecks(key, value, lang) {
  const errors = [];
  if (EMOJI.test(value)) errors.push(`${lang}.${key}: emoji in interface copy`);
  if (ARROWS.test(value)) errors.push(`${lang}.${key}: arrow character in interface copy`);
  return errors;
}

export function lintEnglish(strings) {
  const errors = [];
  for (const [key, value] of strings) {
    errors.push(...sharedChecks(key, value, 'en'));
    for (const w of words(value)) {
      if (w.length >= 2 && w === w.toUpperCase() && /[A-Z]/.test(w) && !ACRONYMS.has(w)) errors.push(`en.${key}: all-caps "${w}"`);
    }
    // Sentence case: a capital mid-sentence must be a proper noun, an acronym or follow a sentence break.
    // Placeholders become a neutral symbol so "R{level}" is not read as a capitalised word.
    const plain = value.replace(/\{\w+\}/g, '·');
    for (const m of plain.matchAll(/(?<![\w'’-])[A-Z][a-z][A-Za-z'’-]*/g)) {
      const before = plain.slice(0, m.index).trimEnd();
      if (!before || /[.?!:;(“"]$/.test(before)) continue;
      if (PROPER.has(m[0])) continue;
      errors.push(`en.${key}: "${m[0]}" breaks sentence case`);
    }
    for (const m of plain.matchAll(/(?<![\w.{])(\d+(?:[.,]\d+)?)(?![\d.,])/g)) {
      const rest = plain.slice((m.index ?? 0) + m[0].length);
      if (!UNIT_NEXT.test(rest) && !/^\s*(to|or|and)\b/.test(rest)) errors.push(`en.${key}: number ${m[1]} has no unit`);
    }
    if (VAGUE.has(value.trim().toLowerCase())) errors.push(`en.${key}: "${value}" does not name its action`);
  }
  return errors;
}

export function lintArabic(strings) {
  const errors = [];
  for (const [key, value] of strings) {
    errors.push(...sharedChecks(key, value, 'ar'));
    const latin = value.replace(/\{\w+\}/g, ' ').match(/[A-Za-z][A-Za-z'’-]*(?:\s+[A-Za-z][A-Za-z'’-]*){2,}/g) ?? [];
    for (const run of latin) {
      const content = run.split(/\s+/).filter(w => !PROPER.has(w) && !ACRONYMS.has(w));
      if (content.length >= 3) errors.push(`ar.${key}: untranslated English "${run}"`);
    }
  }
  return errors;
}

export function parity(en, ar) {
  const errors = [];
  for (const k of en.keys()) if (!ar.has(k)) errors.push(`ar is missing ${k}`);
  for (const k of ar.keys()) if (!en.has(k)) errors.push(`en is missing ${k}`);
  for (const [k, v] of en) {
    const a = ar.get(k);
    if (a !== undefined && placeholders(v).join() !== placeholders(a).join())
      errors.push(`${k}: placeholders differ (en {${placeholders(v).join(', ')}} vs ar {${placeholders(a).join(', ')}})`);
  }
  return errors;
}

/** Literal words between JSX tags; chrome must come from t(). Symbols, numbers and punctuation pass. */
export function jsxText(file, text) {
  const errors = [];
  const code = text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' ')).replace(/\/\/[^\n]*/g, m => ' '.repeat(m.length));
  for (const m of code.matchAll(/>([^<>{}]*[A-Za-z؀-ۿ]{2,}[^<>{}]*)<\//g)) {
    const s = m[1].trim();
    if (!s || /=>|[;=]\s*$|^\)|&&|\|\|/.test(s)) continue;
    const line = code.slice(0, m.index).split('\n').length;
    errors.push(`${file}:${line} literal text "${s.slice(0, 48)}" (use the string files)`);
  }
  return errors;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) continue;
    if (statSync(p).isDirectory()) walk(p, out);
    else if (name.endsWith('.tsx') && !name.endsWith('.test.tsx')) out.push(p);
  }
  return out;
}

export function lintRepository(root) {
  const i18n = join(root, 'apps', 'web', 'src', 'i18n');
  const en = parseStrings(readFileSync(join(i18n, 'en.ts'), 'utf8'));
  const ar = parseStrings(readFileSync(join(i18n, 'ar.ts'), 'utf8'));
  const errors = [...lintEnglish(en), ...lintArabic(ar), ...parity(en, ar)];
  const app = join(root, 'apps', 'web', 'src', 'app');
  const components = [
    ...walk(join(root, 'apps', 'web', 'src', 'components')),
    ...walk(app).filter(f => !relative(app, f).startsWith('api')),
  ];
  for (const f of components) errors.push(...jsxText(relative(root, f).replaceAll('\\', '/'), readFileSync(f, 'utf8')));
  return { errors, checked: { en: en.size, ar: ar.size, components: components.length } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const result = lintRepository(root);
  if (process.argv.includes('--json')) console.log(JSON.stringify(result, null, 2));
  else {
    for (const e of result.errors) console.error(`copy-lint: ${e}`);
    console.log(
      `copy-lint: ${result.errors.length} error(s); ${result.checked.en} English and ${result.checked.ar} Arabic strings, ${result.checked.components} components checked`,
    );
  }
  process.exit(result.errors.length ? 1 : 0);
}
