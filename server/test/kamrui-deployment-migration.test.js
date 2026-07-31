'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const edgeRoot = path.join(__dirname, '..', '..', 'kamrui-media-edge');

function readScript(name) {
  return fs.readFileSync(path.join(edgeRoot, 'scripts', name), 'utf8');
}

function assertDedicatedUserMigration(script, name) {
  const userBlock = script.indexOf('if ! getent passwd mbfd-camera-api');
  const relativeUserBlockEnd = /\n\s*fi/.exec(script.slice(userBlock))?.index ?? -1;
  const userBlockEnd = relativeUserBlockEnd < 0 ? -1 : userBlock + relativeUserBlockEnd;
  const membership = script.indexOf('sudo usermod -aG mbfd-recording mbfd-camera-api');

  assert.ok(userBlock >= 0, `${name} must create the dedicated camera API user`);
  assert.ok(userBlockEnd > userBlock, `${name} must close the user creation block`);
  assert.ok(
    membership > userBlockEnd,
    `${name} must enforce mbfd-recording membership even when the user already exists`,
  );

  assert.match(script, /sudo chown root:mbfd-camera-api "\$ENV_FILE"/);
  assert.match(script, /sudo chmod 0640 "\$ENV_FILE"/);
  assert.doesNotMatch(
    script,
    /(?:cat|tee)[^\n]*"\$ENV_FILE"/,
    `${name} must never print or copy the protected environment through stdout`,
  );
  assert.doesNotMatch(script, /(?:^|[;\s])\.\s+"\$ENV_FILE"/m);
  assert.match(
    script,
    /sudo \/usr\/bin\/python3 "\$HERE\/scripts\/render-mediamtx-config\.py"/,
  );

  assert.match(script, /RECORDING_ROOT=\/mnt\/data\/recordings/);
  assert.match(script, /RECORDING_PARENT="\$\(dirname "\$RECORDING_ROOT"\)"/);
  assert.match(
    script,
    /sudo setfacl -m u:mbfd-camera-api:--x,g:mbfd-recording:--x "\$RECORDING_PARENT"/,
    `${name} must grant only traversal through the dedicated data mount`,
  );
  assert.match(
    script,
    /find "\$RECORDING_ROOT" -xdev -type d[\s\S]*chgrp mbfd-recording[\s\S]*chmod u\+rwx,g\+rwx,g\+s/,
  );
  assert.match(
    script,
    /find "\$RECORDING_ROOT" -xdev -type f[\s\S]*chgrp mbfd-recording[\s\S]*chmod u\+rw,g\+rw/,
  );
  assert.doesNotMatch(
    script,
    /(?:rm\s+-[^\n]*|find[^\n]*-delete)[^\n]*\$RECORDING_ROOT/,
    `${name} must preserve every existing recording artifact`,
  );
}

test('Kamrui install and upgrade safely migrate legacy service ownership and recording data', () => {
  const install = readScript('install.sh');
  const upgrade = readScript('upgrade.sh');

  assertDedicatedUserMigration(install, 'install.sh');
  assertDedicatedUserMigration(upgrade, 'upgrade.sh');

  assert.match(
    upgrade,
    /sudo sed -E 's\/=\.\*\/=<redacted>\/' "\$ENV_FILE"/,
    'status must still work after camera.env becomes root-owned',
  );
});

test('Linux deployment artifacts are exported with LF line endings', () => {
  const attributes = fs.readFileSync(path.join(edgeRoot, '..', '.gitattributes'), 'utf8');
  const helper = fs.readFileSync(path.join(edgeRoot, 'mbfd-media-admin'), 'utf8');

  for (const rule of [
    '*.service text eol=lf',
    '*.socket text eol=lf',
    '*.conf text eol=lf',
    '*.yml text eol=lf',
    '*.tpl text eol=lf',
    '*.py text eol=lf',
    'kamrui-media-edge/mbfd-media-admin text eol=lf',
  ]) {
    assert.ok(attributes.includes(rule), `missing export rule: ${rule}`);
  }
  assert.doesNotMatch(helper, /\r/);
});

test('MediaMTX renderer writes secrets only to the protected destination', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-mediamtx-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, 'camera.env');
  const templatePath = path.join(root, 'mediamtx.yml.tpl');
  const outputPath = path.join(root, 'mediamtx.yml');
  const cameraSecret = 'rtsp://camera-user:camera-secret@example.invalid/main';
  const guestSecret = 'rtsp://guest-user:guest-secret@example.invalid/main';
  fs.writeFileSync(
    envPath,
    `ANPVIZ_RTSP_URL=${cameraSecret}\nZOWIEBOX_RTSP_URL=${guestSecret}\n`,
  );
  fs.writeFileSync(
    templatePath,
    'camera: __ANPVIZ_RTSP_URL__\nguest: __ZOWIEBOX_RTSP_URL__\n',
  );

  const python = process.platform === 'win32' ? 'python' : 'python3';
  const rendered = spawnSync(python, [
    path.join(edgeRoot, 'scripts', 'render-mediamtx-config.py'),
    envPath,
    templatePath,
    outputPath,
  ], { encoding: 'utf8' });

  assert.equal(rendered.status, 0, rendered.stderr);
  assert.equal(rendered.stdout, '');
  assert.equal(rendered.stderr, '');
  assert.equal(
    fs.readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n'),
    `camera: ${cameraSecret}\nguest: ${guestSecret}\n`,
  );
});
