const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('console session waits for a real DRM output and stops Cage after disconnect', () => {
  const session = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'cage', 'mbfd-console-session.sh'),
    'utf8'
  );
  const service = fs.readFileSync(
    path.join(__dirname, '..', 'deploy', 'systemd', 'mbfd-console.service'),
    'utf8'
  );

  assert.match(session, /grep -qs '\^connected\$' \/sys\/class\/drm\/card\*-\*\/status/);
  assert.match(session, /until display_connected/);
  assert.match(session, /stop_cage/);
  assert.match(session, /cage_running\(\)\s*\{/);
  assert.match(session, /\/proc\/\$\{cage_pid\}\/stat/);
  assert.match(session, /!= "Z"/);
  assert.match(session, /while cage_running/);
  assert.match(service, /ExecStart=\/opt\/mbfd\/media-control-console\/mbfd-console-session\.sh/);
});

test('console prefers LAN, records health, and recovers only its own renderer', () => {
  const main = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'console-linux', 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(main, /MBFD_CONSOLE_URLS/);
  assert.match(main, /192\.168\.1\.116:8096\/console\/classroom-1/);
  assert.match(main, /100\.81\.154\.123:8096\/console\/classroom-1/);
  assert.match(main, /function selectReachableConsoleUrl/);
  assert.match(main, /console-health\.json/);
  assert.match(main, /app\.getAppMetrics\(\)/);
  assert.match(main, /mainWindow\.on\('unresponsive'/);
  assert.match(main, /mainWindow\.on\('responsive'/);
  assert.match(main, /recoverConsoleWindow/);
  assert.match(main, /backgroundThrottling: true/);
  assert.doesNotMatch(main, /fs\.appendFileSync/);
  assert.ok(main.indexOf("app.commandLine.appendSwitch('disable-pinch')") < main.indexOf('app.whenReady()'));
});

test('console grants user-initiated screen capture only to trusted console origins', () => {
  const main = fs.readFileSync(
    path.join(__dirname, '..', 'apps', 'console-linux', 'src', 'main', 'main.ts'),
    'utf8'
  );

  assert.match(main, /desktopCapturer/);
  assert.match(main, /unsafely-treat-insecure-origin-as-secure/);
  assert.match(main, /setDisplayMediaRequestHandler/);
  assert.match(main, /request\.userGesture/);
  assert.match(main, /isAllowedUrl\(request\.securityOrigin\)/);
  assert.match(main, /callback\(\{ video: source/);
  assert.match(main, /permission === 'display-capture'/);
});

test('podium agent exposes bounded hardware and storage diagnostics without inventing SMART results', () => {
  const agent = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'podium-agent', 'src', 'index.ts'),
    'utf8'
  );

  assert.match(agent, /async function systemDiagnosticsPayload/);
  assert.match(agent, /fs\.statfsSync/);
  assert.match(agent, /\/proc\/pressure\/cpu/);
  assert.match(agent, /smartctl/);
  assert.match(agent, /available: false/);
  assert.match(agent, /journalctl/);
  assert.match(agent, /\/diagnostics\/system/);
  assert.match(agent, /console-health\.json/);
  assert.match(agent, /\.config\/@mbfd\/console-linux\/console-health\.json/);
  assert.match(agent, /'lsblk', \['-J', '-e', '7'/);
  assert.doesNotMatch(agent, /fs\.appendFileSync/);
});
