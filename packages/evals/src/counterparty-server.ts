import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { CounterpartySimulator } from './counterparty.js';
export async function startCounterpartyServer(
  simulator: CounterpartySimulator,
  token: string,
  port = 0,
): Promise<{ server: Server; url: string; close: () => Promise<void> }> {
  if (process.env.NODE_ENV === 'production' || process.env.LO_SIMULATION_ENABLED !== 'true')
    throw new Error('Explicit nonproduction simulator mode required');
  if (token.length < 32) throw new Error('A random simulator access token of at least32characters is required');
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Type', 'application/json');
    const done = (status: number, body: unknown) => {
      res.writeHead(status);
      res.end(JSON.stringify(body));
    };
    const supplied = Buffer.from(req.headers.authorization ?? ''),
      expected = Buffer.from('Bearer ' + token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      done(401, { error: 'Authentication required' });
      return;
    }
    if (req.method === 'GET' && req.url === '/directory') {
      done(200, { synthetic: true, reviewStatus: 'unreviewed', counterparties: simulator.directoryListing() });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/turn') {
      done(404, { error: 'Unknown simulator endpoint' });
      return;
    }
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
        bytes += value.length;
        if (bytes > 65536) {
          done(413, { error: 'Bounded synthetic turn required' });
          return;
        }
        chunks.push(value);
      }
      const result = await simulator.respond(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      done(200, result);
    } catch (error) {
      const reason = error instanceof Error ? error.message : '';
      done(reason.startsWith('reconcile:') || reason.startsWith('conflict:') ? 409 : 422, {
        error: reason.startsWith('reconcile:')
          ? 'Uncertain turn requires reconciliation; no generation repeated'
          : 'Synthetic turn could not be completed',
        synthetic: true,
      });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Simulator loopback listener missing');
  return {
    server,
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close(error => (error ? reject(error) : resolve()));
        server.closeIdleConnections();
      }),
  };
}
