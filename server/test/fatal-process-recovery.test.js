const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const serverRoot = path.resolve(__dirname, '..');
const fatalHandlerPath = path.join(serverRoot, 'lib', 'fatal-process-handlers.js');

function runFatalProbe(statement) {
  return spawnSync(process.execPath, [
    '-e',
    `const { installFatalProcessHandlers } = require(${JSON.stringify(fatalHandlerPath)}); installFatalProcessHandlers(); ${statement}`,
  ], {
    cwd: serverRoot,
    encoding: 'utf8',
    timeout: 5_000,
  });
}

test('an uncaught exception is logged and terminates the server process non-zero', () => {
  const result = runFatalProbe("setImmediate(() => { throw new Error('synthetic uncaught failure'); });");

  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /\[fatal\] uncaughtException.*synthetic uncaught failure/s);
});

test('an unhandled rejection is logged and terminates the server process non-zero', () => {
  const result = runFatalProbe("Promise.reject(new Error('synthetic rejection failure'));");

  assert.notEqual(result.status, 0);
  assert.equal(result.signal, null);
  assert.match(result.stderr, /\[fatal\] unhandledRejection.*synthetic rejection failure/s);
});

test('server startup installs fail-fast handlers instead of swallowing fatal errors', () => {
  const source = fs.readFileSync(path.join(serverRoot, 'server.js'), 'utf8');

  assert.match(source, /installFatalProcessHandlers\(\)/);
  assert.doesNotMatch(source, /process\.on\(['"]uncaughtException['"]/);
  assert.doesNotMatch(source, /process\.on\(['"]unhandledRejection['"]/);
});
