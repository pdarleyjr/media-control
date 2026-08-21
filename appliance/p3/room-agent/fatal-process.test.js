'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const fatalModule = path.join(__dirname, 'fatal-process.js');

function runFatal(mode) {
  const script = [
    `require(${JSON.stringify(fatalModule)}).installFatalProcessLogging('fatal-test')`,
    mode === 'exception'
      ? "setImmediate(() => { throw new Error('synthetic-uncaught') })"
      : "Promise.reject(new Error('synthetic-rejection'))",
  ].join(';');
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--unhandled-rejections=throw', '-e', script], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stderr, startedAt, endedAt: Date.now() }));
  });
}

test('a synthetic uncaught exception is logged and exits non-zero', async () => {
  const result = await runFatal('exception');
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /fatal-test.*uncaughtException.*synthetic-uncaught/s);
});

test('a synthetic unhandled rejection is logged and exits non-zero', async () => {
  const result = await runFatal('rejection');
  assert.notEqual(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /fatal-test.*unhandledRejection.*synthetic-rejection/s);
});

test('P3 agents use fail-fast logging and the committed RoomAgent supervisor has a bounded restart interval', () => {
  for (const name of ['agent.js', 'cache-agent.js']) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    assert.match(source, /installFatalProcessLogging/);
    assert.doesNotMatch(source, /process\.on\('uncaughtException',/);
    assert.doesNotMatch(source, /process\.on\('unhandledRejection',/);
  }
  const installer = fs.readFileSync(path.join(__dirname, '..', 'install', 'update.ps1'), 'utf8');
  assert.match(installer, /RestartInterval \(New-TimeSpan -Seconds \$RestartSec\)/);
  assert.match(installer, /-RestartSec 60/);
});
