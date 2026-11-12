'use client';

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { FigureValue, Money, UiLanguage } from '../ui-contract';
import { ar } from './ar';
import { en, type MessageKey, type Messages } from './en';
import { formatDate, formatDateTime, formatFigureValue, formatMoney, formatNumber, formatTime, type MoneyFormatOptions } from './format';
import { translate, type Vars } from './messages';

export { en, ar };
export type { MessageKey, Messages, Vars };
export { MESSAGES, countWord, interpolate, translate } from './messages';

export interface I18n {
  readonly lang: UiLanguage;
  readonly dir: 'ltr' | 'rtl';
  readonly timeZone: string;
  readonly t: (key: MessageKey, vars?: Vars) => string;
  readonly money: (m: Money, o?: MoneyFormatOptions) => string;
  readonly num: (n: number, digits?: number) => string;
  readonly date: (iso: string, weekday?: boolean) => string;
  readonly time: (iso: string) => string;
  readonly dateTime: (iso: string) => string;
  readonly figure: (v: FigureValue) => string;
  readonly days: (n: number) => string;
}

export function makeI18n(lang: UiLanguage, timeZone: string): I18n {
  const days = (n: number) =>
    lang === 'ar'
      ? `${formatNumber(n, lang)} ${n === 1 ? 'يوم' : n <= 10 ? 'أيام' : 'يوماً'}`
      : `${formatNumber(n, lang)} ${n === 1 ? 'day' : 'days'}`;
  return {
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    timeZone,
    t: (key, vars) => translate(lang, key, vars),
    money: (m, o) => formatMoney(m, lang, o),
    num: (n, digits) => formatNumber(n, lang, digits),
    date: (iso, weekday) => formatDate(iso, lang, timeZone, weekday),
    time: iso => formatTime(iso, lang, timeZone),
    dateTime: iso => formatDateTime(iso, lang, timeZone),
    figure: v => formatFigureValue(v, { lang, timeZone, days }),
    days,
  };
}

const Ctx = createContext<I18n>(makeI18n('en', 'UTC'));

export function I18nProvider({
  lang,
  timeZone,
  children,
}: {
  readonly lang: UiLanguage;
  readonly timeZone: string;
  readonly children: ReactNode;
}) {
  const value = useMemo(() => makeI18n(lang, timeZone), [lang, timeZone]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = (): I18n => useContext(Ctx);
