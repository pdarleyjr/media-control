// Authoritative operator-console state store.
//
// This is a DERIVED, normalized projection sitting ABOVE the baseline
// room-state store (frontend/js/services/room-state-store.js, exported as
// `roomState` from frontend/js/socket.js). It does NOT open a second Socket.IO
// connection and does NOT hold a competing source of truth. It subscribes to
// the shared room store + the existing command-ack/state-sync events and
// re-projects them into the operator-facing vocabulary defined in
// operator-state.js.
//
// Responsibilities (per task §5):
//  - represent schema version, workspace, room, revision, server timestamp
//  - display topology, device health, confirmed/pending layout & content
//  - playback / ppt / video / screen-share / camera / livestream / recording
//  - command acknowledgments, errors, stale state
//  - newer revisions replace older; duplicates idempotent; older rejected
//  - revision gaps request a complete snapshot (delegated to room store)
//  - reconnect replaces stale local state (room store reset propagates)
//  - pending commands remain visibly pending until acknowledged
//  - failed commands never appear confirmed
//  - another user's changes update every open controller (shared store)

import {
  OPERATOR_STATE,
  displayOperatorState,
  commandOperatorState,
  productionOperatorState,
  highestState,
} from './operator-state.js';

export const OPERATOR_STORE_SCHEMA_VERSION = 1;

// Default freshness tolerance (ms) before a confirmed surface is labelled STALE
// when no newer snapshot has arrived. Tunable; the podium may lower it.
const DEFAULT_STALE_TOLERANCE_MS = 15000;

function now() { return Date.now(); }

function asArray(value) { return Array.isArray(value) ? value : []; }

// Pending commands keyed by target (display id) for O(1) lookup during render.
function indexPendingCommands(commands) {
  const byTarget = new Map();
  for (const cmd of asArray(commands)) {
    if (!cmd) continue;
    const key = cmd.target_id || cmd.device_id || cmd.targetId || cmd.deviceId;
    if (!key) continue;
    if (!byTarget.has(key)) byTarget.set(key, []);
    byTarget.get(key).push(cmd);
  }
  return byTarget;
}

