import { describe, expect, it } from 'vitest';
import { checkScope, draftFromScope } from '../components/workspace/scope';

describe('independent mandate scope review: FR-MAN, I-1/I-2', () => {
  const nonSpending = {
    ceiling: { amountMinor: 0, currency: 'SAR' },
    ceilingMax: { amountMinor: 0, currency: 'SAR' },
    count: 4,
    countMax: 4,
    countUnit: 'actions',
    expiresOn: '2026-11-30',
    expiresMax: '2026-11-30',
  };

  it('allows a frozen zero-money communication mandate without inventing spend authority', () => {
    expect(checkScope(draftFromScope(nonSpending), nonSpending)).toMatchObject({
      ok: true,
      narrowed: false,
      value: { ceiling: { amountMinor: 0, currency: 'SAR' }, count: 4 },
    });
  });

  it('never permits a positive ceiling when the frozen proposal authorizes no spend', () => {
    expect(checkScope({ ...draftFromScope(nonSpending), ceilingMajor: '0.01' }, nonSpending)).toEqual({ ok: false, field: 'ceiling' });
  });

  it('rejects a positive draft rounded down to zero for a spending mandate', () => {
    const spending = {
      ...nonSpending,
      ceiling: { amountMinor: 1000, currency: 'SAR' },
      ceilingMax: { amountMinor: 1000, currency: 'SAR' },
    };
    expect(checkScope({ ...draftFromScope(spending), ceilingMajor: '0.001' }, spending)).toEqual({ ok: false, field: 'ceiling' });
  });
});
