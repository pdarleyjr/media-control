const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.join(__dirname, '..', '..');
const sampler = path.join(repoRoot, 'scripts', 'collect-gmktec-performance.sh');

function findBash() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  if (process.platform !== 'win32') return 'bash';

  const candidates = [
    path.join(process.env.ProgramW6432 || '', 'Git', 'bin', 'bash.exe'),
    path.join(process.env.ProgramFiles || '', 'Git', 'bin', 'bash.exe'),
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ];

  return candidates.find((candidate) => candidate && fs.existsSync(candidate)) || null;
}

function writeExecutable(filePath, content) {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

test('failed HTTP probes stay valid CSV and run concurrently within the sample window', (t) => {
  const bash = findBash();
  if (!bash) {
    t.skip('Bash is not installed; Linux CI exercises the sampler behavior');
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-control-sampler-'));
  const binDir = path.join(dir, 'bin');
  const outputDir = path.join(dir, 'output');
  fs.mkdirSync(binDir);

  writeExecutable(path.join(binDir, 'curl'), `#!/usr/bin/env bash
sleep 2
printf '000,2.000000'
exit 28
`);
  writeExecutable(path.join(binDir, 'docker'), `#!/usr/bin/env bash
exit 1
`);
  writeExecutable(path.join(binDir, 'nstat'), `#!/usr/bin/env bash
printf 'TcpRetransSegs 0 0.0\\n'
`);

  const startedAt = Date.now();
  const result = spawnSync(bash, [sampler, '5', outputDir], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  const elapsedMs = Date.now() - startedAt;

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs < 7_000, `parallel probes exceeded bounded window: ${elapsedMs}ms`);

    const rows = fs.readFileSync(path.join(outputDir, 'http.csv'), 'utf8')
      .trim()
      .split(/\r?\n/);
    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.equal(row.split(',').length, 4, `malformed CSV row: ${row}`);
    }
    assert.ok(fs.existsSync(path.join(outputDir, 'COMPLETE')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