export function createOperatorStore(options = {}) {
  const roomStore = options.roomStore;
  const staleToleranceMs = options.staleToleranceMs ?? DEFAULT_STALE_TOLERANCE_MS;

  if (!roomStore || typeof roomStore.getSnapshot !== 'function') {
    throw new Error('createOperatorStore requires a roomStore (the shared roomState store)');
  }

  const subscribers = new Set();
  let derived = null;
  let lastSnapshotRev = 0;
  let lastAppliedAt = 0;
  // Locally issued commands awaiting acknowledgment: Map<command_id, {target, type, issuedAt, status}>
  const pendingLocal = new Map();
  let unsubscribeRoom = null;

  function build() {
    const snapshot = roomStore.getSnapshot();
    if (!snapshot) {
      derived = null;
      return;
    }
    const pendingByTarget = indexPendingCommands(snapshot.pendingCommands);
    const confirmedDisplays = asArray(snapshot.confirmedState?.displays);
    const deviceDisplays = asArray(snapshot.deviceStates?.displays);
    const walls = asArray(snapshot.layoutState?.walls);
    const groups = asArray(snapshot.layoutState?.groups);

    const deviceById = new Map(deviceDisplays.filter(Boolean).map((d) => [d.id, d]));

    const displays = confirmedDisplays.filter(Boolean).map((row) => {
      const device = deviceById.get(row.id) || {};
      const online = row.status != null
        ? row.status === 'online'
        : (device.status === 'online' || row.online === true);
      const pending = pendingByTarget.get(row.id) || [];
      const localPending = [...pending];
      for (const [, entry] of pendingLocal) {
        if (entry.target === row.id) localPending.push({ status: entry.status, command_id: entry.commandId });
      }
      const opState = displayOperatorState({ ...row, ...device }, localPending);
      return {
        id: row.id,
        name: row.name || device.name || row.id,
        order: row.order ?? device.order ?? null,
        online,
        screenOn: device.screenOn ?? row.screenOn ?? null,
        wallId: row.wallId ?? device.wallId ?? row.wall_id ?? null,
        layoutId: row.layoutId ?? device.layoutId ?? row.layout_id ?? null,
        contentId: row.contentId ?? row.content_id ?? null,
        contentType: row.contentType ?? null,
        mediaTitle: row.mediaTitle ?? row.media_title ?? null,
        paused: row.paused ?? null,
        slideIndex: row.slideIndex ?? null,
        slideCount: row.slideCount ?? null,
        currentTime: row.currentTime ?? null,
        duration: row.duration ?? null,
        opState,
        pending: localPending,
      };
    });

    const topology = walls.map((wall) => ({
      id: wall.id,
      name: wall.name,
      mode: wall.layoutMode ?? wall.layout_mode ?? null,
      layoutRevision: wall.layoutRevision ?? wall.layout_revision ?? null,
      preset: wall.preset ?? null,
      memberIds: asArray(wall.memberIds).length ? wall.memberIds : asArray(wall.members).map((m) => m.id || m.deviceId),
      members: asArray(wall.members),
    }));

    const deviceHealth = {
      total: displays.length,
      online: displays.filter((d) => d.online).length,
      offline: displays.filter((d) => !d.online).length,
      stale: displays.filter((d) => d.opState === OPERATOR_STATE.STALE).length,
      failed: displays.filter((d) => d.opState === OPERATOR_STATE.FAILED).length,
    };

    const pendingCommands = asArray(snapshot.pendingCommands).map((cmd) => ({
      commandId: cmd.command_id || cmd.id,
      target: cmd.target_id || cmd.device_id,
      type: cmd.command_type || cmd.type,
      status: cmd.status,
      opState: commandOperatorState(cmd),
      issuedAt: cmd.created_at || cmd.issuedAt,
    }));

    const recording = snapshot.recordingState
      ? { ...snapshot.recordingState, opState: productionOperatorState(snapshot.recordingState) }
      : null;
    const stream = snapshot.streamState
      ? { ...snapshot.streamState, opState: productionOperatorState(snapshot.streamState) }
      : null;
    const livestream = snapshot.livestreamProgram
      ? {
          id: snapshot.livestreamProgram.id,
          active: snapshot.livestreamProgram.content_active ?? snapshot.livestreamProgram.contentActive,
          opState: productionOperatorState({
            active: snapshot.livestreamProgram.content_active ?? snapshot.livestreamProgram.contentActive,
            reachable: true,
            stale: false,
          }),
        }
      : null;

    const classroomProgram = snapshot.classroomProgram
      ? { targets: asArray(snapshot.classroomProgram.targets) }
      : null;

    const aggregateState = highestState([
      ...displays.map((d) => d.opState),
      recording?.opState,
      stream?.opState,
      livestream?.opState,
    ].filter(Boolean));

    const stale = derivedStale(snapshot, staleToleranceMs);

    derived = {
      schemaVersion: OPERATOR_STORE_SCHEMA_VERSION,
      workspace: snapshot.workspaceId,
      room: snapshot.roomId,
      revision: snapshot.revision,
      serverTimestamp: snapshot.serverTimestamp,
      appliedAt: lastAppliedAt,
      aggregateState,
      stale,
      displays,
      topology,
      groups,
      deviceHealth,
      pendingCommands,
      recording,
      stream,
      livestream,
      classroomProgram,
      localPendingCount: pendingLocal.size,
    };
  }

  function derivedStale(snapshot, tolerance) {
    if (!snapshot?.serverTimestamp) return false;
    const age = now() - Number(snapshot.serverTimestamp);
    return Number.isFinite(age) && age > tolerance;
  }

  function notify() {
    const snapshot = derived;
    for (const cb of subscribers) cb(snapshot);
  }

  function rebuild() {
    build();
    notify();
  }

  // Wire to the shared room store. Idempotent: calling again no-ops.
  function connect() {
    if (unsubscribeRoom) return;
    if (typeof roomStore.subscribe === 'function') {
      unsubscribeRoom = roomStore.subscribe(() => rebuild());
    }
    build();
  }

  function disconnect() {
    if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
  }

  return {
    schemaVersion: OPERATOR_STORE_SCHEMA_VERSION,
    connect,
    disconnect,

    // The current derived projection. Returns null until the room store has a
    // snapshot; callers render a loading/STANDBY state.
    get: () => derived,

    subscribe(callback) {
      if (typeof callback !== 'function') return () => {};
      subscribers.add(callback);
      if (derived) callback(derived);
      return () => subscribers.delete(callback);
    },

    // Track a locally-issued command so it stays visibly PENDING/REQUESTED
    // until the matching command:ack or state-sync arrives. Idempotent on
    // commandId. The room store will eventually mirror it in pendingCommands.
    trackLocalCommand({ commandId, target, type }) {
      if (!commandId) return;
      pendingLocal.set(commandId, { commandId, target, type, status: 'sent', issuedAt: now() });
      rebuild();
    },

    resolveLocalCommand(commandId, ack) {
      if (!commandId || !pendingLocal.has(commandId)) return;
      const entry = pendingLocal.get(commandId);
      entry.status = ack?.ok === false || ack?.status === 'failed' ? 'failed'
        : ack?.status === 'timeout' ? 'timeout'
        : 'acked';
      // Keep the resolved entry briefly so the UI can show CONFIRMED/FAILED,
      // then drop it so the authoritative pendingCommands slice wins.
      setTimeout(() => { pendingLocal.delete(commandId); rebuild(); }, 2500);
      rebuild();
    },

    // Force a re-derivation (e.g. after a manual snapshot request).
    refresh() { build(); notify(); },
  };
}
