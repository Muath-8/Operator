import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { consumeMessageStream } from './message-stream-client';
const response = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const part of chunks) c.enqueue(new TextEncoder().encode(part));
        c.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );
describe('scoped token stream client', () => {
  it('reassembles split frames and replaces drafts instead of duplicating tokens', async () => {
    const missionId = randomUUID(),
      draft = { runId: randomUUID(), attemptKey: 'call', sequence: 0, text: 'Draft', at: new Date().toISOString() },
      frame = `data: ${JSON.stringify({ missionId, drafts: [draft] })}\n\n`,
      received: unknown[] = [];
    await consumeMessageStream(
      response([frame.slice(0, 30), frame.slice(30), `data: ${JSON.stringify({ missionId, drafts: [] })}\n\n`]),
      missionId,
      rows => received.push(rows),
      new AbortController().signal,
    );
    expect(received).toEqual([[draft], []]);
  });
  it('rejects foreign mission, malformed payload, and regressing sequence', async () => {
    const missionId = randomUUID(),
      draft = { runId: randomUUID(), attemptKey: 'call', sequence: 2, text: 'Draft', at: new Date().toISOString() };
    for (const packets of [
      [{ missionId: randomUUID(), drafts: [] }],
      [{ missionId, drafts: [{ text: 'truncated' }] }],
      [
        { missionId, drafts: [draft] },
        { missionId, drafts: [{ ...draft, sequence: 1 }] },
      ],
    ])
      await expect(
        consumeMessageStream(
          response(packets.map(p => `data: ${JSON.stringify(p)}\n\n`)),
          missionId,
          () => {},
          new AbortController().signal,
        ),
      ).rejects.toThrow();
  });
});
