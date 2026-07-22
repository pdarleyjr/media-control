#!/usr/bin/env node
// Enumerate and run every legitimate Node:test file under server/test/,
// explicitly excluding Playwright/e2e infrastructure. Prints the file list,
// fails if zero files are found, and exits with the test runner status.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = path.resolve(__dirname, '..');
const TEST_ROOT = path.join(SERVER_ROOT, 'test');

// Node's default discovery matches these patterns. We mirror them so the runner
// never drops a legitimate test just because its name isn't "*.test.js".
const NAME_RE = /(?:\.test|_test|-test)\.(?:js|cjs|mjs)$|^(?:test-.*|test)\.(?:js|cjs|mjs)$/;

// Paths (relative to server/) that must never be treated as Node unit tests.
const EXCLUDE_PREFIXES = [
  path.join('e2e') + path.sep,
  path.join('test', 'ui-contract', 'playwright') + path.sep, // legacy (should be gone)
];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'test-results' || entry.name === 'playwright-report') continue;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(abs, out);
      continue;
    }
    if (!NAME_RE.test(entry.name)) continue;
    const relFromServer = path.relative(SERVER_ROOT, abs);
    if (EXCLUDE_PREFIXES.some((p) => relFromServer.startsWith(p))) continue;
    out.push(abs);
  }
  return out;
}

const files = walk(TEST_ROOT).sort((a, b) => a.localeCompare(b));

console.log(`[run-node-tests] server root: ${SERVER_ROOT}`);
console.log(`[run-node-tests] discovered ${files.length} Node test file(s):`);
for (const f of files) {
  console.log(`  ${path.relative(SERVER_ROOT, f).replace(/\\/g, '/')}`);
}

if (files.length === 0) {
  console.error('[run-node-tests] FAIL: zero test files discovered');
  process.exit(2);
}

const args = ['--test', '--test-concurrency=1', ...files];
const child = spawn(process.execPath, args, {
  cwd: SERVER_ROOT,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[run-node-tests] killed by signal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
