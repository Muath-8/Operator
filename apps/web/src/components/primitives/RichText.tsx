'use client';

import type { Inline, RichText as RichTextValue } from '../../ui-contract';
import { useWorkspace } from '../workspace/context';
import { FigureText } from './TrustGlyph';

/**
 * Serializable rich text. Interactive runs (glyphs, glossary terms, links, asks) render as
 * controls only where `interactive` is true; inside another control they render as text,
 * so controls never nest (UX 14.1 gap fix).
 */
export function RichText({ value, interactive = true }: { readonly value: RichTextValue; readonly interactive?: boolean }) {
  return (
    <>
      {value.map((run, i) => (
        <Run key={i} run={run} interactive={interactive} />
      ))}
    </>
  );
}

function Run({ run, interactive }: { readonly run: Inline; readonly interactive: boolean }) {
  const ws = useWorkspace();
  switch (run.t) {
    case 'text':
      if (run.emphasis === 'strong') return <b>{run.text}</b>;
      if (run.emphasis === 'struck') return <del>{run.text}</del>;
      return <>{run.text}</>;
    case 'figure':
      return <FigureText figure={run.figure} interactive={interactive} />;
    case 'term': {
      const g = ws.view.glossary[run.termId];
      if (!g || !interactive) return <span className="term">{run.text}</span>;
      return (
        <button type="button" className="term" data-tip={g.definition} data-tip-title={`${g.term}.`} data-tip-toggle="">
          {run.text}
          <span className="sr">: {g.definition}</span>
        </button>
      );
    }
    case 'link':
      if (!interactive) return <span className="link">{run.text}</span>;
      return (
        <button type="button" className="link" onClick={e => ws.open(run.target, e.currentTarget)}>
          {run.text}
        </button>
      );
    case 'ask':
      if (!interactive) return <span className="link">{run.text}</span>;
      return (
        <button type="button" className="link" disabled={!ws.canMessage} onClick={() => void ws.send(run.message)}>
          {run.text}
        </button>
      );
    case 'correction':
      return (
        <>
          <del>{run.from}</del> <ins className="corr">{run.to}</ins>
        </>
      );
  }
}

/** Plain text of rich text, for labels and announcements. */
export function plainText(value: RichTextValue, fmt?: (r: Extract<Inline, { t: 'figure' }>) => string): string {
  return value
    .map(r => {
      switch (r.t) {
        case 'text':
        case 'term':
        case 'link':
        case 'ask':
          return r.text;
        case 'figure':
          return fmt ? fmt(r) : '';
        case 'correction':
          return r.to;
      }
    })
    .join('');
}

export function Paragraphs({ value, className }: { readonly value: readonly RichTextValue[]; readonly className?: string }) {
  return (
    <div className={className ?? 'prose'}>
      {value.map((p, i) => (
        <p key={i}>
          <RichText value={p} />
        </p>
      ))}
    </div>
  );
}
