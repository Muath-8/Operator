import { z } from 'zod';
import { withRole, type ActorScope } from './database.js';
const sourceUrl = z.url().refine(s => {
  const u = new URL(s);
  return u.protocol === 'https:' && !u.username && !u.password;
});
export const ModelPriceSchema = z
  .object({
    inputPerMillion: z.number().finite().nonnegative(),
    cachedInputPerMillion: z.number().finite().nonnegative(),
    outputPerMillion: z.number().finite().nonnegative(),
    audioInputPerMillion: z.number().finite().nonnegative().optional(),
    cachedAudioInputPerMillion: z.number().finite().nonnegative().optional(),
    audioOutputPerMillion: z.number().finite().nonnegative().optional(),
    source: sourceUrl,
    observedAt: z.iso.datetime(),
  })
  .strict();
export interface ModelCallUsage {
  callKey: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  responseId?: string;
}
type Price = z.infer<typeof ModelPriceSchema>;
const integer = (n: number) => BigInt(z.number().int().safe().nonnegative().parse(n));
export function modelCostMicros(usage: ModelCallUsage, price: Price): number {
  const input = integer(usage.inputTokens),
    cached = integer(usage.cachedInputTokens),
    output = integer(usage.outputTokens);
  if (cached > input) throw new Error('validation: cached input exceeds total input');
  const rate = (n: number) => BigInt(Math.ceil(n * 1_000_000));
  const scaled =
    (input - cached) * rate(price.inputPerMillion) + cached * rate(price.cachedInputPerMillion) + output * rate(price.outputPerMillion);
  return z
    .number()
    .int()
    .safe()
    .parse(Number((scaled + 999999n) / 1000000n));
}
export function createModelMeter(scope: ActorScope, runId: string, model: string) {
  const raw = process.env.MODEL_PRICE_RATES_JSON;
  let price: Price | undefined;
  if (raw) {
    const rates = z.record(z.string(), ModelPriceSchema).parse(JSON.parse(raw));
    price = rates[model];
  }
  const cap = z.coerce
    .number()
    .int()
    .safe()
    .positive()
    .optional()
    .parse(process.env.MODEL_FOUNDER_DAILY_CAP_MICRO_USD || undefined);
  const local = process.env.LO_EXECUTION_MODE === 'local';
  if (!local && (!price || !cap))
    throw new Error('validation: sourced model pricing and founder daily cap are required before paid model calls');
  return {
    dispatch: async <T>(callKey: string, invoke: () => Promise<T>): Promise<T> =>
      withRole('policy_role', scope, async db => {
        await db.query('select public.lock_model_dispatch($1,$2,$3)', [scope.missionId, runId, callKey]);
        return invoke();
      }),
    reserve: async (callKey: string, maximumTokens: number) => {
      if (!price || !cap) throw new Error('validation: sourced model pricing and founder daily cap are required before a paid attempt');
      const maximum = modelCostMicros(
        { callKey, inputTokens: 0, cachedInputTokens: 0, outputTokens: maximumTokens, totalTokens: maximumTokens },
        { ...price, outputPerMillion: Math.max(price.inputPerMillion, price.cachedInputPerMillion, price.outputPerMillion) },
      );
      await withRole('policy_role', scope, async db => {
        await db.query('select public.reserve_run_tokens($1,$2,$3,$4)', [scope.missionId, runId, callKey, maximumTokens]);
        const allowed = (
          await db.query('select public.reserve_model_budget($1,$2,$3,$4,$5)ok', [scope.missionId, runId, callKey, maximum, cap])
        ).rows[0]?.ok;
        if (!allowed) throw new Error('validation: founder daily model budget would be exceeded');
      });
    },
    record: async (usage: ModelCallUsage) => {
      const complete = usage.totalTokens > 0 && usage.totalTokens === usage.inputTokens + usage.outputTokens;
      const cost = complete && price && cap ? modelCostMicros(usage, price) : null;
      await withRole('policy_role', scope, async db => {
        await db.query('select public.record_model_usage($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [
          scope.missionId,
          runId,
          usage.callKey,
          model,
          usage.inputTokens,
          usage.outputTokens,
          usage.cachedInputTokens,
          cost,
          complete,
          price ?? null,
          usage.responseId ?? null,
        ]);
      });
    },
  };
}

/** Images and realtime have provider-specific billing dimensions. Reserve a
 * sourced worst-case ceiling before connecting; until exact billable usage can
 * be verified, record unknown cost and retain the whole ceiling. */
export function createServiceModelMeter(scope: ActorScope, runId: string, model: string, kind: 'image' | 'realtime') {
  const cap = z.coerce
    .number()
    .int()
    .safe()
    .positive()
    .optional()
    .parse(process.env.MODEL_FOUNDER_DAILY_CAP_MICRO_USD || undefined);
  const imagePrice =
    kind === 'image' && process.env.MODEL_IMAGE_PRICE_CEILINGS_JSON
      ? z
          .record(
            z.string(),
            z.object({ maximumCallMicroUsd: z.number().int().safe().positive(), source: sourceUrl, observedAt: z.iso.datetime() }).strict(),
          )
          .parse(JSON.parse(process.env.MODEL_IMAGE_PRICE_CEILINGS_JSON))[model]
      : undefined;
  const realtimePrice =
    kind === 'realtime' && process.env.MODEL_PRICE_RATES_JSON
      ? z.record(z.string(), ModelPriceSchema).parse(JSON.parse(process.env.MODEL_PRICE_RATES_JSON))[model]
      : undefined;
  return {
    reserve: async (callKey: string, maximumUnits: number) => {
      if (!cap) throw new Error('validation: founder daily model budget required for paid services');
      let ceiling: number;
      let price: unknown;
      if (kind === 'image') {
        if (!imagePrice) throw new Error('validation: sourced maximum image call price required');
        ceiling = imagePrice.maximumCallMicroUsd;
        price = imagePrice;
      } else {
        if (
          !realtimePrice ||
          realtimePrice.audioInputPerMillion === undefined ||
          realtimePrice.cachedAudioInputPerMillion === undefined ||
          realtimePrice.audioOutputPerMillion === undefined
        )
          throw new Error('validation: sourced text and audio realtime prices required');
        const rate = Math.max(
          realtimePrice.inputPerMillion,
          realtimePrice.cachedInputPerMillion,
          realtimePrice.outputPerMillion,
          realtimePrice.audioInputPerMillion,
          realtimePrice.cachedAudioInputPerMillion,
          realtimePrice.audioOutputPerMillion,
        );
        ceiling = modelCostMicros(
          { callKey, inputTokens: 0, cachedInputTokens: 0, outputTokens: maximumUnits, totalTokens: maximumUnits },
          { ...realtimePrice, outputPerMillion: rate },
        );
        price = realtimePrice;
      }
      const allowed = await withRole(
        'policy_role',
        scope,
        async db =>
          (await db.query('select public.reserve_model_budget($1,$2,$3,$4,$5)ok', [scope.missionId, runId, callKey, ceiling, cap])).rows[0]
            ?.ok,
      );
      if (!allowed) throw new Error('validation: founder daily model budget would be exceeded');
      return { ceilingMicroUsd: ceiling, price };
    },
    recordUnknown: async (callKey: string, responseId?: string) => {
      await withRole('policy_role', scope, async db => {
        await db.query('select public.record_model_usage($1,$2,$3,$4,0,0,0,null,false,$5,$6)', [
          scope.missionId,
          runId,
          callKey,
          model,
          kind === 'image' ? (imagePrice ?? null) : (realtimePrice ?? null),
          responseId ?? null,
        ]);
      });
    },
  };
}
