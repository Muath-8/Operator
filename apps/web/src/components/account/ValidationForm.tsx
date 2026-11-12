'use client';

import { useId, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';

/**
 * Public validation page form (FR-PLY-08, Demand). Email plus an explicit, unchecked consent box,
 * and a hidden honeypot. The submitted state appears only on the server's {ok:true}; on failure
 * every input is kept. The only network action is the signup POST.
 */
export function ValidationForm({ slug, consentText }: { readonly slug: string; readonly consentText: string }) {
  const { t } = useI18n();
  const id = useId();
  const [email, setEmail] = useState('');
  const [consent, setConsent] = useState(false);
  const [website, setWebsite] = useState('');
  const [phase, setPhase] = useState<'idle' | 'busy' | 'done' | 'error'>('idle');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (phase === 'busy' || phase === 'done') return;
    if (!email.trim()) {
      setPhase('error');
      setError(t('val_emailRequired'));
      return;
    }
    if (!consent) {
      setPhase('error');
      setError(t('val_consentRequired'));
      return;
    }
    setPhase('busy');
    try {
      const res = await fetch(`/api/validation/${encodeURIComponent(slug)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), consent: true, website }),
      });
      const data = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (res.ok && data?.ok === true) {
        setPhase('done');
        return;
      }
      setError(t('val_failed', { reason: typeof data?.error === 'string' ? data.error : `HTTP ${res.status}` }));
      setPhase('error');
    } catch {
      setError(t('val_failed', { reason: t('offlineAction') }));
      setPhase('error');
    }
  };

  if (phase === 'done') {
    return (
      <p className="pub-done" role="status">
        <Icon name="check" />
        {t('val_done')}
      </p>
    );
  }

  return (
    <form className="pub-form pub-block" onSubmit={e => void submit(e)} noValidate aria-busy={phase === 'busy' || undefined}>
      <label className="field" htmlFor={`${id}-email`}>
        <span>{t('val_email')}</span>
        <input
          id={`${id}-email`}
          type="email"
          name="email"
          autoComplete="email"
          inputMode="email"
          required
          value={email}
          aria-invalid={phase === 'error' && !email.trim() ? true : undefined}
          onChange={e => setEmail(e.target.value)}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          name="consent"
          checked={consent}
          aria-invalid={phase === 'error' && !consent ? true : undefined}
          onChange={e => setConsent(e.target.checked)}
        />
        <span className="bidi">{consentText}</span>
      </label>
      {/* Honeypot: hidden from people and assistive tech; bots that fill it are rejected by the server. */}
      <div className="hp" aria-hidden="true">
        <label htmlFor={`${id}-website`}>{t('val_honeypot')}</label>
        <input
          id={`${id}-website`}
          type="text"
          name="website"
          tabIndex={-1}
          autoComplete="off"
          value={website}
          onChange={e => setWebsite(e.target.value)}
        />
      </div>
      <button type="submit" className={`btn primary${phase === 'busy' ? ' busy' : ''}`} aria-disabled={phase === 'busy' || undefined}>
        {phase === 'busy' ? <span className="spin" aria-hidden="true" /> : null}
        {phase === 'busy' ? t('val_submitting') : t('val_submit')}
      </button>
      <div aria-live="polite">
        {phase === 'error' ? (
          <p className="cnote err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
