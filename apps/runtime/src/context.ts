import { z } from 'zod';
import { IdSchema, JsonObjectSchema } from '@lo/state';
import { TaskBriefSchema, UntrustedDataSchema, type Role } from './contracts.js';
import { contentHash, detectUntrustedInstructions, redact, TOOL_MANIFESTS } from './security.js';

export const ContextInputSchema = z
  .object({
    missionId: IdSchema,
    roleCard: z.string().min(1),
    missionBrief: z.string(),
    bindingDecisions: z.array(JsonObjectSchema),
    task: TaskBriefSchema,
    artifacts: z.array(JsonObjectSchema),
    commitmentsAndEvents: z.array(JsonObjectSchema),
    counterparty: z.array(UntrustedDataSchema),
  })
  .strict();
export type ContextInput = z.infer<typeof ContextInputSchema>;
export interface ContextPack {
  text: string;
  hash: string;
  tokenUpperBound: number;
  flagged: boolean;
  tools: readonly string[];
}

/** Fixed order per Agent Design 6.2. Budget is conservative UTF-8 bytes, never a
 * language-dependent chars/4 estimate that can undercount Arabic or source data. */
export function buildContextPack(raw: ContextInput, secrets: readonly string[] = []): ContextPack {
  const input = ContextInputSchema.parse(raw);
  if (input.missionId !== input.task.missionId) throw new Error('invariant_violation: cross-mission task');
  const flagged =
    input.counterparty.some(item => detectUntrustedInstructions(item.content).length > 0) ||
    input.artifacts.some(item => detectUntrustedInstructions(JSON.stringify(item)).length > 0);
  const role: Role = input.task.role;
  const sections = [
    ['role_card', input.roleCard],
    ['mission_brief', input.missionBrief],
    ['binding_decisions', input.bindingDecisions],
    ['task_brief', input.task],
    ['artifact_summaries', input.artifacts],
    ['commitments_and_recent_events', input.commitmentsAndEvents],
    ['untrusted_counterparty_data', input.counterparty],
  ];
  const text = JSON.stringify(redact({ schemaVersion: 1, sections }, secrets));
  const tokenUpperBound = Buffer.byteLength(text, 'utf8');
  if (tokenUpperBound > (role === 'lead' ? 40000 : 25000))
    throw new Error('validation: context budget exceeded; retrieve smaller artifact summaries');
  return {
    text,
    hash: contentHash(text),
    tokenUpperBound,
    flagged,
    tools: flagged
      ? TOOL_MANIFESTS[role].filter(t => ['read_state', 'read_artifact', 'read_thread', 'search_mission'].includes(t))
      : TOOL_MANIFESTS[role],
  };
}
