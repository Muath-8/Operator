import { CounterpartySimulator } from '../packages/evals/src/counterparty.js';
import { startCounterpartyServer } from '../packages/evals/src/counterparty-server.js';
import { counterparties } from '../packages/evals/fixtures/counterparties.js';
import { configuration, isPinned } from '../packages/evals/src/runner.js';
const config = configuration(),
  model = process.env.SIMULATOR_MODEL,
  token = process.env.LO_SIMULATOR_TOKEN;
if (!config.apiKey || !model || !isPinned(model) || !token)
  throw new Error('blocked: OPENAI_API_KEY, pinned SIMULATOR_MODEL and random LO_SIMULATOR_TOKEN required');
const port = Number(process.env.LO_SIMULATOR_PORT ?? 8290);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid loopback simulator port');
const simulator = new CounterpartySimulator(
    process.env.LO_SIMULATOR_DIRECTORY ?? '.local/counterparty-simulator',
    counterparties,
    config,
    model,
  ),
  running = await startCounterpartyServer(simulator, token, port);
process.stdout.write(JSON.stringify({ url: running.url, synthetic: true, reviewStatus: 'unreviewed', model }) + '\n');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    void running.close().then(() => process.exit(0));
  });
