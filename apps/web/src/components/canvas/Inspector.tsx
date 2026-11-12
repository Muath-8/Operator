'use client';

import { useState, type FormEvent } from 'react';
import type { ArtifactView, FrameView } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { EvidenceGlyph } from '../primitives/TrustGlyph';
import { useWorkspace } from '../workspace/context';
import { ActionButtons } from '../peek/DocumentView';
import { CommandNote } from '../page/Blocks';
import { outcomeKey } from '../page/ReadinessObject';

/**
 * Inspector (UX 5.6): versions, evidence with glyphs, comments to the Mission Lead, and actions
 * such as a variation request or returning to another version. A labelled region inside the canvas.
 * The comment box keeps its text until the server accepts it.
 */
export function Inspector({
  artifact,
  frame,
  viewingVersionId,
  onPin,
  pinning,
}: {
  readonly artifact: ArtifactView;
  readonly frame: FrameView;
  readonly viewingVersionId: string;
  readonly onPin: () => void;
  readonly pinning: boolean;
}) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const ins = frame.inspector;
  const [text, setText] = useState('');
  const key = `frame:${artifact.id}:${frame.id}`;
  const st = ws.commandState(key);
  const busy = st?.phase === 'running';
  const frameKey = `${artifact.id}:${frame.id}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !ws.canMessage) return;
    const value = text.trim();
    if (ins.allowVariation) {
      const request = value || t('requestVariation');
      const r = await ws.run(key, base =>
        ws.commands.requestVariation({ ...base, artifactId: artifact.id, frameId: frame.id, versionId: viewingVersionId, request }),
      );
      if (r?.ok) setText('');
      return;
    }
    if (!value) return;
    const r = await ws.run(key, base =>
      ws.commands.sendMessage({
        ...base,
        text: value,
        context: { artifactId: artifact.id, frameId: frame.id, versionId: viewingVersionId },
      }),
    );
    if (r?.ok) setText('');
  };

  const actions = ins.actions.filter(a => !a.forVersionId || a.forVersionId === viewingVersionId);

  return (
    <aside className="insp" aria-labelledby={`insp-${frame.id}`}>
      <div className="ih">
        <h2 id={`insp-${frame.id}`}>{frame.title}</h2>
        <button
          type="button"
          className="ib"
          aria-label={t('closeInspector')}
          onClick={() => ws.dispatch({ type: 'inspect', artifactId: artifact.id, frameId: null })}
        >
          <Icon name="close" />
        </button>
      </div>
      <div className="ib2">
        <p className="muted">
          {ins.typeLabel}
          {ins.serves ? `, ${t(outcomeKey(ins.serves))}` : ''}
        </p>
        <h3>{t('versions')}</h3>
        <ul>
          {[...ins.versions].reverse().map(v => (
            <li key={v.id} className={v.id === viewingVersionId ? 'cur' : undefined}>
              <button
                type="button"
                className="v link"
                aria-current={v.id === viewingVersionId || undefined}
                onClick={() => ws.dispatch({ type: 'viewVersion', frameKey, versionId: v.id })}
              >
                {t('versionLabel', { n: v.versionNo })}
              </button>
              <span>
                {v.note}
                {v.variationRequest ? ` (“${v.variationRequest}”)` : ''}, {i18n.date(v.createdAt)}
                {v.sentTo?.length ? `. ${v.sentTo.map(s => `${s.counterparty} ${i18n.date(s.at)}`).join(', ')}` : ''}
              </span>
            </li>
          ))}
        </ul>
        <h3>{t('evidence')}</h3>
        <ul>
          {ins.evidence.map(e => (
            <li key={e.id}>
              <EvidenceGlyph item={e} />
              <span>{e.text}</span>
            </li>
          ))}
        </ul>
        <h3>{t('comments')}</h3>
        <ul>
          {ins.comments.length ? (
            ins.comments.map(c => (
              <li key={c.id}>
                <span className="v">{c.author.slice(0, 1)}</span>
                <span>
                  {c.text}
                  <br />
                  <span className="muted">
                    {c.author}, {i18n.date(c.at)}
                  </span>
                </span>
              </li>
            ))
          ) : (
            <li>{t('noComments')}</li>
          )}
        </ul>
        <form onSubmit={e => void submit(e)}>
          <label className="sr" htmlFor={`iq-${frame.id}`}>
            {ins.allowVariation ? t('requestVariation') : t('comments')}
          </label>
          <input
            id={`iq-${frame.id}`}
            value={text}
            onChange={e => setText(e.target.value)}
            placeholder={ins.allowVariation ? t('variationPlaceholder') : t('commentPlaceholder')}
            disabled={!ws.canMessage}
          />
          <button className={`btn line sm${busy ? ' busy' : ''}`} type="submit" aria-disabled={busy || !ws.canMessage || undefined}>
            {ins.allowVariation ? t('request') : t('sendComment')}
          </button>
          <button type="button" className="btn quiet sm" aria-pressed={pinning} onClick={onPin} disabled={!ws.canMessage}>
            <Icon name="pin" />
            {pinning ? t('pinCancel') : t('pinComment')}
          </button>
        </form>
        {pinning ? <p className="cnote">{t('pinMode')}</p> : null}
        <CommandNote state={st} />
      </div>
      {actions.length ? (
        <ActionButtons actions={actions} artifactId={artifact.id} frameId={frame.id} versionId={viewingVersionId} className="ia" />
      ) : null}
    </aside>
  );
}
