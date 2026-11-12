import type { DecisionView, MandateScopeDraft, Money } from '../../ui-contract';

/**
 * Authority belongs to the options the server names. With `optionIds` present, only those options carry
 * it (recommended or not, one or several). Without it (older fixtures only) the recommended option does.
 * One option's authority is never displayed or submitted for another.
 */
const owns = (ids: readonly string[] | undefined, d: Pick<DecisionView, 'recommendedOptionId'>, optionId: string): boolean =>
  ids ? ids.includes(optionId) : optionId === d.recommendedOptionId;
export const ownsScope = (d: Pick<DecisionView, 'recommendedOptionId' | 'mandateScope'>, optionId: string): boolean =>
  !!d.mandateScope && owns(d.mandateScope.optionIds, d, optionId);
export const ownsPayment = (d: Pick<DecisionView, 'recommendedOptionId' | 'payment'>, optionId: string): boolean =>
  !!d.payment && owns(d.payment.optionIds, d, optionId);
import { currencyDigits } from '../../i18n/format';
import type { ScopeDraft } from './uiState';

/**
 * Mandate-grant variant (UX 7.5): the scope is editable inline, but only narrower than the frozen
 * draft the packet was approved for. The server validates again; the UI never offers a wider scope.
 */
/** Minor units to an exact decimal string (no floating point): 1260 SAR → "12.6", 0 → "0". */
export function minorToMajorString(amountMinor: number, digits: number): string {
  if (digits === 0) return String(amountMinor);
  const scale = 10 ** digits;
  const whole = Math.floor(amountMinor / scale);
  const frac = String(amountMinor % scale)
    .padStart(digits, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * Exact decimal string to minor units, or null when it isn't a plain non-negative amount in the
 * currency's supported precision ("0.001" SAR is rejected, never rounded to zero).
 */
export function majorStringToMinor(input: string, digits: number): number | null {
  const s = input.replace(/,/g, '').trim();
  const m = /^(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) return null;
  const whole = m[1] ?? '0';
  const frac = m[2] ?? '';
  if (frac.length > digits) return null;
  const minor = Number(whole) * 10 ** digits + Number(frac.padEnd(digits, '0') || '0');
  return Number.isSafeInteger(minor) ? minor : null;
}

export function draftFromScope(s: MandateScopeDraft): ScopeDraft {
  return {
    ceilingMajor: minorToMajorString(s.ceiling.amountMinor, currencyDigits(s.ceiling.currency)),
    count: String(s.count),
    expiresOn: s.expiresOn,
  };
}

/** Upper bounds = the frozen draft, further capped by any server maximum. */
export function narrowBounds(s: MandateScopeDraft): { ceiling: Money; count: number; expiresOn: string } {
  return {
    ceiling: { amountMinor: Math.min(s.ceiling.amountMinor, s.ceilingMax.amountMinor), currency: s.ceiling.currency },
    count: Math.min(s.count, s.countMax),
    expiresOn: s.expiresOn && s.expiresMax ? (s.expiresOn < s.expiresMax ? s.expiresOn : s.expiresMax) : s.expiresOn || s.expiresMax,
  };
}

export type ScopeCheck =
  | {
      readonly ok: true;
      readonly value: { readonly ceiling: Money; readonly count: number; readonly expiresOn: string };
      readonly narrowed: boolean;
    }
  | { readonly ok: false; readonly field: 'ceiling' | 'count' | 'expiresOn' };

export function checkScope(draft: ScopeDraft, scope: MandateScopeDraft): ScopeCheck {
  const max = narrowBounds(scope);
  const minor = majorStringToMinor(draft.ceilingMajor, currencyDigits(scope.ceiling.currency));
  // Never above the frozen ceiling. Zero is allowed only when the frozen proposal itself spends nothing
  // (a communications-only mandate); a spending mandate cannot be narrowed to a zero ceiling here.
  if (minor === null || minor > max.ceiling.amountMinor) return { ok: false, field: 'ceiling' };
  if (minor === 0 && max.ceiling.amountMinor !== 0) return { ok: false, field: 'ceiling' };
  const count = Number(draft.count.trim());
  if (!Number.isInteger(count) || count < 1 || count > max.count) return { ok: false, field: 'count' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.expiresOn) || (max.expiresOn && draft.expiresOn > max.expiresOn))
    return { ok: false, field: 'expiresOn' };
  const narrowed = minor < max.ceiling.amountMinor || count < max.count || draft.expiresOn < max.expiresOn;
  return {
    ok: true,
    value: { ceiling: { amountMinor: minor, currency: scope.ceiling.currency }, count, expiresOn: draft.expiresOn },
    narrowed,
  };
}
