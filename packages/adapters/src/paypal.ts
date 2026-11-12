import { z } from 'zod';
import { failure, type EffectIntent } from '@lo/policy';
import {
  AdapterFault,
  Boundary,
  credentialBaseSchema,
  idSchema,
  jsonBody,
  hashPayload,
  parse,
  requireBoundAmount,
  type AdapterDependencies,
} from './core.js';
import { FxConversionSchema } from './fx.js';

const credentialSchema = z
  .object({
    ...credentialBaseSchema,
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    merchantId: z.string().min(1),
    webhookId: z.string().min(1),
    verifiedPayees: z.record(z.string().uuid(), z.string().min(1)),
  })
  .strict();
export { credentialSchema as PayPalCredentialSchema };
const moneySchema = z.object({ currency_code: z.string().regex(/^[A-Z]{3}$/), value: z.string().regex(/^\d+\.\d{2}$/) });
const captureSchema = z.object({
  id: idSchema,
  status: z.string(),
  amount: moneySchema,
  payee: z.object({ merchant_id: z.string() }).optional(),
  supplementary_data: z.object({ related_ids: z.object({ order_id: z.string() }) }).optional(),
});
const orderSchema = z.object({
  id: idSchema,
  status: z.string(),
  intent: z.enum(['CAPTURE', 'AUTHORIZE']).optional(),
  purchase_units: z
    .array(
      z.object({
        reference_id: z.string().optional(),
        amount: moneySchema,
        payee: z.object({ merchant_id: z.string() }),
        payments: z
          .object({
            captures: z.array(captureSchema).optional(),
            authorizations: z.array(z.object({ id: idSchema, status: z.string(), expiration_time: z.string().optional() })).optional(),
            refunds: z.array(z.object({ id: idSchema, status: z.string(), amount: moneySchema })).optional(),
          })
          .optional(),
      }),
    )
    .length(1),
  links: z.array(z.object({ href: z.string().url(), rel: z.string() })).optional(),
});
export const paymentProposalSchema = z
  .object({
    artifactVersionId: z.string().uuid(),
    artifactStatus: z.literal('approved'),
    counterpartyId: z.string().uuid(),
    payeeMerchantId: z.string().regex(/^[A-Z0-9]{8,32}$/),
    amountMinor: z.number().int().positive().safe(),
    currency: z.enum(['USD', 'SAR', 'EUR', 'GBP', 'AED']),
    purpose: z.string().min(1),
    returnUrl: z.string().url(),
    cancelUrl: z.string().url(),
    intent: z.enum(['CAPTURE', 'AUTHORIZE']).default('CAPTURE'),
    conversion: FxConversionSchema.optional(),
  })
  .strict();
