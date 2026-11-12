import { createHash } from 'node:crypto';
import { z } from 'zod';
import { failure, type EffectIntent } from '@lo/policy';
import { AdapterFault, Boundary, credentialBaseSchema, hashPayload, jsonBody, parse, type AdapterDependencies } from './core.js';
import { FxConversionSchema, type FxConversion } from './fx.js';

export const DomainNameSchema = z
  .string()
  .min(4)
  .max(253)
  .regex(/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])$/);
export const GoDaddyCredentialSchema = z
  .object({
    ...credentialBaseSchema,
    pat: z.string().min(16),
    accountPrincipalId: z.uuid(),
    registrantProfileConfirmed: z.literal(true),
    billingProfileConfirmed: z.literal(true),
    ownerFounderId: z.uuid().optional(),
    counterpartyId: z.uuid().optional(),
  })
  .strict();
const money = z.object({ currencyCode: z.string().regex(/^[A-Z]{3}$/), value: z.number().int().nonnegative().safe() }).strict();
export const RegistrationFeeSchema = z.object({ type: z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/), fee: money }).strict();
const agreement = z
  .object({
    agreementType: z.string().regex(/^[A-Z][A-Z0-9_]{1,100}$/),
    title: z.string().min(1).max(500),
    url: z.url().refine(raw => {
      const u = new URL(raw);
      return (
        u.protocol === 'https:' &&
        !u.port &&
        !u.username &&
        !u.password &&
        (u.hostname === 'godaddy.com' || u.hostname.endsWith('.godaddy.com'))
      );
    }, 'Agreement must be on GoDaddy HTTPS'),
  })
  .strict();
const item = z
  .object({
    domain: DomainNameSchema,
    period: z.number().int().min(1).max(10),
    price: money,
    fees: z.array(RegistrationFeeSchema).max(20).default([]),
  })
  .passthrough();
export const RegistrationQuoteSchema = z
  .object({
    domain: DomainNameSchema,
    period: z.number().int().min(1).max(10),
    price: money,
    fees: z.array(RegistrationFeeSchema).max(20),
    requiredAgreements: z.array(agreement).min(1).max(20),
    expiresAt: z.iso.datetime(),
    totalMinor: z.number().int().positive().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  })
  .strict();
export type RegistrationQuote = z.infer<typeof RegistrationQuoteSchema>;
export const RegistrationProposalSchema = RegistrationQuoteSchema.extend({
  quoteId: z.uuid(),
  consentStatement: z.string().min(1).max(15000),
  conversion: FxConversionSchema.optional(),
}).strict();
export type RegistrationProposal = z.infer<typeof RegistrationProposalSchema>;
const quoteResponse = z.union([
  z
    .object({
      quoteToken: z.string().min(1).max(4096),
      expiresAt: z.iso.datetime(),
      requiredAgreements: z.array(agreement).min(1).max(20),
      items: z.array(item).length(1),
    })
    .passthrough(),
  item
    .extend({
      quoteToken: z.string().min(1).max(4096),
      expiresAt: z.iso.datetime(),
      requiredAgreements: z.array(agreement).min(1).max(20),
      available: z.literal(true).optional(),
    })
    .passthrough(),
]);
export function godaddyBase(sandbox: boolean): string {
  return sandbox ? 'https://api.ote-godaddy.com' : 'https://api.godaddy.com';
}
export function registrationOperationKey(idempotencyKey: string): string {
  const bytes = createHash('sha256').update(`godaddy-registration:${idempotencyKey}`).digest().subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 15) | 80;
  bytes[8] = ((bytes[8] ?? 0) & 63) | 128;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
