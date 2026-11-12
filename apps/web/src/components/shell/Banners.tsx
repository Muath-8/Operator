'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';
import { useWorkspace } from '../workspace/context';

/**
 * Honest states under the strip (UX 8.6, Quality Bar 8 Resilience, I-16): sandbox, paused, ended,
 * offline, reconnecting, a slow first connection and read-only access. Text carries the meaning, never colour alone.
 */
/** A first connection over a fresh server snapshot is not news; it is announced only if it takes longer than this. */
const CONNECT_GRACE_MS = 2500;

function useLateConnect(connecting: boolean) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!connecting) return;
    const id = window.setTimeout(() => setLate(true), CONNECT_GRACE_MS);
    return () => {
      window.clearTimeout(id);
      setLate(false);
    };
  }, [connecting]);
  return connecting && late;
}

export function Banners() {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const v = ws.view;
  const c = ws.connection;
  const lateConnect = useLateConnect(c.status === 'connecting');
  const pauseKey = 'mission:status';
  const pause = ws.commandState(pauseKey);
  const busy = pause?.phase === 'running' || pause?.phase === 'awaiting';
  return (
    <div className="banners">
      {c.status === 'offline' ? (
        <div className="banner warn" role="alert">
          <Icon name="wifi" />
          <span className="grow">{t('offlineBanner')}</span>
        </div>
      ) : c.status === 'reconnecting' || lateConnect ? (
        <div className="banner" role="status">
          <span className="spin" aria-hidden="true" />
          <span className="grow">
            {lateConnect ? t('connectingBanner') : t('reconnectingBanner')}
            {c.lastSyncedAt ? ` ${t('staleBanner', { time: i18n.time(c.lastSyncedAt) })}` : ''}
          </span>
        </div>
      ) : null}
      {v.sandbox ? (
        <div className="banner sandbox" role="note">
          <Icon name="lock" />
          <span className="grow">{t('sandboxBanner')}</span>
        </div>
      ) : null}
      {v.status === 'paused' ? (
        <div className="banner warn" role="status">
          <Icon name="pause" />
          <span className="grow">{t('pausedBanner')}</span>
          {ws.canDecide ? (
            <button
              type="button"
              className={`btn line sm${busy ? ' busy' : ''}`}
              aria-disabled={busy || undefined}
              onClick={() => !busy && void ws.run(pauseKey, base => ws.commands.setMissionStatus({ ...base, status: 'active' }))}
            >
              {t('resumeMission')}
            </button>
          ) : null}
        </div>
      ) : null}
      {v.status === 'ended' ? (
        <div className="banner" role="note">
          <Icon name="flag" />
          <span className="grow">{t('endedBanner')}</span>
        </div>
      ) : null}
      {!v.access.canDecide || !v.access.canMessage ? (
        <div className="banner" role="note">
          <Icon name="lock" />
          <span className="grow">
            {t('permissionBanner', { reason: v.access.reason ?? (!v.access.canDecide ? t('permissionDecide') : t('permissionMessage')) })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
