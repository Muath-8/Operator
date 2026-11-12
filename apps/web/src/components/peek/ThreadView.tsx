'use client';

import type { Channel, ThreadContent, ThreadMessage, ThreadText } from '../../ui-contract';
import { useI18n, type MessageKey } from '../../i18n';
import type { IconName } from '../../ui-contract';
import { Dial } from '../primitives/Dial';
import { Icon } from '../primitives/Icon';
import { EvidenceGlyph, FigureText } from '../primitives/TrustGlyph';
import { useWorkspace } from '../workspace/context';
import { CommandNote } from '../page/Blocks';

const CHANNEL_ICON: Readonly<Record<Channel, IconName>> = {
  email: 'mail',
  whatsapp: 'chat',
  voice: 'phone',
  sms: 'chat',
  marketplace: 'chat',
  web: 'doc',
};
const channelKey = (c: Channel): MessageKey => `channel_${c}` as MessageKey;

/** Original beside a faithful translation; each side carries its own lang (UX 10, Thread message). */
function Bilingual({ original, translation }: { readonly original: ThreadText; readonly translation?: ThreadText | undefined }) {
  const { t } = useI18n();
  const rtl = (l: string) => (l.startsWith('ar') ? 'rtl' : 'ltr');
  return (
    <div className={`bi${translation ? '' : ' single'}`}>
      <div lang={original.lang} dir={rtl(original.lang)}>
        <span className="sr">{t('thread_original')}: </span>
        {original.text}
      </div>
      {translation ? (
        <div lang={translation.lang} dir={rtl(translation.lang)}>
          <span className="sr">{t('thread_translation')}: </span>
          {translation.text}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Supplier thread (UX 7.4): channel, timestamp, original beside translation, the mandate that
 * authorised each outbound, the call entry with "claimed (verbal)", drafts held on Guide me,
 * failed sends with Retry, and the dial in the header.
 */
export function ThreadView({
  artifactId,
  title,
  content,
}: {
  readonly artifactId: string;
  readonly title: string;
  readonly content: ThreadContent;
}) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const c = content;
  const draft = c.draft;
  const dKey = draft ? `draft:${draft.id}` : 'draft:none';
  const dState = ws.commandState(dKey);
  const dBusy = dState?.phase === 'running' || dState?.phase === 'awaiting';

  return (
    <div className="thread">
      <h2>{title}</h2>
      <p className="lead">
        {c.counterparty.subtitle}
        {c.counterparty.verification ? (
          <>
            . {c.counterparty.verification.text} <EvidenceGlyph item={c.counterparty.verification} />
          </>
        ) : null}
        {c.note ? <>. {c.note}</> : null}
      </p>
      <div className="thead">
        <span>{t('howIHelpWith', { name: c.counterparty.name })}</span>
        <Dial control={c.help} label={t('howIHelpWith', { name: c.counterparty.name })} />
      </div>
      <ol className="msgs">
        {c.messages.map(m => (
          <Message key={m.id} m={m} who={c.counterparty.name} />
        ))}
        {draft ? (
          <li className="msg">
            <span className="mi">
              <Icon name="pen" />
            </span>
            <div>
              <div className="mh">
                <b>{t('thread_draft')}</b>
                <span>{t('thread_draftWaiting', { channel: t(channelKey(draft.channel)) })}</span>
              </div>
              <div className="draft" aria-busy={dBusy || undefined}>
                <Bilingual original={draft.original} translation={draft.translation} />
                <div className="auth">
                  <EvidenceGlyph item={draft.evidence} />
                  <span>
                    {draft.heldBecause} {draft.mandateUsage}
                  </span>
                </div>
                <div className="acts">
                  <button
                    type="button"
                    className={`btn primary${dBusy ? ' busy' : ''}`}
                    aria-disabled={dBusy || !ws.canMessage || undefined}
                    onClick={() =>
                      !dBusy &&
                      ws.canMessage &&
                      void ws.run(dKey, base => ws.commands.approveDraft({ ...base, artifactId, draftId: draft.id }))
                    }
                  >
                    {dBusy ? <span className="spin" aria-hidden="true" /> : null}
                    {t('thread_approveSend')}
                  </button>
                  <button
                    type="button"
                    className="btn quiet"
                    aria-disabled={!ws.canMessage || undefined}
                    onClick={() => ws.compose({ artifactId, versionId: draft.id }, t('thread_askEdits'))}
                  >
                    {t('thread_askEdits')}
                  </button>
                  <button
                    type="button"
                    className="btn quiet"
                    aria-disabled={dBusy || !ws.canMessage || undefined}
                    onClick={() =>
                      !dBusy &&
                      ws.canMessage &&
                      void ws.run(dKey, base => ws.commands.discardDraft({ ...base, artifactId, draftId: draft.id }))
                    }
                  >
                    {t('thread_discard')}
                  </button>
                </div>
                <CommandNote state={dState} />
              </div>
            </div>
          </li>
        ) : null}
      </ol>
    </div>
  );
}

function Message({ m, who }: { readonly m: ThreadMessage; readonly who: string }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const retryKey = m.failure?.retryStepId ? `step:${m.failure.retryStepId}` : '';
  const rState = retryKey ? ws.commandState(retryKey) : undefined;
  const retrying = m.delivery === 'retrying' || rState?.phase === 'running' || rState?.phase === 'awaiting';

  if (m.direction === 'call' && m.call) {
    const call = m.call;
    return (
      <li className="msg">
        <span className="mi">
          <Icon name="phone" />
        </span>
        <div>
          <div className="mh">
            <b>{t('thread_call', { name: who })}</b>
            <span>
              {i18n.dateTime(m.at)}, {i18n.num(call.durationMinutes)} min
            </span>
          </div>
          <div className="call">
            <span className="muted">{t('thread_transcript')}</span>
            <ul>
              {call.summary.map(s => (
                <li key={s}>{s}</li>
              ))}
            </ul>
            <div className="vb">
              <EvidenceGlyph item={call.evidence} />
              <span>{call.confirmation}</span>
            </div>
            {call.recordingUrl ? (
              <a className="btn line sm" href={call.recordingUrl} target="_blank" rel="noopener noreferrer">
                <Icon name="play" />
                {t('thread_recording')}
              </a>
            ) : null}
          </div>
          {m.authority ? (
            <div className="auth">
              <Icon name="check" />
              <span>{m.authority.label}</span>
            </div>
          ) : null}
        </div>
      </li>
    );
  }

  return (
    <li className="msg">
      <span className="mi" title={t(channelKey(m.channel))}>
        <Icon name={CHANNEL_ICON[m.channel]} />
      </span>
      <div>
        <div className="mh">
          <b>{m.direction === 'outbound' ? t('thread_from') : m.author}</b>
          <span>
            {t(channelKey(m.channel))}, {i18n.dateTime(m.at)}
          </span>
          {m.figures?.map(f => (
            <FigureText key={f.id} figure={f} />
          ))}
        </div>
        <Bilingual original={m.original} translation={m.translation} />
        {m.attachments?.map(a => (
          <div key={a.label + a.versionLabel} className="auth">
            <Icon name="doc" />
            <span>{t('thread_attachment', { label: a.label, version: a.versionLabel, date: i18n.date(a.sentAt) })}</span>
          </div>
        ))}
        {m.delivery === 'failed' && m.failure ? (
          <div className="auth err" role="status">
            <Icon name="close" />
            <span>{t('thread_failed', { reason: m.failure.reason })}</span>
            {m.failure.retryStepId ? (
              <button
                type="button"
                className={`btn line sm${retrying ? ' busy' : ''}`}
                aria-disabled={retrying || !ws.canMessage || undefined}
                onClick={() => {
                  const sid = m.failure?.retryStepId;
                  if (!sid || retrying) return;
                  void ws.run(retryKey, base => ws.commands.retryStep({ ...base, stepId: sid }));
                }}
              >
                {retrying ? <span className="spin" aria-hidden="true" /> : <Icon name="retry" />}
                {retrying ? t('retrying') : t('retry')}
              </button>
            ) : null}
          </div>
        ) : null}
        {m.authority ? (
          <div className="auth">
            <EvidenceGlyph item={m.authority.evidence} />
            <span>
              {m.authority.label}
              {m.reference ? `, ${m.reference}` : ''}
            </span>
          </div>
        ) : m.reference ? (
          <div className="auth">
            <span>{m.reference}</span>
          </div>
        ) : null}
        <CommandNote state={rState} />
      </div>
    </li>
  );
}
