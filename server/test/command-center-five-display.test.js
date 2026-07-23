import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VIEW_MODE,
  buildBroadcastSelection,
  buildRoomBroadcastSelection,
  createCommandCenterState,
  enterFocusView,
  setBroadcastTargets,
  setControlTarget,
  showRoomOverview,
} from '../../frontend/js/services/command-center-state.js';
import { createScreenshotPoller } from '../../frontend/js/services/screenshot-poll.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function read(...parts) {
  return fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');
}

function classroomCatalog() {
  const displays = [
    { type: 'display', id: 'front-left', name: 'Front Left', online: true },
    { type: 'display', id: 'front-center', name: 'Front Center', online: true },
    { type: 'display', id: 'front-right', name: 'Front Right', online: true },
    { type: 'display', id: 'side-left', name: 'Side Left', online: true },
    { type: 'display', id: 'side-right', name: 'Side Right', online: true },
  ];
  const frontMembers = displays.slice(0, 3);
  const sideMembers = displays.slice(3);
  const front = {
    type: 'wall',
    id: 'front-wall',
    name: 'Front Wall',
    layoutRevision: 97,
    memberIds: frontMembers.map((display) => display.id),
    members: frontMembers,
  };
  const side = {
    type: 'wall',
    id: 'side-wall',
    name: 'Side Wall',
    layoutRevision: 4,
    memberIds: sideMembers.map((display) => display.id),
    members: sideMembers,
  };
  const frontSpan = {
    type: 'wall-group',
    id: 'front-wall:front-span',
    wallId: front.id,
    groupId: 'front-span',
    layoutRevision: front.layoutRevision,
    memberIds: ['front-center', 'front-right'],
    members: frontMembers.slice(1),
  };
  return {
    walls: [front, side],
    wallGroups: [frontSpan],
    groups: [],
    displays,
    standaloneDisplays: [],
  };
}

describe('Command Center state separation', () => {
  it('defaults to Room Overview without a focused or control target', () => {
    const state = createCommandCenterState();
    assert.equal(state.viewMode, VIEW_MODE.OVERVIEW);
    assert.equal(state.focusedViewTarget, null);
    assert.equal(state.controlTarget, null);
    assert.deepEqual(state.broadcastTargets, []);
    assert.deepEqual(state.physicalResolvedTargets, []);
  });

  it('changing Focus View never changes broadcast targets', () => {
    const roomSelection = buildRoomBroadcastSelection(classroomCatalog());
    const initial = setBroadcastTargets(createCommandCenterState(), roomSelection);
    const focused = enterFocusView(initial, { type: 'wall', id: 'front-wall' });
    assert.equal(focused.viewMode, VIEW_MODE.FOCUS);
    assert.deepEqual(focused.broadcastTargets, initial.broadcastTargets);
    assert.deepEqual(focused.physicalResolvedTargets, initial.physicalResolvedTargets);
  });

  it('changing the control target never changes broadcast targets', () => {
    const roomSelection = buildRoomBroadcastSelection(classroomCatalog());
    const initial = setBroadcastTargets(createCommandCenterState(), roomSelection);
    const controlled = setControlTarget(initial, { type: 'display', id: 'front-center' });
    assert.deepEqual(controlled.broadcastTargets, initial.broadcastTargets);
    assert.deepEqual(controlled.physicalResolvedTargets, initial.physicalResolvedTargets);
  });

  it('returning to Room Overview clears only view focus', () => {
    const roomSelection = buildRoomBroadcastSelection(classroomCatalog());
    const initial = setControlTarget(
      setBroadcastTargets(createCommandCenterState(), roomSelection),
      { type: 'display', id: 'front-center' },
    );
    const focused = enterFocusView(initial, { type: 'wall', id: 'front-wall' });
    const overview = showRoomOverview(focused);
    assert.equal(overview.viewMode, VIEW_MODE.OVERVIEW);
    assert.equal(overview.focusedViewTarget, null);
    assert.deepEqual(overview.controlTarget, initial.controlTarget);
    assert.deepEqual(overview.broadcastTargets, initial.broadcastTargets);
  });
});

describe('authoritative physical target resolution', () => {
  it('resolves a room-wide broadcast to all five physical classroom players', () => {
    const result = buildRoomBroadcastSelection(classroomCatalog());
    assert.deepEqual(result.broadcastTargets, [
      { type: 'wall', id: 'front-wall', layout_revision: 97 },
      { type: 'wall', id: 'side-wall', layout_revision: 4 },
    ]);
    assert.deepEqual(result.physicalResolvedTargets, [
      'front-left',
      'front-center',
      'front-right',
      'side-left',
      'side-right',
    ]);
  });

  it('resolves Front Wall, Side Wall, one display, and one wall group independently', () => {
    const catalog = classroomCatalog();
    assert.deepEqual(
      buildBroadcastSelection(catalog, [{ type: 'wall', id: 'front-wall' }]).physicalResolvedTargets,
      ['front-left', 'front-center', 'front-right'],
    );
    assert.deepEqual(
      buildBroadcastSelection(catalog, [{ type: 'wall', id: 'side-wall' }]).physicalResolvedTargets,
      ['side-left', 'side-right'],
    );
    assert.deepEqual(
      buildBroadcastSelection(catalog, [{ type: 'display', id: 'front-left' }]).physicalResolvedTargets,
      ['front-left'],
    );
    const group = buildBroadcastSelection(catalog, [{ type: 'wall-group', id: 'front-wall:front-span' }]);
    assert.deepEqual(group.broadcastTargets, [{
      type: 'wall-group',
      id: 'front-wall:front-span',
      wall_id: 'front-wall',
      group_id: 'front-span',
      layout_revision: 97,
    }]);
    assert.deepEqual(group.physicalResolvedTargets, ['front-center', 'front-right']);
  });

  it('keeps a split-region display action isolated to that physical display', () => {
    const result = buildBroadcastSelection(
      classroomCatalog(),
      [{ type: 'display', id: 'front-left' }],
    );
    assert.deepEqual(result.physicalResolvedTargets, ['front-left']);
  });
});

