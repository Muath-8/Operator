import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { ModelRequest } from '@openai/agents';
import { CheckpointedModel, createModelProvider } from './agents.js';
import { founderMessagePrefix } from './message-stream.js';

/** Independent actual pinned SDK HTTP/SSE protocol probe. All responses and
 * usage figures are explicitly local synthetic fixtures, never live scores. */
describe('independent pinned SDK streaming transport boundary', () => {
  for (const completed of [true, false])
    it(
      completed
        ? 'streams actual SDK deltas and accounts only the completed response'
        : 'rejects truncated actual SDK streams without inventing completed usage',
      async () => {
        let requests = 0;
        const wireBodies: unknown[] = [],
          output: string[] = [],
          record = vi.fn(async () => {}),
          reserve = vi.fn(async () => {}),
          text = '{"founderMessage":"Synthetic draft only"}';
        const server = createServer((request, response) => {
          requests++;
          const chunks: Buffer[] = [];
          request.on('data', (chunk: Buffer) => chunks.push(chunk));
          request.on('end', () => {
            wireBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown);
            response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
            const item = {
                id: 'msg_local_review',
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text, annotations: [] }],
              },
              base = {
                id: 'resp_local_review',
                object: 'response',
                created_at: 1,
                model: 'explicit-local-review',
                status: 'in_progress',
                output: [],
                usage: null,
              };
            const send = (event: unknown) => response.write(`data: ${JSON.stringify(event)}\n\n`);
            send({ type: 'response.created', sequence_number: 0, response: base });
            send({
              type: 'response.output_item.added',
              sequence_number: 1,
              output_index: 0,
              item: { ...item, status: 'in_progress', content: [] },
            });
            send({
              type: 'response.output_text.delta',
              sequence_number: 2,
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: '{"founderMessage":"Synthetic',
            });
            send({
              type: 'response.output_text.delta',
              sequence_number: 3,
              item_id: item.id,
              output_index: 0,
              content_index: 0,
              delta: ' draft only"}',
            });
            if (completed)
              send({
                type: 'response.completed',
                sequence_number: 4,
                response: {
                  ...base,
                  status: 'completed',
                  output: [item],
                  usage: {
                    input_tokens: 10,
                    output_tokens: 12,
                    total_tokens: 22,
                    input_tokens_details: { cached_tokens: 0 },
                    output_tokens_details: { reasoning_tokens: 0 },
                  },
                },
              });
            response.end();
          });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        try {
          const address = server.address();
          if (!address || typeof address === 'string') throw new Error('Local synthetic HTTP fixture unavailable');
          const delegate = await createModelProvider('explicit-local-test-key', `http://127.0.0.1:${address.port}/v1`).getModel(
            'explicit-local-review',
          );
          const model = new CheckpointedModel(
            delegate,
            { run: async (_key, invoke) => invoke() },
            randomUUID(),
            10000,
            { reserve, record, dispatch: async (_key, invoke) => invoke() },
            async (_key, json) => {
              output.push(founderMessagePrefix(json) ?? '');
            },
          );
          const request: ModelRequest = {
            systemInstructions: 'Local independent SDK fixture',
            input: 'Explicit synthetic protocol test only',
            modelSettings: { maxTokens: 500, store: true },
            tools: [],
            handoffs: [],
            outputType: 'text',
            tracing: false,
          };
          if (completed) {
            const result = await model.getResponse(request);
            expect(result.usage.totalTokens).toBe(22);
            expect(record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ inputTokens: 10, outputTokens: 12, totalTokens: 22 }));
          } else {
            await expect(model.getResponse(request)).rejects.toThrow();
            expect(record).not.toHaveBeenCalled();
          }
          expect(output).toEqual(['Synthetic', 'Synthetic draft only']);
          expect(requests).toBe(1);
          expect(reserve).toHaveBeenCalledTimes(1);
          expect(wireBodies).toEqual([expect.objectContaining({ stream: true, store: false })]);
        } finally {
          await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        }
      },
    );
});
