import { z } from 'zod';
import type { JsonValue } from '@lo/state';

export const VOICE_TOOL_NAMES = ['check_bounds', 'write_fact', 'schedule_followup', 'end_call'] as const;
export const BoundsSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    maxUnitPriceMinor: z.number().int().nonnegative().safe(),
    maxMoq: z.number().int().positive(),
    maxLeadDays: z.number().int().positive(),
    maxDepositPercent: z.number().min(0).max(100),
  })
  .strict();
export const TermsSchema = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    unitPriceMinor: z.number().int().nonnegative().safe(),
    moq: z.number().int().positive(),
    leadDays: z.number().int().positive(),
    depositPercent: z.number().min(0).max(100),
  })
  .strict();
export const FactSchema = z
  .object({ statement: z.string().min(1).max(4000), kind: z.enum(['quotation', 'sample', 'delivery', 'other']) })
  .strict();
export const FollowupSchema = z.object({ dueAt: z.string().datetime(), reason: z.string().min(1).max(1000) }).strict();
const EndSchema = z.object({ reason: z.string().min(1).max(500) }).strict();
export const SAFE_SENTENCES = {
  en: [
    'Thank you.',
    'Please tell me more.',
    'I will confirm in writing.',
    'I will confirm by message.',
    'That is outside my authority. I will confirm by message.',
    'These are preliminary discussions; the founder approves any commitment.',
    'What is your minimum order quantity?',
    'Could you offer a smaller trial run?',
    'What is the unit price and currency?',
    'What are the payment terms?',
    'What is your lead time?',
    'Would you send that in writing?',
  ],
  ar: [
    'شكراً لك.',
    'يرجى توضيح المزيد.',
    'سأؤكد ذلك كتابة.',
    'سأعود إليك برسالة.',
    'هذا خارج صلاحياتي. سأعود إليك برسالة.',
    'هذه مناقشات أولية؛ أي التزام يحتاج موافقة المؤسس.',
    'ما الحد الأدنى لكمية الطلب؟',
    'هل يمكن توفير طلب تجريبي أصغر؟',
    'ما سعر الوحدة والعملة؟',
    'ما شروط الدفع؟',
    'ما مدة التوريد؟',
    'هل يمكنك إرسال ذلك كتابة؟',
  ],
} as const;
const normalize = (s: string) =>
  s
    .toLocaleLowerCase()
    .replace(/[.,!?;:،؛؟]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
export function trialQuestion(terms: z.infer<typeof TermsSchema>, language: 'ar' | 'en'): string {
  const price = (terms.unitPriceMinor / 100).toFixed(2);
  return language === 'ar'
    ? `هل يمكن توفير تجربة من ${terms.moq} وحدة بسعر ${price} ${terms.currency} للوحدة؟ سأؤكد ذلك كتابة.`
    : `Could you offer a trial of ${terms.moq} units at ${terms.currency} ${price} per unit? I will confirm in writing.`;
}
/** Full-response audio is held until its transcript matches a code-owned nonbinding utterance. */
export class SpokenOutputGuard {
  private approvedTrial: string | undefined;
  constructor(readonly language: 'ar' | 'en') {}
  approveTrial(terms: z.infer<typeof TermsSchema>): void {
    this.approvedTrial = normalize(trialQuestion(terms, this.language));
  }
  clearTrial(): void {
    this.approvedTrial = undefined;
  }
  allows(transcript: string): boolean {
    const text = normalize(transcript);
    return SAFE_SENTENCES[this.language].some(s => normalize(s) === text) || (!!this.approvedTrial && this.approvedTrial === text);
  }
}
export interface VoicePersistence {
  fact(key: string, payload: Record<string, JsonValue>): Promise<void>;
  followup(key: string, dueAt: string, reason: string): Promise<void>;
  end(key: string, reason: string): Promise<void>;
}
export class VoiceTools {
  readonly outputGuard: SpokenOutputGuard;
  private readonly results = new Map<string, Promise<unknown>>();
  constructor(
    readonly language: 'ar' | 'en',
    readonly bounds: unknown,
    readonly persistence: VoicePersistence,
    readonly now = () => Date.now(),
  ) {
    this.outputGuard = new SpokenOutputGuard(language);
  }
  definitions() {
    return [
      {
        type: 'function',
        name: 'check_bounds',
        description:
          'Check complete proposed trial terms against the current recorded negotiation mandate. Never imply a binding agreement. Speak only speakExactly on return.',
        parameters: z.toJSONSchema(TermsSchema),
      },
      {
        type: 'function',
        name: 'write_fact',
        description: 'Record a supplier statement as claimed verbal evidence; it is never verified or payment authority.',
        parameters: z.toJSONSchema(FactSchema),
      },
      {
        type: 'function',
        name: 'schedule_followup',
        description: 'Create a bounded internal follow-up commitment; it never sends a message or payment.',
        parameters: z.toJSONSchema(FollowupSchema),
      },
      {
        type: 'function',
        name: 'end_call',
        description: 'End this call with a reason; written confirmation remains due.',
        parameters: z.toJSONSchema(EndSchema),
      },
    ];
  }
  execute(name: string, raw: unknown, callId: string): Promise<unknown> {
    const existing = this.results.get(callId);
    if (existing) return existing;
    if (!VOICE_TOOL_NAMES.includes(name as (typeof VOICE_TOOL_NAMES)[number]))
      return Promise.resolve({ ok: false, code: 'rejected', message: 'Voice has no such capability.' });
    if (this.results.size >= 40) return Promise.resolve({ ok: false, code: 'rejected', message: 'Voice tool budget exhausted.' });
    const pending = this.run(name, raw, callId);
    this.results.set(callId, pending);
    return pending;
  }
  private async run(name: string, raw: unknown, callId: string): Promise<unknown> {
    try {
      if (name === 'check_bounds') {
        const t = TermsSchema.parse(raw);
        const parsed = BoundsSchema.safeParse(this.bounds);
        this.outputGuard.clearTrial();
        if (!parsed.success)
          return { allowed: false, reason: 'No complete current negotiation mandate.', speakExactly: SAFE_SENTENCES[this.language][4] };
        const b = parsed.data;
        const allowed =
          t.currency === b.currency &&
          t.unitPriceMinor <= b.maxUnitPriceMinor &&
          t.moq <= b.maxMoq &&
          t.leadDays <= b.maxLeadDays &&
          t.depositPercent <= b.maxDepositPercent;
        if (allowed) this.outputGuard.approveTrial(t);
        return { allowed, speakExactly: allowed ? trialQuestion(t, this.language) : SAFE_SENTENCES[this.language][4], binding: false };
      }
      if (name === 'write_fact') {
        const fact = FactSchema.parse(raw);
        await this.persistence.fact(callId, { ...fact, trust: 'claimed', modality: 'verbal' });
        return { ok: true, trust: 'claimed', requiresWrittenAcknowledgement: true };
      }
      if (name === 'schedule_followup') {
        const request = FollowupSchema.parse(raw);
        const due = Date.parse(request.dueAt);
        if (due < this.now() || due > this.now() + 30 * 86400000)
          return { ok: false, code: 'validation', message: 'Follow-up deadline is outside the next 30 days.' };
        await this.persistence.followup(callId, request.dueAt, request.reason);
        return { ok: true, status: 'scheduled_internal' };
      }
      const end = EndSchema.parse(raw);
      await this.persistence.end(callId, end.reason);
      return { ok: true, status: 'ended' };
    } catch {
      return { ok: false, code: 'validation', message: 'Voice tool input or durable write failed; no external success inferred.' };
    }
  }
}
export function escapeXml(text: string): string {
  return text.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c] ?? '');
}
export function voiceTwiML(
  disclosure: string,
  language: 'ar' | 'en',
  streamUrl: string,
  sessionId: string,
  recordingConsent: boolean,
): string {
  const url = new URL(streamUrl);
  if (url.protocol !== 'wss:') throw new Error('Voice media stream must use WSS.');
  const say = language === 'ar' ? 'voice="Polly.Zeina" language="arb"' : 'voice="Polly.Joanna" language="en-US"';
  const recording = recordingConsent
    ? language === 'ar'
      ? ' قد يتم تسجيل هذه المكالمة وفق الموافقة المسجلة.'
      : ' This call may be recorded under your recorded consent.'
    : language === 'ar'
      ? ' لن نحفظ تسجيلاً صوتياً أو نصاً كاملاً لهذه المكالمة.'
      : ' We will not retain an audio recording or full transcript of this call.';
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say ${say}>${escapeXml(disclosure + recording)}</Say><Connect><Stream url="${escapeXml(url.href)}"><Parameter name="sessionId" value="${escapeXml(sessionId)}"/></Stream></Connect><Say ${say}>${escapeXml(SAFE_SENTENCES[language][2])}</Say><Hangup/></Response>`;
}
