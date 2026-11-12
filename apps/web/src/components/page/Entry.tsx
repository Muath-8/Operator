'use client';

import { Fragment } from 'react';
import type { Block, PageEntry } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { RichText } from '../primitives/RichText';
import { useWorkspace } from '../workspace/context';
import { DocumentSections } from '../peek/DocumentView';
import { DecisionBlock } from './DecisionBlock';
import { DecisionMoment } from './DecisionMoment';
import { ReadinessObject } from './ReadinessObject';
import { Steps } from './Steps';
import { Changes, ClosingRecord, EmptyBlock, Embed, Impact, Kit, MoneyBlock, Question, SkeletonBlock, Suggestions } from './Blocks';

/**
 * Agent entries (UX 8.2). The view shows exactly what the server has: a finished entry renders in full
 * and a newly arrived one fades in once, as a unit. There is no simulated word-by-word "typing" of text
 * that is already complete. The caret appears only while the server marks the entry `streaming` (text
 * still arriving over the transport). Under reduced motion nothing animates.
 */
export function EntryView({ e }: { readonly e: PageEntry }) {
  const ws = useWorkspace();
  const { t, time } = useI18n();
  const arrived = ws.isNewEntry(e.id) && !ws.reducedMotion;

  if (e.author === 'founder') {
    return (
      <section className="entry" data-e={e.id} aria-label={t('youWrote', { time: time(e.at) })}>
        <span className="when" aria-hidden="true">
          {time(e.at)}
        </span>
        <div className={`you${e.delivery === 'failed' ? ' failed' : ''}`}>
          <div className="who">{t('you')}</div>
          {e.text}
          {e.delivery === 'failed' ? <div className="cnote err">{t('messageNotSent')}</div> : null}
        </div>
      </section>
    );
  }

  const textBlocks = e.blocks.filter((b): b is Extract<Block, { k: 'lede' | 'prose' }> => b.k === 'lede' || b.k === 'prose');
  const lastText = textBlocks[textBlocks.length - 1];

  return (
    <section
      className={`entry${e.staleNote ? ' is-stale' : ''}${arrived ? ' arrived' : ''}`}
      data-e={e.id}
      aria-label={t('agentWrote', { time: time(e.at) })}
      aria-busy={e.streaming || undefined}
    >
      <span className="when" aria-hidden="true">
        {time(e.at)}
      </span>
      {e.streaming ? (
        // A real transport draft (server-marked). Assistive tech hears that it is still being written.
        <span className="sr" role="status">
          {t('drafting')}
        </span>
      ) : null}
      {e.staleNote ? (
        <div className="stale-note">
          <Icon name="undo" />
          <span>{e.staleNote}</span>
        </div>
      ) : null}
      {e.blocks.map((b, i) => {
        if (b.k === 'lede' || b.k === 'prose') {
          const paragraphs = b.k === 'lede' ? [b.text] : b.paragraphs;
          const runs = paragraphs.map((p, j) => (
            <Fragment key={j}>
              <RichText value={p} />
              {e.streaming && b === lastText && j === paragraphs.length - 1 ? <span className="caret" aria-hidden="true" /> : null}
            </Fragment>
          ));
          if (b.k === 'lede')
            return (
              <p key={i} className="lede">
                {runs}
              </p>
            );
          return (
            <div key={i} className="prose">
              {runs.map((r, j) => (
                <p key={j}>{r}</p>
              ))}
            </div>
          );
        }
        return (
          <div key={i}>
            <BlockView b={b} animate={arrived} />
          </div>
        );
      })}
    </section>
  );
}

function BlockView({ b, animate }: { readonly b: Block; readonly animate: boolean }) {
  const ws = useWorkspace();
  const v = ws.view;
  switch (b.k) {
    case 'decision':
      return <DecisionBlock id={b.decisionId} />;
    case 'moment':
      return <DecisionMoment />;
    case 'embed':
      return <Embed artifactId={b.artifactId} />;
    case 'changes':
      return <Changes rows={b.rows} {...(b.title ? { title: b.title } : {})} animate={animate} />;
    case 'readiness':
      return <ReadinessObject from={b.from} to={b.to} blockersFor={b.blockersFor} animate={animate} />;
    case 'steps':
      return <Steps ids={b.stepIds} scope="page" />;
    case 'impact':
      return <Impact impactId={b.impactId} />;
    case 'question': {
      const q = v.questions[b.questionId];
      return q ? <Question q={q} /> : null;
    }
    case 'document': {
      const a = v.artifacts[b.artifactId];
      return a && a.content.kind === 'document' ? <DocumentSections sections={a.content.sections} artifactId={a.id} inline /> : null;
    }
    case 'skeleton':
      return <SkeletonBlock label={b.label} height={b.height} />;
    case 'empty':
      return <EmptyBlock text={b.text} />;
    case 'suggestions':
      return <Suggestions items={b.items} />;
    case 'money':
      return <MoneyBlock />;
    case 'kit': {
      const k = v.kits[b.kitId];
      return k ? <Kit kit={k} /> : null;
    }
    case 'closing': {
      const r = v.closingRecords[b.recordId];
      return r ? <ClosingRecord rec={r} /> : null;
    }
    case 'lede':
    case 'prose':
      return null;
  }
}
