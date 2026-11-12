import { createHmac } from 'node:crypto';
import { z } from 'zod';
import { JsonObjectSchema, type JsonValue } from '@lo/state';
import { constantTimeEquals } from '@lo/policy';
import {
  PayPalAdapter,
  ChannelsAdapter,
  ingestWebhook,
  ingestPayPalWebhook,
  correlatePayPalCapture,
  type WebhookRequest,
} from '@lo/adapters';
import { ProviderStorage, providerEncryptionKey, verifyProviderRouting } from './provider-storage.js';
import { processVoiceWrittenConfirmation } from './provider-tools.js';
import { withRole } from './database.js';

export function signVoiceWake(route: string, body: string, key = providerEncryptionKey()): string {
  return createHmac('sha256', key).update(`voice-wake:${route}:${body}`).digest('hex');
}
async function received(scope: { authUserId: string; missionId: string }, data: Record<string, JsonValue>): Promise<Response> {
  const { flushOutbox } = await import('./inngest.js');
  await flushOutbox(scope);
  return Response.json(data);
}
/** Thin authenticated ingress: verify exact bytes, durably dedupe, normalize and wake via outbox. */
export async function handleProviderWebhook(provider: string, routeToken: string, request: Request): Promise<Response> {
  try {
    const routing = verifyProviderRouting(routeToken);
    if (provider !== 'voice' && provider !== routing.provider) return new Response('Provider route mismatch', { status: 403 });
    const rawBody = await request.text();
    if (Buffer.byteLength(rawBody) > 1_000_000) return new Response('Payload too large', { status: 413 });
    const scope = { authUserId: routing.authUserId, missionId: routing.missionId };
    const storage = new ProviderStorage(scope, 'ingress_role');
    if (provider === 'voice') {
      if (
        !routing.voiceSessionId ||
        !constantTimeEquals(request.headers.get('x-operator-voice-signature') ?? '', signVoiceWake(routeToken, rawBody))
      )
        return new Response('Invalid internal signature', { status: 401 });
      await processVoiceWrittenConfirmation(scope, routing.voiceSessionId);
      return received(scope, { received: true });
    }
    const allowed = z.enum(['paypal', 'twilio', 'resend', 'shopify']).safeParse(provider);
    if (!allowed.success) return new Response('Unsupported provider', { status: 404 });
    const credential = JsonObjectSchema.parse(
      await storage.resolve({
        ref: routing.credentialRef,
        missionId: routing.missionId,
        provider: allowed.data,
        sandboxMode: routing.sandboxMode,
      }),
    );
    const settings = await storage.settingsFor(routing.credentialRef, allowed.data, routing.sandboxMode);
    const publicOrigin = new URL(z.string().url().parse(process.env['WEBHOOK_ORIGIN']));
    if (publicOrigin.protocol !== 'https:') return new Response('Public HTTPS webhook origin required', { status: 503 });
    const input: WebhookRequest = {
      rawBody,
      headers: Object.fromEntries(request.headers.entries()),
      publicUrl: new URL(new URL(request.url).pathname + new URL(request.url).search, publicOrigin).href,
    };
    if (provider === 'paypal') {
      const adapter = new PayPalAdapter(storage.dependencies());
      const stored = await ingestPayPalWebhook(
        adapter,
        { missionId: scope.missionId, sandboxMode: routing.sandboxMode },
        routing.credentialRef,
        input,
        storage.webhookStore('payment.provider_received'),
      );
      if (!stored.ok) return new Response(stored.message, { status: stored.code === 'rejected' ? 401 : 503 });
      if (!stored.duplicate) {
        const event = z.object({ event_type: z.string(), resource: JsonObjectSchema }).parse(JSON.parse(rawBody) as unknown);
        const orderId =
          event.event_type === 'CHECKOUT.ORDER.APPROVED'
            ? z.string().parse(event.resource['id'])
            : z.object({ related_ids: z.object({ order_id: z.string() }) }).safeParse(event.resource['supplementary_data']).data
                ?.related_ids.order_id;
        if (orderId && (await storage.reference('paypal', orderId))) {
          if (event.event_type === 'PAYMENT.CAPTURE.COMPLETED') {
            const order = await storage.reference('paypal', orderId);
            const c = order?.correlation;
            if (c) {
              const check = correlatePayPalCapture(JSON.parse(rawBody) as unknown, {
                orderId,
                captureId: z.string().parse(event.resource['id']),
                payeeMerchantId: z.string().parse(c['payeeMerchantId']),
                amountMinor: z.number().parse(c['amountMinor']),
                currency: z.string().parse(c['currency']),
                sandboxMode: routing.sandboxMode,
              });
              if (!check.ok) return new Response(check.message, { status: 422 });
            }
          }
          // The durable outbox wakes a serialized mission tick; its policy reconciliation handles capture.
        }
      }
      return received(scope, { received: true, duplicate: stored.duplicate });
    }
    const secret =
      provider === 'twilio'
        ? z.string().parse(credential['authToken'])
        : provider === 'resend'
          ? z.string().parse(settings['webhookSigningSecret'])
          : z.string().parse(settings['oauthClientSecret']);
    if (provider === 'twilio' && new URLSearchParams(rawBody).get('AccountSid') !== credential['accountSid'])
      return new Response('Twilio account correlation mismatch', { status: 422 });
    const stored = await ingestWebhook(
      allowed.data === 'paypal' ? 'twilio' : allowed.data,
      input,
      secret,
      storage.webhookStore(provider === 'shopify' ? 'webhook.parked' : 'counterparty.replied'),
    );
    if (!stored.ok) return new Response(stored.message, { status: stored.code === 'rejected' ? 401 : 503 });
    if (!stored.duplicate && provider === 'twilio') {
      const form = new URLSearchParams(rawBody);
      if (form.get('MessageSid') && form.has('Body')) {
        const from = (form.get('From') ?? '').replace(/^whatsapp:/, '');
        await withRole('ingress_role', scope, async db => {
          await db.query('select public.ingest_inbound_message($1,$2,$3,$4,$5,$6)', [
            scope.missionId,
            stored.eventId,
            (form.get('From') ?? '').startsWith('whatsapp:') ? 'whatsapp' : 'sms',
            form.get('MessageSid'),
            from,
            form.get('Body'),
          ]);
        });
      }
      const callSid = form.get('CallSid');
      if (callSid && routing.voiceSessionId) {
        const known = await storage.reference('twilio', callSid);
        if (!known || known.correlation['voiceSessionId'] !== routing.voiceSessionId)
          return new Response('Unknown call correlation', { status: 422 });
        if (form.get('RecordingSid')) {
          const session = await storage.voiceSession(routing.voiceSessionId);
          if (session.recording_consent)
            await storage.appendVoice(session.id, 'recording', `recording:${form.get('RecordingSid')}`, {
              recordingSid: form.get('RecordingSid') ?? '',
              callSid,
            });
        }
        if (['completed', 'failed', 'busy', 'no-answer', 'canceled'].includes(form.get('CallStatus') ?? '')) {
          await storage.appendVoice(routing.voiceSessionId, 'ended', 'ended', {
            callSid,
            reason: `Provider call status: ${form.get('CallStatus')}`,
            usageUnconfirmed: true,
          });
          await processVoiceWrittenConfirmation(scope, routing.voiceSessionId);
        }
      }
    }
    if (provider === 'resend') {
      const parsed = z
        .object({ type: z.string(), data: z.object({ email_id: z.uuid() }).passthrough() })
        .safeParse(JSON.parse(rawBody) as unknown);
      if (parsed.success && parsed.data.type === 'email.received') {
        const fetched = await new ChannelsAdapter(storage.dependencies(), { get: async () => null }).fetchInboundEmail(
          { missionId: scope.missionId, sandboxMode: routing.sandboxMode },
          routing.credentialRef,
          parsed.data.data.email_id,
        );
        if (!fetched.ok) return new Response('Inbound content fetch pending; retry required', { status: 503 });
        const email = fetched.data.content;
        const match = email.from.match(/<([^>]+)>/);
        const sender = match?.[1] ?? email.from;
        await withRole('ingress_role', scope, async db => {
          await db.query('select public.ingest_inbound_message($1,$2,$3,$4,$5,$6)', [
            scope.missionId,
            stored.eventId,
            'email',
            email.id,
            sender,
            email.text ?? '',
          ]);
        });
      }
    }
    return received(scope, { received: true, duplicate: stored.duplicate, parked: stored.parked });
  } catch {
    return new Response('Webhook unavailable or verification failed; no action inferred', { status: 503 });
  }
}
