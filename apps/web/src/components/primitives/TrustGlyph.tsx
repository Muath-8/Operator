'use client';

import type { EvidenceItem, Figure, GlyphTrust, SourceRef } from '../../ui-contract';
import { useI18n } from '../../i18n';
import type { MessageKey } from '../../i18n';

/** Shape carries meaning; colour supports it (UX 9.4). 12px. */
function GlyphShape({ trust }: { readonly trust: GlyphTrust }) {
  switch (trust) {
    case 'planned':
      return <circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" />;
    case 'performed':
      return <circle cx="6" cy="6" r="3.4" fill="currentColor" />;
    case 'claimed':
      return (
        <>
          <circle cx="6" cy="6" r="4.3" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <path d="M6 1.7a4.3 4.3 0 0 1 0 8.6z" fill="currentColor" />
        </>
      );
    case 'verified':
      return (
        <>
          <circle cx="6" cy="6" r="4.8" fill="currentColor" />
          <path
            d="m3.9 6.1 1.5 1.5 2.8-3.1"
            fill="none"
            stroke="var(--paper)"
            strokeWidth="1.3"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );
    case 'founder_confirmed':
      return <path d="M6 1.4 10.6 6 6 10.6 1.4 6z" fill="currentColor" />;
    case 'failed':
      return (
        <>
          <circle cx="6" cy="6" r="4.8" fill="currentColor" />
          <path d="m4.4 4.4 3.2 3.2M7.6 4.4 4.4 7.6" stroke="var(--paper)" strokeWidth="1.3" strokeLinecap="round" />
        </>
      );
  }
}

export const trustKey = (t: GlyphTrust): MessageKey => `trust_${t}` as MessageKey;

export function sourceLine(source: SourceRef, observed: string, note?: string, original?: string): string {
  const parts = [source.label, observed];
  if (original) parts.push(original);
  if (note) parts.push(note);
  if (source.reference) parts.push(source.reference);
  return parts.filter(Boolean).join('. ').replace(/\.\./g, '.') + '.';
}

export interface TrustGlyphProps {
  readonly trust: GlyphTrust;
  /** Tooltip text: source and date. */
  readonly detail: string;
  /**
   * Interactive glyphs are focusable and open their tooltip on focus or tap.
   * Use static glyphs only inside an existing control, where the control carries the description.
   */
  readonly interactive?: boolean;
  /** For static glyphs: carry the source as screen-reader text. Off where a visible label says it. */
  readonly describe?: boolean;
}

/** Every figure carries its trust glyph with source and date (I-14). */
export function TrustGlyph({ trust, detail, interactive = true, describe = true }: TrustGlyphProps) {
  const { t } = useI18n();
  const label = t(trustKey(trust));
  const svg = (
    <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
      <GlyphShape trust={trust} />
    </svg>
  );
  if (!interactive) {
    // Inside another control: not focusable; hover or tap still shows the tip, and the
    // source is part of the control's accessible text (the "described child" fix, UX 14.1).
    return (
      <>
        <span
          className={`tm static ${trust}`}
          aria-hidden="true"
          {...(describe ? { 'data-tip': detail, 'data-tip-title': `${label}.` } : {})}
        >
          {svg}
        </span>
        {describe ? (
          <span className="sr">
            {' '}
            ({label}: {detail})
          </span>
        ) : null}
      </>
    );
  }
  return (
    <button
      type="button"
      className={`tm ${trust}`}
      aria-label={`${label}: ${detail}`}
      data-tip-title={`${label}.`}
      data-tip={detail}
      data-tip-toggle=""
    >
      {svg}
    </button>
  );
}

export function EvidenceGlyph({ item, interactive = true }: { readonly item: EvidenceItem; readonly interactive?: boolean }) {
  const { date } = useI18n();
  return <TrustGlyph trust={item.trust} detail={sourceLine(item.source, date(item.observedAt))} interactive={interactive} />;
}

export function FigureGlyph({ figure, interactive = true }: { readonly figure: Figure; readonly interactive?: boolean }) {
  const { date } = useI18n();
  return (
    <TrustGlyph
      trust={figure.trust}
      detail={sourceLine(figure.source, date(figure.observedAt), figure.note, figure.original)}
      interactive={interactive}
    />
  );
}

/** A figure is never shown without its glyph (I-14). */
export function FigureText({
  figure,
  interactive = true,
  className,
}: {
  readonly figure: Figure;
  readonly interactive?: boolean;
  readonly className?: string;
}) {
  const { figure: fmt } = useI18n();
  return (
    // dir=auto: the figure takes its direction from its own text, so the glyph sits on the correct side of its gap
    // when an English figure appears in an Arabic page (and the reverse). The number must not be a <bdi>, which dir=auto skips.
    <span className={className ? `fig ${className}` : 'fig'} data-figure={figure.id} dir="auto">
      <span className="num">{fmt(figure.value)}</span>
      <FigureGlyph figure={figure} interactive={interactive} />
    </span>
  );
}

const ALL: readonly GlyphTrust[] = ['planned', 'performed', 'claimed', 'verified', 'founder_confirmed'];

/** A one-line legend under any cluster of figures (UX 9.4). */
export function Legend({ kinds = ALL }: { readonly kinds?: readonly GlyphTrust[] }) {
  const { t } = useI18n();
  return (
    <ul className="legend" aria-label={t('marksMeaning')}>
      {kinds.map(k => (
        <li key={k}>
          <TrustGlyph trust={k} detail={t(trustKey(k))} interactive={false} describe={false} />
          {t(trustKey(k))}
        </li>
      ))}
    </ul>
  );
}
