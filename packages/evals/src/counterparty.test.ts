import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { CounterpartySimulator, CounterpartyScriptSchema, type CounterpartyScript } from './counterparty.js';
import { startCounterpartyServer } from './counterparty-server.js';
import { counterparties } from '../fixtures/counterparties.js';
import type { EvalTransport } from './runner.js';
let directory: string;
const prior = { ...process.env },
  model = 'synthetic-model-v1',
  config = { apiKey: 'explicit-test-key', models: {}, pricing: {}, maxOutputTokens: 1024 };
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'lo-counterparty-'));
  vi.stubEnv('NODE_ENV', 'test');
  process.env.LO_SIMULATION_ENABLED = 'true';
});
afterAll(async () => {
  process.env = prior;
  const base = resolve(tmpdir()),
    target = resolve(directory);
  if (relative(base, target).startsWith('..') || !target.includes('lo-counterparty-')) throw Error('Unsafe test cleanup');
  await rm(target, { recursive: true });
});
const script = () => CounterpartyScriptSchema.parse(counterparties[0]);
const turn = (id = randomUUID()) => ({
  sessionId: randomUUID(),
  eventId: id,
  scriptId: 'bottle-standard',
  at: '2026-11-12T10:00:00.000Z',
  text: 'Please quote the exact bottle specification.',
});
function response(input: { currentTerms: unknown; script: { language: string } }, wrong = false) {
  return new Response(
    JSON.stringify({
      id: 'resp_synthetic_contract',
      model,
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({
                resultJson: JSON.stringify({
                  body: 'Synthetic model-generated contract reply.',
                  language: input.script.language,
                  quotedTerms: wrong ? { ...(input.currentTerms as object), moq: 99999 } : input.currentTerms,
                }),
              }),
            },
          ],
        },
      ],
      usage: { input_tokens: 30, output_tokens: 20 },
    }),
    { status: 200 },
  );
}
const transport =
  (capture: (input: Record<string, unknown>) => void = () => undefined, wrong = false): EvalTransport =>
  async (_url, req) => {
    const body = JSON.parse(String(req.body)) as { input: { content: string }[]; tools?: unknown };
    expect(body.tools).toBeUndefined();
    const input = JSON.parse(body.input[0]?.content ?? '{}') as { currentTerms: unknown; script: { language: string } };
    capture(input);
    return response(input, wrong);
  };
