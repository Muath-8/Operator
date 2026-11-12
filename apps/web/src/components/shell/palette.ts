import type { IconName, MissionSummary, MissionView, Target, Theme, UiLanguage } from '../../ui-contract';
import type { MessageKey } from '../../i18n/en';
import type { Vars } from '../../i18n';

/**
 * ⌘K reaches everything; the composer shows the same index as you type (UX 5.4).
 * Pure: built from the view so the same items exist on every surface.
 */
export type PaletteAction =
  | { readonly k: 'say'; readonly text: string }
  | { readonly k: 'open'; readonly target: Target }
  | { readonly k: 'mission'; readonly id: string }
  | { readonly k: 'newMission' }
  | { readonly k: 'moment' }
  | { readonly k: 'change'; readonly decisionId: string }
  | { readonly k: 'theme'; readonly theme: Theme }
  | { readonly k: 'lang'; readonly lang: UiLanguage }
  | { readonly k: 'chapter' }
  | { readonly k: 'status'; readonly status: 'paused' | 'active' }
  | { readonly k: 'deleteMission' }
  | { readonly k: 'signOut' };

export interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly icon: IconName;
  readonly hint?: string;
  readonly key?: string;
  readonly action: PaletteAction;
}

export interface PaletteContext {
  readonly t: (k: MessageKey, v?: Vars) => string;
  readonly date: (iso: string) => string;
  readonly theme: Theme;
  readonly language: UiLanguage;
  readonly canDecide: boolean;
}

export function buildPaletteItems(v: MissionView, missions: readonly MissionSummary[], c: PaletteContext): PaletteItem[] {
  const { t } = c;
  const items: PaletteItem[] = [];
  const add = (group: string, id: string, label: string, icon: IconName, action: PaletteAction, hint?: string, key?: string) =>
    items.push({ id, group, label, icon, action, ...(hint ? { hint } : {}), ...(key ? { key } : {}) });

  for (const s of v.suggestions) add(t('ask'), `ask:${s}`, s, 'enter', { k: 'say', text: s });

  for (const a of Object.values(v.artifacts))
    add(
      t('open'),
      `art:${a.id}`,
      a.title,
      a.icon,
      { k: 'open', target: { kind: 'artifact', artifactId: a.id } },
      a.status === 'stale' ? t('stale') : undefined,
    );

  const pending = Object.values(v.decisions).filter(d => d.status === 'pending');
  for (const d of pending)
    add(
      t('decisions'),
      `dec:${d.id}`,
      d.question,
      'flag',
      { k: 'open', target: { kind: 'decision', decisionId: d.id } },
      d.needsBy ? (d.binding ? t('by', { date: c.date(d.needsBy) }) : t('defaultBy', { date: c.date(d.needsBy) })) : t('hasDefault'),
    );
  if (v.moment && pending.length > 1) add(t('decisions'), 'moment', t('startMoment'), 'flag', { k: 'moment' }, String(pending.length));
  if (c.canDecide)
    for (const r of v.decisionRecord)
      if (r.canChange && r.decisionId)
        add(t('decisions'), `chg:${r.id}`, t('changePrefix', { text: r.text }), 'undo', { k: 'change', decisionId: r.decisionId });

  add(t('go'), 'readiness', t('readiness'), 'ladder', { k: 'open', target: { kind: 'system', view: 'readiness' } }, undefined, 'R');
  add(t('go'), 'money', t('money'), 'coins', { k: 'open', target: { kind: 'system', view: 'money' } }, undefined, 'M');
  add(
    t('go'),
    'log',
    `${t('log')}: ${t('log_activity').toLowerCase()}, ${t('log_commitments').toLowerCase()}`,
    'list',
    { k: 'open', target: { kind: 'system', view: 'log' } },
    undefined,
    'L',
  );
  add(
    t('go'),
    'notifications',
    t('notifications'),
    'bell',
    { k: 'open', target: { kind: 'system', view: 'notifications' } },
    v.notifications.filter(n => !n.read).length ? String(v.notifications.filter(n => !n.read).length) : undefined,
  );
  if (v.sinceYouLeft) add(t('go'), 'chapter', t('sinceYouLeft', { range: '' }).replace(/,\s*$/, ''), 'clock', { k: 'chapter' });
  if (v.plateSpecimens.length) add(t('go'), 'plates', t('plates'), 'ruler', { k: 'open', target: { kind: 'system', view: 'plates' } });
  add(t('go'), 'record', t('exportRecord'), 'download', { k: 'open', target: { kind: 'system', view: 'record' } });
  add(t('go'), 'accounts', t('accounts'), 'lock', { k: 'open', target: { kind: 'system', view: 'accounts' } });

  for (const m of missions)
    if (m.id !== v.missionId)
      add(
        t('missions'),
        `m:${m.id}`,
        m.untitled ? t('untitled') : `${m.name}, ${m.line}`,
        'doc',
        { k: 'mission', id: m.id },
        m.pendingDecisions ? String(m.pendingDecisions) : undefined,
      );
  add(t('missions'), 'new', t('newMission'), 'plus', { k: 'newMission' });

  add(t('settings'), 'theme', c.theme === 'dark' ? t('themeToLight') : t('themeToDark'), 'moon', {
    k: 'theme',
    theme: c.theme === 'dark' ? 'light' : 'dark',
  });
  add(t('settings'), 'lang', c.language === 'ar' ? t('langToEn') : t('langToAr'), 'globe', {
    k: 'lang',
    lang: c.language === 'ar' ? 'en' : 'ar',
  });
  if (c.canDecide && v.status !== 'ended')
    add(t('settings'), 'pause', v.status === 'paused' ? t('resumeMission') : t('pauseMission'), 'pause', {
      k: 'status',
      status: v.status === 'paused' ? 'active' : 'paused',
    });
  if (v.access.role === 'owner') add(t('settings'), 'delete', t('del_open'), 'close', { k: 'deleteMission' });
  add(t('settings'), 'signout', t('signOut'), 'arrow', { k: 'signOut' });
  return items;
}

export function filterItems(items: readonly PaletteItem[], query: string): PaletteItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const words = q.split(/\s+/).filter(w => w.length > 2);
  const scored = items
    .map(it => {
      const hay = `${it.label} ${it.group}`.toLowerCase();
      let score = 0;
      if (hay.includes(q)) score += 10;
      if (it.label.toLowerCase().startsWith(q)) score += 5;
      for (const w of words) if (hay.includes(w)) score += 2;
      return { it, score };
    })
    .filter(x => x.score > 0);
  // Groups stay together; the group holding the best match leads, so Enter runs the best match.
  const order = new Map(items.map((it, i) => [it.id, i]));
  const best = new Map<string, number>();
  for (const x of scored) best.set(x.it.group, Math.max(best.get(x.it.group) ?? 0, x.score));
  const firstSeen = [...new Set(scored.map(x => x.it.group))];
  const groups = [...firstSeen].sort((a, b) => (best.get(b) ?? 0) - (best.get(a) ?? 0) || firstSeen.indexOf(a) - firstSeen.indexOf(b));
  return groups.flatMap(g =>
    scored
      .filter(x => x.it.group === g)
      .sort((a, b) => b.score - a.score || (order.get(a.it.id) ?? 0) - (order.get(b.it.id) ?? 0))
      .map(x => x.it),
  );
}
