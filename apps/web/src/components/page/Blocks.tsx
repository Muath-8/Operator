'use client';

import type { ArtifactThumbnail, ChangeRow, ClosingRecordView, ExportFormat, KitView, QuestionView } from '../../ui-contract';
import { useI18n, type MessageKey } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { RichText, Paragraphs } from '../primitives/RichText';
import { EvidenceGlyph, FigureText, TrustGlyph } from '../primitives/TrustGlyph';
import { Plate } from '../plate/Plate';
import { rowScale } from '../plate/geometry';
import { useWorkspace } from '../workspace/context';
import { shareOf } from '../../i18n/format';
import { outcomeKey, levelKey } from './ReadinessObject';

/* ---------- embeds ---------- */

export function Thumbnail({ thumb }: { readonly thumb: ArtifactThumbnail }) {
  if (thumb.kind === 'plates' && thumb.plates?.length) {
    const s = rowScale(
      thumb.plates.map(p => p.spec),
      50,
      Math.max(20, 96 / thumb.plates.length),
    );
    return (
      <span className="row">
        {thumb.plates.map((p, i) => (
          <Plate key={i} exhibit={p} scale={s} dims={false} text={false} decorative />
        ))}
      </span>
    );
  }
  if (thumb.kind === 'swatches' && thumb.swatches?.length) {
    return (
      <span className="swatches" aria-hidden="true">
        {thumb.swatches.map((sw, i) => (
          <span key={i} style={{ background: sw[0] ?? 'transparent' }} />
        ))}
      </span>
    );
  }
  return <Icon name={thumb.icon ?? 'doc'} />;
}

/** Artifact embed (UX 5.3): hidden on wide screens when the same artifact is open beside the page. */
export function Embed({ artifactId }: { readonly artifactId: string }) {
  const ws = useWorkspace();
  const { t, num } = useI18n();
  const a = ws.view.artifacts[artifactId];
  if (!a) return null;
  // An agent-opened (auto) peek is hidden below 1280px, so it doesn't count as "open beside the page" there.
  const peekVisible = !!ws.ui.peek && (!ws.ui.peek.auto || ws.layout === 'side');
  const inPeek = peekVisible && ws.ui.peek?.target.kind === 'artifact' && ws.ui.peek.target.artifactId === artifactId;
  const version = a.versions.find(v => v.id === a.currentVersionId);
  return (
    <button
      type="button"
      className={`embed${inPeek ? ' open in-peek' : ''}${ws.ui.peek?.auto ? ' auto' : ''}`}
      onClick={e => ws.open({ kind: 'artifact', artifactId }, e.currentTarget)}
    >
      <span className="thumb">{a.generating ? <span className="sk" /> : <Thumbnail thumb={a.embed.thumbnail} />}</span>
      <span>
        <span className="et">
          {a.title}
          {version && a.versions.length > 1 && !new RegExp(`\\bv${version.versionNo}\\b`).test(a.title) ? (
            <span className="muted"> {t('versionLabel', { n: num(version.versionNo) })}</span>
          ) : null}
          {a.status === 'stale' ? <small>{t('embedStale')}</small> : a.generating ? <small>{t('embedGenerating')}</small> : null}
        </span>
        <span className="es">{a.generating ? a.generating.label : a.embed.subtitle}</span>
      </span>
      <span className="go">{inPeek ? t('open') : <Icon name="expand" />}</span>
    </button>
  );
}

/* ---------- what changed ---------- */

