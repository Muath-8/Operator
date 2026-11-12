import type { FigureValue, Money, UiLanguage } from '../ui-contract';

/**
 * Locale formatting. Numerals stay Western in Arabic (OD-U3 recommended default,
 * pending native review); dates follow the mission's time zone so server and client
 * render the same text.
 */
export const localeFor = (lang: UiLanguage): string => (lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB');

const fractionDigitsCache = new Map<string, number>();
export function currencyDigits(currency: string): number {
  const hit = fractionDigitsCache.get(currency);
  if (hit !== undefined) return hit;
  let digits = 2;
  try {
    digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    digits = 2;
  }
  fractionDigitsCache.set(currency, digits);
  return digits;
}

/** Integer minor units to a decimal number. */
export const toMajor = (m: Money): number => m.amountMinor / 10 ** currencyDigits(m.currency);

export interface MoneyFormatOptions {
  /** Always show minor digits (unit prices). Default: only when the amount has a minor part. */
  readonly exact?: boolean;
  /** Include the currency code. Default true. */
  readonly code?: boolean;
  /** Prefix a sign for deltas. */
  readonly signed?: boolean;
}

export function formatMoney(m: Money, lang: UiLanguage, o: MoneyFormatOptions = {}): string {
  const digits = currencyDigits(m.currency);
  const hasMinor = digits > 0 && m.amountMinor % 10 ** digits !== 0;
  const showDigits = o.exact || hasMinor ? digits : 0;
  const abs = Math.abs(m.amountMinor) / 10 ** digits;
  const n = new Intl.NumberFormat(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', {
    minimumFractionDigits: showDigits,
    maximumFractionDigits: showDigits,
    useGrouping: true,
  }).format(abs);
  const sign = m.amountMinor < 0 ? '−' : o.signed && m.amountMinor > 0 ? '+' : '';
  const code = o.code === false ? '' : `${m.currency} `;
  // The code stays Latin and leads the number in both directions; isolate for RTL.
  return `${sign}${code}${n}`;
}

export function formatNumber(n: number, lang: UiLanguage, maxDigits = 2): string {
  return new Intl.NumberFormat(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-US', { maximumFractionDigits: maxDigits }).format(n);
}

export function formatDate(iso: string, lang: UiLanguage, timeZone: string, withWeekday = false): string {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(localeFor(lang), {
    day: 'numeric',
    month: 'short',
    timeZone,
    ...(withWeekday ? { weekday: 'short' } : {}),
  }).format(d);
}

export function formatTime(iso: string, lang: UiLanguage, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(localeFor(lang), { hour: '2-digit', minute: '2-digit', hour12: false, timeZone }).format(d);
}

export function formatDateTime(iso: string, lang: UiLanguage, timeZone: string): string {
  return `${formatDate(iso, lang, timeZone)}, ${formatTime(iso, lang, timeZone)}`;
}

export function formatRange(fromIso: string, toIso: string, lang: UiLanguage, timeZone: string, joiner: string): string {
  return `${formatDate(fromIso, lang, timeZone)} ${joiner} ${formatDate(toIso, lang, timeZone)}`;
}

export interface FigureFormatContext {
  readonly lang: UiLanguage;
  readonly timeZone: string;
  readonly days: (n: number) => string;
}

export function formatFigureValue(v: FigureValue, ctx: FigureFormatContext): string {
  switch (v.kind) {
    case 'money':
      return formatMoney(v.amount, ctx.lang, { exact: v.per !== undefined }) + (v.per ? ` ${v.per}` : '');
    case 'quantity':
      return `${formatNumber(v.value, ctx.lang)}${v.unit ? ` ${v.unit}` : ''}`;
    case 'duration':
      return ctx.days(v.days);
    case 'percent':
      return `${formatNumber(v.value, ctx.lang, 1)}%`;
    case 'date':
      return formatDate(v.date, ctx.lang, ctx.timeZone);
    case 'text':
      return v.text;
  }
}

/** Share of a ceiling, clamped 0..100, for bars. Presentation only; never a ledger value. */
export function shareOf(part: number, whole: number): number {
  if (!(whole > 0)) return 0;
  return Math.max(0, Math.min(100, (part / whole) * 100));
}
