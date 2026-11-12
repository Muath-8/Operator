import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';

// This is a local sandbox integration check, separate from mission authority/ledgers.
const API = 'https://api-m.sandbox.paypal.com';
const id = z.string().regex(/^[A-Z0-9]{8,64}$/);
const money = z.object({ value: z.literal('1.00'), currency_code: z.literal('USD') });
const capture = z.object({
  id,
  status: z.string(),
  amount: money,
  supplementary_data: z.object({ related_ids: z.object({ order_id: id }) }).optional(),
});
const order = z.object({
  id,
  status: z.string(),
  intent: z.literal('CAPTURE'),
  purchase_units: z.tuple([
    z.object({
      reference_id: z.string(),
      custom_id: z.string(),
      amount: money,
      payee: z.object({ merchant_id: id }),
      payments: z.object({ captures: z.array(capture).optional() }).optional(),
    }),
  ]),
  links: z.array(z.object({ rel: z.string(), href: z.string() })).optional(),
});
const rowSchema = z.object({
  actor: z.string(),
  request_key: z.string(),
  reference: z.string(),
  client_hash: z.string(),
  order_id: z.string().nullable(),
  merchant_id: z.string().nullable(),
  approval_url: z.string().nullable(),
  state: z.string(),
  result: z.string().nullable(),
});
const resultSchema = z.object({
  orderId: id,
  captureId: id,
  status: z.literal('COMPLETED'),
  amount: z.literal('1.00'),
  currency: z.literal('USD'),
});
type Row = z.infer<typeof rowSchema>;
export class LocalPayPalError extends Error {
  constructor(
    readonly code: 'unavailable' | 'validation' | 'forbidden' | 'pending' | 'provider',
    message: string,
  ) {
    super(message);
  }
}
function hash(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
function allowed() {
  return (
    process.env['LO_EXECUTION_MODE'] === 'local' &&
    process.env['LO_STORAGE_BACKEND'] === 'sqlite' &&
    process.env['NODE_ENV'] !== 'production'
  );
}
export function localPayPalStatus(): { configured: boolean } {
  return { configured: allowed() && Boolean(process.env['PAYPAL_CLIENT_ID']?.trim() && process.env['PAYPAL_CLIENT_SECRET']?.trim()) };
}
function configuration() {
  if (!localPayPalStatus().configured)
    throw new LocalPayPalError('unavailable', 'PayPal sandbox requires explicit local SQLite mode and sandbox credentials.');
  const client = z.string().trim().min(1).parse(process.env['PAYPAL_CLIENT_ID']),
    secret = z.string().trim().min(1).parse(process.env['PAYPAL_CLIENT_SECRET']);
  const origin = new URL(process.env['APP_ORIGIN'] || 'http://127.0.0.1:3100');
  if (
    origin.protocol !== 'http:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    throw new LocalPayPalError('validation', 'The sandbox demo return origin must be a loopback HTTP origin.');
  const merchant = process.env['PAYPAL_MERCHANT_ID']?.trim();
  if (merchant && !id.safeParse(merchant).success) throw new LocalPayPalError('validation', 'Invalid sandbox merchant ID.');
  return { client, secret, merchant, origin: origin.origin, clientHash: hash(client) };
}
function database() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const path = resolve(dirname(process.env['LO_SQLITE_PATH'] || resolve(root, '.local/testing/operator.sqlite')), 'paypal.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sandbox_orders(actor TEXT NOT NULL,request_key TEXT NOT NULL,reference TEXT NOT NULL UNIQUE,
    client_hash TEXT NOT NULL,order_id TEXT UNIQUE,merchant_id TEXT,approval_url TEXT,state TEXT NOT NULL,result TEXT,
    PRIMARY KEY(actor,request_key));`);
  return db;
}
async function request(path: string, token: string | undefined, method = 'GET', body?: string, key?: string): Promise<unknown> {
  // No caller-supplied origin and no redirect/retry: ambiguous writes remain durable pending claims.
  let response: Response;
  const config = configuration();
  try {
    response = await fetch(API + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
      headers: {
        Authorization: token ? `Bearer ${token}` : `Basic ${Buffer.from(`${config.client}:${config.secret}`).toString('base64')}`,
        'Content-Type': token ? 'application/json' : 'application/x-www-form-urlencoded',
        ...(key ? { 'PayPal-Request-Id': key, Prefer: 'return=representation' } : {}),
      },
      ...(body !== undefined ? { body } : {}),
    });
  } catch {
    throw new LocalPayPalError('pending', 'Sandbox request outcome is unknown. No write was automatically retried.');
  }
  if (!response.ok)
    throw new LocalPayPalError('provider', `PayPal sandbox returned HTTP ${response.status}; no write was automatically retried.`);
  try {
    return await response.json();
  } catch {
    throw new LocalPayPalError('provider', 'Invalid PayPal sandbox response.');
  }
}
async function token() {
  return z
    .object({ access_token: z.string().min(1) })
    .parse(await request('/v1/oauth2/token', undefined, 'POST', 'grant_type=client_credentials')).access_token;
}
function checked(raw: unknown, row: Row) {
  const parsed = order.parse(raw),
    unit = parsed.purchase_units[0];
  if (
    parsed.id !== row.order_id ||
    unit.reference_id !== row.reference ||
    unit.custom_id !== row.reference ||
    (row.merchant_id && unit.payee.merchant_id !== row.merchant_id)
  )
    throw new LocalPayPalError('validation', 'Sandbox order correlation did not match the persisted order.');
  return parsed;
}
function owned(db: DatabaseSync, actor: string, orderId: string, clientHash: string): Row {
  const value = db.prepare('SELECT * FROM sandbox_orders WHERE actor=? AND order_id=?').get(actor, orderId);
  if (!value) throw new LocalPayPalError('forbidden', 'Sandbox order is not available to this signed-in user.');
  const row = rowSchema.parse(value);
  if (row.client_hash !== clientHash)
    throw new LocalPayPalError('forbidden', 'Sandbox account changed; restore the original account to reconcile this order.');
  return row;
}
function approvalUrl(raw: string, orderId: string) {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.pathname !== '/checkoutnow' ||
    url.searchParams.get('token') !== orderId
  )
    throw new LocalPayPalError('validation', 'PayPal returned an unexpected sandbox approval URL.');
  return url.href;
}
async function finishCreated(db: DatabaseSync, row: Row, accessToken: string) {
  if (!row.order_id)
    throw new LocalPayPalError('pending', 'An earlier create attempt is unresolved. Do not create a replacement payment automatically.');
  const config = configuration();
  const verified = checked(await request(`/v2/checkout/orders/${row.order_id}`, accessToken), {
    ...row,
    merchant_id: row.merchant_id || config.merchant || null,
  });
  const link = row.approval_url || verified.links?.find(item => ['approve', 'payer-action'].includes(item.rel))?.href;
  if (!link) throw new LocalPayPalError('provider', 'Sandbox order did not provide a payer approval link.');
  const url = approvalUrl(link, row.order_id);
  db.prepare('UPDATE sandbox_orders SET merchant_id=?,approval_url=?,state=? WHERE actor=? AND request_key=?').run(
    verified.purchase_units[0].payee.merchant_id,
    url,
    verified.status,
    row.actor,
    row.request_key,
  );
  return { orderId: row.order_id, approvalUrl: url, status: verified.status };
}
export async function createLocalPayPalOrder(
  authUserId: string,
  requestId: string,
): Promise<{ orderId: string; approvalUrl: string; status: string }> {
  const actor = z.uuid().parse(authUserId),
    key = z.uuid().parse(requestId),
    config = configuration(),
    db = database();
  try {
    const existing = db.prepare('SELECT * FROM sandbox_orders WHERE actor=? AND request_key=?').get(actor, key);
    if (existing) {
      const row = rowSchema.parse(existing);
      if (row.client_hash !== config.clientHash) throw new LocalPayPalError('forbidden', 'Sandbox account changed.');
      if (row.order_id && row.approval_url && row.merchant_id)
        return { orderId: row.order_id, approvalUrl: row.approval_url, status: row.state };
      if (row.order_id) return await finishCreated(db, row, await token());
      throw new LocalPayPalError('pending', 'An earlier create attempt is unresolved. Do not create a replacement payment automatically.');
    }
    const reference = hash(`local-paypal:${actor}:${key}`);
    db.prepare('INSERT INTO sandbox_orders(actor,request_key,reference,client_hash,state) VALUES(?,?,?,?,?)').run(
      actor,
      key,
      reference,
      config.clientHash,
      'CREATING',
    );
    let accessToken: string;
    try {
      accessToken = await token();
    } catch (error: unknown) {
      // OAuth cannot create an order. Release only this pre-effect claim.
      db.prepare("DELETE FROM sandbox_orders WHERE actor=? AND request_key=? AND order_id IS NULL AND state='CREATING'").run(actor, key);
      throw error;
    }
    const raw = await request(
      '/v2/checkout/orders',
      accessToken,
      'POST',
      JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [
          {
            reference_id: reference,
            custom_id: reference,
            amount: { currency_code: 'USD', value: '1.00' },
            ...(config.merchant ? { payee: { merchant_id: config.merchant } } : {}),
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              user_action: 'PAY_NOW',
              return_url: config.origin + '/local/paypal',
              cancel_url: config.origin + '/local/paypal?cancelled=1',
            },
          },
        },
      }),
      hash(`create:${reference}`).slice(0, 36),
    );
    const created = z.object({ id, links: z.array(z.object({ rel: z.string(), href: z.string() })).optional() }).parse(raw);
    // Persist ID before any further validation/poll. Once POST began this claim is never released.
    db.prepare('UPDATE sandbox_orders SET order_id=? WHERE actor=? AND request_key=?').run(created.id, actor, key);
    const link = created.links?.find(item => ['approve', 'payer-action'].includes(item.rel));
    if (link)
      db.prepare('UPDATE sandbox_orders SET approval_url=? WHERE actor=? AND request_key=?').run(
        approvalUrl(link.href, created.id),
        actor,
        key,
      );
    const row = rowSchema.parse(db.prepare('SELECT * FROM sandbox_orders WHERE actor=? AND request_key=?').get(actor, key));
    return await finishCreated(db, row, accessToken);
  } finally {
    db.close();
  }
}
export async function captureLocalPayPalOrder(authUserId: string, orderId: string): Promise<z.infer<typeof resultSchema>> {
  const actor = z.uuid().parse(authUserId),
    providerId = id.parse(orderId),
    config = configuration(),
    db = database();
  try {
    let row = owned(db, actor, providerId, config.clientHash);
    if (row.result) return resultSchema.parse(JSON.parse(row.result));
    const accessToken = await token();
    if (!row.merchant_id) {
      await finishCreated(db, row, accessToken);
      row = owned(db, actor, providerId, config.clientHash);
    }
    let current = checked(await request(`/v2/checkout/orders/${providerId}`, accessToken), row);
    if (current.status !== 'COMPLETED') {
      if (current.status !== 'APPROVED') throw new LocalPayPalError('pending', 'The sandbox payer has not approved this order.');
      const claim = db
        .prepare("UPDATE sandbox_orders SET state='CAPTURING' WHERE actor=? AND order_id=? AND state NOT IN('CAPTURING','COMPLETED')")
        .run(actor, providerId);
      if (claim.changes !== 1)
        throw new LocalPayPalError(
          'pending',
          'Capture is already pending. Only provider status will be reconciled; no second capture is sent.',
        );
      await request(`/v2/checkout/orders/${providerId}/capture`, accessToken, 'POST', '{}', hash(`capture:${row.reference}`).slice(0, 36));
      row = owned(db, actor, providerId, config.clientHash);
      current = checked(await request(`/v2/checkout/orders/${providerId}`, accessToken), row);
    }
    const captures = current.purchase_units[0].payments?.captures;
    const captured = captures?.[0];
    if (current.status !== 'COMPLETED' || captures?.length !== 1 || !captured || captured.status !== 'COMPLETED')
      throw new LocalPayPalError('pending', 'Sandbox capture has not been verified as completed.');
    const receipt = capture.parse(await request(`/v2/payments/captures/${captured.id}`, accessToken));
    if (receipt.id !== captured.id || receipt.status !== 'COMPLETED' || receipt.supplementary_data?.related_ids.order_id !== providerId)
      throw new LocalPayPalError('validation', 'Sandbox capture receipt does not match the original order.');
    const result = resultSchema.parse({ orderId: providerId, captureId: receipt.id, status: 'COMPLETED', amount: '1.00', currency: 'USD' });
    db.prepare("UPDATE sandbox_orders SET state='COMPLETED',result=? WHERE actor=? AND order_id=?").run(
      JSON.stringify(result),
      actor,
      providerId,
    );
    return result;
  } finally {
    db.close();
  }
}
