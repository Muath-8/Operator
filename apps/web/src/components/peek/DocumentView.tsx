'use client';

import type { ArtifactAction, DocSection } from '../../ui-contract';
import { RichText, Paragraphs } from '../primitives/RichText';
import { EvidenceGlyph, FigureText, Legend } from '../primitives/TrustGlyph';
import { Plate } from '../plate/Plate';
import { rowScale } from '../plate/geometry';
import { useWorkspace } from '../workspace/context';
import { Kit, CommandNote } from '../page/Blocks';

/**
 * Document renderer (UX 5.5): briefs, specs, guidelines, research, records. Sections are generic;
 * nothing here knows the product. Field rows diff against the previous version (FR-UX-14).
 */
export function DocumentSections({
  sections,
  artifactId,
  inline = false,
}: {
  readonly sections: readonly DocSection[];
  readonly artifactId: string;
  readonly inline?: boolean;
}) {
  return (
    <div className={inline ? 'doc inline' : 'doc'}>
      {sections.map((s, i) => {
        switch (s.k) {
          case 'heading':
            return inline ? null : i === 0 ? (
              <h2 key={i}>{s.text}</h2>
            ) : (
              <h3 key={i} className="sec">
                {s.text}
                {s.note ? <small>{s.note}</small> : null}
              </h3>
            );
          case 'lead':
            return inline ? null : (
              <p key={i} className="lead">
                <RichText value={s.text} />
              </p>
            );
          case 'prose':
            return <Paragraphs key={i} value={s.paragraphs} />;
          case 'fields':
            return (
              <table key={i} className="tt diff">
                {s.diffLabel ? <caption className="sr">{s.diffLabel}</caption> : null}
                <tbody>
                  {s.rows.map(r => {
                    const changed = r.previous !== undefined && r.previous !== r.value;
                    return (
                      <tr key={r.label}>
                        <th scope="row">{r.label}</th>
                        <td>
                          {changed ? (
                            <>
                              <del>{r.previous}</del>
                              <br />
                              <ins>{r.value}</ins>
                            </>
                          ) : (
                            r.value
                          )}
                          {r.figure ? (
                            <>
                              {' '}
                              <FigureText figure={r.figure} />
                            </>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          case 'plates': {
            const s2 = rowScale(
              s.items.map(p => p.spec),
              170,
              150,
            );
            return (
              <div key={i} className="plates-row">
                {s.items.map((p, j) => (
                  <Plate key={j} exhibit={p} scale={s2} />
                ))}
                {s.caption ? (
                  <p className="plates-cap">
                    <RichText value={s.caption} />
                  </p>
                ) : null}
              </div>
            );
          }
          case 'grid':
            return (
              <div key={i}>
                <div className="lean">
                  {s.cells.map(c => (
                    <div key={c.title}>
                      <h4>
                        <span>{c.title}</span>
                        <EvidenceGlyph item={c.evidence} />
                      </h4>
                      <p>{c.text}</p>
                    </div>
                  ))}
                </div>
                <Legend kinds={s.legend} />
              </div>
            );
          case 'code':
            return (
              <div key={i}>
                <h3 className="sec">{s.label}</h3>
                <pre className="code-spec">{s.text}</pre>
              </div>
            );
          case 'gallery':
            return (
              <div key={i} className="gal">
                {s.items.map(g => (
                  <figure key={g.label}>
                    <div className="stage">
                      <Plate exhibit={g.plate} scale={rowScale([g.plate.spec], 130, 200)} />
                    </div>
                    <figcaption>
                      <b>{g.label}</b>, {g.caption}
                    </figcaption>
                  </figure>
                ))}
              </div>
            );
          case 'kit':
            return <Kit key={i} kit={s.kit} />;
          case 'actions':
            return <ActionButtons key={i} actions={s.actions} artifactId={artifactId} />;
        }
      })}
    </div>
  );
}

/** Artifact actions run on the server; changing approved work goes through the impact flow. */
export function ActionButtons({
  actions,
  artifactId,
  frameId,
  versionId,
  className = 'doc-actions',
}: {
  readonly actions: readonly ArtifactAction[];
  readonly artifactId: string;
  readonly frameId?: string;
  readonly versionId?: string;
  readonly className?: string;
}) {
  const ws = useWorkspace();
  if (!actions.length) return null;
  return (
    <div className={className}>
      {actions.map((a, i) => {
        const key = `action:${artifactId}:${a.id}`;
        const st = ws.commandState(key);
        const busy = st?.phase === 'running' || st?.phase === 'awaiting';
        return (
          <span key={a.id} style={{ display: 'contents' }}>
            <button
              type="button"
              className={`btn ${i === 0 && a.kind === 'command' && !a.runsImpact ? 'primary' : 'line'} sm${busy ? ' busy' : ''}`}
              aria-disabled={busy || (a.kind === 'command' && !ws.canDecide) || undefined}
              onClick={e => {
                if (a.kind === 'open' && a.target) return ws.open(a.target, e.currentTarget);
                if (busy || !ws.canDecide) return;
                if (a.runsImpact && versionId) {
                  void ws.run(key, base => ws.commands.requestChange({ ...base, artifactId, versionId, actionId: a.id }));
                  return;
                }
                void ws.run(key, base =>
                  ws.commands.runArtifactAction({
                    ...base,
                    artifactId,
                    actionId: a.id,
                    ...(frameId ? { frameId } : {}),
                    ...(versionId ? { versionId } : {}),
                  }),
                );
              }}
            >
              {busy ? <span className="spin" aria-hidden="true" /> : null}
              {a.label}
            </button>
            <CommandNote state={st} />
          </span>
        );
      })}
    </div>
  );
}
