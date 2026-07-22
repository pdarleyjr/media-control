// Minimal zero-dependency static file server for the isolated Playwright harness.
// Serves the worktree frontend root + this fixtures dir so ES module imports
// resolve over http:// (ES modules cannot use file://). Run via Playwright
// `webServer` config. No production configuration is modified.
//
// Lifecycle: binds loopback only, prints readiness, exits cleanly on SIGINT/SIGTERM
// so Playwright (or other parents) can terminate without leaving orphans.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(process.argv[2] || path.join(__dirname, '../../..')); // worktree root
const PORT = Number(process.argv[3] || 4321);
const HOST = '127.0.0.1';
const FIXTURE = path.join(__dirname, 'fixtures', 'console.html');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, url);
  if (url === '/') filePath = FIXTURE;
  // Prevent path traversal outside ROOT/FIXTURE parent.
  const normalized = path.normalize(filePath);
  const allowedRoots = [ROOT, path.dirname(FIXTURE)];
  if (!allowedRoots.some((r) => normalized === r || normalized.startsWith(r + path.sep))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(normalized, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + url); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(normalized)] || 'text/plain' });
    res.end(data);
  });
});

function shutdown(signal) {
  server.close(() => process.exit(0));
  // Force-exit if close hangs.
  setTimeout(() => process.exit(0), 2000).unref();
  process.stderr.write(`[serve.mjs] ${signal} — shutting down\n`);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.once('error', (err) => {
  process.stderr.write(`[serve.mjs] listen failed on ${HOST}:${PORT}: ${err.message}\n`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`ui-contract harness serving ${ROOT} on http://${HOST}:${PORT}`);
});
