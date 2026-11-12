import type { ArtifactView, DecisionView, MandateUsage, MandateView, MissionView } from '../../ui-contract';
import type { MomentState } from './uiState';

/** Pure projections of the view for presentation. They never compute binding values. */

export const pendingDecisions = (v: MissionView): DecisionView[] => Object.values(v.decisions).filter(d => d.status === 'pending');

/** Decisions the moment line batches: pending or deferred, in the server's order. */
export function momentDecisionIds(v: MissionView): string[] {
  if (!v.moment) return [];
  return v.moment.decisionIds.filter(id => {
    const d = v.decisions[id];
    return d && (d.status === 'pending' || d.status === 'deferred');
  });
}

/** Decisions referenced by page blocks, in page order. */
export function pageDecisionIds(v: MissionView): string[] {
  const out: string[] = [];
  for (const e of v.entries) for (const b of e.blocks) if (b.k === 'decision' && !out.includes(b.decisionId)) out.push(b.decisionId);
  return out;
}

/** The active decision gets key caps and keyboard shortcuts: the ritual's current one, else the first pending on the page. */
export function activeDecisionId(v: MissionView, moment: MomentState | null): string | null {
  if (moment) {
    const id = moment.ids[moment.index];
    return id && v.decisions[id]?.status === 'pending' ? id : null;
  }
  return pageDecisionIds(v).find(id => v.decisions[id]?.status === 'pending') ?? null;
}

export function usageShare(u: MandateUsage | null): number {
  if (!u) return 0;
  const used = u.kind === 'count' ? u.used : u.used.amountMinor;
  const ceil = u.kind === 'count' ? u.ceiling : u.ceiling.amountMinor;
  return ceil > 0 ? Math.max(0, Math.min(1, used / ceil)) : 0;
}

/** Mandate meters approach their ceiling at 80% (UX 10). */
export const nearCeiling = (m: MandateView): boolean => m.status === 'active' && usageShare(m.usage) >= 0.8;

export const stripMeters = (v: MissionView): MandateView[] => v.money.mandates.filter(m => m.inStrip).slice(0, 2);

export const artifactFor = (v: MissionView, id: string | undefined): ArtifactView | null => (id ? (v.artifacts[id] ?? null) : null);

/** Renderer by artifact type, never by category or phase (UX 5.5). */
export type RendererKind = 'canvas' | 'document' | 'thread';
export const RENDERER: Readonly<Record<ArtifactView['type'], RendererKind>> = {
  comparison: 'canvas',
  visual: 'canvas',
  document: 'document',
  thread: 'thread',
};

export function unreadNotifications(v: MissionView): number {
  return v.notifications.filter(n => !n.read).length;
}
