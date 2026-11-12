'use client';

import type { FrameBody as FrameBodyValue, ShelfItem } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { shareOf } from '../../i18n/format';
import { Paragraphs, RichText } from '../primitives/RichText';
import { FigureGlyph, FigureText, Legend } from '../primitives/TrustGlyph';
import { MarkGlyph, Plate } from '../plate/Plate';
import { rowScale } from '../plate/geometry';
import { useWorkspace } from '../workspace/context';

/**
 * Frame bodies are chosen by body kind, never by product. A shelf is any set of quoted items
 * drawn to one millimetre scale; an identity is any brand direction; plates are any drawings.
 */
export function FrameBody({ body, phone, title }: { readonly body: FrameBodyValue; readonly phone: boolean; readonly title: string }) {
  switch (body.k) {
    case 'shelf':
      return <Shelf body={body} phone={phone} />;
    case 'table':
      return <TableBody body={body} />;
    case 'identity':
      return <Identity body={body} title={title} />;
    case 'plates': {
      if (body.generating) {
        return (
          <div className="sk sk-plates" role="status" aria-label={body.generating.label}>
            <span className="sk-cpt" aria-hidden="true">
              {body.generating.label}
            </span>
          </div>
        );
      }
      const s = rowScale(
        body.items.map(p => p.spec),
        phone ? 170 : 250,
        (phone ? 170 : 250) * 1.1,
      );
      return (
        <>
          <div className="plates-frame">
            {body.items.map((p, i) => (
              <Plate key={i} exhibit={p} scale={s} />
            ))}
          </div>
          <p className="frame-cap">{body.caption}</p>
        </>
      );
    }
    case 'choices':
      return <Choices body={body} />;
    case 'rich':
      return <Paragraphs value={body.paragraphs} />;
  }
}

function Shelf({ body, phone }: { readonly body: Extract<FrameBodyValue, { k: 'shelf' }>; readonly phone: boolean }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const n = body.items.length;
  const colW = phone ? Math.max(60, 300 / n - 22) : 150;
  const s = rowScale(
    body.items.map(q => q.plate.spec),
    phone ? 150 : 210,
    colW,
  );
  const arth = Math.ceil(Math.max(...body.items.map(q => q.plate.spec.dims_mm.h)) * s + 36);
  const limit = body.limit?.value ?? null;
  const max = Math.max(limit ?? 0, ...body.items.map(q => q.quantityValue)) * 1.08;
  const pct = (v: number) => `${shareOf(v, max).toFixed(1)}%`;
  const decision = body.decisionId ? ws.view.decisions[body.decisionId] : null;
  // Highlight a column only once the founder picks it; the tag row already marks the recommendation.
  const selected = decision ? (ws.ui.selected[decision.id] ?? null) : null;

  const pick = (q: ShelfItem, el: HTMLElement) => {
    if (decision && decision.status === 'pending' && q.decisionOptionId) {
      ws.dispatch({ type: 'select', decisionId: decision.id, optionId: q.decisionOptionId });
      if (q.decisionOptionId !== decision.recommendedOptionId) ws.dispatch({ type: 'showAll', decisionId: decision.id, value: true });
      ws.open({ kind: 'decision', decisionId: decision.id }, el);
    } else if (decision) {
      ws.open({ kind: 'decision', decisionId: decision.id }, el);
    }
  };

  return (
    <div className="shelf" style={{ ['--n' as string]: n, ['--arth' as string]: `${arth}px` }}>
      {body.items.map(q => {
        const over = limit !== null && q.quantityValue > limit;
        const isSel = !!q.decisionOptionId && q.decisionOptionId === selected && decision?.status === 'pending';
        return (
          <button
            key={q.id}
            type="button"
            className={`col${isSel || q.tag === 'chosen' ? ' sel' : ''}`}
            aria-pressed={isSel || q.tag === 'chosen'}
            onClick={e => pick(q, e.currentTarget)}
          >
            <span className="tag">{q.tag === 'chosen' ? t('chosen') : q.tag === 'recommended' ? t('recommended') : ''}</span>
            <span className="art">
              <Plate exhibit={q.plate} scale={s} recommended={q.tag !== null} />
            </span>
            <span className="sup">{q.title}</span>
            <span className="loc">{q.subtitle}</span>
            <span className="px">
              {q.price.value.kind === 'money' ? (
                <>
                  <bdi className="num">{i18n.money(q.price.value.amount, { code: false, exact: true })}</bdi>
                  <small>{q.price.value.amount.currency}</small>
                  <FigureGlyph figure={q.price} interactive={false} />
                </>
              ) : (
                <FigureText figure={q.price} interactive={false} />
              )}
            </span>
            <span className="moq" aria-hidden="true">
              <i style={{ inlineSize: pct(limit !== null ? Math.min(q.quantityValue, limit) : q.quantityValue) }} />
              {over && limit !== null ? (
                <i className="over" style={{ insetInlineStart: pct(limit), inlineSize: pct(q.quantityValue - limit) }} />
              ) : null}
              {limit !== null ? <span className="lim" style={{ insetInlineStart: pct(limit) }} /> : null}
            </span>
            <span className={`cpt${q.captionTone === 'warning' || over ? ' warning' : ''}`}>{q.caption}</span>
          </button>
        );
      })}
    </div>
  );
}