export function registrationConsentStatement(q: RegistrationQuote & { conversion?: FxConversion }): string {
  return `I approve registration of ${q.domain} for ${q.period} year(s), charged to my founder-owned GoDaddy account. Base price: ${q.price.value} ${q.price.currencyCode} minor units. Fees: ${JSON.stringify(q.fees)}. Total charge: ${q.totalMinor} ${q.currency} minor units. ${q.conversion ? `Mission budget equivalent: ${q.conversion.missionAmountMinor} ${q.conversion.to} minor units; dated reference ${q.conversion.observedAt}, ${q.conversion.source}. ` : ''}I accept the following required legal agreements for this exact registration: ${JSON.stringify(q.requiredAgreements)}. Registration is irreversible once accepted. Quote expires ${q.expiresAt}.`;
}
const registration = z
  .object({
    registrationId: z.uuid(),
    operationId: z.uuid().optional(),
    domain: DomainNameSchema,
    period: z.number().int().min(1).max(10),
    price: money,
    fees: z.array(RegistrationFeeSchema).max(20).default([]),
    status: z.enum(['CONFIRMED', 'EXECUTING', 'COMPLETED', 'FAILED']),
    expiresAt: z.iso.datetime().optional(),
    consent: z
      .object({
        agreementTypes: z.array(z.string()),
        agreedAt: z.iso.datetime(),
        acknowledgedFees: z.array(RegistrationFeeSchema).optional(),
        agreedBy: z.object({ principal: z.string() }).passthrough(),
      })
      .passthrough(),
  })
  .passthrough();
