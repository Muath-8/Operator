'use client';

import { useEffect, useId, useRef, type KeyboardEvent, type Ref } from 'react';
import type { DecisionOptionView, DecisionView } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { RichText, Paragraphs, plainText } from '../primitives/RichText';
import { FigureText } from '../primitives/TrustGlyph';
import { Plate } from '../plate/Plate';
import { rowScale } from '../plate/geometry';
import { useWorkspace } from '../workspace/context';
import { activeDecisionId } from '../workspace/derive';
import { checkScope, draftFromScope, narrowBounds, ownsPayment, ownsScope } from '../workspace/scope';
import { decisionKey, useDecisionActions } from '../workspace/useDecisionActions';

/**
 * Decision block (UX 5.3, 10): question, context, recommended option, hidden options behind
 * "See all n", "Why this?", Defer and the default line. The only bordered block type.
 * It never shows an outcome the ledger has not recorded: while a command runs the block
 * says so, and it collapses to a receipt only when the view reports the resolution.
 */
export function DecisionBlock({ id, inRitual = false }: { readonly id: string; readonly inRitual?: boolean }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const d = ws.view.decisions[id];
  const actions = useDecisionActions();
  const ref = useRef<HTMLDivElement>(null);

  // Flash and scroll when something asks for this decision (palette, pins, links).
  const flash = ws.ui.flash;
  useEffect(() => {
    if (!flash || flash.id !== id || !ref.current) return;
    const el = ref.current;
    el.scrollIntoView({ block: 'center', behavior: ws.reducedMotion ? 'auto' : 'smooth' });
    el.classList.add('flash');
    const first = el.querySelector<HTMLElement>('.btn.primary, .pick[aria-checked="true"], button');
    first?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => el.classList.remove('flash'), 1200);
    return () => window.clearTimeout(timer);
  }, [flash, id, ws.reducedMotion]);

  if (!d) return null;
  if (!inRitual && ws.ui.moment && ws.ui.moment.ids.includes(id) && d.status === 'pending') return null;

  if (d.status === 'superseded') {
    const chosen = d.options.find(o => o.id === d.resolution?.optionId);
    return (
      <div className="done-line superseded" id={`dec-${id}`} ref={ref}>
        <Icon name="undo" />
        <div className="grow">
          <b>{t('superseded')}:</b> <span className="what">{chosen ? <RichText value={chosen.label} /> : d.question}</span>.{' '}
          {d.supersededById ? (
            <button
              type="button"
              className="link"
              onClick={e => ws.open({ kind: 'decision', decisionId: d.supersededById ?? '' }, e.currentTarget)}
            >
              {t('reopenedBelow')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (d.status !== 'pending' && !(d.status === 'deferred' && ws.ui.reopened[id]))
    return <Receipt d={d} innerRef={ref} onChange={() => void actions.change(id)} />;

  return <PendingDecision d={d} inRitual={inRitual} innerRef={ref} />;
}

function Receipt({
  d,
  innerRef,
  onChange,
}: {
  readonly d: DecisionView;
  readonly innerRef: Ref<HTMLDivElement>;
  readonly onChange: () => void;
}) {
  const ws = useWorkspace();
  const { t, dateTime } = useI18n();
  const o = d.options.find(x => x.id === d.resolution?.optionId);
  const changeState = ws.commandState(`change:${d.id}`);
  const changing = changeState?.phase === 'running' || changeState?.phase === 'awaiting';
  if (d.status === 'deferred') {
    return (
      <div className="done-line deferred fade-in" id={`dec-${d.id}`} ref={innerRef}>
        <Icon name="clock" />
        <div className="grow">
          <b>{t('deferredLabel')}:</b> {t('deferredLine', { question: d.question })}
          {d.blocks ? <span className="muted"> {d.blocks}</span> : null}
        </div>
        <button type="button" className="btn quiet sm" onClick={() => ws.dispatch({ type: 'reopen', decisionId: d.id })}>
          {t('decideNow')}
        </button>
      </div>
    );
  }
  const label = d.status === 'rejected' ? t('rejectedLabel') : d.resolution?.how === 'default' ? t('defaultApplied') : t('youChose');
  return (
    <div className="done-line fade-in" id={`dec-${d.id}`} ref={innerRef}>
      <Icon name={d.status === 'rejected' ? 'close' : 'check'} />
      <div className="grow">
        <b>{label}:</b> <span className="what">{o ? <RichText value={o.label} /> : d.question}</span>.{' '}
        {/* The topic keeps receipts distinguishable when option labels are generic. */}
        <span className="muted">
          {d.topic ? `${d.topic.charAt(0).toUpperCase()}${d.topic.slice(1)}${d.resolution ? ', ' : ''}` : ''}
          {d.resolution ? dateTime(d.resolution.at) : ''}
        </span>
        {changeState?.phase === 'error' ? (
          <span className="cnote err" role="alert">
            {t('commandFailed', {
              reason: changeState.error?.code === 'offline' ? t('offlineAction') : (changeState.error?.message ?? ''),
            })}
          </span>
        ) : null}
      </div>
      {d.canChange && d.status === 'approved' ? (
        <button
          type="button"
          className={`btn quiet sm${changing ? ' busy' : ''}`}
          aria-disabled={changing || !ws.canDecide || undefined}
          onClick={() => !changing && onChange()}
        >
          <Icon name="undo" />
          {t('changeThis')}
        </button>
      ) : null}
    </div>
  );
}

function PendingDecision({
  d,
  innerRef,
}: {
  readonly d: DecisionView;
  readonly inRitual: boolean;
  readonly innerRef: Ref<HTMLDivElement>;
}) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const actions = useDecisionActions();
  const uid = useId();
  const optRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const id = d.id;
  const sel = ws.ui.selected[id] ?? d.recommendedOptionId;
  const all = !!ws.ui.showAll[id];
  const whyOpen = !!ws.ui.whyOpen[id];
  const active = activeDecisionId(ws.view, ws.ui.moment) === id;
  const keycaps = active && ws.layout !== 'phone' && ws.canDecide;
  const shown = all ? d.options : d.options.filter(o => o.id === sel);
  const selOpt = d.options.find(o => o.id === sel) ?? d.options[0];
  const cmd = ws.commandState(decisionKey(id));
  const busy = cmd?.phase === 'running' || cmd?.phase === 'awaiting';
  const disabled = busy || !ws.canDecide;
  const meta = d.kind === 'mandate' || d.kind === 'payment' || !d.binding;
  const scopeDraft = d.mandateScope ? (ws.ui.scopes[id] ?? draftFromScope(d.mandateScope)) : null;
  const scopeCheck = d.mandateScope && scopeDraft ? checkScope(scopeDraft, d.mandateScope) : null;
  const showScope = ownsScope(d, sel);

  const primaryLabel = d.payment && ownsPayment(d, sel) ? d.payment.providerActionLabel : (selOpt?.actionLabel ?? '');

  const onOptKey = (e: KeyboardEvent<HTMLButtonElement>, idx: number) => {
    const rtl = i18n.dir === 'rtl';
    const step =
      e.key === 'ArrowDown' || e.key === (rtl ? 'ArrowLeft' : 'ArrowRight')
        ? 1
        : e.key === 'ArrowUp' || e.key === (rtl ? 'ArrowRight' : 'ArrowLeft')
          ? -1
          : 0;
    if (!step || shown.length < 2) return;
    e.preventDefault();
    const next = shown[(idx + step + shown.length) % shown.length];
    if (!next) return;
    ws.dispatch({ type: 'select', decisionId: id, optionId: next.id });
    optRefs.current[next.id]?.focus();
  };

  return (
    <div
      className={`dec${d.stale ? ' stale' : ''}`}
      id={`dec-${id}`}
      ref={innerRef}
      role="group"
      aria-labelledby={`${uid}-q`}
      aria-busy={busy || undefined}
    >
      {meta ? (
        <div className="meta">
          <Icon name={d.kind === 'mandate' || d.kind === 'payment' ? 'coins' : 'clock'} />
          <span>
            {d.kind === 'mandate' ? t('mandate') : d.kind === 'payment' ? t('payment') : t('decision')},{' '}
            {d.binding && d.needsBy ? t('needsBy', { date: i18n.date(d.needsBy, true) }) : t('hasDefault')}
          </span>
        </div>
      ) : null}
      <h3 id={`${uid}-q`}>{d.question}</h3>
      <p className="ctx">
        <RichText value={d.context} />
      </p>
      <div className="opts" role="radiogroup" aria-label={t('options')}>
        {shown.map((o, idx) => (
          <OptionRow
            key={o.id}
            d={d}
            o={o}
            n={d.options.indexOf(o) + 1}
            selected={o.id === sel}
            keycaps={keycaps && all}
            uid={uid}
            disabled={busy}
            btnRef={el => {
              optRefs.current[o.id] = el;
            }}
            onPick={() => ws.dispatch({ type: 'select', decisionId: id, optionId: o.id })}
            onKey={e => onOptKey(e, idx)}
          />
        ))}
      </div>
      {showScope && d.mandateScope && scopeDraft ? <ScopeEditor d={d} uid={uid} disabled={disabled} /> : null}
      {ownsPayment(d, sel) ? <PaymentDetails d={d} /> : null}
      {whyOpen ? <Paragraphs value={d.why} className="why fade-in" /> : null}
      <div className="acts">
        <button
          type="button"
          className={`btn primary${busy ? ' busy' : ''}`}
          aria-disabled={disabled || (showScope && scopeCheck !== null && !scopeCheck.ok) || undefined}
          aria-keyshortcuts={keycaps ? (sel === d.recommendedOptionId ? 'A' : 'Enter') : undefined}
          onClick={() => {
            if (!disabled) void actions.approve(id, sel);
          }}
        >
          {busy ? <span className="spin" aria-hidden="true" /> : null}
          {primaryLabel}
          {keycaps && !busy ? <kbd>{sel === d.recommendedOptionId ? 'A' : '↵'}</kbd> : null}
        </button>
        {d.options.length > 1 ? (
          <button type="button" className="btn quiet" aria-expanded={all} onClick={() => ws.dispatch({ type: 'showAll', decisionId: id })}>
            {all ? t('recommendedOnly') : t('seeAll', { n: d.options.length })}
          </button>
        ) : null}
        <button type="button" className="btn quiet" aria-expanded={whyOpen} onClick={() => ws.dispatch({ type: 'why', decisionId: id })}>
          {t('why')}
        </button>
        {d.status === 'pending' ? (
          <button
            type="button"
            className="btn quiet"
            aria-disabled={disabled || undefined}
            aria-keyshortcuts={keycaps ? 'D' : undefined}
            onClick={() => {
              if (!disabled) void actions.defer(id);
            }}
          >
            {t('defer')}
            {keycaps ? <kbd>D</kbd> : null}
          </button>
        ) : null}
      </div>
      {cmd ? (
        <p className={`status${cmd.phase === 'error' ? ' err' : ''}`} role={cmd.phase === 'error' ? 'alert' : 'status'}>
          {cmd.phase === 'running' ? (
            <>
              <span className="spin" aria-hidden="true" />
              {t('approving')}
            </>
          ) : cmd.phase === 'awaiting' ? (
            t('waitingForLedger')
          ) : (
            <>
              {t('commandFailed', { reason: cmd.error?.code === 'offline' ? t('offlineAction') : (cmd.error?.message ?? '') })}
              {cmd.error?.retryable ? (
                <button type="button" className="btn line sm" onClick={() => void actions.approve(id, sel)}>
                  {t('tryAgain')}
                </button>
              ) : null}
            </>
          )}
        </p>
      ) : !ws.canDecide ? (
        <p className="status">{ws.view.status === 'ended' ? t('endedBanner') : (ws.view.access.reason ?? t('permissionDecide'))}</p>
      ) : null}
      <p className="dflt">{d.defaultLine}</p>
    </div>
  );
}

function OptionRow(props: {
  readonly d: DecisionView;
  readonly o: DecisionOptionView;
  readonly n: number;
  readonly selected: boolean;
  readonly keycaps: boolean;
  readonly uid: string;
  readonly disabled: boolean;
  readonly btnRef: (el: HTMLButtonElement | null) => void;
  readonly onPick: () => void;
  readonly onKey: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const { d, o, n, selected, keycaps, uid, disabled } = props;
  const { t } = useI18n();
  const lid = `${uid}-ol-${o.id}`;
  const did = `${uid}-od-${o.id}`;
  const scale = o.visual ? rowScale([o.visual.spec], 34, 40) : 1;
  // The whole option is one radio button; trust glyphs inside are described children, not controls.
  return (
    <button
      ref={props.btnRef}
      type="button"
      className={`opt${selected ? ' sel' : ''}`}
      role="radio"
      aria-checked={selected}
      tabIndex={selected ? 0 : -1}
      aria-labelledby={lid}
      aria-describedby={did}
      aria-disabled={disabled || undefined}
      onClick={props.onPick}
      onKeyDown={props.onKey}
    >
      <span className="radio" aria-hidden="true" />
      <span className="ol" id={lid}>
        <RichText value={o.label} interactive={false} />
      </span>
      <span className="rec">
        {o.id === d.recommendedOptionId ? t('recommended') : ''}
        {keycaps ? <kbd aria-hidden="true">{n}</kbd> : null}
      </span>
      <span className="od" id={did}>
        <RichText value={o.description} interactive={false} />
        {o.cost ? (
          <>
            {' '}
            <FigureText figure={o.cost} interactive={false} />
          </>
        ) : null}
        {o.effects.length ? (
          <span className="fx">
            {o.effects.map(f => (
              <span key={f.label}>
                <i>{f.label}</i> {f.value}
              </span>
            ))}
          </span>
        ) : null}
      </span>
      {o.visual ? (
        <span className="viz">
          <Plate exhibit={o.visual} scale={scale} dims={false} decorative />
          <span>{o.visual.spec.code ?? ''}</span>
        </span>
      ) : null}
    </button>
  );
}

/**
 * Mandate scope, editable only narrower than the frozen draft. Shown only while an option that owns the
 * draft (`mandateScope.optionIds`, see ownsScope) is selected, so no other option appears to carry it.
 */
function ScopeEditor({ d, uid, disabled }: { readonly d: DecisionView; readonly uid: string; readonly disabled: boolean }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const s = d.mandateScope;
  if (!s) return null;
  const draft = ws.ui.scopes[d.id] ?? draftFromScope(s);
  const check = checkScope(draft, s);
  const max = narrowBounds(s);
  const set = (patch: Partial<typeof draft>) => ws.dispatch({ type: 'scope', decisionId: d.id, draft: { ...draft, ...patch } });
  const bad = (f: 'ceiling' | 'count' | 'expiresOn') => (!check.ok && check.field === f ? true : undefined);
  return (
    <fieldset className="scope" aria-describedby={`${uid}-scope`}>
      <legend className="scope-h">{t('scopeEdit')}</legend>
      {max.ceiling.amountMinor === 0 ? (
        // Communications-only mandate: no spend authority to narrow, so no money field to edit.
        <p className="scope-fixed">
          <span>{t('scopeCeiling')}</span>
          <b>{t('scopeNoSpend')}</b>
        </p>
      ) : (
        <label>
          {t('scopeCeiling')} ({s.ceiling.currency})
          <input
            inputMode="decimal"
            value={draft.ceilingMajor}
            aria-invalid={bad('ceiling')}
            disabled={disabled}
            onChange={e => set({ ceilingMajor: e.target.value })}
          />
          <small>{t('scopeLimit', { v: i18n.money(max.ceiling) })}</small>
        </label>
      )}
      <label>
        {t('scopeCount')} ({s.countUnit})
        <input
          inputMode="numeric"
          value={draft.count}
          aria-invalid={bad('count')}
          disabled={disabled}
          onChange={e => set({ count: e.target.value })}
        />
        <small>{t('scopeLimit', { v: i18n.num(max.count) })}</small>
      </label>
      <label>
        {t('scopeExpiry')}
        <input
          type="date"
          value={draft.expiresOn}
          max={max.expiresOn || undefined}
          aria-invalid={bad('expiresOn')}
          disabled={disabled}
          onChange={e => set({ expiresOn: e.target.value })}
        />
        <small>{max.expiresOn ? t('scopeLimit', { v: i18n.date(max.expiresOn) }) : ''}</small>
      </label>
      <ul className="scope-facts">
        {s.perItemCeiling && s.perItemCeiling.amountMinor > 0 ? <li>{t('scopePerItem', { v: i18n.money(s.perItemCeiling) })}</li> : null}
        {s.channels?.length ? <li>{t('scopeChannels', { v: s.channels.join(t('comma').trim() + ' ') })}</li> : null}
        <li>{check.ok && check.narrowed ? t('scopeNarrowed') : t('scopeNarrowOnly')}</li>
      </ul>
      {!check.ok ? (
        <p className="scope-err" id={`${uid}-scope`} role="alert">
          {max.ceiling.amountMinor === 0
            ? t('scopeInvalidCount', { cmax: i18n.num(max.count) })
            : t('scopeInvalid', { max: i18n.money(max.ceiling), cmax: i18n.num(max.count) })}
        </p>
      ) : (
        <span id={`${uid}-scope`} className="sr">
          {t('scopeNarrowOnly')}
        </span>
      )}
    </fieldset>
  );
}

function PaymentDetails({ d }: { readonly d: DecisionView }) {
  const p = d.payment;
  const i18n = useI18n();
  const { t } = i18n;
  if (!p) return null;
  return (
    <>
      <dl className="pay">
        <dt>{t('paymentPayee')}</dt>
        <dd>
          {p.payee}, {p.purpose}
        </dd>
        <dt>{t('paymentAmount')}</dt>
        <dd>
          <FigureText figure={p.amount} className="amt" />
        </dd>
        {p.converted ? (
          <>
            <dt>{t('paymentConverted')}</dt>
            <dd>
              {i18n.money(p.converted.amount)}{' '}
              <span className="muted">
                ({p.converted.rate}, {p.converted.rateSource.label})
              </span>
            </dd>
          </>
        ) : null}
        <dt>{t('paymentMandate')}</dt>
        <dd>{p.mandate ?? t('paymentNoMandate')}</dd>
        <dt>{t('paymentInstrument')}</dt>
        <dd>{p.instrumentLabel}</dd>
      </dl>
      <p className="pay-note">
        {t('paymentRedirect')} {p.sandbox ? t('paymentSandbox') : null}
      </p>
    </>
  );
}

export const decisionPlain = (d: DecisionView): string => `${d.question} ${plainText(d.context)}`;