describe('screenshot request lifecycle', () => {
  it('does not complete an in-flight request when a fire-and-forget emit returns', async () => {
    const calls = [];
    const poller = createScreenshotPoller({
      requestTimeoutMs: 1000,
      requestScreenshot: (id, meta) => {
        calls.push({ id, meta });
        return Promise.resolve();
      },
    });
    poller.requestIds(['front-center'], true);
    await Promise.resolve();
    assert.equal(calls.length, 1);
    assert.match(calls[0].meta.correlationId, /^ss-/);
    assert.deepEqual(poller.getState().inFlightIds, ['front-center']);
    poller.markReady('front-center', calls[0].meta.correlationId);
    assert.deepEqual(poller.getState().inFlightIds, []);
    poller.stop();
  });

  it('ignores a mismatched screenshot-ready correlation id', () => {
    let correlationId = '';
    const poller = createScreenshotPoller({
      requestTimeoutMs: 1000,
      requestScreenshot: (_id, meta) => { correlationId = meta.correlationId; },
    });
    poller.requestIds(['front-left'], true);
    poller.markReady('front-left', 'stale-request');
    assert.deepEqual(poller.getState().inFlightIds, ['front-left']);
    poller.markReady('front-left', correlationId);
    assert.deepEqual(poller.getState().inFlightIds, []);
    poller.stop();
  });

  it('clears an explicitly failed request and applies bounded backoff', async () => {
    const poller = createScreenshotPoller({
      minIntervalMs: 100,
      requestTimeoutMs: 1000,
      requestScreenshot: () => Promise.reject(new Error('offline')),
    });
    poller.requestIds(['side-left'], true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const state = poller.getState();
    assert.deepEqual(state.inFlightIds, []);
    assert.ok(state.backoffUntil['side-left'] > Date.now());
    poller.stop();
  });

  it('times out, tears down, and does not duplicate schedulers on restart', async () => {
    const poller = createScreenshotPoller({
      requestTimeoutMs: 15,
      activeIntervalMs: 100000,
      backgroundIntervalMs: 100000,
      requestScreenshot: () => {},
      listVisibleIds: () => [],
    });
    poller.requestIds(['side-right'], true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(poller.getState().inFlightIds, []);
    assert.equal(poller.getState().timeouts, 1);
    poller.start();
    poller.start();
    assert.equal(poller.getState().activeTimerCount, 3);
    poller.stop();
    assert.equal(poller.getState().activeTimerCount, 0);
  });
});

it('wires screenshot-ready and offline transitions to the mounted poller', () => {
  const source = read('frontend', 'js', 'views', 'media-control.js');
  assert.match(source, /socketOn\('screenshot-ready',\s*screenshotReadyHandler\)/);
  assert.match(source, /screenshotPoller\?\.markReady\(data\.device_id,\s*data\.correlation_id\)/);
  assert.match(source, /screenshotPoller\?\.markOffline\(display\.id\)/);
  assert.match(source, /socketOff\('screenshot-ready',\s*screenshotReadyHandler\)/);
});

it('propagates screenshot correlation IDs through dashboard, player, and ready event', () => {
  const socket = read('frontend', 'js', 'socket.js');
  const dashboardSocket = read('server', 'ws', 'dashboardSocket.js');
  const player = read('server', 'player', 'index.html');
  const deviceSocket = read('server', 'ws', 'deviceSocket.js');
  assert.match(socket, /correlation_id:\s*options\.correlationId/);
  assert.match(dashboardSocket, /correlation_id/);
  assert.match(player, /captureAndSend\(data\?\.correlation_id/);
  assert.match(player, /correlation_id:\s*correlationId/);
  assert.match(deviceSocket, /correlation_id/);
});

it('Room Overview renders each physical wall member and split-wall markup has a defined mode', () => {
  const stage = read('frontend', 'js', 'views', 'media-control', 'stage.js');
  assert.match(stage, /overviewMode/);
  assert.match(stage, /showPreview:\s*overviewMode\s*\|\|\s*mode === 'split'/);
  const splitStart = stage.indexOf('function wallSplitGroup');
  const splitEnd = stage.indexOf('// Plus tile', splitStart);
  assert.ok(splitStart >= 0 && splitEnd > splitStart);
  assert.doesNotMatch(stage.slice(splitStart, splitEnd), /\$\{esc\(mode\)\}/);
});

it('Nextcloud routing does not reject a wall-only room before the typed picker opens', () => {
  const toolbox = read('frontend', 'js', 'views', 'media-control', 'toolbox.js');
  assert.match(
    toolbox,
    /typeof onRouteNextcloud !== 'function'\s*&&\s*\(!Array\.isArray\(selectedIds\)\s*\|\|\s*selectedIds\.length === 0\)/,
  );
});