function TableBody({ body }: { readonly body: Extract<FrameBodyValue, { k: 'table' }> }) {
  const ws = useWorkspace();
  const { t } = useI18n();
  return (
    <>
      <table className="tt">
        <thead>
          <tr>
            <td />
            {body.columns.map(c => (
              <th key={c.id} scope="col" className={c.highlight ? 'rc' : undefined}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.rows.map(r => {
            const g = r.termId ? ws.view.glossary[r.termId] : undefined;
            return (
              <tr key={r.label}>
                <th scope="row">{g ? <RichText value={[{ t: 'term', text: r.label, termId: r.termId ?? '' }]} /> : r.label}</th>
                {r.cells.map((c, i) => {
                  const col = body.columns[i];
                  const cls = [c.unobserved ? 'no' : '', c.tone === 'warning' ? 'bad' : '', col?.highlight ? 'rc' : '']
                    .filter(Boolean)
                    .join(' ');
                  return (
                    <td key={i} className={cls || undefined} {...(c.why ? { 'data-tip': c.why } : {})}>
                      {c.unobserved ? t('notObserved') : c.figure ? <FigureText figure={c.figure} /> : c.text}
                      {c.notes?.map((nt, j) => (
                        <div key={j} className="note">
                          <RichText value={nt} />
                        </div>
                      ))}
                      {c.why ? <span className="sr"> {c.why}</span> : null}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
      {body.legend.length ? <Legend kinds={body.legend} /> : null}
      {body.footnote ? <p className="foot">{body.footnote}</p> : null}
    </>
  );
}

function Identity({ body, title }: { readonly body: Extract<FrameBodyValue, { k: 'identity' }>; readonly title: string }) {
  const bg = body.palette[body.background] ?? 'transparent';
  const fg = body.palette[body.foreground] ?? 'currentColor';
  return (
    <div className="dir">
      <div className="art2" style={{ background: bg, color: fg }}>
        {body.generating ? (
          <div className="sk" style={{ position: 'absolute', inset: 0 }} role="status" aria-label={body.generating.label}>
            <span className="sk-cpt" aria-hidden="true">
              {body.generating.label}
            </span>
          </div>
        ) : (
          <>
            {body.mark ? <MarkGlyph mark={body.mark} palette={body.palette} size={64} /> : null}
            <span className={`wm ${body.typeface}`}>{body.wordmark}</span>
            {body.wordmarkAlt ? (
              <span className="wm-alt" lang={body.wordmarkAlt.lang} dir="rtl">
                {body.wordmarkAlt.text}
              </span>
            ) : null}
          </>
        )}
      </div>
      <div className="fn">
        <b>{title}</b>
        <small>{body.statusLabel}</small>
      </div>
      <p className="pos">{body.positioning}</p>
      <ul className="sw" aria-hidden="true">
        {body.palette.map(c => (
          <li key={c} style={{ background: c }} />
        ))}
      </ul>
      <div className="vers">
        {body.versionChips.map(v => (
          <span key={v.versionId} className={`${v.current ? 'cur' : ''}${v.fresh ? ' new' : ''}`}>
            {v.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function Choices({ body }: { readonly body: Extract<FrameBodyValue, { k: 'choices' }> }) {
  const { t } = useI18n();
  const s = rowScale(
    body.items.map(i => i.plate.spec),
    40,
    40,
  );
  return (
    <div className="choices-row">
      {body.items.map(i => (
        <figure key={i.optionId}>
          <Plate exhibit={i.plate} scale={s} dims={false} />
          <figcaption>
            {i.label}
            {i.chosen ? `, ${t('chosen').toLowerCase()}` : ''}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
