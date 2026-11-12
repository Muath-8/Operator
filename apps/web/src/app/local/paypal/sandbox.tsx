'use client';
import { useState } from 'react';
import type { PayPalCopy } from './copy';
type Receipt = { orderId: string; captureId: string; status: string; amount: string; currency: string };
export function PayPalSandbox({
  copy,
  configured,
  orderId,
  cancelled,
}: {
  copy: PayPalCopy;
  configured: boolean;
  orderId: string | null;
  cancelled: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  async function run() {
    setBusy(true);
    setFailed(false);
    try {
      let requestId = sessionStorage.getItem('lo-paypal-sandbox-request');
      if (!requestId) {
        requestId = crypto.randomUUID();
        sessionStorage.setItem('lo-paypal-sandbox-request', requestId);
      }
      const response = await fetch('/api/local/paypal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(orderId ? { action: 'capture', orderId } : { action: 'create', requestId }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true || result.sandbox !== true) throw new Error('unconfirmed');
      if (orderId) {
        if (
          result.orderId !== orderId ||
          typeof result.captureId !== 'string' ||
          typeof result.status !== 'string' ||
          result.amount !== '1.00' ||
          result.currency !== 'USD'
        )
          throw new Error('unconfirmed');
        setReceipt(result);
        sessionStorage.removeItem('lo-paypal-sandbox-request');
      } else {
        const approval = new URL(result.approvalUrl);
        if (
          approval.protocol !== 'https:' ||
          !['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(approval.hostname) ||
          approval.username ||
          approval.password ||
          approval.port
        )
          throw new Error('invalid redirect');
        window.location.assign(approval.href);
      }
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="pub-block" aria-label={copy.title}>
      <p>{configured ? copy.ready : copy.missing}</p>
      {cancelled && <p role="status">{copy.cancelled}</p>}
      {orderId && !receipt && <p>{copy.returned}</p>}
      {!receipt && (
        <button className="btn primary" type="button" disabled={!configured || busy} onClick={() => void run()}>
          {busy ? copy.busy : orderId ? copy.capture : copy.create}
        </button>
      )}
      {failed && <p role="alert">{copy.failed}</p>}
      {receipt && (
        <div role="status" className="pub-block">
          <h2>{copy.receipt}</h2>
          <dl>
            <dt>{copy.order}</dt>
            <dd>{receipt.orderId}</dd>
            <dt>{copy.captureId}</dt>
            <dd>{receipt.captureId}</dd>
            <dt>{copy.status}</dt>
            <dd>{receipt.status}</dd>
            <dt>{copy.amount}</dt>
            <dd>
              {receipt.currency} {receipt.amount}
            </dd>
          </dl>
        </div>
      )}
    </section>
  );
}
