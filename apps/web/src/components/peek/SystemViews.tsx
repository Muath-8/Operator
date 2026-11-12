'use client';

import { useState } from 'react';
import { ArchiveDownload } from '../account/PrivacyControls';
import type { MandateView, NotificationSettingsView, StepLabel } from '../../ui-contract';
import { useI18n, type MessageKey } from '../../i18n';
import { shareOf } from '../../i18n/format';
import { Dial } from '../primitives/Dial';
import { Icon } from '../primitives/Icon';
import { EvidenceGlyph, FigureGlyph, FigureText, Legend } from '../primitives/TrustGlyph';
import { Plate } from '../plate/Plate';
import { rowScale } from '../plate/geometry';
import { useWorkspace } from '../workspace/context';
import { nearCeiling, usageShare } from '../workspace/derive';
import { ClosingRecord, CommandNote } from '../page/Blocks';
import { ReadinessObject, currentLevels, levelKey, outcomeKey } from '../page/ReadinessObject';
import { Steps } from '../page/Steps';

/* ---------- Money (UX 7.7) ---------- */

export function MoneyPeek() {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const money = ws.view.money;
  const tt = money.totals;
  const b = tt.budget.amountMinor;
  const fc = tt.forecast.value.kind === 'money' ? tt.forecast.value.amount : null;
  return (
    <div>
      <h2>{t('money')}</h2>
      <div style={{ marginBlockStart: 'var(--sp-5)' }}>
        <div className="big xl">{i18n.money(tt.left)}</div>
        <p className="lead">
          {t('money_left', { budget: i18n.money(tt.budget) })}.{' '}
          {t('money_lead', { spent: i18n.money(tt.spent), committed: i18n.money(tt.committed) })}{' '}
          {t('money_forecastLine', { fc: i18n.figure(tt.forecast.value), head: i18n.money(tt.headroom) })}
        </p>
        <div className="mbar" aria-hidden="true">
          <i className="sp" style={{ inlineSize: `${shareOf(tt.spent.amountMinor, b)}%` }} />
          <i className="co" style={{ inlineSize: `${shareOf(tt.committed.amountMinor, b)}%` }} />
          <i className="fc" style={{ inlineSize: `${shareOf(fc?.amountMinor ?? 0, b)}%` }} />
        </div>
        <ul className="key">
          <li>
            <i className="sp" />
            {t('money_spent', { v: i18n.money(tt.spent) })}
          </li>
          <li>
            <i className="co" />
            {t('money_committed', { v: i18n.money(tt.committed) })}
          </li>
          <li>
            <i className="fc" />
            {t('money_forecast', { v: i18n.figure(tt.forecast.value) })} <FigureGlyph figure={tt.forecast} />
          </li>
        </ul>
      </div>
      <h3 className="sec">
        {t('money_envelopes')} <small>{t('money_envelopesNote')}</small>
      </h3>
      {money.envelopes.length ? (
        <table className="tt">
          <tbody>
            {money.envelopes.map(e => {
              const tot = e.spent.amountMinor + e.committed.amountMinor + e.forecast.amountMinor;
              const over = tot > e.allocated.amountMinor;
              return (
                <tr key={e.id} className={over ? 'over' : undefined}>
                  <th scope="row">{e.name}</th>
                  <td style={{ inlineSize: '30%' }}>
                    <span className="env-bar" aria-hidden="true">
                      <span className="eb">
                        <i className="s" style={{ inlineSize: `${shareOf(e.spent.amountMinor, e.allocated.amountMinor)}%` }} />
                        <i
                          className="f"
                          style={{ inlineSize: `${shareOf(e.forecast.amountMinor + e.committed.amountMinor, e.allocated.amountMinor)}%` }}
                        />
                      </span>
                    </span>
                  </td>
                  <td className={`ev${over ? ' bad' : ''}`} style={{ textAlign: 'end' }}>
                    {i18n.money({ amountMinor: tot, currency: e.allocated.currency })} / {i18n.money(e.allocated, { code: false })}
                    {over ? (
                      <span className="sr">
                        {' '}
                        {t('money_over', { v: i18n.money({ amountMinor: tot - e.allocated.amountMinor, currency: e.allocated.currency }) })}
                      </span>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="foot">{t('money_noEnvelopes')}</p>
      )}
      <h3 className="sec">
        {t('money_mandates')} <small>{t('money_mandatesNote')}</small>
      </h3>
      {money.mandates.length ? money.mandates.map(m => <MandateRow key={m.id} m={m} />) : <p className="foot">{t('money_noMandates')}</p>}
      <h3 className="sec">
        {t('money_receipts')} <small>{t('money_receiptsNote')}</small>
      </h3>
      {money.receipts.length ? (
        money.receipts.map(r => (
          <div key={r.id} className="rcpt">
            <span className="d">{i18n.date(r.at)}</span>
            <span>
              {r.payee}
              <br />
              <span className="r">
                {r.purpose}, {r.reference}
              </span>
            </span>
            <FigureText figure={r.amount} />
          </div>
        ))
      ) : (
        <p className="foot">{t('money_noReceipts')}</p>
      )}
      {money.sandbox ? (
        <section className="sandbox-box" aria-labelledby="sbx">
          <h3 id="sbx">
            {t('money_sandbox')}: <span className="muted">{t('money_sandboxNote')}</span>
          </h3>
          <p className="foot">
            {t('money_spent', { v: i18n.money(money.sandbox.totals.spent) })},{' '}
            {t('money_committed', { v: i18n.money(money.sandbox.totals.committed) })}
          </p>
          {money.sandbox.receipts.map(r => (
            <div key={r.id} className="rcpt">
              <span className="d">{i18n.date(r.at)}</span>
              <span>
                {r.payee}
                <br />
                <span className="r">
                  {r.purpose}, {r.reference}
                </span>
              </span>
              <FigureText figure={r.amount} />
            </div>
          ))}
        </section>
      ) : null}
      <Legend kinds={['planned', 'performed', 'verified']} />
    </div>
  );
}

function MandateRow({ m }: { readonly m: MandateView }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const [confirming, setConfirming] = useState(false);
  const key = `mandate:${m.id}`;
  const st = ws.commandState(key);
  const busy = st?.phase === 'running' || st?.phase === 'awaiting';
  const u = m.usage;
  const cells = u?.kind === 'count' ? Math.min(30, Math.max(1, u.ceiling)) : 10;
  const filled = Math.round(usageShare(u) * cells);
  const value = !u
    ? ''
    : u.kind === 'count'
      ? `${i18n.num(u.used)} / ${i18n.num(u.ceiling)} ${u.unit}`
      : `${i18n.money(u.used)} / ${i18n.money(u.ceiling, { code: false })}`;
  return (
    <div className={`mand${m.status === 'revoked' ? ' revoked' : ''}`}>
      <div className="mt">
        <b>{m.name}</b>
        <span className="num">
          {value}
          {m.status !== 'active' ? <span className="st"> {t(`mandateStatus_${m.status}` as MessageKey)}</span> : null}
          {nearCeiling(m) ? <span className="st"> {t('mandateNear')}</span> : null}
        </span>
      </div>
      <div className="msc">{m.scope}</div>
      {m.revokedNote ? <div className="msc">{m.revokedNote}</div> : null}
      {u ? (
        <div className={`mtr${nearCeiling(m) ? ' near' : ''}`} aria-hidden="true">
          {Array.from({ length: cells }, (_, i) => (
            <i key={i} className={i < filled ? 'f' : ''} />
          ))}
        </div>
      ) : null}
      <div className="acts">
        {m.status === 'requested' && m.requestDecisionId ? (
          <button
            type="button"
            className="btn line sm"
            onClick={e => m.requestDecisionId && ws.open({ kind: 'decision', decisionId: m.requestDecisionId }, e.currentTarget)}
          >
            {t('reviewRequest')}
          </button>
        ) : null}
        {m.status === 'active' && ws.view.access.canGrantMandates ? (
          confirming ? (
            <>
              <span>{t('revokeConfirm', { name: m.name })}</span>
              <button
                type="button"
                className={`btn line sm${busy ? ' busy' : ''}`}
                aria-disabled={busy || undefined}
                onClick={() => {
                  if (busy) return;
                  void ws
                    .run(key, base => ws.commands.setMandateStatus({ ...base, mandateId: m.id, status: 'revoked' }))
                    .then(r => {
                      if (r?.ok) setConfirming(false);
                    });
                }}
              >
                {t('revokeYes', { name: m.name })}
              </button>
              <button type="button" className="btn quiet sm" onClick={() => setConfirming(false)}>
                {t('revokeNo')}
              </button>
            </>
          ) : (
            <button type="button" className="btn quiet sm" onClick={() => setConfirming(true)}>
              {t('revokeMandate')}
            </button>
          )
        ) : null}
      </div>
      <CommandNote state={st} />
    </div>
  );
}

/* ---------- Readiness (UX 9.5, FR-UX-05) ---------- */

export function ReadinessPeek() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const r = ws.view.readiness;
  const levels = currentLevels(r.outcomes);
  const sel = ws.ui.readinessSel;
  const o = sel ? r.outcomes.find(x => x.outcome === sel.outcome) : null;
  const rung = o && sel ? o.rungs.find(x => x.level === sel.level) : null;
  return (
    <div>
      <h2>{t('readiness')}</h2>
      <p className="lead">{t('readinessLead')}</p>
      <div style={{ marginBlockStart: 'var(--sp-5)' }}>
        <ReadinessObject to={levels} blockersFor={r.outcomes.map(x => x.outcome)} big />
      </div>
      {o && sel ? (
        <div className="evl fade-in" aria-live="polite">
          <h3>
            {t(outcomeKey(o.outcome))}, R{sel.level} {t(levelKey(sel.level))}
          </h3>
          <ul>
            {rung && rung.met && rung.evidence.length ? (
              rung.evidence.map(e => (
                <li key={e.id}>
                  <EvidenceGlyph item={e} />
                  <span>{e.text}</span>
                </li>
              ))
            ) : (
              <li>
                {t('rungNotMet')} {rung?.missing ?? o.blocker} {sel.level >= 4 ? t('rungClaimsCap') : ''}
              </li>
            )}
          </ul>
        </div>
      ) : null}
      <Legend />
    </div>
  );
}

/* ---------- Log: activity, waiting on you, commitments, decision record (UX 7.6) ---------- */

const FILTERS: readonly (StepLabel | 'all')[] = [
  'all',
  'planned',
  'performed',
  'claimed',
  'verified',
  'proposed',
  'approved',
  'blocked',
  'failed',
  'corrected',
];

export function LogPeek() {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const v = ws.view;
  const filter = ws.ui.logFilter;
  const ids = v.activityOrder.filter(id => filter === 'all' || v.activity[id]?.label === filter);
  const pending = Object.values(v.decisions).filter(d => d.status === 'pending');
  const commitments = [...v.commitments]
    .filter(c => c.status === 'open')
    .sort((a, b) => b.overdueDays - a.overdueDays || a.due.localeCompare(b.due));
  return (
    <div>
      <h2>{t('log')}</h2>
      <p className="lead">{t('log_lead')}</p>
      <h3 className="sec">
        {t('log_activity')} <small>{t('log_activityNote')}</small>
      </h3>
      <div className="filters" role="group" aria-label={t('log_filterLabel')}>
        {FILTERS.map(f => (
          <button key={f} type="button" aria-pressed={filter === f} onClick={() => ws.dispatch({ type: 'logFilter', filter: f })}>
            {f === 'all' ? t('log_filterAll') : t(`step_${f}` as MessageKey)}
          </button>
        ))}
      </div>
      <Steps ids={ids} scope="log" />
      <h3 className="sec">
        {t('log_waiting')} <small>{pending.length ? i18n.num(pending.length) : t('log_nothing')}</small>
      </h3>
      {pending.map(d => (
        <div key={d.id} className="dl">
          <Icon name="flag" />
          <button type="button" className="tx link" onClick={e => ws.open({ kind: 'decision', decisionId: d.id }, e.currentTarget)}>
            {d.question}
          </button>
          <span className="st">
            {d.needsBy ? (d.binding ? t('by', { date: i18n.date(d.needsBy) }) : t('defaultBy', { date: i18n.date(d.needsBy) })) : ''}
          </span>
        </div>
      ))}
      <h3 className="sec">
        {t('log_commitments')} <small>{t('log_commitmentsNote')}</small>
      </h3>
      {commitments.map(c => (
        <div key={c.id} className="cm">
          <span>
            {c.owedBy}: {c.what}
          </span>
          <span className={`cw${c.overdueDays > 0 ? ' od' : ''}`}>
            {c.overdueDays > 0
              ? c.overdueDays === 1
                ? t('dayOverdue')
                : t('daysOverdue', { n: c.overdueDays })
              : t('due', { date: i18n.date(c.due) })}
          </span>
          {c.escalation ? <span className="cw wide">{t('escalation', { text: c.escalation })}</span> : null}
          {c.help ? <Dial control={c.help} /> : null}
        </div>
      ))}
      <h3 className="sec">
        {t('log_record')} <small>{t('log_recordNote')}</small>
      </h3>
      {v.decisionRecord.map(r => (
        <RecordRow key={r.id} r={r} />
      ))}
    </div>
  );
}

function RecordRow({ r }: { readonly r: ReturnType<typeof useWorkspace>['view']['decisionRecord'][number] }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const key = r.decisionId ? `change:${r.decisionId}` : '';
  const st = key ? ws.commandState(key) : undefined;
  const busy = st?.phase === 'running' || st?.phase === 'awaiting';
  return (
    <div className={`dl ${r.status}`}>
      <Icon name={r.status === 'superseded' ? 'undo' : 'check'} />
      <span className="tx">
        {r.status === 'superseded' ? <span className="sr">{t('superseded')}: </span> : null}
        {r.text}
      </span>
      <span className="st">
        {r.status === 'superseded' ? t('superseded').toLowerCase() : i18n.date(r.at)}
        {r.canChange && r.decisionId ? (
          <button
            type="button"
            className={`btn quiet sm${busy ? ' busy' : ''}`}
            aria-disabled={busy || !ws.canDecide || undefined}
            onClick={() => {
              const id = r.decisionId;
              if (!id || busy || !ws.canDecide) return;
              void ws.run(key, base => ws.commands.requestChange({ ...base, decisionId: id }));
              ws.closePeek();
            }}
          >
            <Icon name="undo" />
            {t('changeThis')}
          </button>
        ) : null}
      </span>
    </div>
  );
}

/* ---------- Notifications (UX 8.5, FR-NOT) ---------- */

export function NotificationsPeek() {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const v = ws.view;
  const unread = v.notifications.filter(n => !n.read).map(n => n.id);
  const key = 'notifications';
  const st = ws.commandState(key);
  const s = v.notificationSettings;
  // Every update sends the whole settings object, so changing one field preserves the others (incl. momentsPerWeek).
  const setSettings = (next: NotificationSettingsView) =>
    void ws.run('notif-settings', base => ws.commands.updateNotificationSettings({ ...base, settings: next }));
  const settingsState = ws.commandState('notif-settings');
  const settingsBusy = settingsState?.phase === 'running' || settingsState?.phase === 'awaiting';
  return (
    <div>
      <h2>{t('notif_title')}</h2>
      <p className="lead">{t('notif_lead')}</p>
      {unread.length ? (
        <div className="doc-actions">
          <button
            type="button"
            className="btn line sm"
            onClick={() => void ws.run(key, base => ws.commands.markNotificationsRead({ ...base, notificationIds: unread }))}
          >
            {t('notif_markRead')}
          </button>
        </div>
      ) : null}
      <CommandNote state={st} />
      {v.notifications.length ? (
        <ul className="notes">
          {v.notifications.map(n => (
            <li key={n.id} className={`note-row${n.read ? '' : ' unread'}`}>
              <Icon
                name={
                  n.kind === 'payment'
                    ? 'coins'
                    : n.kind === 'failure'
                      ? 'close'
                      : n.kind === 'mandate'
                        ? 'lock'
                        : n.kind === 'reply'
                          ? 'mail'
                          : n.kind === 'digest'
                            ? 'list'
                            : 'flag'
                }
              />
              <span className="tx">
                <button type="button" className="link" onClick={e => ws.open(n.target, e.currentTarget)}>
                  <b>{n.title}</b>
                </button>
                {n.amount ? <span className="num"> {i18n.money(n.amount)}</span> : null}
                <span className="why">{n.why}</span>
              </span>
              <span className="st">
                {n.immediate ? t('notif_immediate') : t('notif_digest')}, {i18n.date(n.at)}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="foot">{t('notif_none')}</p>
      )}
      <h3 className="sec">{t('settings')}</h3>
      <div className="settings-grid">
        <label htmlFor="cadence">{t('notif_cadence')}</label>
        <select
          id="cadence"
          value={s.digestCadence}
          disabled={settingsBusy}
          aria-busy={settingsBusy || undefined}
          onChange={e => setSettings({ ...s, digestCadence: e.target.value as NotificationSettingsView['digestCadence'] })}
        >
          {(['daily', 'twice_weekly', 'weekly'] as const).map(c => (
            <option key={c} value={c}>
              {t(`cadence_${c}`)}
            </option>
          ))}
        </select>
        {typeof s.momentsPerWeek === 'number' ? (
          <>
            <label htmlFor="moments">{t('notif_moments')}</label>
            <select
              id="moments"
              value={String(s.momentsPerWeek)}
              aria-describedby="moments-note"
              aria-busy={settingsBusy || undefined}
              disabled={settingsBusy}
              onChange={e => {
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 1 && n <= 7) setSettings({ ...s, momentsPerWeek: n });
              }}
            >
              {[1, 2, 3, 4, 5, 6, 7].map(n => (
                <option key={n} value={n}>
                  {t('notif_momentsN', { n: i18n.num(n) })}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <span className="muted">{t('notif_quiet')}</span>
        <span>{s.quietHours ? `${s.quietHours.from}–${s.quietHours.to}` : t('notif_quietNone')}</span>
      </div>
      {typeof s.momentsPerWeek === 'number' ? (
        <p className="foot" id="moments-note">
          {t('notif_momentsNote')}
        </p>
      ) : null}
      <p className="foot">{t('notif_quietNote')}</p>
      <CommandNote state={ws.commandState('notif-settings')} />
    </div>
  );
}

/* ---------- How drawings are made (UX 7.1) ---------- */

export function PlatesPeek() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const items = ws.view.plateSpecimens;
  const second = items[1] ?? items[0];
  return (
    <div>
      <h2>{t('plates')}</h2>
      <p className="lead">{t('specimens_lead')}</p>
      <div className="gal">
        {items.map(g => (
          <figure key={g.label}>
            <div className="stage">
              <Plate exhibit={g.plate} scale={rowScale([g.plate.spec], 130, 200)} />
            </div>
            <figcaption>
              <b>{g.label}</b>,{' '}
              {t('specimens_parts', { w: g.plate.spec.dims_mm.w, h: g.plate.spec.dims_mm.h, n: g.plate.spec.parts.length })}
            </figcaption>
          </figure>
        ))}
      </div>
      {second ? (
        <>
          <h3 className="sec">{t('specimens_spec', { label: second.label.toLowerCase() })}</h3>
          <pre className="code-spec">
            {JSON.stringify(
              { kind: second.plate.spec.kind, dims_mm: second.plate.spec.dims_mm, parts: second.plate.spec.parts.slice(0, 2) },
              null,
              1,
            ).slice(0, 600)}
          </pre>
        </>
      ) : null}
    </div>
  );
}

/* ---------- Launch Record and closing records (FR-MIS-09/10) ---------- */

export function RecordPeek() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const recs = Object.values(ws.view.closingRecords);
  const st = ws.commandState('export');
  const busy = st?.phase === 'running';
  return (
    <div>
      <h2>{t('launchRecord')}</h2>
      {recs.map(r => (
        <ClosingRecord key={r.id} rec={r} />
      ))}
      {recs.length ? null : <p className="lead">{t('export_zipNote')}</p>}
      {recs.length ? null : (
        <div className="doc-actions">
          {(['zip', 'pdf', 'markdown', 'json'] as const).map((f, i) => (
            <button
              key={f}
              type="button"
              className={`btn ${i === 0 ? 'primary' : 'line'} sm${busy ? ' busy' : ''}`}
              aria-disabled={busy || undefined}
              onClick={() => !busy && void ws.run('export', base => ws.commands.exportLaunchRecord({ ...base, format: f }))}
            >
              {i === 0 ? <Icon name="download" /> : null}
              {i === 0 ? `${t('exportRecord')}, ${t(`export_${f}`)}` : t(`export_${f}`)}
            </button>
          ))}
        </div>
      )}
      <CommandNote state={st} />
      <ArchiveDownload />
    </div>
  );
}
