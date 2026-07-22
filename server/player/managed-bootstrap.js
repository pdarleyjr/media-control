(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.MbfdPlayerBootstrap = api;
}(typeof window !== 'undefined' ? window : this, function () {
  'use strict';

  function normalizeHttpOrigin(value) {
    var input = String(value || '').trim();
    if (!input) return '';
    try {
      if (typeof URL === 'function') {
        var parsed = new URL(input);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
        return parsed.origin.replace(/\/$/, '');
      }
    } catch (error) {
      // Fall through to the ES5 parser for older embedded signage browsers.
    }
    var match = input.match(/^(https?):\/\/([^\/?#]+)/i);
    return match ? (match[1].toLowerCase() + '://' + match[2]) : '';
  }

  function resolveManagedServerUrl(options) {
    var input = options || {};
    var managed = input.managed || {};
    var pageOrigin = normalizeHttpOrigin(input.pageOrigin);
    var configured = normalizeHttpOrigin(managed.serverUrl);

    // OBS and Media Control run on the same GMKtec host. Its managed player
    // must retain the explicit loopback/LAN address even when the HTML itself
    // was reached through an HTTPS tunnel; otherwise all content and Socket.IO
    // traffic silently detours through the public edge.
    if (managed.connectionScope === 'obs-same-host' && configured) return configured;

    // Ordinary managed displays reached over HTTPS should keep same-origin
    // control and asset URLs. Direct HTTP/LAN displays may use their configured
    // appliance URL.
    if (/^https:/i.test(pageOrigin)) return pageOrigin;
    return configured || pageOrigin;
  }

  var ROOM_SNAPSHOT_FIELDS = [
    'schemaVersion', 'workspaceId', 'roomId', 'revision', 'serverTimestamp',
    'confirmedState', 'pendingCommands', 'lastCommandId', 'deviceStates',
    'layoutState', 'classroomProgram', 'livestreamProgram', 'recordingState',
    'streamState',
  ];

  function validateRoomSnapshot(snapshot, expected) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
      return { ok: false, code: 'INCOMPLETE_SNAPSHOT', message: 'Room snapshot is missing' };
    }
    for (var i = 0; i < ROOM_SNAPSHOT_FIELDS.length; i += 1) {
      var field = ROOM_SNAPSHOT_FIELDS[i];
      if (!Object.prototype.hasOwnProperty.call(snapshot, field) || snapshot[field] === undefined) {
        return { ok: false, code: 'INCOMPLETE_SNAPSHOT', message: 'Room snapshot is missing ' + field };
      }
    }
    var intended = expected || {};
    if (intended.workspaceId && snapshot.workspaceId !== intended.workspaceId) {
      return { ok: false, code: 'WORKSPACE_MISMATCH', message: 'Room snapshot workspace mismatch' };
    }
    if (intended.roomId && snapshot.roomId !== intended.roomId) {
      return { ok: false, code: 'ROOM_MISMATCH', message: 'Room snapshot classroom mismatch' };
    }
    if (!Number.isFinite(Number(snapshot.revision)) || !Number.isFinite(Number(snapshot.serverTimestamp))) {
      return { ok: false, code: 'INVALID_SNAPSHOT_CURSOR', message: 'Room snapshot cursor is invalid' };
    }
    return { ok: true };
  }

  function createReceiverHealth(options) {
    var input = options || {};
    var now = typeof input.now === 'function' ? input.now : Date.now;
    var staleAfterMs = Math.max(1000, Number(input.staleAfterMs) || 20000);
    var state = {
      state: 'connecting',
      code: null,
      message: 'Connecting to Media Control',
      workspaceId: input.workspaceId || null,
      roomId: input.roomId || null,
      revision: null,
      serverTimestamp: null,
      lastSnapshotAt: null,
      updatedAt: now(),
    };

    function report() {
      var copy = {};
      Object.keys(state).forEach(function (key) { copy[key] = state[key]; });
      return copy;
    }

    function publish() {
      var current = report();
      if (typeof input.onChange === 'function') input.onChange(current);
      return current;
    }

    function transition(nextState, message, code) {
      state.state = nextState;
      state.message = message || nextState;
      state.code = code || null;
      state.updatedAt = now();
      return publish();
    }

    function acceptSnapshot(snapshot) {
      var validation = validateRoomSnapshot(snapshot, {
        workspaceId: input.workspaceId,
        roomId: input.roomId,
      });
      if (!validation.ok) return transition('error', validation.message, validation.code);
      state.revision = Number(snapshot.revision);
      state.serverTimestamp = Number(snapshot.serverTimestamp);
      state.lastSnapshotAt = now();
      return transition('connected', 'Connected to authoritative room state', null);
    }

    function checkFreshness() {
      if (state.lastSnapshotAt == null || now() - state.lastSnapshotAt > staleAfterMs) {
        return transition('stale', 'Room state is stale', 'ROOM_SNAPSHOT_STALE');
      }
      return report();
    }

    return {
      acceptSnapshot: acceptSnapshot,
      checkFreshness: checkFreshness,
      markConnecting: function (message) { return transition('connecting', message || 'Connecting to Media Control'); },
      markError: function (message, code) { return transition('error', message || 'Media Control receiver error', code || 'RECEIVER_ERROR'); },
      markStale: function (message) { return transition('stale', message || 'Media Control connection is stale', 'RECEIVER_STALE'); },
      report: report,
    };
  }

  return {
    createReceiverHealth: createReceiverHealth,
    normalizeHttpOrigin: normalizeHttpOrigin,
    resolveManagedServerUrl: resolveManagedServerUrl,
    validateRoomSnapshot: validateRoomSnapshot,
  };
}));
