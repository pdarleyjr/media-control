const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cfg = process.argv[2];
if (!cfg) { console.error('usage: run-playwright-config.js <config-file>'); process.exit(2); }
const cwd = __dirname;
const r = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['playwright', 'test', '-c', cfg],
  { cwd, stdio: 'inherit', shell: true }
);
process.exit(r.status ?? 1);
