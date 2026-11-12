import { describe, expect, it } from 'vitest';
import { translate } from '../../i18n';
import { MISSIONS, perfumeMission } from '../../../tests/ui/fixtures/missions.fixture';
import { buildPaletteItems, filterItems } from './palette';

const ctx = {
  t: (k: Parameters<typeof translate>[1], v?: Parameters<typeof translate>[2]) => translate('en', k, v),
  date: (s: string) => s.slice(0, 10),
  theme: 'light' as const,
  language: 'en' as const,
  canDecide: true,
};

describe('⌘K index', () => {
  const items = buildPaletteItems(perfumeMission(), MISSIONS, ctx);

  it('reaches everything: asks, artifacts, decisions, peeks, missions, settings', () => {
    const groups = new Set(items.map(i => i.group));
    for (const g of ['Ask the Mission Lead', 'Open beside the page', 'Decisions', 'Go to', 'Missions', 'Settings'])
      expect(groups.has(g), g).toBe(true);
    expect(items.find(i => i.id === 'readiness')?.key).toBe('R');
    expect(items.find(i => i.id === 'money')?.key).toBe('M');
    expect(items.find(i => i.id === 'log')?.key).toBe('L');
    expect(items.some(i => i.action.k === 'mission' && i.action.id === 'm2')).toBe(true);
    expect(items.some(i => i.action.k === 'moment')).toBe(true);
    expect(items.some(i => i.id === 'plates')).toBe(true);
  });

  it('offers Change this only for reversible approved decisions, and only to deciders', () => {
    expect(items.filter(i => i.action.k === 'change')).toHaveLength(1);
    const viewer = buildPaletteItems(perfumeMission(), MISSIONS, { ...ctx, canDecide: false });
    expect(viewer.some(i => i.action.k === 'change' || i.action.k === 'status')).toBe(false);
  });

  it('filters while keeping groups together', () => {
    const r = filterItems(items, 'money');
    expect(r[0]?.label.toLowerCase()).toContain('money');
    const seen: string[] = [];
    for (const it of r) if (seen[seen.length - 1] !== it.group) seen.push(it.group);
    expect(new Set(seen).size).toBe(seen.length);
    expect(filterItems(items, 'zzzz-nothing')).toEqual([]);
  });

  it('puts the best match first even when another group matches a common word', () => {
    // "this" also appears in "What has this cost so far?"; Enter must still run the deletion item.
    expect(filterItems(items, 'delete this')[0]?.action.k).toBe('deleteMission');
    expect(filterItems(items, 'readiness')[0]?.id).toBe('readiness');
  });
});