export function Changes({
  rows,
  title,
  animate,
}: {
  readonly rows: readonly ChangeRow[];
  readonly title?: string;
  readonly animate: boolean;
}) {
  const ws = useWorkspace();
  const { t } = useI18n();
  const heading = title ?? t('whatChanged');
  return (
    <div className="chg">
      <div className="ch" aria-hidden="true">
        <span>{heading}</span>
        <span>{rows.length === 1 ? t('changeCount') : t('changesCount', { n: rows.length })}</span>
      </div>
      <table>
        <caption className="sr">{heading}</caption>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.id}
              className={animate ? 'row-in' : undefined}
              style={animate && !ws.reducedMotion ? { animationDelay: `calc(var(--stagger) * ${i})` } : undefined}
            >
              <th scope="row">
                {r.target ? (
                  <button type="button" className="link" onClick={e => r.target && ws.open(r.target, e.currentTarget)}>
                    {r.label}
                  </button>
                ) : (
                  r.label
                )}
              </th>
              <td className="from">{r.from}</td>
              <td className="arr" aria-hidden="true">
                <Icon name="arrow" />
              </td>
              <td className={`to ${r.direction === 'neutral' ? '' : r.direction}`}>
                <span className="sr">{r.from ? ', ' : ''}</span>
                {r.to}
                {r.receipt ? <EvidenceGlyph item={r.receipt} /> : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ---------- impact analysis for "Change this" ---------- */

export function Impact({ impactId }: { readonly impactId: string }) {
  const ws = useWorkspace();
  const { t } = useI18n();
  const p = ws.view.impacts[impactId];
  if (!p) return null;
  if (p.status !== 'open') {
    return (
      <div className="done-line">
        <Icon name={p.status === 'kept' ? 'check' : 'undo'} />
        <div className="grow">{p.status === 'kept' ? t('impactKept') : <b>{t('impactConfirmed')}</b>}</div>
      </div>
    );
  }
  const key = `impact:${impactId}`;
  const st = ws.commandState(key);
  const busy = st?.phase === 'running' || st?.phase === 'awaiting';
  const disabled = busy || !ws.canDecide;
  return (
    <div className="impact" aria-busy={busy || undefined}>
      <h4>{p.title}</h4>
      <dl>
        <dt>{t('impactStale')}</dt>
        <dd>{p.stale.length ? p.stale.join('; ') : t('impactNothing')}</dd>
        {p.secondOrder.length ? (
          <>
            <dt>{t('impactSecond')}</dt>
            <dd>
              <ul>
                {p.secondOrder.map(s => (
                  <li key={s.label}>
                    {s.label} <span className="via">{s.via}</span>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        ) : null}
        <dt>{t('impactReadiness')}</dt>
        <dd>
          {p.readiness.length
            ? p.readiness
                .map(r => t('impactLevel', { outcome: t(outcomeKey(r.outcome)), to: r.to, name: t(levelKey(r.to)), from: r.from }))
                .join('; ')
            : t('impactNoChange')}
        </dd>
        <dt>{t('impactCost')}</dt>
        <dd>{p.cost}</dd>
        <dt>{t('impactTime')}</dt>
        <dd>{p.time}</dd>
        <dt>{t('impactRedo')}</dt>
        <dd>{p.redo.length ? p.redo.join('; ') : t('impactNothing')}</dd>
      </dl>
      <div className="acts">
        <button
          type="button"
          className={`btn primary${busy ? ' busy' : ''}`}
          aria-disabled={disabled || undefined}
          onClick={() => !disabled && void ws.run(key, base => ws.commands.confirmChange({ ...base, impactId }))}
        >
          {busy ? <span className="spin" aria-hidden="true" /> : null}
          {p.confirmLabel}
        </button>
        <button
          type="button"
          className="btn quiet"
          aria-disabled={disabled || undefined}
          onClick={() => !disabled && void ws.run(key, base => ws.commands.keepDecision({ ...base, impactId }))}
        >
          {t('impactKeep')}
        </button>
      </div>
      <CommandNote state={st} />
    </div>
  );
}

export function CommandNote({ state }: { readonly state: ReturnType<ReturnType<typeof useWorkspace>['commandState']> }) {
  const { t } = useI18n();
  if (!state) return null;
  if (state.phase === 'error')
    return (
      <p className="cnote err" role="alert">
        {t('commandFailed', { reason: state.error?.code === 'offline' ? t('offlineAction') : (state.error?.message ?? '') })}
      </p>
    );
  if (state.phase === 'awaiting')
    return (
      <p className="cnote" role="status">
        {t('waitingForLedger')}
      </p>
    );
  return null;
}

/* ---------- questions with defaults ---------- */

export function Question({ q }: { readonly q: QuestionView }) {
  const ws = useWorkspace();
  const { t } = useI18n();
  const key = `question:${q.id}`;
  const st = ws.commandState(key);
  const busy = st?.phase === 'running' || st?.phase === 'awaiting';
  const answer = (text: string, skipped: boolean) => {
    if (busy || !ws.canMessage) return;
    void ws.run(key, base => ws.commands.answerQuestion({ ...base, questionId: q.id, answer: text, skipped }));
  };
  if (q.status !== 'open') {
    return (
      <div className="ask">
        <div className="prose">
          <p>
            <RichText value={q.prompt} />
          </p>
        </div>
        <p className="done">
          {q.status === 'skipped' ? t('skipped', { a: q.answer ?? q.recommended }) : t('answered', { a: q.answer ?? '' })}
        </p>
      </div>
    );
  }
  return (
    <div className="ask" aria-busy={busy || undefined}>
      <div className="prose">
        <p>
          <RichText value={q.prompt} />
        </p>
      </div>
      <fieldset className="choices">
        <legend>
          {t('questionOf', { i: q.index, n: q.total })}. <span className="sr">{t('defaultAnnounced', { a: q.recommended })}</span>
        </legend>
        {q.options.map(o => (
          <button
            key={o}
            type="button"
            className={`chip${o === q.recommended ? ' rec' : ''}`}
            aria-disabled={busy || undefined}
            onClick={() => answer(o, false)}
          >
            {o}
            {o === q.recommended ? <small>{t('recommended')}</small> : null}
          </button>
        ))}
        <button type="button" className="btn quiet sm" aria-disabled={busy || undefined} onClick={() => answer(q.recommended, true)}>
          {t('skipUseRecommended')}
        </button>
      </fieldset>
      <CommandNote state={st} />
    </div>
  );
}

/* ---------- one-page kit (Help me do it) ---------- */

/** The four parts a one-page kit must have (FR-EASE-07). Returns the missing ones. */
export function kitMissing(kit: KitView): ('where' | 'enter' | 'bring' | 'verify')[] {
  const missing: ('where' | 'enter' | 'bring' | 'verify')[] = [];
  if (!kit.where.label.trim()) missing.push('where');
  if (!kit.enter.some(x => x.trim())) missing.push('enter');
  if (!kit.bring.some(x => x.trim())) missing.push('bring');
  if (!kit.verify.trim()) missing.push('verify');
  return missing;
}

const httpsOnly = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && !u.username && !u.password ? u.href : null;
  } catch {
    return null;
  }
};

export function Kit({ kit }: { readonly kit: KitView }) {
  const { t } = useI18n();
  const missing = kitMissing(kit);
  if (missing.length) {
    // An incomplete kit is never presented as a task to do.
    return (
      <section className="kit incomplete" aria-labelledby={`kit-${kit.id}`}>
        <h3 id={`kit-${kit.id}`}>{kit.title}</h3>
        <p className="cnote err" role="status">
          {t('kit_incomplete', { parts: missing.map(p => t(`kit_${p}` as MessageKey).toLowerCase()).join(t('comma').trim() + ' ') })}
        </p>
      </section>
    );
  }
  const url = httpsOnly(kit.where.url);
  return (
    <section className="kit" aria-labelledby={`kit-${kit.id}`}>
      <h3 id={`kit-${kit.id}`}>
        {kit.title}
        <small>
          {/* 0 means the estimate is unknown: show none rather than a fabricated "0 minutes". */}
          {kit.estimateMinutes > 0 ? `${t('kit_minutes', { n: kit.estimateMinutes })}, ` : ''}
          {t(`kitStatus_${kit.status}` as MessageKey)}
        </small>
      </h3>
      <dl>
        <dt>{t('kit_where')}</dt>
        <dd>
          {url ? (
            <a className="link" href={url} target="_blank" rel="noopener noreferrer">
              {kit.where.label}
            </a>
          ) : (
            kit.where.label
          )}
        </dd>
        <dt>{t('kit_enter')}</dt>
        <dd>
          <ol>
            {kit.enter.map(x => (
              <li key={x}>{x}</li>
            ))}
          </ol>
        </dd>
        <dt>{t('kit_bring')}</dt>
        <dd>
          <ul>
            {kit.bring.map(x => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </dd>
        <dt>{t('kit_verify')}</dt>
        <dd>{kit.verify}</dd>
      </dl>
    </section>
  );
}

/* ---------- closing record and Launch Record export ---------- */

export function ClosingRecord({ rec }: { readonly rec: ClosingRecordView }) {
  const ws = useWorkspace();
  const { t, dateTime } = useI18n();
  const key = 'export';
  const st = ws.commandState(key);
  const busy = st?.phase === 'running';
  const doExport = (format: ExportFormat) => {
    if (busy) return;
    void ws.run(key, base => ws.commands.exportLaunchRecord({ ...base, format }));
  };
  return (
    <section className="closing" aria-labelledby={`cr-${rec.id}`}>
      <h3 id={`cr-${rec.id}`}>
        {t('closing_title')}: {t(`terminal_${rec.terminal}` as MessageKey)}, {dateTime(rec.decidedAt)}
      </h3>
      <Paragraphs value={rec.summary} />
      {rec.openCommitments.length ? (
        <>
          <h4>{t('closing_open')}</h4>
          <ul>
            {rec.openCommitments.map(c => (
              <li key={c.commitmentId}>
                <b>{c.what}</b>. {c.recommendedAction}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {rec.accounts.length ? (
        <>
          <h4>{t('closing_accounts')}</h4>
          <ul>
            {rec.accounts.map(a => (
              <li key={a.name}>
                {a.name}: {a.owner}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {rec.exportFormats.includes('zip') ? <p className="foot">{t('export_zipNote')}</p> : null}
      <div className="acts">
        {[...rec.exportFormats]
          .sort((a, b) => Number(b === 'zip') - Number(a === 'zip'))
          .map((f, i) => (
            <button
              key={f}
              type="button"
              className={`btn ${i === 0 ? 'primary' : 'line'}${busy ? ' busy' : ''}`}
              aria-disabled={busy || undefined}
              onClick={() => doExport(f)}
            >
              {i === 0 ? <Icon name="download" /> : null}
              {i === 0 ? `${t('closing_export')}, ${t(`export_${f}` as MessageKey)}` : t(`export_${f}` as MessageKey)}
            </button>
          ))}
      </div>
      {busy ? <p className="cnote">{t('closing_exporting')}</p> : <CommandNote state={st} />}
    </section>
  );
}

/* ---------- money on the page ---------- */

export function MoneyBlock() {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const m = ws.view.money.totals;
  const b = m.budget.amountMinor;
  const fcMinor = m.forecast.value.kind === 'money' ? m.forecast.value.amount.amountMinor : 0;
  return (
    <div className="mb">
      <div>
        <div className="big">{i18n.money(m.left)}</div>
        <div className="sub">{t('money_left', { budget: i18n.money(m.budget) })}</div>
      </div>
      <div>
        <div className="sub">
          {t('money_forecastLine', { fc: i18n.figure(m.forecast.value), head: i18n.money(m.headroom) })}
          <TrustGlyph trust={m.forecast.trust} detail={`${m.forecast.source.label}. ${m.forecast.note ?? ''}`} />
        </div>
        <div className="mbar" aria-hidden="true">
          <i className="sp" style={{ inlineSize: `${shareOf(m.spent.amountMinor, b)}%` }} />
          <i className="co" style={{ inlineSize: `${shareOf(m.committed.amountMinor, b)}%` }} />
          <i className="fc" style={{ inlineSize: `${shareOf(fcMinor, b)}%` }} />
        </div>
      </div>
    </div>
  );
}

/* ---------- empty page, suggestions, skeletons ---------- */

export function EmptyBlock({ text }: { readonly text: string }) {
  return (
    <div className="empty">
      <svg width="72" height="48" viewBox="0 0 72 48" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden="true">
        <rect x="4" y="4" width="28" height="20" rx="2" />
        <rect x="40" y="4" width="28" height="20" rx="2" strokeDasharray="3 3" />
        <rect x="4" y="30" width="64" height="14" rx="2" strokeDasharray="3 3" />
      </svg>
      <div>{text}</div>
    </div>
  );
}

export function Suggestions({ items }: { readonly items: readonly string[] }) {
  const ws = useWorkspace();
  const { t } = useI18n();
  return (
    <div className="mline" role="group" aria-label={t('suggestionsLabel')}>
      {items.map(a => (
        <button
          key={a}
          type="button"
          className="chip"
          aria-disabled={!ws.canMessage || undefined}
          onClick={() => ws.canMessage && void ws.send(a)}
        >
          {a}
        </button>
      ))}
    </div>
  );
}

export function SkeletonBlock({ label, height }: { readonly label: string; readonly height: number }) {
  return (
    <div className="sk" style={{ blockSize: height }} role="status" aria-label={label}>
      <span className="sk-cpt" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

export { FigureText };
