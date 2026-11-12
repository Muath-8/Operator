import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { environment } from './config.js';
import { withRole, type ActorScope } from './database.js';
import { EffectIntentSchema, hashApprovalToken, JsonObjectSchema, type EffectIntent } from '@lo/state';

export const ValidationPageSchema = z.object({
  slug: z.string(),
  title: z.string(),
  description: z.string(),
  consentText: z.string(),
  imageUrl: z.url().nullable(),
  sandbox: z.boolean(),
});
let publicPool: Pool | undefined;
async function publicQuery(sql: string, args: unknown[]) {
  const env = environment();
  const connectionString = process.env.DATABASE_DEMAND_PUBLIC_URL ?? (env.LO_EXECUTION_MODE === 'local' ? env.DATABASE_URL : undefined);
  if (!connectionString) throw new Error('provider_down: public validation database connection is not configured');
  publicPool ??= new Pool({ connectionString, max: 3 });
  const db = await publicPool.connect();
  try {
    await db.query('begin');
    await db.query('set local role demand_public_role');
    const result = await db.query(sql, args);
    await db.query('commit');
    return result;
  } catch (error) {
    await db.query('rollback');
    throw error;
  } finally {
    db.release();
  }
}
export async function readValidationPage(slug: string) {
  const result = await publicQuery('select public.read_validation_page($1) as page', [
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{2,62}$/)
      .parse(slug),
  ]);
  return ValidationPageSchema.nullable().parse(result.rows[0]?.page);
}
export async function recordWaitlistSignup(raw: unknown): Promise<void> {
  const input = z
    .object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{2,62}$/),
      email: z.email().max(254),
      consent: z.literal(true),
      website: z.string().max(0),
    })
    .strict()
    .parse(raw);
  const encoded = process.env.PROVIDER_ENCRYPTION_KEY;
  if (!encoded) throw new Error('provider_down: waitlist email encryption key is not configured');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('validation: email encryption needs a 32-byte key');
  const normalized = input.email.trim().toLowerCase();
  const hash = createHmac('sha256', key).update(`${input.slug}:${normalized}`).digest('hex');
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(input.slug));
  const encrypted = Buffer.concat([cipher.update(normalized, 'utf8'), cipher.final()]);
  const ciphertext = JSON.stringify({
    version: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64'),
  });
  await publicQuery('select public.record_waitlist_signup($1,$2,$3,$4)', [input.slug, hash, ciphertext, true]);
}
export async function publishDemandPage(scope: ActorScope, rawIntent: EffectIntent, versionId: string, thresholdId: string, slug: string) {
  const intent = EffectIntentSchema.parse(rawIntent);
  if (intent.missionId !== scope.missionId || !intent.approvalToken) throw new Error('needs_approval: publication requires exact approval');
  const { approvalToken, ...safeIntent } = intent;
  return withRole('policy_role', scope, async db => {
    const result = await db.query('select public.publish_demand_page($1,$2,$3,$4,$5,$6) as result', [
      scope.missionId,
      safeIntent,
      hashApprovalToken(approvalToken),
      z.uuid().parse(versionId),
      z.uuid().parse(thresholdId),
      slug,
    ]);
    return JsonObjectSchema.parse(result.rows[0]?.result);
  });
}
export function evaluateDemand(
  submissions: number,
  threshold: number,
  skippedWithRisk: boolean,
): { result: 'met' | 'not_met' | 'risk_accepted'; basis: string } {
  z.number().int().nonnegative().parse(submissions);
  z.number().int().positive().parse(threshold);
  return {
    result: skippedWithRisk ? 'risk_accepted' : submissions >= threshold ? 'met' : 'not_met',
    basis: skippedWithRisk
      ? 'Founder explicitly accepted the validation risk'
      : `${submissions} distinct consented sign-ups against a threshold of ${threshold}; email ownership and purchasing intent are not established by this count`,
  };
}
export async function closeDemandPool() {
  await publicPool?.end();
  publicPool = undefined;
}

/** Used only after the caller has selected consented signup rows through the
 * founder-scoped archive transaction. Authentication never happens in a codec. */
export function decryptWaitlistEmail(ciphertext: string, slug: string): string {
  const encoded = process.env.PROVIDER_ENCRYPTION_KEY;
  if (!encoded) throw new Error('provider_down: signup decryption key unavailable');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('validation: signup decryption key invalid');
  const value = z
      .object({ version: z.literal(1), iv: z.string(), tag: z.string(), data: z.string() })
      .strict()
      .parse(JSON.parse(ciphertext) as unknown),
    iv = Buffer.from(value.iv, 'base64'),
    tag = Buffer.from(value.tag, 'base64');
  if (iv.length !== 12 || tag.length !== 16) throw new Error('validation: signup ciphertext envelope invalid');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(slug));
  decipher.setAuthTag(tag);
  return z.email().parse(Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'));
}
