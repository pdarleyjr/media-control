const { spawnSync } = require('node:child_process');
const path = require('node:path');
const cfg = process.argv[2];
if (!cfg) {
  console.error('usage: run-playwright-config.js <config-file>');
  process.exit(2);
}
const cwd = __dirname;
const pw = path.join(cwd, 'node_modules', '.bin', process.platform === 'win32' ? 'playwright.cmd' : 'playwright');
const r = spawnSync(pw, ['test', '-c', cfg], { cwd, stdio: 'inherit', shell: true, env: process.env });
process.exit(r.status == null ? 1 : r.status);
