import { z } from 'zod';
import { failure, type EffectIntent } from '@lo/policy';
import { AdapterFault, Boundary, credentialBaseSchema, jsonBody, hashPayload, parse, type AdapterDependencies } from './core.js';

/** Durable atomic per-task + per-founder service cap, separate from supplier spend. */
export interface ServiceBudgetStore {
  reserve(missionId: string, key: string, provider: 'openai' | 'browserbase', maximumUnits: number): Promise<boolean>;
  complete(missionId: string, key: string, providerId: string, usedUnits: number): Promise<void>;
  ambiguous(missionId: string, key: string): Promise<void>;
}
const credentialSchema = z
  .object({
    ...credentialBaseSchema,
    apiKey: z.string().min(1),
    allowedModels: z.array(z.string()).min(1),
    maxOutputTokens: z.number().int().positive().max(16000),
  })
  .strict();
export { credentialSchema as OpenAICredentialSchema };
const generationInputSchema = z
  .object({
    model: z.string().min(1),
    instructions: z.string().min(1).max(20000),
    input: z.string().min(1).max(100000),
    maxOutputTokens: z.number().int().positive().max(16000),
  })
  .strict();
export class OpenAIGenerationAdapter {
  readonly boundary: Boundary;
  constructor(
    deps: AdapterDependencies,
    readonly budgets: ServiceBudgetStore,
  ) {
    this.boundary = new Boundary(deps);
  }
  structured<T>(intent: EffectIntent, credentialRef: string, raw: unknown, schema: z.ZodType<T>, schemaName: string) {
    const candidate = generationInputSchema.safeParse(raw);
    if (!candidate.success)
      return this.boundary.read(async () => {
        throw new AdapterFault(failure('validation', 'Invalid structured generation input.'));
      });
    const inputBound = Buffer.byteLength(JSON.stringify({ input: raw, schema: z.toJSONSchema(schema), schemaName }), 'utf8');
    return this.boundary.preparation(
      {
        provider: 'openai',
        kind: 'openai_structured',
        credentialRef,
        intent,
        requestHash: hashPayload([raw, z.toJSONSchema(schema), schemaName]),
        model: candidate.data.model,
        maximumUnits: inputBound + candidate.data.maxOutputTokens,
      },
      async () => {
        const input = parse(generationInputSchema, raw);
        parse(z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), schemaName);
        const c = await this.boundary.credential('openai', credentialRef, intent, credentialSchema);
        if (!c.allowedModels.includes(input.model) || input.maxOutputTokens > c.maxOutputTokens)
          throw new AdapterFault(failure('rejected', 'Generation model or token cap is outside account policy.'));
        if (!(await this.budgets.reserve(intent.missionId, intent.idempotencyKey, 'openai', inputBound + input.maxOutputTokens)))
          throw new AdapterFault(failure('rejected', 'Generation budget exhausted or this generation has already started.'));
        try {
          const r = await this.boundary.http(
            {
              url: 'https://api.openai.com/v1/responses',
              method: 'POST',
              headers: {
                Authorization: `Bearer ${c.apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': intent.idempotencyKey,
              },
              body: jsonBody({
                model: input.model,
                instructions: input.instructions,
                input: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'input_text',
                        text: JSON.stringify({
                          kind: 'untrusted_data',
                          provenance: { missionId: intent.missionId, taskId: intent.taskId },
                          content: input.input,
                        }),
                      },
                    ],
                  },
                ],
                max_output_tokens: input.maxOutputTokens,
                store: false,
                text: { format: { type: 'json_schema', name: schemaName, schema: z.toJSONSchema(schema), strict: true } },
              }),
            },
            true,
          );
          const response = parse(
            z.object({
              id: z.string().min(1),
              status: z.string(),
              output: z.array(
                z.object({
                  type: z.string(),
                  content: z.array(z.object({ type: z.string(), text: z.string().optional(), refusal: z.string().optional() })).optional(),
                }),
              ),
              usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }),
            }),
            r.body,
          );
          if (response.status !== 'completed')
            throw new AdapterFault(failure('rejected', 'Generation incomplete; no artifact was created.'));
          const content = response.output.flatMap(o => o.content ?? []);
          if (content.some(c => c.type === 'refusal'))
            throw new AdapterFault(failure('rejected', 'Generation refused; no artifact was created.'));
          const text = content
            .filter(c => c.type === 'output_text')
            .map(c => c.text ?? '')
            .join('');
          const output = parse(schema, JSON.parse(text) as unknown);
          await this.budgets.complete(
            intent.missionId,
            intent.idempotencyKey,
            response.id,
            response.usage.input_tokens + response.usage.output_tokens,
          );
          return { output, usage: response.usage, receipt: this.boundary.receipt('openai', response.id, intent, r.body) };
        } catch (error) {
          await this.budgets.ambiguous(intent.missionId, intent.idempotencyKey);
          throw error;
        }
      },
    );
  }
  image(intent: EffectIntent, credentialRef: string, raw: unknown) {
    const candidate = z
      .object({ model: z.string().min(1) })
      .passthrough()
      .safeParse(raw);
    if (!candidate.success)
      return this.boundary.read(async () => {
        throw new AdapterFault(failure('validation', 'Invalid image generation input.'));
      });
    return this.boundary.preparation(
      {
        provider: 'openai',
        kind: 'openai_image',
        credentialRef,
        intent,
        requestHash: hashPayload(raw),
        model: candidate.data.model,
        maximumUnits: 1,
      },
      async () => {
        const input = parse(
          z
            .object({
              model: z.string().min(1),
              prompt: z.string().min(1).max(32000),
              size: z.enum(['1024x1024', '1536x1024', '1024x1536']),
              transparent: z.boolean(),
            })
            .strict(),
          raw,
        );
        const c = await this.boundary.credential('openai', credentialRef, intent, credentialSchema);
        if (!c.allowedModels.includes(input.model) || !(await this.budgets.reserve(intent.missionId, intent.idempotencyKey, 'openai', 1)))
          throw new AdapterFault(failure('rejected', 'Image model or budget unavailable.'));
        try {
          const r = await this.boundary.http(
            {
              url: 'https://api.openai.com/v1/images/generations',
              method: 'POST',
              headers: {
                Authorization: `Bearer ${c.apiKey}`,
                'Content-Type': 'application/json',
                'Idempotency-Key': intent.idempotencyKey,
              },
              body: jsonBody({
                model: input.model,
                prompt: input.prompt,
                n: 1,
                size: input.size,
                background: input.transparent ? 'transparent' : 'opaque',
                output_format: 'png',
              }),
            },
            true,
          );
          const image = parse(
            z.object({ created: z.number(), data: z.array(z.object({ b64_json: z.string().min(1) })).length(1) }),
            r.body,
          );
          const id = `image-${image.created}-${intent.idempotencyKey}`;
          await this.budgets.complete(intent.missionId, intent.idempotencyKey, id, 1);
          return {
            base64: image.data[0]?.b64_json ?? '',
            mimeType: 'image/png' as const,
            receipt: this.boundary.receipt('openai', id, intent, { created: image.created }),
          };
        } catch (error) {
          await this.budgets.ambiguous(intent.missionId, intent.idempotencyKey);
          throw error;
        }
      },
    );
  }
}
