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

// The cache agent is fail-fast, so an unsupervised MBFD_RoomCacheAgent task
// turns any single fatal exception into an outage that lasts until the next
// reboot. These are static contract assertions over the committed installer.
const installDir = path.join(__dirname, '..', 'install');
const supervisionScript = path.join(installDir, 'ensure-cache-agent-supervision.ps1');

test('the installer wires up MBFD_RoomCacheAgent supervision', () => {
  const installer = fs.readFileSync(path.join(installDir, 'update.ps1'), 'utf8');
  assert.match(installer, /MBFD_RoomCacheAgent/, 'update.ps1 must manage MBFD_RoomCacheAgent supervision');
  assert.match(installer, /ensure-cache-agent-supervision\.ps1/);
  assert.ok(fs.existsSync(supervisionScript), 'ensure-cache-agent-supervision.ps1 must be committed');
});

test('the cache-agent supervision script enables fixed-interval restart on failure', () => {
  const source = fs.readFileSync(supervisionScript, 'utf8');
  // Restart-on-failure must actually be configured.
  assert.match(source, /-RestartCount \$RestartCount/);
  assert.match(source, /-RestartInterval \(New-TimeSpan -Seconds \$RestartIntervalSeconds\)/);
  assert.match(source, /\[int\]\$RestartIntervalSeconds = 60/, 'default restart interval must be 60 seconds');
  assert.match(source, /\[int\]\$RestartCount = 999/, 'default restart attempts must survive realistic faults');
  // A healthy long-running agent must never be force-terminated by the default
  // PT72H execution time limit.
  assert.match(source, /-ExecutionTimeLimit \(\[TimeSpan\]::Zero\)/);
  // A duplicate trigger must not start a second agent fighting over port 8097.
  assert.match(source, /-MultipleInstances IgnoreNew/);
  assert.match(source, /-StartWhenAvailable/);
  // It must refuse obviously invalid supervision values rather than silently
  // registering a task that cannot recover.
  assert.match(source, /RestartIntervalSeconds must be >= 60/);
  assert.match(source, /RestartCount must be >= 1/);
  // And it must verify the applied result instead of assuming success.
  assert.match(source, /Supervision NOT applied/);
});

test('the cache-agent supervision script never destroys the secret-bearing task definition', () => {
  const source = fs.readFileSync(supervisionScript, 'utf8');
  // Unregistering would drop the on-box launcher/principal that loads
  // MC_NODE_TOKEN from ENV, so it must never appear.
  assert.doesNotMatch(source, /Unregister-ScheduledTask/);
  // Settings-only update for the existing task.
  assert.match(source, /Set-ScheduledTask -TaskName \$TaskName -Settings \$settings/);
  // Drift guards so a silent action/principal/trigger rewrite fails loudly.
  assert.match(source, /Refusing to continue: task action changed/);
  assert.match(source, /Refusing to continue: task principal changed/);
  assert.match(source, /Refusing to continue: task triggers changed/);
});

test('the cache-agent supervision script embeds no secret material', () => {
  const source = fs.readFileSync(supervisionScript, 'utf8');
  // Only the *names* of secret-bearing env vars may be mentioned in comments;
  // no assignment of a literal value is permitted.
  assert.doesNotMatch(source, /MC_NODE_TOKEN\s*=\s*\S/);
  assert.doesNotMatch(source, /-----BEGIN/);
  assert.doesNotMatch(source, /(?:password|secret|apikey|api_key)\s*=\s*['"][^'"]{6,}['"]/i);
});

test('the P3 README documents fixed-interval restart, not exponential backoff, for the supervisor', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
  assert.match(readme, /fixed\s*\n?\s*\*\*interval\*\*|fixed \*\*interval\*\*|fixed[\s\S]{0,40}interval/i);
  assert.match(readme, /no\*\* exponential backoff|no exponential backoff/i,
    'README must state that Task Scheduler does not provide exponential backoff');
  assert.match(readme, /MBFD_RoomCacheAgent/);
  assert.match(readme, /ensure-cache-agent-supervision\.ps1/);
});