export type PaymentProposal = z.infer<typeof paymentProposalSchema>;
export interface PaymentCorrelation {
  orderId: string;
  captureId?: string;
  artifactVersionId?: string;
  payeeMerchantId: string;
  amountMinor: number;
  currency: string;
  sandboxMode: boolean;
}
function moneyValue(minor: number): string {
  return `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
}
function matchesMoney(value: z.infer<typeof moneySchema>, amount: number, currency: string): boolean {
  return value.currency_code === currency && value.value === moneyValue(amount);
}
export function validatePayPalLink(raw: string, sandboxMode: boolean): { ok: true; url: string } | ReturnType<typeof failure> {
  try {
    const u = new URL(raw);
    const allowed = sandboxMode ? ['www.sandbox.paypal.com', 'sandbox.paypal.com'] : ['www.paypal.com', 'paypal.com'];
    if (
      u.protocol !== 'https:' ||
      u.username ||
      u.password ||
      u.port ||
      !allowed.includes(u.hostname) ||
      !/^\/(invoice|invoices|checkoutnow|checkout|ncp|pay)\b/.test(u.pathname)
    )
      return failure('validation', 'Payment link is not an allowed PayPal checkout or invoice URL.');
    return { ok: true, url: u.href };
  } catch {
    return failure('validation', 'Invalid payment link.');
  }
}
export class PayPalAdapter {
  readonly boundary: Boundary;
  constructor(deps: AdapterDependencies) {
    this.boundary = new Boundary(deps);
  }
  private base(sandbox: boolean): string {
    return sandbox ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
  }
  private async access(ref: string, intent: Pick<EffectIntent, 'missionId' | 'sandboxMode'>) {
    const c = await this.boundary.credential('paypal', ref, intent, credentialSchema);
    const res = await this.boundary.http(
      {
        url: `${this.base(intent.sandboxMode)}/v1/oauth2/token`,
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      },
      false,
    );
    const token = parse(z.object({ access_token: z.string().min(1) }), res.body).access_token;
    return { credential: c, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } };
  }
  /** Order creation cannot capture or spend. No model receives an execute capability. */
  prepare(raw: unknown, intent: EffectIntent, credentialRef: string) {
    return this.boundary.preparation(
      { provider: 'paypal', kind: 'paypal_order', credentialRef, intent, requestHash: hashPayload(raw) },
      async () => {
        const p = parse(paymentProposalSchema, raw);
        requireBoundAmount(intent, p.amountMinor, p.currency, p.artifactVersionId, p.counterpartyId);
        await this.boundary.approvedInput(intent, p);
        for (const value of [p.returnUrl, p.cancelUrl]) {
          const u = new URL(value);
          if (
            (u.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) ||
            !this.boundary.deps.allowedCallbackOrigins?.includes(u.origin) ||
            u.username ||
            u.password
          )
            throw new AdapterFault(failure('validation', 'Checkout callback is outside the configured app origin.'));
        }
        const auth = await this.access(credentialRef, intent);
        if (auth.credential.verifiedPayees[intent.counterpartyId] !== p.payeeMerchantId)
          throw new AdapterFault(failure('needs_approval', 'Payee details do not match the verified counterparty.'));
        const response = await this.boundary.http(
          {
            url: `${this.base(intent.sandboxMode)}/v2/checkout/orders`,
            method: 'POST',
            headers: { ...auth.headers, 'PayPal-Request-Id': `${intent.idempotencyKey}:prepare` },
            body: jsonBody({
              intent: p.intent,
              purchase_units: [
                {
                  reference_id: p.artifactVersionId,
                  amount: { currency_code: p.currency, value: moneyValue(p.amountMinor) },
                  payee: { merchant_id: p.payeeMerchantId },
                  description: p.purpose,
                },
              ],
              payment_source: {
                paypal: { experience_context: { return_url: p.returnUrl, cancel_url: p.cancelUrl, user_action: 'PAY_NOW' } },
              },
            }),
          },
          true,
        );
        const order = parse(orderSchema, response.body);
        this.assertOrder(order, {
          orderId: order.id,
          artifactVersionId: p.artifactVersionId,
          payeeMerchantId: p.payeeMerchantId,
          amountMinor: p.amountMinor,
          currency: p.currency,
          sandboxMode: intent.sandboxMode,
        });
        const link = order.links?.find(l => ['payer-action', 'approve'].includes(l.rel));
        const checked = link
          ? validatePayPalLink(link.href, intent.sandboxMode)
          : failure('validation', 'Provider did not return a payer approval URL.');
        if (!checked.ok) throw new AdapterFault(checked);
        return {
          orderId: order.id,
          approvalUrl: checked.url,
          status: 'planned' as const,
          receipt: this.boundary.receipt('paypal', order.id, intent, response.body),
        };
      },
    );
  }
  private assertOrder(order: z.infer<typeof orderSchema>, expected: PaymentCorrelation): void {
    const unit = order.purchase_units[0];
    if (
      order.id !== expected.orderId ||
      !unit ||
      unit.payee.merchant_id !== expected.payeeMerchantId ||
      !matchesMoney(unit.amount, expected.amountMinor, expected.currency) ||
      (expected.artifactVersionId && unit.reference_id !== expected.artifactVersionId)
    )
      throw new AdapterFault(
        failure('invariant_violation', 'PayPal order amount, currency or payee does not match the approved proposal.'),
      );
  }
  execute(intent: EffectIntent, credentialRef: string, expected: PaymentCorrelation) {
    return this.boundary.effect(intent, 'payment_capture', 'spend', async () => {
      if (
        expected.sandboxMode !== intent.sandboxMode ||
        expected.amountMinor !== intent.amountMinor ||
        expected.currency !== intent.currency
      )
        throw new AdapterFault(failure('invariant_violation', 'Payment correlation does not match approved environment or amount.'));
      parse(idSchema, expected.orderId);
      const auth = await this.access(credentialRef, intent);
      if (auth.credential.verifiedPayees[intent.counterpartyId] !== expected.payeeMerchantId)
        throw new AdapterFault(failure('needs_approval', 'Payee details do not match the verified counterparty.'));
      const fetched = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${expected.orderId}`,
          method: 'GET',
          headers: { ...auth.headers, 'PayPal-Request-Id': `${intent.idempotencyKey}:approval-check` },
        },
        false,
      );
      const order = parse(orderSchema, fetched.body);
      this.assertOrder(order, { ...expected, artifactVersionId: intent.artifactVersionId });
      if (order.status !== 'APPROVED') throw new AdapterFault(failure('needs_approval', 'PayPal has not confirmed payer approval.'));
      const operation = order.intent === 'AUTHORIZE' ? 'authorize' : 'capture';
      const res = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${expected.orderId}/${operation}`,
          method: 'POST',
          headers: { ...auth.headers, 'PayPal-Request-Id': intent.idempotencyKey },
          body: '{}',
        },
        true,
      );
      const result = parse(orderSchema, res.body);
      this.assertOrder(result, { ...expected, artifactVersionId: intent.artifactVersionId });
      const authorization = result.purchase_units[0]?.payments?.authorizations?.[0];
      const capture = result.purchase_units[0]?.payments?.captures?.[0];
      const providerId = operation === 'capture' ? capture?.id : authorization?.id;
      if (!providerId || (operation === 'authorize' && !z.iso.datetime().safeParse(authorization?.expiration_time).success))
        throw new AdapterFault(
          failure('invariant_violation', 'PayPal did not provide a capture or dated authorization receipt.', 'reconcile'),
        );
      return {
        data: {
          orderId: result.id,
          status: 'pending_verification' as const,
          operation,
          ...(capture ? { captureId: capture.id } : {}),
          ...(authorization ? { authorizationId: authorization.id, captureBy: authorization.expiration_time } : {}),
        },
        receipt: this.boundary.receipt('paypal', providerId, intent, res.body, {
          orderId: result.id,
          ...(capture ? { captureId: capture.id } : {}),
          ...(authorization ? { authorizationId: authorization.id, authorizationExpiresAt: authorization.expiration_time } : {}),
          payeeId: intent.counterpartyId,
          payeeMerchantId: expected.payeeMerchantId,
          amountMinor: expected.amountMinor,
          currency: expected.currency,
        }),
      };
    });
  }
  captureAuthorization(intent: EffectIntent, credentialRef: string, expected: PaymentCorrelation, authorizationId: string) {
    return this.boundary.effect(intent, 'payment_authorization_capture', 'spend', async () => {
      parse(idSchema, authorizationId);
      if (
        expected.sandboxMode !== intent.sandboxMode ||
        expected.amountMinor !== intent.amountMinor ||
        expected.currency !== intent.currency
      )
        throw new AdapterFault(failure('invariant_violation', 'Authorization capture differs from approved amount or environment.'));
      const auth = await this.access(credentialRef, intent);
      if (auth.credential.verifiedPayees[intent.counterpartyId] !== expected.payeeMerchantId)
        throw new AdapterFault(failure('needs_approval', 'Payee changed.'));
      const fetched = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${parse(idSchema, expected.orderId)}`,
          method: 'GET',
          headers: { ...auth.headers, 'PayPal-Request-Id': `${intent.idempotencyKey}:authorization-check` },
        },
        false,
      );
      const order = parse(orderSchema, fetched.body);
      this.assertOrder(order, expected);
      const authorization = order.purchase_units[0]?.payments?.authorizations?.find(a => a.id === authorizationId);
      if (
        !authorization ||
        !['CREATED', 'PARTIALLY_CAPTURED'].includes(authorization.status) ||
        !authorization.expiration_time ||
        Date.parse(authorization.expiration_time) <= Date.parse(this.boundary.now())
      )
        throw new AdapterFault(failure('rejected', 'Authorization unavailable or expired.'));
      const response = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/payments/authorizations/${authorizationId}/capture`,
          method: 'POST',
          headers: { ...auth.headers, 'PayPal-Request-Id': intent.idempotencyKey },
          body: jsonBody({ amount: { value: moneyValue(expected.amountMinor), currency_code: expected.currency }, final_capture: true }),
        },
        true,
      );
      const capture = parse(captureSchema, response.body);
      if (!matchesMoney(capture.amount, expected.amountMinor, expected.currency))
        throw new AdapterFault(failure('invariant_violation', 'Authorization capture amount differs.', 'reconcile'));
      return {
        data: { captureId: capture.id, status: 'pending_verification' as const },
        receipt: this.boundary.receipt('paypal', capture.id, intent, response.body, {
          orderId: expected.orderId,
          captureId: capture.id,
          payeeId: intent.counterpartyId,
          payeeMerchantId: expected.payeeMerchantId,
          amountMinor: expected.amountMinor,
          currency: expected.currency,
        }),
      };
    });
  }
  voidAuthorization(intent: EffectIntent, credentialRef: string, expected: PaymentCorrelation, authorizationId: string) {
    return this.boundary.effect(intent, 'payment_authorization_void', 'bind', async () => {
      parse(idSchema, authorizationId);
      const auth = await this.access(credentialRef, intent);
      if (auth.credential.verifiedPayees[intent.counterpartyId] !== expected.payeeMerchantId || expected.sandboxMode !== intent.sandboxMode)
        throw new AdapterFault(failure('needs_approval', 'Authorization payee or environment mismatch.'));
      const fetched = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${parse(idSchema, expected.orderId)}`,
          method: 'GET',
          headers: { ...auth.headers, 'PayPal-Request-Id': `${intent.idempotencyKey}:void-check` },
        },
        false,
      );
      const order = parse(orderSchema, fetched.body);
      this.assertOrder(order, expected);
      if (!order.purchase_units[0]?.payments?.authorizations?.some(a => a.id === authorizationId))
        throw new AdapterFault(failure('rejected', 'Authorization is not part of the approved order.'));
      await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/payments/authorizations/${authorizationId}/void`,
          method: 'POST',
          headers: { ...auth.headers, 'PayPal-Request-Id': intent.idempotencyKey },
          body: '{}',
        },
        true,
      );
      return {
        data: { authorizationId, status: 'voided' as const },
        receipt: this.boundary.receipt('paypal', authorizationId, intent, { authorizationId, status: 'VOIDED' }),
      };
    });
  }
  verify(intent: EffectIntent, credentialRef: string, expected: PaymentCorrelation) {
    return this.boundary.read(async () => {
      if (expected.sandboxMode !== intent.sandboxMode)
        throw new AdapterFault(failure('invariant_violation', 'Payment verification environment mismatch.'));
      parse(idSchema, expected.orderId);
      const auth = await this.access(credentialRef, intent);
      if (auth.credential.verifiedPayees[intent.counterpartyId] !== expected.payeeMerchantId)
        throw new AdapterFault(failure('needs_approval', 'Payee details do not match the verified counterparty.'));
      const r = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${expected.orderId}`,
          method: 'GET',
          headers: { ...auth.headers, 'PayPal-Request-Id': `${intent.idempotencyKey}:verify` },
        },
        false,
      );
      const order = parse(orderSchema, r.body);
      this.assertOrder(order, expected);
      const captures = order.purchase_units[0]?.payments?.captures ?? [];
      const capture = captures.find(
        c =>
          ['COMPLETED', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(c.status) &&
          matchesMoney(c.amount, expected.amountMinor, expected.currency) &&
          (!expected.captureId || c.id === expected.captureId),
      );
      if (order.status !== 'COMPLETED' || !capture)
        throw new AdapterFault(failure('rejected', 'Settlement is not yet verified.', 'same_key'));
      return {
        orderId: order.id,
        captureId: capture.id,
        amountMinor: expected.amountMinor,
        currency: expected.currency,
        payeeMerchantId: expected.payeeMerchantId,
        sandboxMode: intent.sandboxMode,
        confirmationSource: 'verified_poll' as const,
        verifiedAt: this.boundary.now(),
        receipt: this.boundary.receipt('paypal', capture.id, intent, r.body, {
          orderId: order.id,
          captureId: capture.id,
          payeeId: intent.counterpartyId,
          payeeMerchantId: expected.payeeMerchantId,
          amountMinor: expected.amountMinor,
          currency: expected.currency,
        }),
      };
    });
  }
  verifyAuthorization(
    intent: EffectIntent,
    credentialRef: string,
    expected: PaymentCorrelation,
    authorizationId?: string,
    status: 'CREATED' | 'VOIDED' = 'CREATED',
  ) {
    return this.boundary.read(async () => {
      const auth = await this.access(credentialRef, intent);
      if (expected.sandboxMode !== intent.sandboxMode || auth.credential.verifiedPayees[intent.counterpartyId] !== expected.payeeMerchantId)
        throw new AdapterFault(failure('invariant_violation', 'Authorization verification scope mismatch.'));
      const response = await this.boundary.http(
          {
            url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${parse(idSchema, expected.orderId)}`,
            method: 'GET',
            headers: auth.headers,
          },
          false,
        ),
        order = parse(orderSchema, response.body);
      this.assertOrder(order, expected);
      const authorization = order.purchase_units[0]?.payments?.authorizations?.find(
        a => a.status === status && (!authorizationId || a.id === authorizationId),
      );
      if (
        order.intent !== 'AUTHORIZE' ||
        !authorization ||
        !z.iso.datetime().safeParse(authorization.expiration_time).success ||
        (status === 'CREATED' && Date.parse(authorization.expiration_time ?? '') <= Date.parse(this.boundary.now()))
      )
        throw new AdapterFault(failure('rejected', 'The requested authorization state is not verified.', 'same_key'));
      return {
        authorizationId: authorization.id,
        status,
        receipt: this.boundary.receipt('paypal', authorization.id, intent, response.body, {
          orderId: order.id,
          authorizationId: authorization.id,
          authorizationExpiresAt: authorization.expiration_time,
          payeeId: intent.counterpartyId,
          payeeMerchantId: expected.payeeMerchantId,
          amountMinor: expected.amountMinor,
          currency: expected.currency,
        }),
      };
    });
  }
  reverse(intent: EffectIntent, credentialRef: string, expected: PaymentCorrelation) {
    return this.boundary.effect(intent, 'payment_refund', 'spend', async () => {
      if (
        !expected.captureId ||
        expected.sandboxMode !== intent.sandboxMode ||
        intent.amountMinor === undefined ||
        intent.amountMinor > expected.amountMinor ||
        intent.currency !== expected.currency
      )
        throw new AdapterFault(failure('validation', 'Refund must name the original capture and approved amount.'));
      parse(idSchema, expected.captureId);
      const verified = await this.verify(intent, credentialRef, expected);
      if (!verified.ok) throw new AdapterFault(verified);
      const auth = await this.access(credentialRef, intent);
      const res = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/payments/captures/${expected.captureId}/refund`,
          method: 'POST',
          headers: { ...auth.headers, 'PayPal-Request-Id': intent.idempotencyKey },
          body: jsonBody({ amount: { currency_code: expected.currency, value: moneyValue(intent.amountMinor) } }),
        },
        true,
      );
      const refund = parse(z.object({ id: idSchema, status: z.string(), amount: moneySchema }), res.body);
      if (!matchesMoney(refund.amount, intent.amountMinor, expected.currency))
        throw new AdapterFault(failure('invariant_violation', 'Refund response amount mismatch.', 'reconcile'));
      return {
        data: { refundId: refund.id, status: 'pending_verification' as const },
        receipt: this.boundary.receipt('paypal', refund.id, intent, res.body, {
          orderId: expected.orderId,
          captureId: expected.captureId,
          payeeId: intent.counterpartyId,
          payeeMerchantId: expected.payeeMerchantId,
          amountMinor: intent.amountMinor,
          currency: expected.currency,
        }),
      };
    });
  }
  verifyRefund(intent: EffectIntent, credentialRef: string, expected: PaymentCorrelation, refundId: string, refundAmountMinor: number) {
    return this.boundary.read(async () => {
      parse(idSchema, refundId);
      if (
        !expected.captureId ||
        expected.sandboxMode !== intent.sandboxMode ||
        refundAmountMinor <= 0 ||
        refundAmountMinor > expected.amountMinor ||
        refundAmountMinor !== intent.amountMinor ||
        expected.currency !== intent.currency
      )
        throw new AdapterFault(failure('invariant_violation', 'Refund verification differs from the approved original payment.'));
      const auth = await this.access(credentialRef, intent);
      if (auth.credential.verifiedPayees[intent.counterpartyId] !== expected.payeeMerchantId)
        throw new AdapterFault(failure('needs_approval', 'Refund payee details changed.'));
      const source = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${parse(idSchema, expected.orderId)}`,
          method: 'GET',
          headers: { ...auth.headers, 'PayPal-Request-Id': `${intent.idempotencyKey}:refund-source` },
        },
        false,
      );
      const order = parse(orderSchema, source.body);
      this.assertOrder(order, expected);
      if (
        !order.purchase_units[0]?.payments?.captures?.some(
          c => c.id === expected.captureId && matchesMoney(c.amount, expected.amountMinor, expected.currency),
        )
      )
        throw new AdapterFault(failure('invariant_violation', 'Refund source capture does not match the approved order.'));
      const response = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v2/payments/refunds/${refundId}`,
          method: 'GET',
          headers: { ...auth.headers, 'PayPal-Request-Id': `${intent.idempotencyKey}:refund-verify` },
        },
        false,
      );
      const refund = parse(
        z.object({
          id: idSchema,
          status: z.string(),
          amount: moneySchema,
          links: z.array(z.object({ rel: z.string(), href: z.string().url() })),
        }),
        response.body,
      );
      const parent = refund.links.find(l => l.rel === 'up');
      const link = parent ? new URL(parent.href) : null;
      const hosts = intent.sandboxMode ? ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'] : ['api.paypal.com', 'api-m.paypal.com'];
      if (
        refund.id !== refundId ||
        !matchesMoney(refund.amount, refundAmountMinor, expected.currency) ||
        !link ||
        link.protocol !== 'https:' ||
        !hosts.includes(link.hostname) ||
        link.pathname !== `/v2/payments/captures/${expected.captureId}`
      )
        throw new AdapterFault(failure('invariant_violation', 'Refund amount, currency, capture or environment correlation failed.'));
      if (refund.status !== 'COMPLETED') throw new AdapterFault(failure('rejected', 'Refund settlement is not verified yet.', 'same_key'));
      return {
        refundId,
        captureId: expected.captureId,
        orderId: expected.orderId,
        amountMinor: refundAmountMinor,
        currency: expected.currency,
        payeeId: intent.counterpartyId,
        sandboxMode: intent.sandboxMode,
        confirmationSource: 'verified_poll' as const,
        receipt: this.boundary.receipt('paypal', refundId, intent, response.body, {
          orderId: expected.orderId,
          captureId: expected.captureId,
          payeeId: intent.counterpartyId,
          payeeMerchantId: expected.payeeMerchantId,
          amountMinor: refundAmountMinor,
          currency: expected.currency,
        }),
      };
    });
  }
  findVerifiedRefund(intent: EffectIntent, credentialRef: string, expected: PaymentCorrelation, knownRefundIds: readonly string[]) {
    return this.boundary.read(async () => {
      const auth = await this.access(credentialRef, intent);
      if (
        expected.sandboxMode !== intent.sandboxMode ||
        auth.credential.verifiedPayees[intent.counterpartyId] !== expected.payeeMerchantId ||
        !intent.amountMinor
      )
        throw new AdapterFault(failure('invariant_violation', 'Unknown refund source scope mismatch.'));
      const response = await this.boundary.http(
          {
            url: `${this.base(intent.sandboxMode)}/v2/checkout/orders/${parse(idSchema, expected.orderId)}`,
            method: 'GET',
            headers: auth.headers,
          },
          false,
        ),
        order = parse(orderSchema, response.body);
      this.assertOrder(order, expected);
      const candidates = (order.purchase_units[0]?.payments?.refunds ?? []).filter(
        r =>
          !knownRefundIds.includes(r.id) && r.status === 'COMPLETED' && matchesMoney(r.amount, intent.amountMinor ?? 0, expected.currency),
      );
      if (candidates.length !== 1)
        throw new AdapterFault(
          failure('rejected', 'A unique unrecorded refund is not yet verifiable; no refund will be repeated.', 'same_key'),
        );
      const candidate = candidates[0];
      if (!candidate) throw new AdapterFault(failure('rejected', 'Refund reference is unavailable.'));
      const verified = await this.verifyRefund(intent, credentialRef, expected, candidate.id, intent.amountMinor);
      if (!verified.ok) throw new AdapterFault(verified);
      return verified.data;
    });
  }
  verifyWebhook(
    intent: Pick<EffectIntent, 'missionId' | 'sandboxMode'>,
    credentialRef: string,
    headers: Record<string, string>,
    rawBody: string,
  ) {
    return this.boundary.read(async () => {
      const event = parse(
        z.object({ id: z.string().min(1), event_type: z.string().min(1), resource: z.record(z.string(), z.unknown()) }).passthrough(),
        JSON.parse(rawBody) as unknown,
      );
      const names = [
        'paypal-auth-algo',
        'paypal-cert-url',
        'paypal-transmission-id',
        'paypal-transmission-sig',
        'paypal-transmission-time',
      ];
      if (names.some(name => !headers[name])) throw new AdapterFault(failure('rejected', 'Missing PayPal signature headers.'));
      const auth = await this.access(credentialRef, intent);
      const cert = new URL(headers['paypal-cert-url'] ?? '');
      const certHosts = intent.sandboxMode
        ? ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com']
        : ['api.paypal.com', 'api-m.paypal.com'];
      if (
        cert.protocol !== 'https:' ||
        !certHosts.includes(cert.hostname) ||
        cert.port ||
        cert.username ||
        cert.password ||
        cert.search ||
        cert.hash ||
        !/^\/v1\/notifications\/certs\/CERT-[A-Za-z0-9-]+$/.test(cert.pathname)
      )
        throw new AdapterFault(failure('rejected', 'Untrusted PayPal certificate URL.'));
      const r = await this.boundary.http(
        {
          url: `${this.base(intent.sandboxMode)}/v1/notifications/verify-webhook-signature`,
          method: 'POST',
          headers: auth.headers,
          body: jsonBody({
            auth_algo: headers['paypal-auth-algo'],
            cert_url: cert.href,
            transmission_id: headers['paypal-transmission-id'],
            transmission_sig: headers['paypal-transmission-sig'],
            transmission_time: headers['paypal-transmission-time'],
            webhook_id: auth.credential.webhookId,
            webhook_event: event,
          }),
        },
        false,
      );
      if (parse(z.object({ verification_status: z.enum(['SUCCESS', 'FAILURE']) }), r.body).verification_status !== 'SUCCESS')
        throw new AdapterFault(failure('rejected', 'Invalid PayPal webhook signature.'));
      return event;
    });
  }
}
