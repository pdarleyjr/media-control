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

test('MediaMTX renderer renders the complete security topology without emitting credentials', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-mediamtx-render-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const envPath = path.join(root, 'camera.env');
  const templatePath = path.join(edgeRoot, 'mediamtx.yml.tpl');
  const outputPath = path.join(root, 'mediamtx.yml');
  const anpvizRtspUrl = 'rtsp://anpviz-test:anpviz-test-password@192.0.2.10:554/Streaming/Channels/101';
  const zowieboxRtspUrl = 'rtsp://zowiebox-test:zowiebox-test-password@198.51.100.10:554/main/av';
  const kamruiLanIp = '192.0.2.20';
  const kamruiTailscaleIp = '198.51.100.20';
  const p3PublisherLanIp = '192.0.2.30';
  const p3PublisherTailscaleIp = '198.51.100.30';
  const guestPublisherLanIp = '203.0.113.40';
  const guestPublisherUser = 'fixture-guest-obs';
  const guestPublisherPasswordHash = 'sha256:5ouY7uMmer2LsXqwy6C8hnjV3oTbxPjE8RAsagW4mXE=';
  fs.writeFileSync(
    envPath,
    [
      `ANPVIZ_RTSP_URL=${anpvizRtspUrl}`,
      `ZOWIEBOX_RTSP_URL=${zowieboxRtspUrl}`,
      `KAMRUI_LAN_IP=${kamruiLanIp}`,
      `KAMRUI_TAILSCALE_IP=${kamruiTailscaleIp}`,
      `P3_PUBLISHER_LAN_IP=${p3PublisherLanIp}`,
      `P3_PUBLISHER_TAILSCALE_IP=${p3PublisherTailscaleIp}`,
      `GUEST_RTMP_PUBLISHER_LAN_IP=${guestPublisherLanIp}`,
      `GUEST_RTMP_PUBLISHER_USER=${guestPublisherUser}`,
      `GUEST_RTMP_PUBLISHER_PASSWORD_HASH=${guestPublisherPasswordHash}`,
      '',
    ].join('\n'),
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
  const renderedConfig = fs.readFileSync(outputPath, 'utf8').replace(/\r\n/g, '\n');
  assert.ok(
    renderedConfig.includes(`source: ${JSON.stringify(anpvizRtspUrl)}`),
    'renders the Anpviz RTSP source',
  );
  assert.ok(
    renderedConfig.includes(`source: ${JSON.stringify(zowieboxRtspUrl)}`),
    'renders the ZowieBox RTSP source',
  );
  assert.ok(
    renderedConfig.includes(`rtmpAddress: ${JSON.stringify(`${kamruiLanIp}:1935`)}`),
    'renders the KAMRUI LAN-only RTMP listener',
  );
  assert.ok(
    renderedConfig.includes(
      `webrtcAdditionalHosts: [${JSON.stringify(kamruiLanIp)}, ${JSON.stringify(kamruiTailscaleIp)}]`,
    ),
    'renders the KAMRUI LAN and Tailscale WebRTC hosts',
  );

  const authSection = renderedConfig.slice(
    renderedConfig.indexOf('authInternalUsers:'),
    renderedConfig.indexOf('\npaths:'),
  );
  const publisherPaths = (marker, label) => {
    const start = authSection.indexOf(marker);
    assert.ok(start >= 0, `${label} publisher restriction must be rendered`);
    const end = authSection.indexOf('\n  - user:', start + 1);
    const publisherBlock = authSection.slice(start, end === -1 ? authSection.length : end);
    return [...publisherBlock.matchAll(/^\s+path: (.+)$/gm)].map((match) => match[1]);
  };

  const p3PublisherMarker = [
    '  - user: any',
    '    pass:',
    `    ips: [${JSON.stringify(p3PublisherLanIp)}, ${JSON.stringify(p3PublisherTailscaleIp)}]`,
    '    permissions:',
    '      - action: publish',
    '        path: anpviz-main',
  ].join('\n');
  assert.deepEqual(
    publisherPaths(p3PublisherMarker, 'P3'),
    ['anpviz-main'],
    'P3 can publish only the existing Anpviz path',
  );

  const guestPublisherMarker = [
    `  - user: ${JSON.stringify(guestPublisherUser)}`,
    `    pass: ${JSON.stringify(guestPublisherPasswordHash)}`,
    `    ips: [${JSON.stringify(guestPublisherLanIp)}]`,
    '    permissions:',
    '      - action: publish',
    '        path: guest-computer',
  ].join('\n');
  assert.deepEqual(
    publisherPaths(guestPublisherMarker, 'guest'),
    ['guest-computer'],
    'the guest publisher can publish only guest-computer',
  );

  assert.ok(
    renderedConfig.includes([
      '  podium-computer:',
      `    source: ${JSON.stringify(zowieboxRtspUrl)}`,
      '    rtspTransport: tcp',
    ].join('\n')),
    'podium-computer remains the ZowieBox RTSP source',
  );
  assert.ok(
    renderedConfig.includes([
      '  guest-computer:',
      '    source: publisher',
      '    overridePublisher: false',
    ].join('\n')),
    'guest-computer remains publisher-backed',
  );
  assert.doesNotMatch(renderedConfig, /__[A-Z0-9_]+__/);
});
