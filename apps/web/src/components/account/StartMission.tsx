'use client';

import { useRef, useState } from 'react';
import { useI18n } from '../../i18n';
import { newIdempotencyKey } from '../workspace/commandRunner';

/**
 * Start a mission from the empty workspace (FR-MIS-01). The mission and its first questions come from
 * the server's ledgers; nothing is pre-filled here. A retry reuses the same idempotency key, so a slow
 * network can never start two missions (I-4).
 */
interface Failure {
  readonly message: string;
  readonly retryable: boolean;
}

export function StartMission() {
  const { t } = useI18n();
  const key = useRef<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);

  const start = async () => {
    if (busy) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      setFailure({ message: t('offlineAction'), retryable: true });
      return;
    }
    key.current ??= newIdempotencyKey();
    setBusy(true);
    setFailure(null);
    try {
      const res = await fetch('/api/missions/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'createMission', idempotencyKey: key.current }),
      });
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean;
        missionId?: string;
        error?: { message?: string; retryable?: boolean };
      } | null;
      if (data?.ok === true && typeof data.missionId === 'string') {
        window.location.assign(`/?mission=${encodeURIComponent(data.missionId)}`);
        return;
      }
      const retryable = data?.error?.retryable !== false;
      if (!retryable) key.current = null;
      setFailure({ message: data?.error?.message ?? `HTTP ${res.status}`, retryable });
    } catch {
      setFailure({ message: t('commandFailed', { reason: '' }).replace(/:\s*$/, '.'), retryable: true });
    }
    setBusy(false);
  };

  return (
    <div className="pub-block">
      <button type="button" className={`btn primary${busy ? ' busy' : ''}`} aria-disabled={busy || undefined} onClick={() => void start()}>
        {busy ? <span className="spin" aria-hidden="true" /> : null}
        {busy ? t('onboard_starting') : failure?.retryable ? t('tryAgain') : t('onboard_start')}
      </button>
      <div aria-live="polite">
        {failure ? (
          <p className="cnote err" role="alert">
            {t('commandFailed', { reason: failure.message })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
