'use client';

import { useCallback, useEffect, useId, useState, type FormEvent } from 'react';
import type { AccountView, AccountsView } from '../../ui-contract';
import { useI18n } from '../../i18n';
import { PrivacyControls } from './PrivacyControls';
import { useWorkspace } from '../workspace/context';
import { fetchAccounts, isShopDomain, revokeAccountAccess, safeShopifyRedirect, startShopifyConnect } from './accountApi';

/**
 * Accounts (FR-ACC-01/02, docs/implementation/ACCOUNT-API.md): founder-owned accounts the agent may use.
 * A passed read-only check is never shown as verified ownership; unverified reads "Verification pending".
 * Revocation is shown only after the server confirms and the list reloads. No credential entry anywhere:
 * Shopify connects through its own OAuth page, other providers through the operator's server-side command.
 */
export function AccountsPeek() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const missionId = ws.view.missionId;
  const [data, setData] = useState<AccountsView | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(() => {
    setFailed(false);
    (ws.host.loadAccounts ?? fetchAccounts)(missionId)
      .then(setData)
      .catch(() => setFailed(true));
  }, [missionId, ws.host.loadAccounts]);
  useEffect(load, [load]);
  const hasShopify = !!data?.accounts.some(a => a.provider === 'shopify' && a.status === 'connected');

  return (
    <div>
      <h2>{t('accounts')}</h2>
      <p className="lead">{t('acc_lead')}</p>
      {failed ? (
        <p className="cnote err" role="alert">
          {t('acc_loadFailed')}{' '}
          <button type="button" className="btn line sm" onClick={load}>
            {t('tryAgain')}
          </button>
        </p>
      ) : !data ? (
        <p className="cnote" role="status">
          <span className="spin" aria-hidden="true" /> {t('acc_loading')}
        </p>
      ) : data.accounts.length ? (
        <ul className="accts" aria-label={t('accounts')}>
          {data.accounts.map(a => (
            <AccountRow key={a.id} a={a} onChanged={load} />
          ))}
        </ul>
      ) : (
        <p className="foot">{t('acc_none')}</p>
      )}
      <h3 className="sec">{t('acc_connect')}</h3>
      {hasShopify || ws.view.access.role !== 'owner' ? null : <ShopifyConnect />}
      <p className="acc-note">{t('acc_connectOperator')}</p>
      <PrivacyControls key={missionId} />
    </div>
  );
}

