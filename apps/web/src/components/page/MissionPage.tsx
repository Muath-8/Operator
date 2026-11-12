'use client';

import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { FigureText } from '../primitives/TrustGlyph';
import { useWorkspace } from '../workspace/context';
import { EntryView } from './Entry';
import { Steps } from './Steps';

/** "9 to 11 Nov" when both dates share a month, else "30 Oct to 2 Nov". */
export function dateRange(from: string, to: string, join: string): string {
  const a = from.split(' ');
  const b = to.split(' ');
  if (a.length === 2 && b.length === 2 && a[1] === b[1]) return `${a[0]} ${join} ${to}`;
  return `${from} ${join} ${to}`;
}

/**
 * Quiet second line under the property line: the founder's active time (a Figure with its own trust,
 * source and date; shown only once the server has measured real activity) and the category knowledge the
 * agent follows, with its review status as sent. "Unverified" is always visible; "reviewed" is shown only
 * when the server says so, never inferred.
 */
function HeaderMeta() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const h = ws.view.header;
  const k = h.knowledge;
  const open = !!ws.ui.expanded.knowledge;
  if (!h.activeTime && !k) return null;
  return (
    <div className="props-sub">
      {h.activeTime ? (
        <span className="meta-item">
          {t('activeTime')} <FigureText figure={h.activeTime} />
        </span>
      ) : null}
      {k ? (
        <span className="meta-item">
          <button
            type="button"
            className={`toggle know${k.reviewStatus === 'unverified' ? ' unverified' : ''}`}
            aria-expanded={open}
            aria-controls="knowledge-body"
            onClick={() => ws.dispatch({ type: 'toggle', key: 'knowledge' })}
          >
            <bdi>{t('know_label', { category: k.category, version: k.version })}</bdi>
            <span className="know-st">{k.reviewStatus === 'unverified' ? t('know_unverified') : t('know_reviewed')}</span>
          </button>
        </span>
      ) : null}
      {k && open ? (
        <div className="know-body fade-in" id="knowledge-body">
          {k.reviewStatus === 'unverified' ? <p>{t('know_unverifiedNote')}</p> : null}
          {k.warning ? <p className="know-warn bidi">{k.warning}</p> : null}
          {k.sources.length ? (
            <>
              <p className="muted">{t('know_sources')}</p>
              <ul>
                {k.sources.map(s => (
                  <li key={s} className="bidi">
                    {s}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="muted">{t('know_noSources')}</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The page is the conversation (UX 2.2, 5.3): title and property line, the since-you-left chapter
 * (collapsed), then the entries the Mission Lead writes. No persistent side panels on load.
 */
export function MissionPage() {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const v = ws.view;
  const h = v.header;
  const chapterOpen = !!ws.ui.expanded.chapter;
  const syl = v.sinceYouLeft;

  return (
    <article className="page" id="page" aria-labelledby="mission-title">
      <h1 className={`title${h.untitled ? ' untitled' : ''}`} id="mission-title">
        {h.untitled ? t('untitled') : h.name}
        {h.altName ? (
          <span className="alt ar" lang={h.altName.lang} dir="rtl">
            {h.altName.text}
          </span>
        ) : null}
      </h1>
      <p className="props">
        {/* The server line may end with its own full stop; the property line adds its own punctuation. */}
        <bdi>{h.line.replace(/[.。؛]\s*$/, '')}</bdi>
        {h.week ? `${t('comma')}${t('weekN', { n: h.week })}` : ''}
        {h.budget ? (
          <>
            {t('stop')}
            {t('budget')}{' '}
            {h.budgetDecisionId ? (
              <button
                type="button"
                className="budget"
                onClick={e => h.budgetDecisionId && ws.open({ kind: 'decision', decisionId: h.budgetDecisionId }, e.currentTarget)}
              >
                <b className="num">{i18n.money(h.budget)}</b>
              </button>
            ) : (
              <b className="num">{i18n.money(h.budget)}</b>
            )}
          </>
        ) : null}
      </p>
      <HeaderMeta />
      {syl && (syl.stepIds.length || syl.overdueCommitmentIds.length || syl.waitingDecisionIds.length) ? (
        <div className="chapter">
          <button
            type="button"
            className="toggle"
            aria-expanded={chapterOpen}
            aria-controls="chapter-body"
            onClick={() => ws.dispatch({ type: 'toggle', key: 'chapter' })}
          >
            <Icon name="chev" className="chev" />
            <span>{t('sinceYouLeft', { range: dateRange(i18n.date(syl.from), i18n.date(syl.to), t('rangeJoin')) })}</span>
          </button>
          {chapterOpen ? (
            <div className="chapter-body fade-in" id="chapter-body">
              {syl.stepIds.length ? (
                <div>
                  <h4>{t('arrivedLine')}</h4>
                  <Steps ids={syl.stepIds} scope="chapter" />
                </div>
              ) : null}
              {syl.overdueCommitmentIds.length ? (
                <div>
                  <h4>{t('overdueLine')}</h4>
                  <ul className="steps">
                    {syl.overdueCommitmentIds.map(id => {
                      const c = v.commitments.find(x => x.id === id);
                      if (!c) return null;
                      return (
                        <li key={id} className="step">
                          <div className="sh">
                            <i className="sdot failed" aria-hidden="true" />
                            <span>
                              {c.owedBy}: {c.what}
                            </span>
                            <span className="lab failed">
                              {c.overdueDays === 1 ? t('dayOverdue') : t('daysOverdue', { n: c.overdueDays })}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
              {syl.waitingDecisionIds.length ? (
                <div>
                  <h4>{t('waitingLine')}</h4>
                  <ul className="steps">
                    {syl.waitingDecisionIds.map(id => {
                      const d = v.decisions[id];
                      if (!d) return null;
                      return (
                        <li key={id}>
                          <button
                            type="button"
                            className="link"
                            onClick={e => ws.open({ kind: 'decision', decisionId: id }, e.currentTarget)}
                          >
                            {d.question}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <div className="entries">
        {v.entries.map(e => (
          <EntryView key={e.id} e={e} />
        ))}
      </div>
    </article>
  );
}