describe('durable explicitly synthetic LLM counterparty service', () => {
  it('validates eight distinct sourced synthetic scripts and hides private intentions/moves from directory', () => {
    expect(counterparties).toHaveLength(8);
    for (const s of counterparties) CounterpartyScriptSchema.parse(s);
    const sim = new CounterpartySimulator(directory, counterparties, config, model, transport());
    const listing = JSON.stringify(sim.directoryListing());
    expect(listing).not.toContain('hiddenIntent');
    expect(listing).not.toContain('moves');
    expect(listing).not.toContain('unitPriceMinor');
    expect(sim.directoryListing().every(s => s.synthetic && s.reviewStatus === 'unreviewed')).toBe(true);
  });
  it('coalesces concurrent same-event requests, survives reconstructed process state, and rejects changed request or script', async () => {
    let calls = 0;
    const request = turn(),
      sim = new CounterpartySimulator(
        directory,
        [script()],
        config,
        model,
        transport(() => calls++),
      );
    const [a, b] = await Promise.all([sim.respond(request), sim.respond(request)]);
    expect(a).toEqual(b);
    expect(calls).toBe(1);
    expect(a.generation).toMatchObject({ source: 'test_transport', inputTokens: 30, outputTokens: 20 });
    expect(a.deliverAt).toBe('2026-11-12T12:00:00.000Z');
    const restarted = new CounterpartySimulator(
      directory,
      [script()],
      config,
      model,
      transport(() => calls++),
    );
    expect(await restarted.respond(request)).toEqual(a);
    await expect(restarted.respond({ ...request, text: 'Changed request' })).rejects.toThrow('conflict');
    expect(calls).toBe(1);
  });
  it('preserves hidden scripted MOQ/price moves and passes actual prior exchanges into the next model call', async () => {
    const changed: CounterpartyScript = {
      ...script(),
      moves: [{ afterTurn: 2, moq: 2000, unitPriceMinor: 1200, attack: 'ask_budget', delayHours: 24 }],
    };
    const inputs: Record<string, unknown>[] = [];
    const sim = new CounterpartySimulator(
        directory,
        [changed],
        config,
        model,
        transport(i => inputs.push(i)),
      ),
      first = turn();
    await sim.respond(first);
    const second = await sim.respond({
      ...first,
      eventId: randomUUID(),
      at: '2026-11-13T10:00:00.000Z',
      text: 'Has the original MOQ changed?',
    });
    expect(second.reply?.quotedTerms).toMatchObject({ moq: 2000, unitPriceMinor: 1200 });
    expect(inputs[1]).toMatchObject({
      turn: 2,
      attack: 'ask_budget',
      history: [{ message: first.text, response: 'Synthetic model-generated contract reply.' }],
    });
    expect(second.deliverAt).toBe('2026-11-14T10:00:00.000Z');
  });
  it('models deliberate silence with no model call, no reply and no invented generation evidence', async () => {
    let calls = 0;
    const sim = new CounterpartySimulator(
      directory,
      [{ ...script(), moves: [{ afterTurn: 1, silent: true }] }],
      config,
      model,
      transport(() => calls++),
    );
    expect(await sim.respond(turn())).toMatchObject({ status: 'silent', reply: null, generation: null, deliverAt: null });
    expect(calls).toBe(0);
  });
  it('holds ambiguous remote generation across restart rather than retrying under the same identity', async () => {
    let calls = 0;
    const request = turn(),
      down: EvalTransport = async () => {
        calls++;
        throw Error('Synthetic transport uncertainty');
      };
    await expect(new CounterpartySimulator(directory, [script()], config, model, down).respond(request)).rejects.toThrow();
    await expect(
      new CounterpartySimulator(
        directory,
        [script()],
        config,
        model,
        transport(() => calls++),
      ).respond(request),
    ).rejects.toThrow('reconcile');
    expect(calls).toBe(1);
  });
  it('rejects generated drift from exact controlled terms and retains the attempted reservation', async () => {
    const request = turn(),
      sim = new CounterpartySimulator(directory, [script()], config, model, transport(undefined, true));
    await expect(sim.respond(request)).rejects.toThrow('changed controlled');
    await expect(sim.respond(request)).rejects.toThrow('reconcile');
  });
  it('refuses missing live credentials, unknown personas and malformed bounded input', async () => {
    const sim = new CounterpartySimulator(directory, [script()], { ...config, apiKey: undefined }, model);
    await expect(sim.respond(turn())).rejects.toThrow('API key');
    await expect(sim.respond({ ...turn(), scriptId: 'not-present' })).rejects.toThrow('Unknown');
    await expect(sim.respond({ ...turn(), sessionId: '../escape' })).rejects.toThrow();
  });
  it('serves actual loopback HTTP with authentication, private directory and strict body bounds', async () => {
    const token = 'synthetic-local-token-'.repeat(3),
      sim = new CounterpartySimulator(directory, [script()], config, model, transport()),
      running = await startCounterpartyServer(sim, token);
    try {
      expect((await fetch(running.url + '/directory')).status).toBe(401);
      const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
      expect(await (await fetch(running.url + '/directory', { headers })).json()).toMatchObject({
        synthetic: true,
        reviewStatus: 'unreviewed',
      });
      const reply = await fetch(running.url + '/turn', { method: 'POST', headers, body: JSON.stringify(turn()) });
      expect(reply.status).toBe(200);
      expect(await reply.json()).toMatchObject({ synthetic: true, status: 'scheduled', generation: { source: 'test_transport' } });
      expect((await fetch(running.url + '/turn', { method: 'POST', headers, body: 'a'.repeat(66000) })).status).toBe(413);
      expect((await fetch(running.url + '/unknown', { headers })).status).toBe(404);
    } finally {
      await running.close();
    }
  });
  it('refuses production simulation and synthetic model injection outside tests', async () => {
    const existingSimulator = new CounterpartySimulator(directory, [script()], config, model);
    vi.stubEnv('NODE_ENV', 'production');
    try {
      expect(() => new CounterpartySimulator(directory, [script()], config, model, transport())).toThrow('only in tests');
      await expect(startCounterpartyServer(existingSimulator, 'synthetic-token-'.repeat(4))).rejects.toThrow('nonproduction');
    } finally {
      vi.stubEnv('NODE_ENV', 'test');
    }
  });
});