function AccountRow({ a, onChanged }: { readonly a: AccountView; readonly onChanged: () => void }) {
  const ws = useWorkspace();
  const i18n = useI18n();
  const { t } = i18n;
  const [confirming, setConfirming] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [reason, setReason] = useState('');
  const revoked = a.status === 'revoked';
  const canAct = a.canRevoke && !revoked && ws.view.access.role === 'owner';

  const revoke = async () => {
    if (phase === 'busy') return;
    if (ws.connection.status === 'offline') {
      setPhase('failed');
      setReason(t('offlineAction'));
      return;
    }
    setPhase('busy');
    const r = await (ws.host.revokeAccount ?? revokeAccountAccess)(ws.view.missionId, a.id);
    if (r.ok) {
      setConfirming(false);
      setPhase('idle');
      ws.announce(t('acc_revoked'));
      onChanged();
    } else {
      setReason(r.message);
      setPhase('failed');
    }
  };

  return (
    <li className={`acct${revoked ? ' revoked' : ''}`}>
      <div className="acct-h">
        <b>
          {a.label}
          {a.sandbox ? <span className="acct-tag">{t('money_sandbox')}</span> : null}
        </b>
        <span className={`acct-st${!revoked && a.check === 'passed' ? ' ok' : !revoked ? ' wait' : ''}`}>
          {revoked
            ? t('acc_revokedState')
            : a.check === 'passed'
              ? t('acc_checkPassed', { date: a.checkedAt ? i18n.date(a.checkedAt) : '' }).trim()
              : t('acc_pending')}
        </span>
      </div>
      {!revoked ? <div className="acct-d">{a.check === 'passed' ? t('acc_checkPassedNote') : t('acc_pendingNote')}</div> : null}
      {a.reason ? <div className="acct-d bidi">{a.reason}</div> : null}
      {a.ownership === 'founder_attested' ? <div className="acct-d">{t('acc_attested')}</div> : null}
      {a.scopes.length ? <div className="acct-d bidi">{t('acc_scopes', { v: a.scopes.join(t('comma').trim() + ' ') })}</div> : null}
      {a.connectedAt ? <div className="acct-d">{t('acc_since', { date: i18n.date(a.connectedAt) })}</div> : null}
      {canAct ? (
        confirming ? (
          <div className="acct-confirm" role="group" aria-label={t('acc_revoke')}>
            <p>{t('acc_revokeConfirm', { name: a.label })}</p>
            <div className="acts">
              <button
                type="button"
                className={`btn line sm${phase === 'busy' ? ' busy' : ''}`}
                aria-disabled={phase === 'busy' || undefined}
                onClick={() => void revoke()}
              >
                {phase === 'busy' ? <span className="spin" aria-hidden="true" /> : null}
                {phase === 'busy' ? t('acc_revoking') : t('acc_revokeYes', { name: a.label })}
              </button>
              <button
                type="button"
                className="btn quiet sm"
                aria-disabled={phase === 'busy' || undefined}
                onClick={() => phase !== 'busy' && setConfirming(false)}
              >
                {t('acc_keep')}
              </button>
            </div>
          </div>
        ) : (
          <div className="acts">
            <button type="button" className="btn quiet sm" onClick={() => setConfirming(true)}>
              {t('acc_revoke')}
            </button>
          </div>
        )
      ) : null}
      {!revoked && a.canRevoke && ws.view.access.role !== 'owner' ? <div className="acct-d">{t('acc_ownerOnly')}</div> : null}
      {phase === 'failed' ? (
        <p className="cnote err" role="alert">
          {t('acc_revokeFailed', { reason })}
        </p>
      ) : null}
    </li>
  );
}

/** Shopify install: the founder's store address and ownership attestation; Shopify's own page does the rest. */
function ShopifyConnect() {
  const ws = useWorkspace();
  const { t } = useI18n();
  const id = useId();
  const [shop, setShop] = useState('');
  const [attest, setAttest] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'busy' | 'error'>('idle');
  const [message, setMessage] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (phase === 'busy') return;
    if (!isShopDomain(shop) || !attest) {
      setPhase('error');
      setMessage(t('shop_invalid'));
      return;
    }
    setPhase('busy');
    const r = await (ws.host.connectShopify ?? startShopifyConnect)(ws.view.missionId, shop);
    const url = r.ok ? safeShopifyRedirect(r.authorizationUrl, shop) : null;
    if (url) {
      window.location.assign(url);
      return;
    }
    setPhase('error');
    setMessage(t('shop_failed', { reason: r.ok ? '' : r.message }));
  };

  return (
    <form className="shop" onSubmit={e => void submit(e)} noValidate aria-busy={phase === 'busy' || undefined}>
      <p className="shop-h">{t('shop_title')}</p>
      <label className="field" htmlFor={`${id}-shop`}>
        <span>
          {t('shop_domain')} <span className="muted">({t('shop_hint')})</span>
        </span>
        <input
          id={`${id}-shop`}
          dir="ltr"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="your-store.myshopify.com"
          value={shop}
          aria-invalid={phase === 'error' && !isShopDomain(shop) ? true : undefined}
          onChange={e => setShop(e.target.value)}
        />
      </label>
      <label className="check">
        <input
          type="checkbox"
          checked={attest}
          aria-invalid={phase === 'error' && !attest ? true : undefined}
          onChange={e => setAttest(e.target.checked)}
        />
        <span>{t('shop_attest')}</span>
      </label>
      <p className="acct-d">{t('shop_note')}</p>
      <button type="submit" className={`btn line sm${phase === 'busy' ? ' busy' : ''}`} aria-disabled={phase === 'busy' || undefined}>
        {phase === 'busy' ? <span className="spin" aria-hidden="true" /> : null}
        {phase === 'busy' ? t('shop_going') : t('shop_go')}
      </button>
      {phase === 'error' ? (
        <p className="cnote err" role="alert">
          {message}
        </p>
      ) : null}
    </form>
  );
}
