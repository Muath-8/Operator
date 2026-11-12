import { z } from 'zod';
import { failure, type EffectIntent } from '@lo/policy';
import { AdapterFault, Boundary, credentialBaseSchema, jsonBody, parse, type AdapterDependencies } from './core.js';

export const channelStateSchema = z
  .object({
    counterpartyId: z.string().uuid(),
    optedOut: z.boolean(),
    email: z.string().email().nullable(),
    phone: z
      .string()
      .regex(/^\+[1-9]\d{7,14}$/)
      .nullable(),
    phoneVerified: z.boolean(),
    lastWhatsappInboundAt: z.string().datetime().nullable(),
    localHoursOpen: z.boolean(),
    senderRegistered: z.boolean(),
    disclosure: z.string().min(10),
    founderBudgetFigures: z.array(z.string()).default([]),
    approvedTemplates: z.array(
      z
        .object({
          id: z.string().min(1),
          language: z.enum(['ar', 'en']),
          purpose: z.string().min(1),
          body: z.string().min(1).max(10000).optional(),
        })
        .strict(),
    ),
  })
  .strict();
export type ChannelState = z.infer<typeof channelStateSchema>;
export interface ChannelStateStore {
  get(missionId: string, counterpartyId: string): Promise<unknown>;
}
export const outboundMessageSchema = z
  .object({
    channel: z.enum(['email', 'whatsapp', 'sms', 'voice']),
    text: z.string().min(1).max(10000),
    translation: z.string().min(1),
    language: z.enum(['ar', 'en']),
    purpose: z.enum([
      'introduction',
      'follow_up',
      'quotation_request',
      'sample_status',
      'payment_confirmation',
      'call_scheduling',
      'notification',
    ]),
    templateId: z.string().optional(),
    templateVariables: z.record(z.string(), z.string()).optional(),
    subject: z.string().min(1).max(200).optional(),
    hasDocument: z.boolean().default(false),
  })
  .strict();
export type OutboundMessage = z.infer<typeof outboundMessageSchema>;
export interface SentMessage {
  messageId: string;
  channel: OutboundMessage['channel'];
  original: string;
  translation: string;
  reason: string;
  authorizer: string;
  timestamp: string;
}
function numericFigures(text: string): string[] {
  const normalized = text
    .normalize('NFKC')
    .replace(/\p{Cf}/gu, '')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x6f0))
    .replace(/٫/g, '.')
    .replace(/٬/g, ',')
    .replace(/(?<=\d)[ \u00a0\u202f\u2009](?=\d{3}(?:\D|$))/g, '');
  return (normalized.match(/\d+(?:[.,]\d+)*/g) ?? [])
    .flatMap(token => [
      token.replace(/,/g, ''),
      ...(token.includes(',') || /^\d{1,3}(?:\.\d{3})+$/.test(token) ? [token.replace(/\./g, '').replace(',', '.')] : []),
    ])
    .map(v =>
      v
        .replace(/^0+(?=\d)/, '')
        .replace(/(\.\d*?)0+$/, '$1')
        .replace(/\.$/, ''),
    );
}
export function evaluateChannel(
  message: OutboundMessage,
  state: ChannelState,
  now = new Date(),
): { ok: true; reason: string } | ReturnType<typeof failure> {
  if (state.optedOut) return failure('rejected', 'Counterparty opted out across all channels.');
  if (!state.localHoursOpen) return failure('window_closed', 'Counterparty local business hours are closed.', 'same_key');
  const protectedFigures = new Set(state.founderBudgetFigures.flatMap(numericFigures)),
    wire = [message.text, message.subject ?? '', message.translation, ...Object.values(message.templateVariables ?? {})].flatMap(
      numericFigures,
    );
  if (wire.some(figure => protectedFigures.has(figure)))
    return failure('rejected', 'Message may disclose a protected founder budget figure.');
  if (message.purpose === 'introduction' && !message.text.includes(state.disclosure))
    return failure('rejected', 'First contact must include the recorded AI disclosure.');
  if (message.hasDocument && message.channel !== 'email') return failure('rejected', 'Documents use the recorded email channel.');
  if (message.channel === 'email')
    return state.email
      ? { ok: true, reason: 'Email supports this recorded document or message.' }
      : failure('validation', 'Counterparty email unavailable.');
  if (!state.phone || !state.phoneVerified) return failure('rejected', 'Counterparty phone is not verified.');
  if (message.channel === 'whatsapp') {
    const elapsed = state.lastWhatsappInboundAt ? now.getTime() - Date.parse(state.lastWhatsappInboundAt) : Infinity;
    if (message.templateId) {
      const template = state.approvedTemplates.find(
        t => t.id === message.templateId && t.language === message.language && t.purpose === message.purpose,
      );
      if (!template?.body) return failure('rejected', 'WhatsApp template needs a frozen approved body matching purpose and language.');
      const keys = new Set([...template.body.matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)].map(m => m[1] ?? '')),
        variables = message.templateVariables ?? {};
      if (keys.size !== Object.keys(variables).length || Object.keys(variables).some(k => !keys.has(k)))
        return failure('rejected', 'Template variables differ from the approved template placeholders.');
      const rendered = template.body.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (_match, key: string) => variables[key] ?? '');
      if (rendered !== message.text) return failure('rejected', 'Actual rendered template differs from the reviewed message text.');
      return { ok: true, reason: 'Frozen approved template renders the exact reviewed text.' };
    }
    if (elapsed < 0 || elapsed >= 86_400_000 || message.purpose === 'introduction')
      return failure('window_closed', 'WhatsApp requires an approved template outside the 24-hour window.');
    return { ok: true, reason: 'WhatsApp customer-service window is open.' };
  }
  if (message.channel === 'sms') {
    if (
      !state.senderRegistered ||
      message.purpose !== 'notification' ||
      /(?:https?:|www\.|\b\w+\.(?:com|net|org)\b|\d|price|cost|MOQ|deposit|سعر|ريال)/i.test(message.text)
    )
      return failure('rejected', 'SMS requires a registered sender and a plain notification without URLs, prices or negotiation.');
    return { ok: true, reason: 'Registered sender, plain notification only.' };
  }
  if (!message.text.startsWith(state.disclosure)) return failure('rejected', 'Voice must begin with the recorded AI disclosure.');
  return { ok: true, reason: 'Verified phone and disclosure at call start.' };
}
const twilioCredentialSchema = z
  .object({
    ...credentialBaseSchema,
    accountSid: z.string().regex(/^AC[a-fA-F0-9]{32}$/),
    authToken: z.string().min(1),
    from: z.string().min(1),
    allowedSandboxRecipients: z.array(z.string()),
    voiceCallbackOrigin: z.string().url(),
    voiceCallbackUrl: z.string().url().optional(),
    statusCallbackUrl: z.string().url().optional(),
    recordingConsent: z.boolean().optional(),
  })
  .strict();
