import { describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Usage, type Model, type ModelRequest } from '@openai/agents';
import { CheckpointedModel, type DurableSteps } from './agents.js';
import { founderMessagePrefix } from './message-stream.js';
const request: ModelRequest = {
  input: 'Hello',
  modelSettings: { maxTokens: 500 },
  tools: [],
  handoffs: [],
  outputType: 'text',
  tracing: false,
};
describe('F7 genuine model output streaming and recovery', () => {
  it('extracts only a top-level founder message and buffers split escapes/surrogates', () => {
    expect(founderMessagePrefix('{"tool":{"founderMessage":"secret"},"founderMessage":"Real')).toBe('Real');
    expect(founderMessagePrefix('{"founderMessage":"A \\u062')).toBe('A ');
    expect(founderMessagePrefix('{"founderMessage":"A \\u0628')).toBe('A ب');
    expect(founderMessagePrefix('{"founderMessage":"A \\uD83D')).toBe('A ');
    expect(founderMessagePrefix('{"founderMessage":"Quoted \\"')).toBe('Quoted "');
    expect(founderMessagePrefix('{"other":"founderMessage: leaked"}')).toBeNull();
  });
  it('streams actual provider deltas inside one metered durable attempt, and replay makes no paid request', async () => {
    const cache = new Map<string, unknown>(),
      steps: DurableSteps = {
        run: async <T>(id: string, work: () => Promise<T>) => {
          if (!cache.has(id)) cache.set(id, await work());
          return cache.get(id) as T;
        },
      };
    const network = vi.fn(),
      deltas: string[] = [];
    const delegate: Model = {
      getResponse: async () => {
        throw Error('Non-stream path forbidden');
      },
      async *getStreamedResponse() {
        network();
        yield { type: 'response_started' };
        yield { type: 'output_text_delta', delta: '{"founderMessage":"In' };
        yield { type: 'output_text_delta', delta: ' progress"}' };
        yield {
          type: 'response_done',
          response: {
            id: 'response-1',
            usage: { requests: 1, inputTokens: 20, outputTokens: 8, totalTokens: 28 },
            output: [
              {
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: '{"founderMessage":"In progress"}' }],
              },
            ],
          },
        };
      },
    };
    const meter = {
        reserve: vi.fn(async () => {}),
        record: vi.fn(async () => {}),
        dispatch: async <T>(_key: string, invoke: () => Promise<T>) => invoke(),
      },
      run = randomUUID();
    for (let i = 0; i < 2; i++) {
      const model = new CheckpointedModel(delegate, steps, run, 10000, meter, async (_key, text) => {
        deltas.push(founderMessagePrefix(text) ?? '');
      });
      expect((await model.getResponse(request)).usage).toBeInstanceOf(Usage);
    }
    expect(deltas).toEqual(['In', 'In progress']);
    expect(network).toHaveBeenCalledTimes(1);
    expect(meter.reserve).toHaveBeenCalledTimes(1);
    expect(meter.record).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ totalTokens: 28 }));
  });
  it('holds an incomplete stream reservation and never records fabricated complete usage', async () => {
    const record = vi.fn(),
      delegate: Model = {
        getResponse: async () => {
          throw Error('unexpected');
        },
        async *getStreamedResponse() {
          yield { type: 'output_text_delta', delta: '{"founderMessage":"Partial' };
        },
      };
    const model = new CheckpointedModel(
      delegate,
      { run: async (_id, work) => work() },
      randomUUID(),
      10000,
      { reserve: async () => {}, record },
      async () => {},
    );
    await expect(model.getResponse(request)).rejects.toThrow(/without a completed/);
    expect(record).not.toHaveBeenCalled();
  });
});
