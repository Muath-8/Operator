'use client';
let renewal: Promise<boolean> | null = null;
export async function renewSession(): Promise<boolean> {
  if (renewal) return renewal;
  renewal = fetch('/api/session/refresh', { method: 'POST', credentials: 'same-origin' })
    .then(r => r.ok)
    .catch(() => false);
  try {
    return await renewal;
  } finally {
    renewal = null;
  }
}
/** Retries the same request after a coalesced session renewal. Mutation callers
 * retain their original idempotency key and immutable request body. */
export async function sessionFetch(url: string, init?: RequestInit): Promise<Response> {
  let response = await fetch(url, init);
  if (response.status === 401 && (await renewSession())) response = await fetch(url, init);
  return response;
}
/** JWT contents are used only to schedule refresh, never to authorize access. */
export function tokenRefreshDelay(token: string, now = Date.now()): number {
  try {
    const body = JSON.parse(atob((token.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/'))) as { exp?: number };
    if (typeof body.exp === 'number') return Math.max(1000, Math.min(300000, body.exp * 1000 - now - 60000));
  } catch {
    /* Malformed scheduling hint; server remains the authority. */
  }
  return 60000;
}