const resendCredentialSchema = z
  .object({
    ...credentialBaseSchema,
    apiKey: z.string().min(1),
    from: z.string().min(1),
    allowedSandboxRecipients: z.array(z.string()),
    testDomain: z.string().min(1),
  })
  .strict();
export { twilioCredentialSchema as TwilioCredentialSchema, resendCredentialSchema as ResendCredentialSchema };
export class ChannelsAdapter {
  readonly boundary: Boundary;
  constructor(
    deps: AdapterDependencies,
    readonly contacts: ChannelStateStore,
  ) {
    this.boundary = new Boundary(deps);
  }
  send(intent: EffectIntent, credentialRef: string, raw: unknown) {
    return this.boundary.effect<SentMessage>(intent, 'send_message', 'communicate', async () => {
      const message = parse(outboundMessageSchema, raw);
      const state = parse(channelStateSchema, await this.contacts.get(intent.missionId, intent.counterpartyId));
      if (intent.approvalToken) await this.boundary.approvedInput(intent, message);
      if (state.counterpartyId !== intent.counterpartyId || intent.channel !== message.channel || intent.purpose !== message.purpose)
        throw new AdapterFault(failure('invariant_violation', 'Message channel, purpose or recipient differs from authorization.'));
      const outbound = {
        channel: message.channel,
        original: message.text,
        translation: message.translation,
        purpose: message.purpose,
        ...(message.subject ? { subject: message.subject } : {}),
      };
      const policy = evaluateChannel(message, state, new Date(this.boundary.now()));
      if (!policy.ok) throw new AdapterFault(policy);
      if (message.channel === 'email') {
        const c = await this.boundary.credential('resend', credentialRef, intent, resendCredentialSchema);
        if (!message.subject || !state.email)
          throw new AdapterFault(failure('validation', 'Email needs a subject and recorded recipient.'));
        if (intent.sandboxMode && (!c.allowedSandboxRecipients.includes(state.email) || !c.from.endsWith(`@${c.testDomain}`)))
          throw new AdapterFault(failure('rejected', 'Sandbox email sender or recipient is outside the test allowlist.'));
        const r = await this.boundary.http(
          {
            url: 'https://api.resend.com/emails',
            method: 'POST',
            headers: { Authorization: `Bearer ${c.apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': intent.idempotencyKey },
            body: jsonBody({ from: c.from, to: [state.email], subject: message.subject, text: message.text }),
          },
          true,
        );
        const data = parse(z.object({ id: z.string().min(1) }), r.body);
        return {
          data: {
            messageId: data.id,
            channel: message.channel,
            original: message.text,
            translation: message.translation,
            reason: policy.reason,
            authorizer: intent.mandateId ?? 'specific_approval',
            timestamp: this.boundary.now(),
          },
          receipt: { ...this.boundary.receipt('resend', data.id, intent, r.body), outbound },
        };
      }
      const c = await this.boundary.credential('twilio', credentialRef, intent, twilioCredentialSchema);
      if (!state.phone) throw new AdapterFault(failure('validation', 'Recorded phone required.'));
      if (intent.sandboxMode && !c.allowedSandboxRecipients.includes(state.phone))
        throw new AdapterFault(failure('rejected', 'Sandbox Twilio recipient is outside the team-operated allowlist.'));
      const fields: Record<string, string> = {
        To: message.channel === 'whatsapp' ? `whatsapp:${state.phone}` : state.phone,
        From: message.channel === 'whatsapp' ? `whatsapp:${c.from}` : c.from,
      };
      if (message.channel === 'voice') {
        const origin = new URL(c.voiceCallbackOrigin);
        if (origin.protocol !== 'https:') throw new AdapterFault(failure('validation', 'Voice callback must be HTTPS.'));
        fields['Url'] =
          c.voiceCallbackUrl ??
          new URL(`/twilio/voice/${encodeURIComponent(intent.missionId)}/${encodeURIComponent(intent.taskId)}`, origin).href;
        fields['StatusCallback'] = c.statusCallbackUrl ?? new URL('/api/webhooks/twilio', origin).href;
        fields['TimeLimit'] = '300';
        if (new URL(fields['Url']).protocol !== 'https:' || new URL(fields['StatusCallback']).protocol !== 'https:')
          throw new AdapterFault(failure('validation', 'Voice callbacks must use HTTPS.'));
        if (c.recordingConsent === true) {
          fields['Record'] = 'true';
          fields['RecordingStatusCallback'] = fields['StatusCallback'];
          fields['RecordingStatusCallbackEvent'] = 'completed';
        }
      } else if (message.templateId) {
        fields['ContentSid'] = message.templateId;
        fields['ContentVariables'] = jsonBody(message.templateVariables ?? {});
      } else fields['Body'] = message.text;
      if (message.channel !== 'voice' && c.statusCallbackUrl) fields['StatusCallback'] = c.statusCallbackUrl;
      // Twilio creation has no guaranteed native idempotency. Durable started/ambiguous state prevents a second POST.
      const r = await this.boundary.http(
        {
          url: `https://api.twilio.com/2010-04-01/Accounts/${c.accountSid}/${message.channel === 'voice' ? 'Calls' : 'Messages'}.json`,
          method: 'POST',
          headers: {
            Authorization: `Basic ${Buffer.from(`${c.accountSid}:${c.authToken}`).toString('base64')}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'X-Operator-Idempotency-Key': intent.idempotencyKey,
          },
          body: new URLSearchParams(fields).toString(),
        },
        true,
      );
      const data = parse(z.object({ sid: z.string().min(1), status: z.string() }), r.body);
      return {
        data: {
          messageId: data.sid,
          channel: message.channel,
          original: message.text,
          translation: message.translation,
          reason: policy.reason,
          authorizer: intent.mandateId ?? 'specific_approval',
          timestamp: this.boundary.now(),
        },
        receipt: { ...this.boundary.receipt('twilio', data.sid, intent, r.body), outbound },
      };
    });
  }
  fetchInboundEmail(intent: Pick<EffectIntent, 'missionId' | 'sandboxMode'>, credentialRef: string, emailId: string) {
    return this.boundary.read(async () => {
      parse(z.string().uuid(), emailId);
      const c = await this.boundary.credential('resend', credentialRef, intent, resendCredentialSchema);
      const r = await this.boundary.http(
        { url: `https://api.resend.com/emails/receiving/${emailId}`, method: 'GET', headers: { Authorization: `Bearer ${c.apiKey}` } },
        false,
      );
      const data = parse(
        z.object({
          id: z.string(),
          from: z.string(),
          to: z.array(z.string()),
          subject: z.string(),
          text: z.string().nullable(),
          html: z.string().nullable(),
        }),
        r.body,
      );
      return {
        kind: 'untrusted_data' as const,
        source: { provider: 'resend', reference: data.id, receivedAt: this.boundary.now() },
        content: data,
      };
    });
  }
}
