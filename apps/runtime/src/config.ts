import { z } from 'zod';

const optionalUrl = z.preprocess(v => (v === '' ? undefined : v), z.url().optional());
const optionalString = z.preprocess(v => (v === '' ? undefined : v), z.string().min(1).optional());
export const EnvironmentSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LO_EXECUTION_MODE: z.enum(['local', 'sandbox', 'production']).default('local'),
    LO_STORAGE_BACKEND: z.enum(['postgres', 'sqlite']).default('postgres'),
    LO_LOCAL_AI: z.enum(['simulated', 'codex']).default('simulated'),
    LO_SQLITE_PATH: optionalString,
    DATABASE_URL: optionalString,
    DATABASE_FOUNDER_URL: optionalString,
    DATABASE_LEAD_URL: optionalString,
    DATABASE_SPECIALIST_URL: optionalString,
    DATABASE_POLICY_URL: optionalString,
    DATABASE_INGRESS_URL: optionalString,
    DATABASE_VOICE_URL: optionalString,
    SUPABASE_URL: optionalUrl,
    SUPABASE_ANON_KEY: optionalString,
    OPENAI_API_KEY: optionalString,
    MODEL_FRONTIER: optionalString,
    MODEL_MID: optionalString,
    MODEL_SMALL: optionalString,
    MODEL_REVIEWER: optionalString,
    MODEL_REALTIME: optionalString,
    APP_ORIGIN: z.url().default('http://127.0.0.1:3000'),
    INNGEST_EVENT_KEY: optionalString,
    INNGEST_SIGNING_KEY: optionalString,
    LO_DEV_FOUNDER_ID: z.preprocess(v => (v === '' ? undefined : v), z.uuid().optional()),
    LO_DEV_AUTH_TOKEN: optionalString,
    MAX_PARALLEL_RUNS: z.coerce.number().int().min(1).max(6).default(4),
    INNGEST_DEV: optionalString,
  })
  .superRefine((env, ctx) => {
    if (env.LO_STORAGE_BACKEND === 'sqlite' && (env.LO_EXECUTION_MODE !== 'local' || env.NODE_ENV === 'production'))
      ctx.addIssue({ code: 'custom', message: 'SQLite testing is available only in local development mode' });
    if (
      env.LO_LOCAL_AI === 'codex' &&
      (env.LO_STORAGE_BACKEND !== 'sqlite' || env.LO_EXECUTION_MODE !== 'local' || env.NODE_ENV === 'production')
    )
      ctx.addIssue({ code: 'custom', message: 'Subscription AI is available only in the private SQLite testing app' });
    if (env.NODE_ENV === 'production' && env.LO_EXECUTION_MODE === 'local')
      ctx.addIssue({ code: 'custom', message: 'Local test mode cannot run in production' });
    if (env.LO_EXECUTION_MODE !== 'local') {
      if (env.INNGEST_DEV)
        ctx.addIssue({
          code: 'custom',
          path: ['INNGEST_DEV'],
          message: 'Unsigned Inngest development mode is forbidden outside explicit local mode',
        });
      for (const key of [
        'SUPABASE_URL',
        'SUPABASE_ANON_KEY',
        'DATABASE_FOUNDER_URL',
        'DATABASE_LEAD_URL',
        'DATABASE_SPECIALIST_URL',
        'DATABASE_POLICY_URL',
        'DATABASE_INGRESS_URL',
        'INNGEST_EVENT_KEY',
        'INNGEST_SIGNING_KEY',
      ] as const)
        if (!env[key]) ctx.addIssue({ code: 'custom', path: [key], message: 'Required outside explicit local mode' });
      if (env.LO_DEV_FOUNDER_ID || env.LO_DEV_AUTH_TOKEN)
        ctx.addIssue({ code: 'custom', message: 'Local authentication cannot be configured outside local mode' });
    }
    if (env.LO_DEV_FOUNDER_ID && (!env.LO_DEV_AUTH_TOKEN || env.LO_DEV_AUTH_TOKEN.length < 32))
      ctx.addIssue({ code: 'custom', message: 'Local founder authentication requires a random token of at least 32 characters' });
    if (env.LO_EXECUTION_MODE === 'local' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(env.APP_ORIGIN).hostname))
      ctx.addIssue({ code: 'custom', message: 'Local mode must bind a loopback origin' });
  });
export type Environment = z.infer<typeof EnvironmentSchema>;
export function environment(raw: Record<string, string | undefined> = process.env): Environment {
  return EnvironmentSchema.parse(raw);
}
