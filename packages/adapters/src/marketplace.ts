import { z } from 'zod';
import { failure, type EffectIntent } from '@lo/policy';
import { AdapterFault, Boundary, hashPayload, jsonBody, parse, type AdapterDependencies } from './core.js';
import { BrowserbaseCredentialSchema } from './research.js';
import { channelStateSchema, evaluateChannel, type ChannelStateStore } from './channels.js';
import type { ServiceBudgetStore } from './generation.js';

const identifier = z.string().regex(/^[A-Za-z0-9_.:-]{1,160}$/),
  selector = z.string().min(1).max(400);
/** Operator-owned encrypted configuration, never accepted from model input.
 * Selectors/endpoints must be recorded from the founder's current Alibaba UI. */
export const MarketplaceProfileSchema = z
  .object({
    platform: z.literal('alibaba'),
    contextId: z.uuid(),
    founderAccountLabel: z.string().min(1).max(200),
    counterpartyId: z.uuid(),
    threadId: identifier,
    url: z.url(),
    allowedHosts: z
      .array(z.string().regex(/^(?:[a-z0-9-]+\.)*alibaba\.com$/))
      .min(1)
      .max(20),
    timeoutSeconds: z.number().int().min(5).max(120),
    accountSelector: selector,
    accountText: z.string().min(1).max(200),
    identitySelector: selector,
    identityText: z.string().min(1).max(200),
    composerSelector: selector,
    sendSelector: selector,
    messageSelector: selector,
    bodySelector: selector,
    messageIdAttribute: identifier,
    directionAttribute: identifier,
    outboundValue: identifier,
    inboundValue: identifier,
    sendUrl: z.url(),
    sendFormat: z.enum(['json', 'form']),
    textField: identifier,
    threadField: identifier,
    readPostUrls: z.array(z.url()).max(10),
    responseSuccessPath: z.array(identifier).min(1).max(8).default(['ok']),
    responseSuccessValue: z.union([z.string(), z.number().finite(), z.boolean()]).default(true),
    responseMessageIdPath: z.array(identifier).min(1).max(8).default(['id']),
    staticSendFields: z.record(identifier, z.union([z.string().max(1000), z.number().finite(), z.boolean()])).default({}),
    securityFieldNames: z
      .array(z.string().regex(/^(?:csrf|xsrf|token|nonce|authenticity)[A-Za-z0-9_-]*$/i))
      .max(5)
      .default([]),
    reviewedAt: z.iso.datetime(),
    sandboxThread: z.boolean(),
  })
  .strict()
  .superRefine((p, c) => {
    for (const value of [p.url, p.sendUrl, ...p.readPostUrls]) {
      const u = new URL(value);
      if (!marketplaceUrlAllowed(u) || u.hash || !p.allowedHosts.includes(u.hostname))
        c.addIssue({ code: 'custom', message: 'Marketplace URLs must use the exact registered Alibaba HTTPS hosts' });
    }
    if (Date.parse(p.reviewedAt) > Date.now() || Date.now() - Date.parse(p.reviewedAt) > 30 * 86400000)
      c.addIssue({ code: 'custom', message: 'Marketplace DOM profile must be reviewed within30days' });
    if (
      p.readPostUrls.includes(p.sendUrl) ||
      p.textField === p.threadField ||
      Object.keys(p.staticSendFields).some(k => [p.textField, p.threadField, ...p.securityFieldNames].includes(k)) ||
      p.securityFieldNames.some(k => [p.textField, p.threadField].includes(k)) ||
      Object.keys(p.staticSendFields).length > 20
    )
      c.addIssue({ code: 'custom', message: 'Read/send endpoints and request fields must be distinct and bounded' });
    if (p.outboundValue === p.inboundValue) c.addIssue({ code: 'custom', message: 'Message directions must differ' });
  });
