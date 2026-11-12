import { z } from 'zod';
import { withRole, type ActorScope } from './database.js';
import { redact } from './security.js';
import { MessageDraftSchema } from '@lo/state/stream';
export { MessageDraftSchema } from '@lo/state/stream';
/** Extract only the top-level founderMessage JSON string. Incomplete escapes
 * remain buffered; tool arguments and other model fields never enter the stream. */
export function founderMessagePrefix(json: string): string | null {
  let depth = 0,
    inString = false,
    escaped = false,
    start = 0;
  for (let i = 0; i < json.length; i++) {
    const c = json[i];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === '\\') {
        escaped = true;
        continue;
      }
      if (c !== '"') continue;
      inString = false;
      if (depth !== 1) continue;
      let key: unknown;
      try {
        key = JSON.parse(json.slice(start, i + 1));
      } catch {
        continue;
      }
      if (key !== 'founderMessage') continue;
      let cursor = i + 1;
      while (/\s/.test(json[cursor] ?? '')) cursor++;
      if (json[cursor++] !== ':') continue;
      while (/\s/.test(json[cursor] ?? '')) cursor++;
      if (json[cursor++] !== '"') return null;
      let raw = '';
      for (; cursor < json.length; cursor++) {
        const char = json[cursor];
        if (char === '"') {
          try {
            return z
              .string()
              .max(24000)
              .parse(JSON.parse('"' + raw + '"'));
          } catch {
            return null;
          }
        }
        if (char === '\\') {
          const next = json[cursor + 1];
          if (next === undefined) break;
          if (next === 'u') {
            const digits = json.slice(cursor + 2, cursor + 6);
            if (!/^[0-9a-f]{4}$/i.test(digits)) break;
            raw += '\\u' + digits;
            cursor += 5;
          } else {
            raw += '\\' + next;
            cursor++;
          }
        } else raw += char;
      }
      try {
        const text = z
          .string()
          .max(24000)
          .parse(JSON.parse('"' + raw + '"'));
        return /[\uD800-\uDBFF]$/.test(text) ? text.slice(0, -1) : text;
      } catch {
        return null;
      }
    } else if (c === '"') {
      inString = true;
      start = i;
    } else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
  }
  return null;
}
export function createMessagePublisher(scope: ActorScope, runId: string) {
  let attempt = '',
    sequence = 0,
    last = '',
    lastAt = 0;
  return async (callKey: string, json: string) => {
    const text = founderMessagePrefix(json);
    if (text === null) return;
    const fresh = attempt !== callKey;
    if (fresh) {
      attempt = callKey;
      sequence = 0;
      last = '';
      lastAt = 0;
    }
    if (!fresh && (text === last || Date.now() - lastAt < 120)) return;
    const safe = z.string().parse(redact(text));
    await withRole('lead_role', scope, d =>
      d.query('select public.publish_agent_message_stream($1,$2,$3,$4,$5)', [scope.missionId, runId, callKey, sequence++, safe]),
    );
    last = text;
    lastAt = Date.now();
  };
}
export async function readMessageDrafts(scope: ActorScope) {
  return withRole('founder_role', scope, async d => {
    await d.query('select public.mission_engagement($1)', [scope.missionId]);
    const rows = await d.query(
      'select run_id,attempt_key,sequence,text,updated_at from public.agent_message_streams where mission_id=$1 and expires_at>clock_timestamp() order by updated_at,run_id',
      [scope.missionId],
    );
    return rows.rows.map(r =>
      MessageDraftSchema.parse({
        runId: r.run_id,
        attemptKey: r.attempt_key,
        sequence: r.sequence,
        text: r.text,
        at: new Date(r.updated_at).toISOString(),
      }),
    );
  });
}
