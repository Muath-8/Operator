'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { useWorkspace } from '../workspace/context';
import { CommandNote } from '../page/Blocks';
import { fetchPrivacy, type MissionPrivacy } from './privacyApi';

export function ArchiveDownload() {
  const ws = useWorkspace();
  const { t } = useI18n();
  return (
    <section aria-label={t('privacy_archive')}>
      <h3 className="sec">{t('privacy_archive')}</h3>
      <p className="acct-d">{t('privacy_archiveNote')}</p>
      {ws.view.access.role === 'owner' && ws.connection.status !== 'offline' ? (
        <a
          className="btn line sm"
          href={`/api/missions/${encodeURIComponent(ws.view.missionId)}/archive`}
          download={`mission-${ws.view.missionId}.ndjson`}
        >
          {t('privacy_download')}
        </a>
      ) : (
        <p className="cnote">{t(ws.connection.status === 'offline' ? 'offlineAction' : 'acc_ownerOnly')}</p>
      )}
    </section>
  );
}

/** Keyed by mission at its entry point. Requests are aborted on switch/unmount;
 * acknowledged changes reload only once the rendered ledger reaches their version. */
export function PrivacyControls() {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const [data, setData] = useState<MissionPrivacy | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [refreshAt, setRefreshAt] = useState<number | null>(null);
  const request = useRef<AbortController | null>(null);
  const live = useRef(true);
  const owner = ws.view.access.role === 'owner';
  const load = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setFailed(false);
    setLoading(true);
    void fetchPrivacy(ws.view.missionId, controller.signal)
      .then(value => {
        if (!controller.signal.aborted) {
          setData(value);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setFailed(true);
          setLoading(false);
        }
      });
  }, [ws.view.missionId]);
  useEffect(() => {
    live.current = true;
    if (owner) load();
    return () => {
      live.current = false;
      request.current?.abort();
    };
  }, [load, owner]);
  useEffect(() => {
    if (refreshAt !== null && ws.view.ledgerVersion >= refreshAt) {
      setRefreshAt(null);
      load();
    }
  }, [refreshAt, ws.view.ledgerVersion, load]);
  const blocked = !owner || loading || refreshAt !== null || ws.connection.status === 'offline';
  const change = async (key: string, action: Parameters<typeof ws.run>[1]) => {
    const result = await ws.run(key, action);
    if (live.current && result?.ok) setRefreshAt(result.ledgerVersion);
  };
  if (!owner) return <ArchiveDownload />;
  return (
    <>
      <section aria-label={t('privacy_title')}>
        <h3 className="sec">{t('privacy_title')}</h3>
        <p className="acct-d">{t('privacy_note')}</p>
        {loading ? (
          <p className="cnote" role="status">
            {t('privacy_loading')}
          </p>
        ) : null}
        {failed ? (
          <p className="cnote err" role="alert">
            {t('privacy_failed')}{' '}
            <button type="button" className="btn line sm" onClick={load}>
              {t('tryAgain')}
            </button>
          </p>
        ) : null}
        {data && !failed ? (
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={data.traceRetentionEnabled}
                disabled={blocked || (!!ws.commandState('privacy-trace') && ws.commandState('privacy-trace')?.phase !== 'error')}
                onChange={event => {
                  const enabled = event.target.checked;
                  void change('privacy-trace', base => ws.commands.setTraceRetention({ ...base, enabled }));
                }}
              />
              <span>{t('privacy_trace')}</span>
            </label>
            <p className="acct-d">{t(data.externalTraceExportConfigured ? 'privacy_externalOn' : 'privacy_externalOff')}</p>
            <CommandNote state={ws.commandState('privacy-trace')} />
            <h4>{t('privacy_raw')}</h4>
            {data.objects.length ? (
              <ul className="accts">
                {data.objects.map(object => {
                  const key = `privacy-keep:${object.id}`;
                  const state = ws.commandState(key);
                  return (
                    <li className="acct" key={object.id}>
                      <b>{t(object.kind === 'trace' ? 'privacy_traceKind' : `privacy_${object.kind}`)}</b>
                      <div className="acct-d">{i18n.dateTime(object.createdAt)}</div>
                      <p className="acct-d">
                        {t(!object.available ? 'privacy_unavailable' : object.kept ? 'privacy_kept' : 'privacy_expires', {
                          date: i18n.date(object.expiresAt),
                        })}
                      </p>
                      {object.kind !== 'trace' && (object.available || object.kept) ? (
                        <button
                          type="button"
                          className="btn quiet sm"
                          disabled={blocked || (!!state && state.phase !== 'error')}
                          onClick={() =>
                            void change(key, base => ws.commands.keepRetainedContent({ ...base, objectId: object.id, keep: !object.kept }))
                          }
                        >
                          {t(object.kept ? 'privacy_unkeep' : 'privacy_keep')}
                        </button>
                      ) : null}
                      <CommandNote state={state} />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="foot">{t('privacy_none')}</p>
            )}
          </>
        ) : null}
        {refreshAt !== null ? (
          <p className="cnote" role="status">
            {t('waitingForLedger')}
          </p>
        ) : null}
        {ws.connection.status === 'offline' ? <p className="cnote">{t('offlineAction')}</p> : null}
      </section>
      <ArchiveDownload />
    </>
  );
}
