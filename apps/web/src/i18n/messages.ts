import type { UiLanguage } from '../ui-contract';
import { ar } from './ar';
import { en, type MessageKey, type Messages } from './en';

/** Server-safe translation helpers (no React). The client provider in index.tsx re-exports these. */
export const MESSAGES: Readonly<Record<UiLanguage, Messages>> = { en, ar };

export type Vars = Readonly<Record<string, string | number>>;

export function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
}

export function translate(lang: UiLanguage, key: MessageKey, vars?: Vars): string {
  return interpolate(MESSAGES[lang][key] ?? en[key], vars);
}

/** Counts as words at sentence start (UX 6.1). */
const WORDS_EN = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
export function countWord(n: number, lang: UiLanguage): string {
  if (lang === 'en' && n >= 0 && n < WORDS_EN.length) return WORDS_EN[n] ?? String(n);
  return String(n);
}

export const languageFromCookie = (v: string | undefined): UiLanguage => (v === 'ar' ? 'ar' : 'en');
