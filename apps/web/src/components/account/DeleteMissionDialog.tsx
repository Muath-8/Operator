'use client';

import { useEffect, useId, useState } from 'react';
import type { DeletionNotice } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { Dialog } from '../primitives/Dialog';
import { Icon } from '../primitives/Icon';
import { useWorkspace } from '../workspace/context';
import { fetchDeletionNotice, requestDeletion } from './accountApi';

/**
 * Mission deletion (FR-ACC-06). The founder sees the concrete accounts and assets that stay theirs,
 * confirms twice, and only a server {ok:true, receiptId} counts as deleted. A failure asks the founder to refresh the current state;
 * nothing is removed from the screen until the server confirms.
 */
export function DeleteMissionDialog({ onClose }: { readonly onClose: () => void }) {
  const ws = useWorkspace();
  const { t } = useI18n();
  const id = useId();
  const missionId = ws.view.missionId;
  const name = ws.view.header.untitled ? t('untitled') : ws.view.header.name;
  const [notice, setNotice] = useState<DeletionNotice | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [understand, setUnderstand] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'deleting' | 'failed' | 'done'>('idle');
  const [failure, setFailure] = useState('');
  const [receipt, setReceipt] = useState('');
  const owner = ws.view.access.role === 'owner';

  useEffect(() => {
    let live = true;
    (ws.host.loadDeletionNotice ?? fetchDeletionNotice)(missionId)
      .then(n => live && setNotice(n))
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, [missionId, ws.host.loadDeletionNotice]);

  const canDelete =
    owner && !!notice && understand && confirm && phase !== 'deleting' && phase !== 'done' && ws.connection.status !== 'offline';

  const doDelete = async () => {
    if (!canDelete) return;
    setPhase('deleting');
    const r = await (ws.host.deleteMission ?? requestDeletion)(missionId);
    if (r.ok) {
      setReceipt(r.receiptId);
      setPhase('done');
      ws.announce(t('del_done', { id: r.receiptId }));
      window.location.assign('/');
    } else {
      setFailure(r.message);
      setPhase('failed');
    }
  };

  const list = (items: DeletionNotice['retainedAccounts']) =>
    items.length ? (
      <ul className="keep">
        {items.map(x => (
          <li key={x.id}>
            <b>{x.label}</b>
            {x.detail ? <span className="muted"> {x.detail}</span> : null}
          </li>
        ))}
      </ul>
    ) : (
      <p className="muted">{t('del_none')}</p>
    );

  return (
    <Dialog labelledBy={`${id}-h`} onClose={onClose} busy={phase === 'deleting'}>
      <h2 id={`${id}-h`}>{t('del_title', { name })}</h2>
      <p className="lead">{notice?.notice || t('del_lead')}</p>
      {!owner ? <p className="cnote err">{t('del_ownerOnly')}</p> : null}
      {loadError ? (
        <p className="cnote err" role="alert">
          {t('del_loadFailed')}
        </p>
      ) : !notice ? (
        <p className="cnote" role="status">
          <span className="spin" aria-hidden="true" /> {t('del_loading')}
        </p>
      ) : (
        <>
          <h3>{t('del_accounts')}</h3>
          {list(notice.retainedAccounts)}
          <h3>{t('del_assets')}</h3>
          {list(notice.retainedExternalAssets)}
          <label className="check">
            <input type="checkbox" checked={understand} disabled={phase === 'deleting'} onChange={e => setUnderstand(e.target.checked)} />
            <span>{t('del_understand')}</span>
          </label>
          <label className="check">
            <input type="checkbox" checked={confirm} disabled={phase === 'deleting'} onChange={e => setConfirm(e.target.checked)} />
            <span>{t('del_confirm')}</span>
          </label>
        </>
      )}
      {phase === 'failed' ? (
        <p className="cnote err" role="alert">
          {t('del_failed')}
          {failure && failure !== t('del_failed') ? ` ${failure}` : ''}
        </p>
      ) : null}
      {phase === 'done' ? (
        <p className="cnote" role="status">
          {t('del_done', { id: receipt })}
        </p>
      ) : null}
      {ws.connection.status === 'offline' ? <p className="cnote err">{t('offlineAction')}</p> : null}
      <div className="dlg-acts">
        <button
          type="button"
          className={`btn primary${phase === 'deleting' ? ' busy' : ''}`}
          aria-disabled={!canDelete || undefined}
          onClick={() => void doDelete()}
        >
          {phase === 'deleting' ? <span className="spin" aria-hidden="true" /> : <Icon name="close" />}
          {phase === 'deleting' ? t('del_deleting') : phase === 'failed' ? t('retry') : t('del_button')}
        </button>
        <button
          type="button"
          className="btn quiet"
          aria-disabled={phase === 'deleting' || undefined}
          onClick={() => phase !== 'deleting' && onClose()}
        >
          {t('del_cancel')}
        </button>
      </div>
    </Dialog>
  );
}
