// Minimal zero-dependency static file server for the isolated Playwright harness.
// Serves the worktree frontend root + this fixtures dir so ES module imports
// resolve over http:// (ES modules cannot use file://). Run via Playwright
// `webServer` config. No production configuration is modified.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '../../../..'); // worktree root
const PORT = Number(process.argv[3] || 4321);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let filePath = path.join(ROOT, url);
  if (url === '/' ) filePath = path.join(ROOT, 'server/test/ui-contract/playwright/fixtures/console.html');
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found: ' + url); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ui-contract harness serving ${ROOT} on http://127.0.0.1:${PORT}`);
});
