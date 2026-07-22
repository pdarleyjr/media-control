// Normalized, revision-aware store for the authoritative room contract.
// It is deliberately transport-agnostic: socket.js owns reconnection and asks
// for a full snapshot whenever applyDelta reports a gap.

function isNonNegativeInteger(value) {
  return Number.isInteger(Number(value)) && Number(value) >= 0;
}

function validSnapshot(value) {
  return !!value
    && typeof value === 'object'
    && Number(value.schemaVersion) === 1
    && typeof value.workspaceId === 'string'
    && value.workspaceId.length > 0
    && typeof value.roomId === 'string'
    && value.roomId.length > 0
    && isNonNegativeInteger(value.revision)
    && value.confirmedState
    && typeof value.confirmedState === 'object';
}

export function createRoomStateStore(options = {}) {
  const onGap = typeof options.onGap === 'function' ? options.onGap : () => {};
  const subscribers = new Set();
  let current = null;
  let displaysById = new Map();
  let identity = null;

  function index(snapshot) {
    const displays = Array.isArray(snapshot?.confirmedState?.displays)
      ? snapshot.confirmedState.displays
      : [];
    displaysById = new Map(
      displays
        .filter((display) => display && typeof display.id === 'string')
        .map((display) => [display.id, display]),
    );
  }

  function notify() {
    for (const subscriber of subscribers) subscriber(current);
  }

  function applySnapshot(snapshot) {
    if (!validSnapshot(snapshot)) {
      return { applied: false, reason: 'invalid_snapshot', revision: current?.revision ?? 0 };
    }
    const revision = Number(snapshot.revision);
    const nextIdentity = `${snapshot.workspaceId}\u0000${snapshot.roomId}`;
    if (identity && nextIdentity !== identity) {
      return { applied: false, reason: 'identity_mismatch', revision: current?.revision ?? 0 };
    }
    if (current && revision < current.revision) {
      return { applied: false, reason: 'stale_revision', revision: current.revision };
    }
    if (current && revision === current.revision) {
      // A force-refresh snapshot can legitimately carry the same state
      // revision with a newer server timestamp. Accept it so a picker can prove
      // that its topology was re-read immediately before operator selection.
      if (!(Number(snapshot.serverTimestamp) > Number(current.serverTimestamp))) {
        return { applied: false, reason: 'duplicate_revision', revision: current.revision };
      }
    }
    identity = nextIdentity;
    current = { ...snapshot, revision };
    index(current);
    notify();
    return { applied: true, revision };
  }

  function applyDelta(delta) {
    if (!current || !delta || typeof delta !== 'object' || !isNonNegativeInteger(delta.revision)) {
      const recovery = { expectedRevision: current ? current.revision + 1 : null, receivedRevision: Number(delta?.revision) || null };
      onGap(recovery);
      return { applied: false, reason: 'snapshot_required', revision: current?.revision ?? 0 };
    }
    if (delta.workspaceId !== current.workspaceId || delta.roomId !== current.roomId) {
      return { applied: false, reason: 'identity_mismatch', revision: current.revision };
    }
    const receivedRevision = Number(delta.revision);
    if (receivedRevision <= current.revision) {
      return { applied: false, reason: 'stale_revision', revision: current.revision };
    }
    const expectedRevision = current.revision + 1;
    if (receivedRevision !== expectedRevision) {
      const gap = { expectedRevision, receivedRevision };
      onGap(gap);
      return { applied: false, reason: 'revision_gap', ...gap };
    }
    const patch = delta.patch && typeof delta.patch === 'object' ? delta.patch : {};
    current = { ...current, ...patch, revision: receivedRevision };
    index(current);
    notify();
    return { applied: true, revision: receivedRevision };
  }

  return {
    applySnapshot,
    applyDelta,
    getSnapshot: () => current,
    getRevision: () => current?.revision ?? 0,
    getDisplay: (id) => displaysById.get(id) || null,
    getDisplays: () => [...displaysById.values()],
    subscribe(callback) {
      if (typeof callback !== 'function') return () => {};
      subscribers.add(callback);
      return () => subscribers.delete(callback);
    },
    reset() {
      current = null;
      identity = null;
      displaysById = new Map();
      notify();
    },
  };
}
