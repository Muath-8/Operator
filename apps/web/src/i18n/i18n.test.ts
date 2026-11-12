import { describe, expect, it } from 'vitest';
import { ar } from './ar';
import { en } from './en';
import { formatMoney, shareOf, toMajor } from './format';
import { countWord, interpolate, makeI18n } from './index';

describe('interface strings', () => {
  it('Arabic covers every English key and keeps every placeholder', () => {
    for (const k of Object.keys(en) as (keyof typeof en)[]) {
      expect(ar[k], k).toBeTruthy();
      const ph = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
      expect(ph(ar[k]), k).toEqual(ph(en[k]));
    }
  });

  it('follows the copy rules: no all-caps words, no emoji, no arrows in labels', () => {
    for (const [k, v] of Object.entries(en)) {
      expect(/\b[A-Z]{4,}\b/.test(v.replace(/\b(SAR|USD|MOQ|JSON|PDF|SMS)\b/g, '')), k).toBe(false);
      expect(/[\u{1F300}-\u{1FAFF}]/u.test(v), k).toBe(false);
      expect(/[→←⇒]/.test(v), k).toBe(false);
    }
  });

  it('interpolates and leaves unknown placeholders visible', () => {
    expect(interpolate('See all {n}', { n: 3 })).toBe('See all 3');
    expect(interpolate('{a} {b}', { a: 'x' })).toBe('x {b}');
  });

  it('writes counts as words at sentence start in English', () => {
    expect(countWord(2, 'en')).toBe('Two');
    expect(countWord(12, 'en')).toBe('12');
  });
});

describe('money from integer minor units', () => {
  it('formats whole amounts without decimals and unit prices exactly', () => {
    expect(formatMoney({ amountMinor: 3_000_000, currency: 'SAR' }, 'en')).toBe('SAR 30,000');
    expect(formatMoney({ amountMinor: 1260, currency: 'SAR' }, 'en')).toBe('SAR 12.60');
    expect(formatMoney({ amountMinor: 1200, currency: 'SAR' }, 'en', { exact: true })).toBe('SAR 12.00');
    expect(formatMoney({ amountMinor: -110_000, currency: 'SAR' }, 'en')).toBe('−SAR 1,100');
  });

  it('respects currencies without minor units', () => {
    expect(toMajor({ amountMinor: 500, currency: 'JPY' })).toBe(500);
    expect(formatMoney({ amountMinor: 500, currency: 'JPY' }, 'en')).toBe('JPY 500');
  });

  it('uses Western numerals in Arabic (OD-U3 default)', () => {
    expect(formatMoney({ amountMinor: 250_000, currency: 'SAR' }, 'ar')).toMatch(/2,500|2٬500/);
    expect(formatMoney({ amountMinor: 250_000, currency: 'SAR' }, 'ar')).not.toMatch(/[٠-٩]/);
  });

  it('formats dates in the mission time zone', () => {
    const i = makeI18n('en', 'Asia/Riyadh');
    expect(i.date('2026-11-15T23:30:00Z')).toBe('16 Nov');
    expect(i.days(21)).toBe('21 days');
  });

  it('clamps bar shares', () => {
    expect(shareOf(5, 0)).toBe(0);
    expect(shareOf(150, 100)).toBe(100);
  });
});
