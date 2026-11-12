import { z } from 'zod';
import { failure, type EffectIntent } from '@lo/policy';
import { AdapterFault, Boundary, credentialBaseSchema, jsonBody, hashPayload, parse, type AdapterDependencies } from './core.js';
import type { ServiceBudgetStore } from './generation.js';

/** Driver only exposes GET navigation/text/screenshot; no click, forms, credentials or JS from a model. */
export interface ReadOnlyBrowserDriver {
  read(
    connectUrl: string,
    url: string,
    allowedHosts: readonly string[],
  ): Promise<{ url: string; title: string; text: string; screenshotBase64: string }>;
}
const credentialSchema = z
  .object({
    ...credentialBaseSchema,
    apiKey: z.string().min(1),
    projectId: z.string().min(1),
    allowedHosts: z.array(z.string()).min(1),
    maxSessionSeconds: z.number().int().positive().max(300),
  })
  .strict();
export { credentialSchema as BrowserbaseCredentialSchema };
export class BrowserbaseResearchAdapter {
  readonly boundary: Boundary;
  constructor(
    deps: AdapterDependencies,
    readonly budgets: ServiceBudgetStore,
    readonly driver: ReadOnlyBrowserDriver,
  ) {
    this.boundary = new Boundary(deps);
  }
  fetchPage(intent: EffectIntent, credentialRef: string, raw: unknown) {
    return this.boundary.preparation(
      { provider: 'browserbase', kind: 'browserbase_research', credentialRef, intent, requestHash: hashPayload(raw) },
      async () => {
        const input = parse(z.object({ url: z.string().url(), timeoutSeconds: z.number().int().min(5).max(300) }).strict(), raw);
        const c = await this.boundary.credential('browserbase', credentialRef, intent, credentialSchema);
        const url = new URL(input.url);
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          url.port ||
          !c.allowedHosts.includes(url.hostname) ||
          input.timeoutSeconds > c.maxSessionSeconds
        )
          throw new AdapterFault(failure('rejected', 'Research URL or session duration is outside the task allowlist.'));
        if (!(await this.budgets.reserve(intent.missionId, intent.idempotencyKey, 'browserbase', input.timeoutSeconds)))
          throw new AdapterFault(failure('rejected', 'Research budget exhausted or this session already started.'));
        let sessionId: string | undefined;
        try {
          const response = await this.boundary.http(
            {
              url: 'https://api.browserbase.com/v1/sessions',
              method: 'POST',
              headers: {
                'X-BB-API-Key': c.apiKey,
                'Content-Type': 'application/json',
                'X-Operator-Idempotency-Key': intent.idempotencyKey,
              },
              body: jsonBody({
                projectId: c.projectId,
                timeout: input.timeoutSeconds,
                keepAlive: false,
                browserSettings: { recordSession: true, logSession: true },
                userMetadata: { missionId: intent.missionId, taskId: intent.taskId },
              }),
            },
            true,
          );
          const session = parse(z.object({ id: z.string().uuid(), connectUrl: z.string().url() }), response.body);
          sessionId = session.id;
          const connect = new URL(session.connectUrl);
          if (connect.protocol !== 'wss:' || !connect.hostname.endsWith('.browserbase.com'))
            throw new AdapterFault(failure('rejected', 'Browserbase returned an untrusted connection URL.'));
          const page = await this.driver.read(session.connectUrl, url.href, c.allowedHosts);
          if (!c.allowedHosts.includes(new URL(page.url).hostname))
            throw new AdapterFault(failure('rejected', 'Research redirected outside the task allowlist.'));
          await this.budgets.complete(intent.missionId, intent.idempotencyKey, session.id, input.timeoutSeconds);
          return {
            kind: 'untrusted_data' as const,
            provenance: { provider: 'browserbase' as const, url: page.url, sessionId: session.id, fetchedAt: this.boundary.now() },
            content: { title: page.title, text: page.text.slice(0, 100000), screenshotBase64: page.screenshotBase64 },
            receipt: this.boundary.receipt('browserbase', session.id, intent, { url: page.url, title: page.title, text: page.text }),
          };
        } catch (error) {
          await this.budgets.ambiguous(intent.missionId, intent.idempotencyKey);
          throw error;
        } finally {
          if (sessionId)
            await this.boundary.http(
              {
                url: `https://api.browserbase.com/v1/sessions/${sessionId}`,
                method: 'POST',
                headers: {
                  'X-BB-API-Key': c.apiKey,
                  'Content-Type': 'application/json',
                  'X-Operator-Idempotency-Key': `${intent.idempotencyKey}:release`,
                },
                body: jsonBody({ status: 'REQUEST_RELEASE' }),
              },
              false,
            );
        }
      },
    );
  }
}
