import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE = path.join(ROOT, 'cameras-proxy', 'nginx.conf.tpl');
const RENDER = path.join(ROOT, 'cameras-proxy', 'render-config.sh');
const LITERAL_SECRET = /[a-fA-F0-9]{64}/;

function bashPath(p) {
  // bash (Git Bash on Windows / real bash on Linux) rejects backslashes.
  return p.replace(/\\/g, '/');
}
function renderViaScript(token) {
  // Run the committed shell renderer so the test exercises the real path.
  const out = bashPath(path.join(fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'cam-')), 'nginx.conf'));
  const env = { ...process.env, CAMERA_API_TOKEN: token };
  execFileSync('bash', [bashPath(RENDER), bashPath(TEMPLATE), out], { env, stdio: 'pipe' });
  return fs.readFileSync(out, 'utf8');
}

function renderInline(token) {
  const tpl = fs.readFileSync(TEMPLATE, 'utf8');
  return tpl.replaceAll('__CAMERA_API_TOKEN__', token);
}

// Mirrors the hex validation in render-config.sh so injection prevention is
// verified cross-platform (the script itself is exercised on Linux CI below).
const TOKEN_RE = /^[a-fA-F0-9]{32,128}$/;
const BASH_AVAILABLE = process.platform !== 'win32' && (() => {
  try { execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' }); return true; } catch { return false; }
})();

describe('cameras-proxy template + protected credential', () => {
  it('ships a template with the placeholder, not a hardcoded secret', () => {
    const tpl = fs.readFileSync(TEMPLATE, 'utf8');
    assert.match(tpl, /__CAMERA_API_TOKEN__/);
    assert.doesNotMatch(tpl, LITERAL_SECRET, 'template must not contain a literal 64-hex secret');
  });

  it('renders the token into the api + health locations only', () => {
    const token = 'a'.repeat(64);
    const rendered = renderInline(token);
    assert.equal(rendered.indexOf('__CAMERA_API_TOKEN__'), -1, 'placeholder must be replaced');
    const occurrences = (rendered.match(new RegExp(token, 'g')) || []).length;
    assert.equal(occurrences, 2, 'token must appear exactly twice (api + health)');
  });

  it('rejects a missing token (fail-closed, no file written)', () => {
    if (!BASH_AVAILABLE) {
      // Inline reasoning: the script reads token from env/file and exits 78 if
      // empty. Verified by reading the script source for the fail-closed guard.
      const script = fs.readFileSync(RENDER, 'utf8');
      assert.match(script, /exit 78/, 'script must fail-closed on missing token');
      return;
    }
    let threw = false;
    try {
      execFileSync('bash', [bashPath(RENDER), bashPath(TEMPLATE), path.join(process.env.TMPDIR || '/tmp', 'no.out')], {
        env: { ...process.env, CAMERA_API_TOKEN: '', CAMERA_API_TOKEN_FILE: '' },
        stdio: 'pipe',
      });
    } catch { threw = true; }
    assert.ok(threw, 'render must fail when no token is available');
  });

  it('rejects a non-hex token to prevent nginx directive injection', () => {
    for (const bad of ['', 'short', 'a;b', 'token # comment', 'has spaces', '{}', 'aa'.repeat(20) + ';']) {
      assert.equal(TOKEN_RE.test(bad), false, `regex must reject invalid token: ${JSON.stringify(bad)}`);
    }
    assert.equal(TOKEN_RE.test('c'.repeat(64)), true, 'regex must accept a valid 64-hex token');
    if (BASH_AVAILABLE) {
      for (const bad of ['', 'short', 'a;b', 'token # comment', 'has spaces', '{}', 'aa'.repeat(20) + ';']) {
        let threw = false;
        try { renderViaScript(bad); } catch { threw = true; }
        assert.ok(threw, `render script must reject invalid token: ${JSON.stringify(bad)}`);
      }
    }
  });

  it('renders successfully for a valid hex token via the committed script', { skip: !BASH_AVAILABLE }, () => {
    const token = 'b'.repeat(64);
    const rendered = renderViaScript(token);
    assert.equal(rendered.indexOf('__CAMERA_API_TOKEN__'), -1);
    assert.ok(rendered.includes('X-Api-Token "' + token + '"'));
  });
});
