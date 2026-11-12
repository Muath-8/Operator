import { MessageStreamPacketSchema, type MessageDraft } from '@lo/state/stream';
/** Consume only framed, schema-valid, scoped server data. Reconnect receives a
 * replacement snapshot; sequence numbers reject stale frames within an attempt. */
export async function consumeMessageStream(
  response: Response,
  missionId: string,
  onDrafts: (drafts: MessageDraft[]) => void,
  signal: AbortSignal,
): Promise<void> {
  if (!response.ok || !response.body || !response.headers.get('content-type')?.includes('text/event-stream'))
    throw new Error('Draft stream unavailable');
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let buffer = '';
  const seen = new Map<string, { attempt: string; sequence: number }>();
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      if (buffer.length > 300000) throw new Error('Draft packet exceeds bound');
      let split;
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        if (frame.startsWith('event: unavailable')) throw new Error('Draft stream interrupted');
        const data = frame.split('\n').find(line => line.startsWith('data: '));
        if (!data) continue;
        const packet = MessageStreamPacketSchema.parse(JSON.parse(data.slice(6)));
        if (packet.missionId !== missionId) throw new Error('Draft mission mismatch');
        for (const draft of packet.drafts) {
          const previous = seen.get(draft.runId);
          if (previous?.attempt === draft.attemptKey && previous.sequence > draft.sequence) throw new Error('Draft stream regressed');
          seen.set(draft.runId, { attempt: draft.attemptKey, sequence: draft.sequence });
        }
        onDrafts(packet.drafts);
      }
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
