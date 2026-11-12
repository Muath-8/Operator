import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  GoDaddyAdapter,
  DomainNameSchema,
  RegistrationProposalSchema,
  registrationConsentStatement,
  registrationOperationKey,
  hashPayload,
  type Transport,
  type RegistrationProposal,
} from '@lo/adapters';
import { EffectIntentSchema, JsonObjectSchema, type JsonValue, type Result } from '@lo/state';
import { tokenHash, type EffectIntent, type Receipt } from '@lo/policy';
import { withRole, type ActorScope } from './database.js';
import { ProviderStorage, decryptProviderValue, encryptProviderValue } from './provider-storage.js';
import { fetchAuthoritativeFxQuote } from './fx.js';

const PrepareSchema = z
  .object({ accountId: z.uuid(), counterpartyId: z.uuid(), domain: DomainNameSchema, period: z.number().int().min(1).max(10) })
  .strict();
const ContextSchema = z.object({
  quoteId: z.uuid(),
  encrypted: z.object({ iv: z.string(), ciphertext: z.string(), tag: z.string() }),
  agreedAt: z.iso.datetime({ offset: true }).transform(value => new Date(value).toISOString()),
  quote: RegistrationProposalSchema,
  accountId: z.uuid(),
  counterpartyId: z.uuid(),
});
function blocked<T>(message: string, code: 'validation' | 'provider_down' | 'needs_approval' = 'provider_down'): Result<T> {
  return { ok: false, error: { code, message, retryable: false } };
}
function adapter(storage: ProviderStorage, transport?: Transport) {
  if (transport && process.env['NODE_ENV'] !== 'test') throw new Error('validation: injected registrar transport forbidden outside tests');
  return new GoDaddyAdapter({ ...storage.dependencies(), ...(transport ? { transport } : {}) });
}
async function executionContext(
  storage: ProviderStorage,
  versionId: string,
  historical = false,
  authorizationId?: string,
  approvalHash?: string,
) {
  const context = await withRole('policy_role', storage.scope, async db =>
    ContextSchema.parse(
      (
        await db.query('select public.registrar_execution_context($1,$2,$3,$4,$5)result', [
          storage.missionId,
          versionId,
          historical,
          authorizationId ?? null,
          approvalHash ?? null,
        ])
      ).rows[0]?.result,
    ),
  );
  const secret = z
    .object({ quoteToken: z.string().min(1).max(4096) })
    .strict()
    .parse(decryptProviderValue(context.encrypted, `registrar-quote:${storage.missionId}:${context.quoteId}`));
  return { ...context, quoteToken: secret.quoteToken };
}
/** Returns a proposal only. The private provider quote token never leaves this server module. */
export async function prepareDomainRegistration(
  scope: ActorScope,
  raw: unknown,
  taskId: string,
  transport?: Transport,
): Promise<Result<JsonValue>> {
  try {
    const input = PrepareSchema.parse(raw),
      task = z.uuid().parse(taskId),
      storage = new ProviderStorage(scope),
      connection = await storage.connection('godaddy', input.accountId),
      mission = await storage.mission();
    const prior = await withRole(
      'policy_role',
      scope,
      async db =>
        (
          await db.query('select artifact_version_id,quote from public.registrar_quotes where mission_id=$1 and task_id=$2', [
            storage.missionId,
            task,
          ])
        ).rows[0],
    );
    if (prior) {
      const proposal = RegistrationProposalSchema.parse(prior.quote);
      if (proposal.domain !== input.domain || proposal.period !== input.period) throw new Error('Frozen registration request changed');
      return {
        ok: true,
        value: {
          artifactVersionId: z.uuid().parse(prior.artifact_version_id),
          proposal,
          decisionQuestion: proposal.consentStatement,
          status: 'proposed',
          sandboxMode: connection.sandboxMode,
        },
      };
    }
    const intent = await storage.buildIntent(
        task,
        'registrar_quote',
        'communicate',
        { counterpartyId: input.counterpartyId, instrumentId: input.accountId, purpose: 'Read-only domain quote' },
        [],
      ),
      quoted = await adapter(storage, transport).quote(intent, connection.ref, { domain: input.domain, period: input.period });
    if (!quoted.ok) return blocked(quoted.message, quoted.code === 'validation' ? 'validation' : 'provider_down');
    const quote = quoted.data.quote;
    let conversion: RegistrationProposal['conversion'];
    if (quote.currency !== mission.currency) {
      const fx = await fetchAuthoritativeFxQuote(
        scope,
        { amountMinor: quote.totalMinor, from: quote.currency, to: mission.currency },
        transport,
      );
      if (!fx.ok) return fx;
      conversion = fx.value;
    }
    const quoteId = randomUUID(),
      display = { ...quote, ...(conversion ? { conversion } : {}) },
      proposal = RegistrationProposalSchema.parse({ ...display, quoteId, consentStatement: registrationConsentStatement(display) }),
      encrypted = encryptProviderValue({ quoteToken: quoted.data.quoteToken }, `registrar-quote:${storage.missionId}:${quoteId}`),
      versionId = await withRole('policy_role', scope, async db =>
        z
          .uuid()
          .parse(
            (
              await db.query('select public.save_registrar_quote($1,$2,$3,$4,$5,$6,$7)id', [
                storage.missionId,
                quoteId,
                input.accountId,
                input.counterpartyId,
                task,
                proposal,
                encrypted,
              ])
            ).rows[0]?.id,
          ),
      );
    return {
      ok: true,
      value: {
        artifactVersionId: versionId,
        proposal,
        decisionQuestion: proposal.consentStatement,
        status: 'proposed',
        sandboxMode: connection.sandboxMode,
      },
    };
  } catch (error) {
    return blocked(
      'Registrar quote is unavailable or the founder account/domain request changed. No purchase was attempted.',
      error instanceof z.ZodError ? 'validation' : 'provider_down',
    );
  }
}
async function fileRegistration(
  storage: ProviderStorage,
  intent: EffectIntent,
  receipt: Receipt,
  expiresAt: string,
  proposal: RegistrationProposal,
) {
  const authorizationId = await withRole('policy_role', storage.scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select id from public.effect_authorizations where mission_id=$1 and idempotency_key=$2', [
            storage.missionId,
            intent.idempotencyKey,
          ])
        ).rows[0]?.id,
      ),
  );
  const payload = {
      registrationId: receipt.providerId,
      domain: proposal.domain,
      artifactVersionId: z.uuid().parse(intent.artifactVersionId),
      totalMinor: proposal.totalMinor,
      currency: proposal.currency,
      sandboxMode: intent.sandboxMode,
      expiresAt,
    },
    event = await storage
      .webhookStore('registrar.verified_poll')
      .insertVerified({
        provider: 'godaddy',
        providerEventId: `registration-poll:${intent.sandboxMode ? 'sandbox' : 'live'}:${receipt.providerId}`,
        payload,
        payloadHash: hashPayload(payload),
        receivedAt: new Date().toISOString(),
        signatureVerified: true,
      });
  return withRole('policy_role', storage.scope, async db =>
    z
      .uuid()
      .parse(
        (
          await db.query('select public.file_domain_registration($1,$2,$3,$4)id', [
            storage.missionId,
            authorizationId,
            event.eventId,
            expiresAt,
          ])
        ).rows[0]?.id,
      ),
  );
}
export async function executeApprovedDomainRegistration(
  scope: ActorScope,
  artifactVersionId: string,
  taskId: string,
  transport?: Transport,
): Promise<Result<JsonValue>> {
  try {
    const storage = new ProviderStorage(scope),
      version = z.uuid().parse(artifactVersionId),
      artifact = await storage.artifact(version);
    if (artifact.status !== 'approved') return blocked('Current approved immutable domain registration is required.', 'needs_approval');
    const effect = JsonObjectSchema.parse(artifact.content['effectIntent']);
    if (effect['action'] !== 'registration' || effect['effectClass'] !== 'spend')
      return blocked('This artifact does not authorize registrar registration.', 'validation');
    const { action: _a, effectClass: _e, ...fields } = effect,
      intent = await storage.buildIntent(z.uuid().parse(taskId), 'registration', 'spend', { ...fields, artifactVersionId: version }, []),
      prior = await withRole(
        'policy_role',
        scope,
        async db =>
          (
            await db.query('select id from public.effect_authorizations where mission_id=$1 and idempotency_key=$2', [
              storage.missionId,
              intent.idempotencyKey,
            ])
          ).rows[0],
      );
    const context = await executionContext(
        storage,
        version,
        Boolean(prior),
        prior ? z.uuid().parse(prior.id) : undefined,
        intent.approvalToken ? tokenHash(intent.approvalToken) : undefined,
      ),
      connection = await storage.connection('godaddy', context.accountId),
      outcome = await adapter(storage, transport).register(
        intent,
        connection.ref,
        context.quote,
        context.quoteToken,
        context.agreedAt,
        async (registrationId, operationId) => {
          await withRole('policy_role', scope, async db => {
            await db.query('select public.record_registrar_acknowledgement($1,$2,$3,$4,$5)', [
              storage.missionId,
              registrationOperationKey(intent.idempotencyKey),
              intent.idempotencyKey,
              registrationId,
              operationId ?? null,
            ]);
          });
        },
      );
    if (!outcome.ok) return blocked(outcome.message, outcome.code === 'needs_approval' ? 'needs_approval' : 'provider_down');
    if ('data' in outcome) {
      const recordId = await fileRegistration(storage, intent, outcome.receipt, outcome.data.expiresAt, context.quote);
      return {
        ok: true,
        value: {
          status: 'registered_verified',
          domain: context.quote.domain,
          registrationId: outcome.receipt.providerId,
          recordId,
          sandboxMode: intent.sandboxMode,
        },
      };
    }
    await reconcileDomainRegistrations(scope, transport);
    return {
      ok: true,
      value: {
        status: 'receipt_recorded',
        registrationId: outcome.receipt.providerId,
        domain: context.quote.domain,
        sandboxMode: intent.sandboxMode,
      },
    };
  } catch (error) {
    return blocked(
      'Registration is blocked or its existing result needs reconciliation. No replacement quote or second purchase was issued.',
      error instanceof z.ZodError ? 'validation' : 'provider_down',
    );
  }
}
/** Reconciles saved operations with GET only; a lost POST acknowledgement remains explicitly unresolved. */
export async function reconcileDomainRegistrations(
  scope: ActorScope,
  transport?: Transport,
): Promise<{ examined: number; filed: number; unresolved: number }> {
  const storage = new ProviderStorage(scope),
    rows = await withRole('policy_role', scope, async db =>
      z
        .array(z.object({ authorization_id: z.uuid(), intent: EffectIntentSchema, registration_id: z.uuid().nullable() }))
        .parse((await db.query('select public.pending_registrar_operations($1)result', [storage.missionId])).rows[0]?.result),
    ),
    result = { examined: rows.length, filed: 0, unresolved: 0 };
  for (const row of rows) {
    try {
      if (!row.registration_id) {
        result.unresolved++;
        continue;
      }
      const version = z.uuid().parse(row.intent.artifactVersionId),
        context = await executionContext(storage, version, true, row.authorization_id),
        connection = await storage.connection('godaddy', context.accountId),
        verified = await adapter(storage, transport).reconcile(
          row.intent,
          connection.ref,
          context.quote,
          row.registration_id,
          context.agreedAt,
        );
      if (!verified.ok) {
        result.unresolved++;
        continue;
      }
      await storage.dependencies().repository.completeEffect(row.authorization_id, verified.data.receipt);
      await fileRegistration(storage, row.intent, verified.data.receipt, verified.data.data.expiresAt, context.quote);
      result.filed++;
    } catch {
      result.unresolved++;
    }
  }
  return result;
}
export async function prepareFounderOwnershipKit(scope: ActorScope, raw: unknown): Promise<Result<JsonValue>> {
  try {
    const input = z
      .object({
        kind: z.enum(['domain', 'handles']),
        accountId: z.uuid(),
        resource: z.string().trim().min(3).max(253),
        sourceEvidenceIds: z.array(z.uuid()).max(20).default([]),
      })
      .strict()
      .parse(raw);
    if (input.kind === 'domain') DomainNameSchema.parse(input.resource);
    await withRole('specialist_role', scope, async db => {
      if (!(await db.query('select id from public.founder_accounts where id=$1', [input.accountId])).rows[0])
        throw new Error('Account unavailable');
    });
    const instructions = [
      'Open the actual registrar or social account owned by you. Complete registration or secure the handle yourself.',
      'Provide the account ownership/registration document, authenticated account screenshot or provider confirmation as a sourced ownership document naming this exact account and resource. Availability checks are insufficient.',
      'Review that exact source and approve the explicit ownership confirmation. This records founder-confirmed ownership, without claiming an agent registration or provider payment.',
    ];
    if (!input.sourceEvidenceIds.length)
      return { ok: true, value: { status: 'awaiting_ownership_source', mode: 'C', ...input, instructions } };
    const statement = `I reviewed the ownership documents ${input.sourceEvidenceIds.join(', ')} and confirm that ${input.resource} (${input.kind}) is secured under my founder-owned account ${input.accountId}. This confirms ownership, not mere availability.`,
      versionId = await withRole('specialist_role', scope, async db => {
        const artifact = z
            .uuid()
            .parse(
              (
                await db.query(
                  "select public.create_artifact($1,'founder_confirmation','brand','Confirm sourced founder-owned domain or handles')id",
                  [scope.missionId],
                )
              ).rows[0]?.id,
            ),
          version = z
            .uuid()
            .parse(
              (
                await db.query('select public.append_artifact_version($1,$2,$3)id', [
                  scope.missionId,
                  artifact,
                  { founderConfirmation: { kind: 'owned_resource', outcome: 'brand', statement, payload: input } },
                ])
              ).rows[0]?.id,
            );
        await db.query("select public.set_artifact_status($1,$2,'proposed')", [scope.missionId, version]);
        return version;
      });
    return {
      ok: true,
      value: {
        status: 'proposed',
        mode: 'C',
        artifactVersionId: versionId,
        decisionQuestion: statement,
        gate: 'account_ownership',
        instructions,
      },
    };
  } catch (error) {
    return blocked(
      'A founder-owned account and sourced ownership document are required for this manual workflow.',
      error instanceof z.ZodError ? 'validation' : 'provider_down',
    );
  }
}
export async function confirmFounderOwnership(
  scope: ActorScope,
  decisionId: string,
  artifactVersionId: string,
): Promise<Result<JsonValue>> {
  try {
    const evidenceId = await withRole('founder_role', scope, async db =>
      z
        .uuid()
        .parse(
          (
            await db.query('select public.confirm_owned_resource($1,$2,$3)id', [
              scope.missionId,
              z.uuid().parse(decisionId),
              z.uuid().parse(artifactVersionId),
            ])
          ).rows[0]?.id,
        ),
    );
    return { ok: true, value: { evidenceId, status: 'founder_confirmed' } };
  } catch {
    return blocked(
      'Ownership confirmation needs the selected exact document-backed approval. Availability alone cannot satisfy ownership.',
      'needs_approval',
    );
  }
}
