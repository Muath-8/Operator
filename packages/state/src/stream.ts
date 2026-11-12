import { z } from 'zod';
export const MessageDraftSchema = z
  .object({
    runId: z.uuid(),
    attemptKey: z.string().min(1).max(256),
    sequence: z.number().int().nonnegative(),
    text: z.string().max(24000),
    at: z.iso.datetime(),
  })
  .strict();
export const MessageStreamPacketSchema = z.object({ missionId: z.uuid(), drafts: z.array(MessageDraftSchema).max(4) }).strict();
export type MessageDraft = z.infer<typeof MessageDraftSchema>;
