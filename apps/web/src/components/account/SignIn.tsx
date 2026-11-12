'use client';

import { useEffect, useEffectEvent, useId, useState, type FormEvent } from 'react';
import { useI18n } from '../../i18n';
import { Icon } from '../primitives/Icon';

/**
 * Sign-in (FR-ACC). Local sandbox: one explicit button, clearly labelled, POST /api/session/local.
 * Hosted: an email magic link through Supabase; the link returns here with the session in the URL
 * fragment, which is exchanged through POST /api/session {token}. The founder never pastes keys.
 */
export interface SignInProps {
  readonly local: boolean;
  readonly supabaseUrl: string | null;
  readonly supabaseAnonKey: string | null;
}

type Phase = { k: 'idle' } | { k: 'busy'; label: 'login_sending' | 'login_signingIn' } | { k: 'sent' } | { k: 'error'; message: string };

export interface Fragment {
  readonly token: string | null;
  readonly refreshToken: string | null;
  readonly error: string | null;
}

/** Pull the session tokens (or a provider error) out of a magic-link return fragment. */
export function readFragment(hash: string): Fragment {
  const p = new URLSearchParams(hash.replace(/^#/, ''));
  const get = (k: string) => {
    const v = p.get(k);
    return v && v.length <= 10000 ? v : null;
  };
  return { token: get('access_token'), refreshToken: get('refresh_token'), error: p.get('error_description') ?? p.get('error') };
}

/** Body for POST /api/session: only the fields the server accepts; refreshToken only when present. */
export function sessionBody(f: Fragment): { token: string; refreshToken?: string } | null {
  if (!f.token) return null;
  return f.refreshToken ? { token: f.token, refreshToken: f.refreshToken } : { token: f.token };
}

/** Keys an identity provider may put in a callback fragment. Any of them makes the fragment secret-bearing. */
const AUTH_KEYS =
  /(?:^|[#&?])(?:access_token|refresh_token|provider_token|provider_refresh_token|id_token|token_type|expires_in|expires_at|code|error|error_code|error_description)=/i;

/**
 * True when the fragment carries (or may carry) authentication material, however malformed or encoded:
 * keys are checked raw, after form decoding (URLSearchParams decodes `access%5Ftoken`), and after up to
 * three rounds of percent-decoding (double-encoded keys). Undecodable input that mentions a token is
 * treated as secret-bearing. Over-scrubbing an ordinary anchor is acceptable; leaking a token is not.
 */
export function isAuthFragment(hash: string): boolean {
  const body = hash.replace(/^#/, '');
  if (!body) return false;
  if (AUTH_KEYS.test(`#${body}`)) return true;
  try {
    for (const key of new URLSearchParams(body).keys()) if (AUTH_KEYS.test(`#${key}=`)) return true;
  } catch {
    /* fall through to percent-decoding */
  }
  let s = body;
  for (let i = 0; i < 3; i++) {
    let next: string;
    try {
      next = decodeURIComponent(s.replace(/\+/g, ' '));
    } catch {
      return /token|code=|error/i.test(s);
    }
    if (AUTH_KEYS.test(`#${next}`)) return true;
    if (next === s) break;
    s = next;
  }
  return /(?:access|refresh|id|provider)(?:_|%5f|%255f)?token/i.test(body);
}

/**
 * Scrub first, parse second: any auth-bearing fragment is removed from the address bar before it is
 * validated or used, including refresh-only, empty or oversized ones, so no token lingers in the URL,
 * history, referrers or screenshots. Unrelated anchors (#section) are left alone.
 */
export function takeFragment(loc: Pick<Location, 'hash' | 'pathname' | 'search'>, hist: Pick<History, 'replaceState'>): Fragment | null {
  const hash = loc.hash;
  if (!hash || hash.length < 2 || !isAuthFragment(hash)) return null;
  hist.replaceState(null, '', `${loc.pathname}${loc.search}`);
  return readFragment(hash);
}

export function SignIn({ local, supabaseUrl, supabaseAnonKey }: SignInProps) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const [email, setEmail] = useState('');
  const id = useId();
  const hosted = !!supabaseUrl && !!supabaseAnonKey;

  // The tokens go only to the HttpOnly session endpoint: never stored, logged or shown in errors.
  const exchange = async (body: { token: string; refreshToken?: string }) => {
    setPhase({ k: 'busy', label: 'login_signingIn' });
    try {
      const res = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('rejected');
      window.location.assign('/');
    } catch {
      setPhase({ k: 'error', message: t('login_linkFailed') });
    }
  };

  // Magic-link return: clear the fragment first, then exchange the tokens once. A callback without a
  // usable access token (refresh-only, empty, oversized) is never sent anywhere; it just reports failure.
  // Runs once per page load: the fragment is consumed (scrubbed) on the first read, so there is nothing to react to later.
  const consumeReturn = useEffectEvent(() => {
    let f: Fragment | null = null;
    try {
      f = takeFragment(window.location, window.history);
    } catch {
      setPhase({ k: 'error', message: t('login_linkFailed') });
      return;
    }
    if (!f) return;
    const body = sessionBody(f);
    if (f.error || !body) setPhase({ k: 'error', message: t('login_linkFailed') });
    else void exchange(body);
  });
  useEffect(() => consumeReturn(), []);

  const signInLocal = async () => {
    if (phase.k === 'busy') return;
    setPhase({ k: 'busy', label: 'login_signingIn' });
    try {
      const res = await fetch('/api/session/local', { method: 'POST' });
      if (!res.ok) throw new Error(res.status === 403 ? 'local sign-in is not enabled here' : `HTTP ${res.status}`);
      window.location.assign('/');
    } catch (e) {
      setPhase({ k: 'error', message: t('login_failed', { reason: e instanceof Error ? e.message : '' }) });
    }
  };

  const sendLink = async (e: FormEvent) => {
    e.preventDefault();
    if (phase.k === 'busy' || !hosted || !supabaseUrl || !supabaseAnonKey) return;
    const value = email.trim();
    if (!value) return;
    setPhase({ k: 'busy', label: 'login_sending' });
    try {
      const { createClient } = await import('@supabase/supabase-js');
      const client = createClient(supabaseUrl, supabaseAnonKey, {
        auth: { flowType: 'implicit', persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      const { error } = await client.auth.signInWithOtp({ email: value, options: { emailRedirectTo: `${window.location.origin}/login` } });
      if (error) throw error;
      setPhase({ k: 'sent' });
    } catch (err) {
      setPhase({ k: 'error', message: t('login_failed', { reason: err instanceof Error ? err.message : '' }) });
    }
  };

  const busy = phase.k === 'busy';
  return (
    <div className="pub-form" aria-busy={busy || undefined}>
      {local ? (
        <div className="pub-block">
          <p className="sandbox-tag">
            <Icon name="lock" />
            {t('login_localNote')}
          </p>
          <button
            type="button"
            className={`btn primary${busy ? ' busy' : ''}`}
            aria-disabled={busy || undefined}
            onClick={() => void signInLocal()}
          >
            {busy ? <span className="spin" aria-hidden="true" /> : null}
            {t('login_local')}
          </button>
        </div>
      ) : null}
      {hosted ? (
        <form className="pub-block" onSubmit={e => void sendLink(e)} noValidate>
          <label className="field" htmlFor={`${id}-email`}>
            <span>{t('login_email')}</span>
            <input
              id={`${id}-email`}
              type="email"
              autoComplete="email"
              inputMode="email"
              required
              value={email}
              readOnly={busy}
              onChange={e => setEmail(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className={`btn ${local ? 'line' : 'primary'}${busy ? ' busy' : ''}`}
            aria-disabled={busy || !email.trim() || undefined}
          >
            {phase.k === 'busy' && phase.label === 'login_sending' ? <span className="spin" aria-hidden="true" /> : <Icon name="mail" />}
            {t('login_send')}
          </button>
        </form>
      ) : null}
      {!local && !hosted ? <p className="cnote">{t('login_unconfigured')}</p> : null}
      <div className="pub-status" aria-live="polite">
        {phase.k === 'busy' ? (
          <p className="cnote">
            <span className="spin" aria-hidden="true" /> {t(phase.label)}
          </p>
        ) : phase.k === 'sent' ? (
          <p className="cnote">
            <Icon name="check" /> {t('login_sent')}
          </p>
        ) : phase.k === 'error' ? (
          <p className="cnote err" role="alert">
            {phase.message}
          </p>
        ) : null}
      </div>
    </div>
  );
}
