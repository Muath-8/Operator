import type { AccountRevocation, AccountsView, AccountView, DeletionNotice, DeletionResult, ShopifyConnectResult } from '../../ui-contract';

/**
 * Default account actions against root's documented routes, used when the host does not inject its own.
 * Nothing here is optimistic: callers show success only on the server's {ok:true}.
 */
type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === 'object' && !Array.isArray(v);
const raw = (o: Record<string, Json>, k: string): string => (typeof o[k] === 'string' ? (o[k] as string) : '');
const strs = (v: Json | undefined): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
/** Identifier-style labels ("marketing_publish") read as words; free text (references, sentences) is kept exactly. */
export const readable = (v: string): string => (/^[a-z0-9]+(_[a-z0-9]+)+$/.test(v) ? v.replace(/_/g, ' ') : v);
/** Safe server message from either {error:{message}} or {error:"..."}. Never echoes request data. */
const errMessage = (d: unknown): string => {
  if (!isObj(d)) return '';
  const e = d['error'];
  if (isObj(e) && typeof e['message'] === 'string') return e['message'];
  return typeof e === 'string' ? e : '';
};

/* ---------- mission deletion (FR-ACC-06) ---------- */

/**
 * Map rows to labelled items using only fields the server sent; nothing is invented.
 * Strict: the list must be an array and every row must identify itself (non-empty `id`) and be nameable,
 * either as a structured row {id, label, detail} or a legacy row with a known name field. Anything else
 * throws, so a malformed disclosure is a load failure, never "none recorded".
 */
export function toItems(rows: unknown, labelKeys: readonly string[], detailKeys: readonly string[]): DeletionNotice['retainedAccounts'] {
  if (!Array.isArray(rows)) throw new Error('Disclosure list missing');
  return rows.map(row => {
    if (!isObj(row)) throw new Error('Disclosure row malformed');
    const id = raw(row, 'id').trim();
    if (!id) throw new Error('Disclosure row without id');
    if ('label' in row) {
      const label = raw(row, 'label').trim();
      if (!label || ('detail' in row && typeof row['detail'] !== 'string')) throw new Error('Disclosure row malformed');
      return { id, label: readable(label), detail: raw(row, 'detail') };
    }
    const label = labelKeys.map(k => raw(row, k).trim()).find(Boolean);
    if (!label) throw new Error('Disclosure row without a name');
    const detail = detailKeys
      .map(k => readable(raw(row, k)))
      .filter(Boolean)
      .join(', ');
    return { id, label: readable(label), detail };
  });
}

/** Complete documented disclosure: both lists (possibly empty arrays) and the notice text. */
export function parseDeletionNotice(data: unknown): DeletionNotice {
  if (!isObj(data)) throw new Error('Unexpected deletion notice');
  if (typeof data['notice'] !== 'string') throw new Error('Deletion notice text missing');
  return {
    retainedAccounts: toItems(data['retainedAccounts'], ['provider', 'name'], ['status']),
    retainedExternalAssets: toItems(data['retainedExternalAssets'], ['title', 'name', 'type', 'kind'], ['type', 'status']),
    notice: data['notice'],
  };
}

export async function fetchDeletionNotice(missionId: string): Promise<DeletionNotice> {
  const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/deletion`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseDeletionNotice(await res.json());
}

export async function requestDeletion(missionId: string): Promise<DeletionResult> {
  try {
    const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/deletion`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true, understandExternalAssetsRemain: true }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (res.ok && isObj(data) && data['ok'] === true && typeof data['receiptId'] === 'string')
      return { ok: true, receiptId: data['receiptId'] };
    return { ok: false, message: errMessage(data) };
  } catch {
    return { ok: false, message: '' };
  }
}

/* ---------- provider accounts (FR-ACC-01/02, docs/implementation/ACCOUNT-API.md) ---------- */

const PROVIDERS: Readonly<Record<string, string>> = {
  paypal: 'PayPal',
  twilio: 'Twilio',
  resend: 'Resend',
  shopify: 'Shopify',
  browserbase: 'Browserbase',
  openai: 'OpenAI',
};

const nullableString = (v: Json | undefined): boolean => v === null || typeof v === 'string';

