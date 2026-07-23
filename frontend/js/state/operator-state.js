// Operator state vocabulary for the enterprise Media Control console.
//
// The baseline already ships an authoritative, revision-aware room-state store
// (frontend/js/services/room-state-store.js) and a display projection
// (frontend/js/services/display-state.js). This module does NOT replace either.
// It defines ONE consistent, color-independent, text-backed state vocabulary
// that the operator console uses to render every surface (display, command,
// playback, livestream, camera, recording) identically.
//
// State is derived, never invented: each OPERATOR_STATE maps to concrete
// signals already present in the room contract (confirmedState, pendingCommands,
// deviceStates, recordingState, streamState, livestreamProgram). See
// docs/ui-ux/operator-state-model.md for the full derivation table.

export const OPERATOR_STATE = Object.freeze({
  STANDBY: 'standby',     // no active command; device idle / nothing sent
  REQUESTED: 'requested', // operator just issued a command; not yet acknowledged
  PENDING: 'pending',     // command accepted/delivered, awaiting confirmation
  CONFIRMED: 'confirmed', // device reported state matching the command
  FAILED: 'failed',       // command rejected, timed out, or device reported error
  OFFLINE: 'offline',     // device unreachable; commands may queue but cannot confirm
  STALE: 'stale',         // snapshot revision gap / no confirmation within tolerance
});

export const OPERATOR_STATES = Object.freeze(Object.values(OPERATOR_STATE));

// Stable display order for chips/badges. Each entry: { value, rank, label-key,
// tone, icon }. `tone` is a semantic class (never the only signal) paired with a
// text label and glyph so status is legible without color.
export const OPERATOR_STATE_META = Object.freeze({
  [OPERATOR_STATE.STANDBY]: { rank: 0, labelKey: 'mc.e.op_state.standby', tone: 'idle', glyph: '◯' },
  [OPERATOR_STATE.REQUESTED]: { rank: 1, labelKey: 'mc.e.op_state.requested', tone: 'requested', glyph: '◐' },
  [OPERATOR_STATE.PENDING]: { rank: 2, labelKey: 'mc.e.op_state.pending', tone: 'pending', glyph: '◓' },
  [OPERATOR_STATE.CONFIRMED]: { rank: 3, labelKey: 'mc.e.op_state.confirmed', tone: 'ok', glyph: '●' },
  [OPERATOR_STATE.FAILED]: { rank: 4, labelKey: 'mc.e.op_state.failed', tone: 'error', glyph: '✕' },
  [OPERATOR_STATE.OFFLINE]: { rank: 5, labelKey: 'mc.e.op_state.offline', tone: 'offline', glyph: '⊘' },
  [OPERATOR_STATE.STALE]: { rank: 6, labelKey: 'mc.e.op_state.stale', tone: 'stale', glyph: '◷' },
});

// Higher rank = more attention-worthy. When a surface has multiple signals we
// surface the highest-rank state (e.g. a device is OFFLINE but a prior command
// FAILED → show FAILED only while it is actionable, then OFFLINE).
export function stateRank(state) {
  return OPERATOR_STATE_META[state]?.rank ?? -1;
}

export function highestState(states) {
  if (!Array.isArray(states) || states.length === 0) return OPERATOR_STATE.STANDBY;
  return states.reduce((acc, s) => (stateRank(s) > stateRank(acc) ? s : acc), OPERATOR_STATE.STANDBY);
}

export function isValidState(state) {
  return OPERATOR_STATES.includes(state);
}

// Map a raw display row from the room snapshot to an OPERATOR_STATE.
// Mirrors the confirmed vs pending vs offline derivation documented in
// operator-state-model.md. Pure function; no side effects.
export function displayOperatorState(display, pendingForDisplay = []) {
  if (!display) return OPERATOR_STATE.STANDBY;
  const online = display.status === 'online' || display.online === true;
  if (!online) return OPERATOR_STATE.OFFLINE;

  const pending = Array.isArray(pendingForDisplay) ? pendingForDisplay : [];
  if (pending.some((p) => p.status === 'failed' || p.ok === false)) {
    return OPERATOR_STATE.FAILED;
  }
  if (pending.some((p) => p.status === 'timeout')) {
    return OPERATOR_STATE.STALE;
  }
  if (pending.some((p) => p.status === 'sent' || p.status === 'requested')) {
    // Delivered but not yet confirmed via state-report → pending.
    return OPERATOR_STATE.PENDING;
  }
  if (display.contentId || display.content_id || display.contentType) {
    return OPERATOR_STATE.CONFIRMED;
  }
  return OPERATOR_STATE.STANDBY;
}

// Map a pending command row to its operator state using the command_logs
// status vocabulary the server already emits (sent/acked/timeout/failed).
export function commandOperatorState(command) {
  if (!command) return OPERATOR_STATE.STANDBY;
  const status = String(command.status || command.state || '').toLowerCase();
  if (status === 'failed' || command.ok === false) return OPERATOR_STATE.FAILED;
  if (status === 'timeout') return OPERATOR_STATE.STALE;
  // ack proves RECEIPT only — it is NOT physical confirmation. Map to PENDING
  // (awaiting the player's matching state report). Only an explicit 'confirmed'
  // status (a server-side state-match reconciliation) reaches CONFIRMED.
  if (status === 'confirmed') return OPERATOR_STATE.CONFIRMED;
  if (status === 'acked' || status === 'acknowledged' || status === 'sent' || status === 'requested' || status === 'queued') return OPERATOR_STATE.PENDING;
  return OPERATOR_STATE.STANDBY;
}

// Map a production-state slice (recording/stream) to an operator state.
// Uses the same fields the snapshot exposes (active/reachable/stale/error).
export function productionOperatorState(slice) {
  if (!slice) return OPERATOR_STATE.STANDBY;
  if (slice.error) return OPERATOR_STATE.FAILED;
  if (slice.stale === true) return OPERATOR_STATE.STALE;
  if (slice.active === true) {
    return slice.reachable === false ? OPERATOR_STATE.STALE : OPERATOR_STATE.CONFIRMED;
  }
  if (slice.available === false) return OPERATOR_STATE.OFFLINE;
  return OPERATOR_STATE.STANDBY;
}