export function marketplaceUrlAllowed(url: URL): boolean {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).normalize('NFKC').replaceAll('\\', '/');
  } catch {
    return false;
  }
  // A second escape layer has different meanings across proxies/routers. Do
  // not let either malformed or multiply encoded endpoints reach the browser.
  if (path.includes('%') || /[\u0000-\u001f\u007f]/.test(path)) return false;
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    !url.port &&
    !/(?:^|\.)(?:pay(?:ment)?|checkout|cashier)\./i.test(url.hostname) &&
    !/(?:^|\/)(?:pay(?:ment)?s?|checkout|cashier|orders?|cart|refunds?|contracts?)(?:[\/._?-]|$)/i.test(path)
  );
}
export type MarketplaceProfile = z.infer<typeof MarketplaceProfileSchema>;
export const MarketplaceMessageSchema = z
  .object({
    channel: z.literal('marketplace'),
    threadId: identifier,
    text: z.string().min(1).max(10000),
    translation: z.string().min(1).max(10000),
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
  })
  .strict();
export interface MarketplaceObservedMessage {
  messageId: string;
  text: string;
  direction: 'inbound' | 'outbound';
}
export interface MarketplaceObservation {
  url: string;
  messages: MarketplaceObservedMessage[];
  screenshotBase64: string;
  sentMessageId?: string;
}
export interface MarketplaceDriver {
  visit(connectUrl: string, profile: MarketplaceProfile, text?: string): Promise<MarketplaceObservation>;
}
export class BrowserbaseMarketplaceAdapter {
  readonly boundary: Boundary;
  constructor(
    deps: AdapterDependencies,
    readonly budgets: ServiceBudgetStore & {
      ensureMarketplaceBudget?: (missionId: string, key: string, units: number) => Promise<boolean>;
    },
    readonly contacts: ChannelStateStore,
    readonly driver: MarketplaceDriver,
  ) {
    this.boundary = new Boundary(deps);
  }
  private async session(
    intent: EffectIntent,
    ref: string,
    profile: MarketplaceProfile,
    text?: string,
  ): Promise<MarketplaceObservation & { sessionId: string }> {
    const credential = await this.boundary.credential('browserbase', ref, intent, BrowserbaseCredentialSchema);
    if (
      profile.counterpartyId !== intent.counterpartyId ||
      profile.allowedHosts.some(h => !credential.allowedHosts.includes(h)) ||
      profile.timeoutSeconds > credential.maxSessionSeconds ||
      (intent.sandboxMode && !profile.sandboxThread)
    )
      throw new AdapterFault(
        failure('rejected', 'Marketplace thread, host, environment or session duration is outside the founder registration.'),
      );
    let id: string | undefined;
    try {
      const response = await this.boundary.http(
        {
          url: 'https://api.browserbase.com/v1/sessions',
          method: 'POST',
          headers: { 'X-BB-API-Key': credential.apiKey, 'Content-Type': 'application/json' },
          body: jsonBody({
            projectId: credential.projectId,
            timeout: profile.timeoutSeconds,
            keepAlive: false,
            browserSettings: { context: { id: profile.contextId, persist: false }, recordSession: true, logSession: false },
            userMetadata: { missionId: intent.missionId, taskId: intent.taskId },
          }),
        },
        true,
      );
      const created = parse(z.object({ id: z.uuid(), connectUrl: z.url() }), response.body);
      id = created.id;
      const connect = new URL(created.connectUrl);
      if (connect.protocol !== 'wss:' || !connect.hostname.endsWith('.browserbase.com') || connect.username || connect.password)
        throw new AdapterFault(failure('rejected', 'Untrusted Browserbase connection URL.'));
      return { ...(await this.driver.visit(created.connectUrl, profile, text)), sessionId: id };
    } finally {
      if (id)
        await this.boundary
          .http(
            {
              url: `https://api.browserbase.com/v1/sessions/${id}`,
              method: 'POST',
              headers: { 'X-BB-API-Key': credential.apiKey, 'Content-Type': 'application/json' },
              body: jsonBody({ status: 'REQUEST_RELEASE' }),
            },
            false,
          )
          .catch(() => undefined);
    }
  }
  async send(intent: EffectIntent, ref: string, raw: unknown, registered: unknown) {
    const profile = MarketplaceProfileSchema.safeParse(registered),
      message = MarketplaceMessageSchema.safeParse(raw);
    if (!profile.success || !message.success)
      return failure('validation', 'Registered marketplace profile and immutable message are required.');
    // Reserve outside the dispatch transaction: completion happens after its
    // commit, avoiding a nested mission-lock deadlock. Replay skips invocation.
    const key = `marketplace:${intent.idempotencyKey}`,
      reserved = await (this.budgets.ensureMarketplaceBudget
        ? this.budgets.ensureMarketplaceBudget(intent.missionId, key, profile.data.timeoutSeconds)
        : this.budgets.reserve(intent.missionId, key, 'browserbase', profile.data.timeoutSeconds));
    const outcome = await this.boundary.effect(intent, 'marketplace_message', 'communicate', async () => {
      if (!reserved)
        throw new AdapterFault(
          failure('rejected', 'Marketplace session budget exhausted or the prior attempt requires reconciliation.', 'reconcile'),
        );
      if (
        intent.channel !== 'marketplace' ||
        message.data.threadId !== profile.data.threadId ||
        intent.counterpartyId !== profile.data.counterpartyId ||
        intent.purpose !== message.data.purpose
      )
        throw new AdapterFault(failure('rejected', 'Marketplace message target differs from the authorized registered thread.'));
      await this.boundary.approvedInput(intent, message.data);
      const state = await this.contacts.get(intent.missionId, intent.counterpartyId);
      const contact = parse(channelStateSchema, state);
      const channel = evaluateChannel(
        { ...message.data, channel: 'email', hasDocument: false },
        { ...contact, email: 'marketplace-thread@registered.invalid' },
        new Date(this.boundary.now()),
      );
      if (!channel.ok) throw new AdapterFault(channel);
      const observation = await this.session(intent, ref, profile.data, message.data.text);
      const sent = observation.messages.find(
        m => m.messageId === observation.sentMessageId && m.direction === 'outbound' && m.text === message.data.text,
      );
      if (!sent)
        throw new AdapterFault(
          failure('provider_down', 'Marketplace send has no verified provider message ID; reconcile without resending.', 'reconcile'),
        );
      const providerId = `alibaba:${profile.data.threadId}:${sent.messageId}`;
      return {
        data: {
          messageId: providerId,
          threadId: profile.data.threadId,
          original: message.data.text,
          translation: message.data.translation,
          sessionId: observation.sessionId,
          screenshotBase64: observation.screenshotBase64,
        },
        receipt: this.boundary.receipt('browserbase', providerId, intent, {
          threadId: profile.data.threadId,
          messageId: sent.messageId,
          textHash: hashPayload(sent.text),
          sessionId: observation.sessionId,
          screenshotHash: hashPayload(observation.screenshotBase64),
        }),
      };
    });
    if (outcome.ok) await this.budgets.complete(intent.missionId, key, outcome.receipt.providerId, profile.data.timeoutSeconds);
    else if (reserved) await this.budgets.ambiguous(intent.missionId, key);
    return outcome;
  }
  read(intent: EffectIntent, ref: string, registered: unknown) {
    return this.boundary.preparation(
      { provider: 'browserbase', kind: 'browserbase_research', credentialRef: ref, intent, requestHash: hashPayload(registered) },
      async () => {
        const profile = parse(MarketplaceProfileSchema, registered),
          key = `marketplace-read:${intent.idempotencyKey}`;
        if (!(await this.budgets.reserve(intent.missionId, key, 'browserbase', profile.timeoutSeconds)))
          throw new AdapterFault(failure('rejected', 'Marketplace read budget exhausted or already started.'));
        try {
          const observation = await this.session(intent, ref, profile);
          await this.budgets.complete(intent.missionId, key, observation.sessionId, profile.timeoutSeconds);
          return observation;
        } catch (error) {
          await this.budgets.ambiguous(intent.missionId, key);
          throw error;
        }
      },
    );
  }
}