/** Validate one documented account row; any missing or mistyped critical field rejects the whole list. */
function accountRow(a: Json): AccountView {
  if (!isObj(a)) throw new Error('Account row malformed');
  const id = raw(a, 'accountId').trim();
  const provider = raw(a, 'provider').trim();
  const status = raw(a, 'status');
  const v = a['verification'];
  if (!id || !provider || (status !== 'connected' && status !== 'revoked')) throw new Error('Account row malformed');
  if (typeof a['sandboxMode'] !== 'boolean' || !Array.isArray(a['scopes']) || !a['scopes'].every(s => typeof s === 'string'))
    throw new Error('Account row malformed');
  if (!nullableString(a['counterpartyId'] ?? null) || !nullableString(a['createdAt'] ?? null)) throw new Error('Account row malformed');
  if (
    !isObj(v) ||
    (v['status'] !== 'authenticated' && v['status'] !== 'unverified') ||
    typeof v['ownership'] !== 'string' ||
    !nullableString(v['checkedAt'] ?? null) ||
    !nullableString(v['reason'] ?? null)
  ) {
    throw new Error('Account verification malformed');
  }
  return {
    id,
    label: PROVIDERS[provider] ?? readable(provider),
    provider,
    status,
    check: v['status'] === 'authenticated' ? 'passed' : 'pending',
    checkedAt: raw(v, 'checkedAt') || null,
    reason: raw(v, 'reason'),
    ownership: v['ownership'] === 'founder_attested' ? 'founder_attested' : 'unknown',
    sandbox: a['sandboxMode'],
    scopes: strs(a['scopes']).map(readable),
    connectedAt: raw(a, 'createdAt') || null,
    canRevoke: status !== 'revoked',
  };
}

/**
 * Strict to docs/implementation/ACCOUNT-API.md: `{ok:true, value:{accounts:[…]}}` with every row valid.
 * A malformed or incomplete inventory throws (shown as "couldn't load"), never as "no accounts".
 * Nothing is upgraded: `authenticated` is a passed read-only check, never verified ownership.
 */
export function parseAccounts(data: unknown): AccountsView {
  if (!isObj(data) || data['ok'] !== true) throw new Error('Accounts unavailable');
  const value = data['value'];
  if (!isObj(value) || !Array.isArray(value['accounts'])) throw new Error('Accounts list missing');
  return { accounts: value['accounts'].map(accountRow) };
}

export async function fetchAccounts(missionId: string): Promise<AccountsView> {
  const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/accounts`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseAccounts(await res.json());
}

/** DELETE takes no body and is idempotent. Only {ok:true} counts as revoked. */
export async function revokeAccountAccess(missionId: string, accountId: string): Promise<AccountRevocation> {
  try {
    const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/accounts/${encodeURIComponent(accountId)}`, {
      method: 'DELETE',
    });
    const data: unknown = await res.json().catch(() => null);
    if (res.ok && isObj(data) && data['ok'] === true) {
      const value = isObj(data['value']) ? data['value'] : {};
      return { ok: true, revokedAt: raw(value, 'revokedAt') || null };
    }
    return { ok: false, message: errMessage(data) };
  } catch {
    return { ok: false, message: '' };
  }
}

export const isShopDomain = (v: string): boolean => /^[a-z0-9][a-z0-9-]{0,61}\.myshopify\.com$/.test(v.trim().toLowerCase());

/** Only an https authorize URL on the same shop is followed. */
export function safeShopifyRedirect(url: string, shopDomain: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === shopDomain.trim().toLowerCase() && u.pathname.startsWith('/admin/oauth/authorize')
      ? u.href
      : null;
  } catch {
    return null;
  }
}

export async function startShopifyConnect(missionId: string, shopDomain: string): Promise<ShopifyConnectResult> {
  try {
    const res = await fetch(`/api/missions/${encodeURIComponent(missionId)}/accounts/shopify/oauth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shopDomain: shopDomain.trim().toLowerCase(), founderAttestsOwnership: true }),
    });
    const data: unknown = await res.json().catch(() => null);
    if (res.ok && isObj(data) && data['ok'] === true && isObj(data['value']) && typeof data['value']['authorizationUrl'] === 'string')
      return { ok: true, authorizationUrl: data['value']['authorizationUrl'] };
    return { ok: false, message: errMessage(data) };
  } catch {
    return { ok: false, message: '' };
  }
}

/* ---------- session ---------- */

/** Resolves only when the server confirms the session cookie was removed; otherwise rejects. */
export async function endSession(): Promise<void> {
  const res = await fetch('/api/session', { method: 'DELETE', credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`Sign-out was not confirmed (HTTP ${res.status})`);
  const data: unknown = await res.json().catch(() => null);
  if (!isObj(data) || data['ok'] !== true) throw new Error('Sign-out was not confirmed');
}
