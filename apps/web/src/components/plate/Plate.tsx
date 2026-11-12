import type { MarkGlyph as MarkGlyphSpec, PlateExhibit, PlatePart } from '../../ui-contract';
import { dimensionPath, holeCenters, plateFrame, polyPoints, type PlateFrame } from './geometry';

/**
 * The one bold element: a technical plate drawn from a spec (UX 7.1). Shared by the quote shelf,
 * packaging, spec sheets, finish options, embed thumbnails and the drawing gallery.
 * Materials are theme classes; a brand tint, when given, colours parts by role.
 */
export interface PlateProps {
  readonly exhibit: PlateExhibit;
  /** px per mm; pass one scale for a row (rowScale). */
  readonly scale: number;
  readonly dims?: boolean;
  readonly text?: boolean;
  readonly recommended?: boolean;
  /** Decorative inside a control that already carries the summary. */
  readonly decorative?: boolean;
  readonly className?: string;
}

export function MarkGlyph({
  mark,
  palette,
  size,
  ink,
}: {
  readonly mark: MarkGlyphSpec;
  readonly palette: readonly string[];
  readonly size: number;
  readonly ink?: string;
}) {
  const col = (c: number | 'current' | undefined): string => {
    if (c === undefined) return 'none';
    if (ink) return ink;
    if (c === 'current') return 'currentColor';
    return palette[c] ?? 'currentColor';
  };
  return (
    <svg viewBox={mark.viewBox} width={size} height={size} aria-hidden="true" focusable="false">
      {mark.paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill={p.fill === undefined ? 'none' : col(p.fill)}
          stroke={p.stroke === undefined ? 'none' : col(p.stroke)}
          strokeWidth={p.width ?? 2}
        />
      ))}
    </svg>
  );
}

function partFill(p: PlatePart, exhibit: PlateExhibit): { className: string; style?: { fill: string; stroke?: string } } {
  const tint = exhibit.tint;
  const role = 'role' in p ? p.role : undefined;
  const idx = role && tint ? tint.byRole[role] : undefined;
  if (tint && idx !== undefined) {
    const fill = tint.palette[idx];
    const stroke = tint.stroke !== undefined ? tint.palette[tint.stroke] : undefined;
    if (fill) return { className: 'pm', style: { fill, ...(stroke ? { stroke } : {}) } };
  }
  const m = 'm' in p && p.m ? p.m : 'glass';
  return { className: `pm ${m}` };
}

function PartShape({
  p,
  f,
  exhibit,
  text,
}: {
  readonly p: PlatePart;
  readonly f: PlateFrame;
  readonly exhibit: PlateExhibit;
  readonly text: boolean;
}) {
  switch (p.t) {
    case 'rect': {
      const fill = partFill(p, exhibit);
      return (
        <>
          <rect
            x={f.X(p.x)}
            y={f.Y(p.y + p.h)}
            width={p.w * f.s}
            height={p.h * f.s}
            rx={(p.r ?? 0) * f.s}
            className={fill.className}
            style={fill.style}
          />
          {p.finish && exhibit.finish === 'gloss' ? (
            <rect
              className="gloss"
              x={f.X(p.x + p.w * 0.18)}
              y={f.Y(p.y + p.h * 0.86)}
              width={p.w * 0.12 * f.s}
              height={p.h * 0.72 * f.s}
              rx={p.w * 0.06 * f.s}
            />
          ) : null}
        </>
      );
    }
    case 'poly': {
      const fill = partFill(p, exhibit);
      return <polygon points={polyPoints(p, f)} className={fill.className} style={fill.style} strokeLinejoin="round" />;
    }
    case 'circle': {
      const fill = partFill(p, exhibit);
      return <circle cx={f.X(p.cx)} cy={f.Y(p.cy)} r={p.r * f.s} className={fill.className} style={fill.style} />;
    }
    case 'holes':
      return (
        <>
          {holeCenters(p, f).map((h, i) => (
            <circle key={i} cx={h.cx} cy={h.cy} r={h.r} className="pm void" />
          ))}
        </>
      );
    case 'line':
      return (
        <path
          d={`M${f.X(p.x1)} ${f.Y(p.y1)}L${f.X(p.x2)} ${f.Y(p.y2)}`}
          className={p.m === 'solid' ? 'pm' : 'hint'}
          strokeDasharray={p.m === 'solid' ? undefined : '2 2'}
        />
      );
    case 'mark': {
      const tint = exhibit.tint;
      if (!tint?.mark) return null;
      const sz = p.size * f.s;
      const idx = p.role ? tint.byRole[p.role] : undefined;
      const ink = idx !== undefined ? tint.palette[idx] : undefined;
      return (
        <g transform={`translate(${f.X(p.cx) - sz / 2} ${f.Y(p.cy) - sz / 2})`}>
          <MarkGlyph mark={tint.mark} palette={tint.palette} size={sz} {...(ink ? { ink } : {})} />
        </g>
      );
    }
    case 'text': {
      if (!text) return null;
      const idx = p.role && exhibit.tint ? exhibit.tint.byRole[p.role] : undefined;
      const fill = idx !== undefined && exhibit.tint ? exhibit.tint.palette[idx] : undefined;
      const rtl = p.lang?.startsWith('ar');
      return (
        <text
          x={f.X(p.x)}
          y={f.Y(p.y)}
          textAnchor="middle"
          fontSize={p.size * f.s}
          letterSpacing={p.track ?? 0}
          className={`ptext${fill ? '' : ' ink-fill'}${rtl ? ' ar' : ''}`}
          style={fill ? { fill } : undefined}
          lang={p.lang}
          direction={rtl ? 'rtl' : undefined}
        >
          {p.s}
        </text>
      );
    }
  }
}

export function Plate({ exhibit, scale, dims = true, text = true, recommended = false, decorative = false, className }: PlateProps) {
  const spec = exhibit.spec;
  const f = plateFrame(spec, scale, dims);
  const d = dims ? dimensionPath(spec, f) : null;
  const cls = ['plate', recommended ? 'rec' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <svg
      className={cls}
      width={f.width}
      height={f.height}
      viewBox={`0 0 ${f.width} ${f.height}`}
      {...(decorative ? { 'aria-hidden': true, focusable: 'false' } : { role: 'img', 'aria-label': exhibit.summary })}
    >
      <g>
        {spec.parts.map((p, i) => (
          <PartShape key={i} p={p} f={f} exhibit={exhibit} text={text} />
        ))}
      </g>
      {d ? (
        <g aria-hidden="true">
          <path className="dim" d={d.path} />
          <text className="dimt" x={d.hLabel.x} y={d.hLabel.y} textAnchor="middle" transform={`rotate(-90 ${d.hLabel.x} ${d.hLabel.y})`}>
            {spec.dims_mm.h} mm
          </text>
          <text className="dimt" x={d.wLabel.x} y={d.wLabel.y} textAnchor="middle">
            {spec.dims_mm.w} mm
          </text>
        </g>
      ) : null}
    </svg>
  );
}
