'use client';

import type { MandateView } from '../../ui-contract';
import { useI18n, type MessageKey } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { MarkGlyph } from '../plate/Plate';
import { useWorkspace } from '../workspace/context';
import { nearCeiling, stripMeters, usageShare } from '../workspace/derive';

/**
 * Status strip (UX 5.1), 32px, full width: mission name (a mission-mark button on phones),
 * the working line with a breathing dot, and two mandate meters. Nothing else, ever.
 */
export function StatusStrip() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const v = ws.view;
  const name = v.header.untitled ? t('untitled') : v.header.name;
  const current = ws.missions.find(m => m.id === v.missionId);
  const state = v.status === 'paused' ? 'paused' : v.working.state;
  const lineLabel: MessageKey =
    state === 'paused'
      ? 'paused'
      : state === 'idle'
        ? 'idle'
        : state === 'waiting'
          ? 'waiting'
          : state === 'blocked'
            ? 'blocked'
            : state === 'planning'
              ? 'planning'
              : 'working';
  const dotClass = state === 'working' || state === 'planning' ? '' : state;
  return (
    <header className="strip">
      <button type="button" className="mbtn" aria-label={t('missionMarkButton', { name })} onClick={() => ws.openPalette()}>
        {current?.icon ? <MarkGlyph mark={current.icon} palette={[]} size={16} ink="currentColor" /> : <Icon name="doc" />}
        <Icon name="chev" className="chev90" />
      </button>
      <button type="button" className="mn" aria-label={t('missionSwitch', { name })} onClick={() => ws.openPalette()}>
        {name}
      </button>
      <div className="working" role="status">
        <i className={`dot ${dotClass}`} aria-hidden="true" />
        <span key={v.working.text}>
          {t(lineLabel)}
          {v.working.text && state !== 'idle' ? (
            <>
              {': '}
              <bdi className="wt">{v.working.text}</bdi>
            </>
          ) : null}
        </span>
      </div>
      {stripMeters(v).map(m => (
        <Meter key={m.id} m={m} />
      ))}
    </header>
  );
}

function Meter({ m }: { readonly m: MandateView }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const pending = m.status === 'requested';
  const revoked = m.status === 'revoked' || m.status === 'expired';
  const u = m.usage;
  const value = !u
    ? ''
    : u.kind === 'count'
      ? `${i18n.num(u.used)}/${i18n.num(u.ceiling)}`
      : `${i18n.money(u.used, { code: ws.language !== 'ar' })}/${i18n.money(u.ceiling, { code: false })}`;
  const unit = u?.kind === 'count' ? u.unit : '';
  const status = pending ? t('mandatePendingTip') : revoked ? t('mandateRevokedTip') : t('mandateActiveTip');
  const near = nearCeiling(m);
  const open = ws.ui.peek?.target.kind === 'system' && ws.ui.peek.target.view === 'money' && !ws.ui.peek.auto;
  return (
    // The accessible name is the visible text plus a screen-reader suffix (label in name, WCAG 2.5.3).
    <button
      type="button"
      className={`meter${pending ? ' pending' : ''}${revoked ? ' revoked' : ''}${near ? ' near' : ''}`}
      data-tip-title={`${t('mandate')}: ${m.name}.`}
      data-tip={`${status}. ${m.scope}`}
      aria-expanded={open}
      onClick={e => (open ? ws.closePeek() : ws.open({ kind: 'system', view: 'money' }, e.currentTarget))}
    >
      <span className="lbl">{m.name}</span>{' '}
      <span className="bar" aria-hidden="true">
        <i style={{ inlineSize: `${pending ? 0 : usageShare(u) * 100}%` }} />
      </span>
      <b className="num">{value}</b>
      {pending ? <em>{t('pending')}</em> : revoked ? <em>{t('revoked')}</em> : null}
      <span className="sr">
        {' '}
        {unit}, {t('mandate').toLowerCase()} {status}
        {near ? `, ${t('mandateNear')}` : ''}
      </span>
    </button>
  );
}
