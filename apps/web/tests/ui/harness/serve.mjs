// TEST HARNESS ONLY. Builds the harness and serves it on a separate loopback port (default 4317).
// Serves only the built harness files; binds to 127.0.0.1 and refuses any other host.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { build, DIST } from './build.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.UI_HARNESS_PORT ?? 4317);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

if (!process.argv.includes('--no-build')) await build();

const server = createServer(async (req, res) => {
  const hostHeader = (req.headers.host ?? '').split(':')[0];
  if (!['127.0.0.1', 'localhost'].includes(hostHeader) || req.method !== 'GET') {
    res.writeHead(403).end();
    return;
  }
  const path = new URL(req.url ?? '/', `http://${HOST}`).pathname;
  const file = path === '/' ? 'index.html' : normalize(path).replace(/^[\\/]+/, '');
  const ext = file.slice(file.lastIndexOf('.'));
  if (file.includes('..') || !(ext in TYPES)) {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(join(DIST, file));
    res.writeHead(200, {
      'Content-Type': TYPES[ext],
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(PORT, HOST, () => console.log(`UI harness (test only) at http://${HOST}:${PORT}/`));