export class GoDaddyAdapter {
  readonly boundary: Boundary;
  constructor(deps: AdapterDependencies) {
    this.boundary = new Boundary(deps);
  }
  private async auth(intent: EffectIntent, ref: string) {
    const credential = await this.boundary.credential('godaddy', ref, intent, GoDaddyCredentialSchema);
    if (credential.counterpartyId && credential.counterpartyId !== intent.counterpartyId)
      throw new AdapterFault(failure('rejected', 'Registrar counterparty differs from founder account.'));
    return { credential, headers: { Authorization: `Bearer ${credential.pat}`, 'Content-Type': 'application/json' } };
  }
  /** Private service result. The caller must encrypt quoteToken and expose only quote. */
  quote(intent: EffectIntent, ref: string, raw: unknown) {
    return this.boundary.preparation(
      { provider: 'godaddy', kind: 'registrar_quote', credentialRef: ref, intent, requestHash: hashPayload(raw) },
      async () => {
        const input = parse(z.object({ domain: DomainNameSchema, period: z.number().int().min(1).max(10) }).strict(), raw),
          auth = await this.auth(intent, ref),
          base = godaddyBase(intent.sandboxMode);
        const availability = await this.boundary.http(
          { url: `${base}/v3/domains/check-availability?domain=${encodeURIComponent(input.domain)}`, method: 'GET', headers: auth.headers },
          false,
        );
        const available = parse(z.object({ domain: DomainNameSchema, available: z.boolean() }).passthrough(), availability.body);
        if (available.domain !== input.domain || !available.available)
          throw new AdapterFault(failure('rejected', 'Domain is not currently available; availability is not ownership.'));
        const response = await this.boundary.http(
            { url: `${base}/v3/domains/registration-quotes`, method: 'POST', headers: auth.headers, body: jsonBody(input) },
            false,
          ),
          quoted = parse(quoteResponse, response.body),
          items = z.object({ items: z.array(item).length(1) }).safeParse(quoted),
          first = items.success ? items.data.items[0] : parse(item, quoted);
        if (
          !first ||
          first.domain !== input.domain ||
          first.period !== input.period ||
          Date.parse(quoted.expiresAt) <= Date.parse(this.boundary.now()) ||
          Date.parse(quoted.expiresAt) > Date.parse(this.boundary.now()) + 15 * 60000 ||
          first.fees.some(f => f.fee.currencyCode !== first.price.currencyCode)
        )
          throw new AdapterFault(failure('validation', 'Registrar quote domain, term, expiry or currency differs.'));
        const totalMinor = first.price.value + first.fees.reduce((sum, f) => sum + f.fee.value, 0),
          quote = parse(RegistrationQuoteSchema, {
            domain: first.domain,
            period: first.period,
            price: first.price,
            fees: first.fees,
            requiredAgreements: quoted.requiredAgreements,
            expiresAt: quoted.expiresAt,
            totalMinor,
            currency: first.price.currencyCode,
          });
        if (new Set(quote.requiredAgreements.map(a => a.agreementType)).size !== quote.requiredAgreements.length)
          throw new AdapterFault(failure('validation', 'Registrar quote repeats legal agreements.'));
        return { quote, quoteToken: quoted.quoteToken };
      },
    );
  }
  private async poll(intent: EffectIntent, ref: string, p: RegistrationProposal, registrationId: string, agreedAt: string) {
    const auth = await this.auth(intent, ref),
      id = z.uuid().parse(registrationId),
      response = await this.boundary.http(
        { url: `${godaddyBase(intent.sandboxMode)}/v3/domains/registrations/${id}`, method: 'GET', headers: auth.headers },
        false,
      ),
      record = parse(registration, response.body);
    if (
      record.registrationId !== id ||
      record.domain !== p.domain ||
      record.period !== p.period ||
      hashPayload(record.price) !== hashPayload(p.price) ||
      hashPayload(record.fees) !== hashPayload(p.fees) ||
      record.consent.agreedBy.principal !== auth.credential.accountPrincipalId ||
      Date.parse(record.consent.agreedAt) !== Date.parse(agreedAt) ||
      hashPayload([...record.consent.agreementTypes].sort()) !== hashPayload(p.requiredAgreements.map(a => a.agreementType).sort()) ||
      (p.fees.length > 0 && hashPayload(record.consent.acknowledgedFees) !== hashPayload(p.fees))
    )
      throw new AdapterFault(
        failure(
          'invariant_violation',
          'Registrar status does not match approved domain, term, all fees, account and legal consent.',
          'reconcile',
        ),
      );
    if (record.status !== 'COMPLETED' || !record.expiresAt || Date.parse(record.expiresAt) <= Date.parse(this.boundary.now()))
      throw new AdapterFault(
        failure(
          'provider_down',
          record.status === 'FAILED'
            ? 'Registrar reports registration failed; reconcile account billing before another purchase.'
            : 'Registrar registration is pending; reconcile the same operation without resubmitting.',
          'reconcile',
        ),
      );
    return {
      data: { registrationId: id, domain: p.domain, period: p.period, expiresAt: record.expiresAt, status: 'COMPLETED' as const },
      receipt: this.boundary.receipt(
        'godaddy',
        id,
        intent,
        record,
        { orderId: id, payeeId: intent.counterpartyId, amountMinor: p.totalMinor, currency: p.currency },
        {
          kind: 'founder_owned_domain',
          outcome: 'brand',
          artifactVersionId: z.uuid().parse(intent.artifactVersionId),
          method: 'verified_poll',
        },
      ),
    };
  }
  register(
    intent: EffectIntent,
    ref: string,
    raw: unknown,
    quoteToken: string,
    agreedAt: string,
    recordAcknowledgement: (id: string, operationId?: string) => Promise<void>,
  ) {
    return this.boundary.effect(intent, 'registration', 'spend', async () => {
      const p = parse(RegistrationProposalSchema, raw);
      await this.boundary.approvedInput(intent, p);
      if (
        intent.amountMinor !== p.totalMinor ||
        intent.currency !== p.currency ||
        !intent.artifactVersionId ||
        !z.uuid().safeParse(intent.taskId).success ||
        p.consentStatement !== registrationConsentStatement(p) ||
        Date.parse(p.expiresAt) <= Date.parse(this.boundary.now()) ||
        !z.iso.datetime().safeParse(agreedAt).success ||
        Date.parse(agreedAt) > Date.parse(this.boundary.now()) ||
        Date.parse(agreedAt) > Date.parse(p.expiresAt)
      )
        throw new AdapterFault(failure('needs_approval', 'Exact current quote and actual founder legal consent are required.'));
      const auth = await this.auth(intent, ref),
        response = await this.boundary.http(
          {
            url: `${godaddyBase(intent.sandboxMode)}/v3/domains/registrations`,
            method: 'POST',
            headers: { ...auth.headers, 'Idempotency-Key': registrationOperationKey(intent.idempotencyKey) },
            body: jsonBody({
              quoteToken: z.string().min(1).max(4096).parse(quoteToken),
              domain: p.domain,
              period: p.period,
              consent: {
                agreedAt,
                agreementTypes: p.requiredAgreements.map(a => a.agreementType),
                ...(p.fees.length ? { acknowledgedFees: p.fees } : {}),
              },
            }),
          },
          true,
        ),
        ack = parse(z.object({ registrationId: z.uuid(), operationId: z.uuid().optional() }).passthrough(), response.body);
      await recordAcknowledgement(ack.registrationId, ack.operationId);
      return this.poll(intent, ref, p, ack.registrationId, agreedAt);
    });
  }
  /** Read-only recovery never issues POST or obtains a replacement quote. */
  reconcile(intent: EffectIntent, ref: string, raw: unknown, registrationId: string, agreedAt: string) {
    return this.boundary.read(() => this.poll(intent, ref, parse(RegistrationProposalSchema, raw), registrationId, agreedAt));
  }
}
