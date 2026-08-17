export const BLANK_STATES = Object.freeze({
  ON: 'ON',
  BLANKED: 'BLANKED',
  MIXED: 'MIXED',
  PENDING_ON: 'PENDING_ON',
  PENDING_BLANK: 'PENDING_BLANK',
  UNKNOWN: 'UNKNOWN',
  PARTIAL_OFFLINE: 'PARTIAL/OFFLINE',
  ERROR: 'ERROR',
});

function displayMap(displays) {
  if (displays instanceof Map) return displays;
  return new Map((Array.isArray(displays) ? displays : []).filter(Boolean).map((entry) => [String(entry.id), entry]));
}

export function deriveBlankState(deviceIds, displays, pending = [], now = Date.now()) {
  const ids = [...new Set((Array.isArray(deviceIds) ? deviceIds : []).filter(Boolean).map(String))];
  const byId = displayMap(displays);
  const relevantPending = (Array.isArray(pending) ? pending : [])
    .filter((entry) => ids.includes(String(entry.deviceId)) && (entry.phase === 'error' || entry.expiresAt > now));
  const members = ids.map((id) => byId.get(id) || null);
  const screenValues = members.map((entry) => (typeof entry?.screen_on === 'boolean' ? entry.screen_on : null));

  if (!ids.length) return { state: BLANK_STATES.UNKNOWN, confirmed: false, ids, members };
  if (relevantPending.some((entry) => entry.phase === 'error')
      || members.some((entry) => entry?.error_state || entry?.errorState)) {
    return { state: BLANK_STATES.ERROR, confirmed: false, ids, members };
  }
  if (members.some((entry) => entry && entry.online === false)) {
    return { state: BLANK_STATES.PARTIAL_OFFLINE, confirmed: false, ids, members };
  }
  if (relevantPending.length) {
    const desired = new Set(relevantPending.map((entry) => entry.desiredScreenOn));
    const state = desired.size === 1 && desired.has(true)
      ? BLANK_STATES.PENDING_ON
      : desired.size === 1 && desired.has(false)
        ? BLANK_STATES.PENDING_BLANK
        : BLANK_STATES.ERROR;
    return { state, confirmed: false, ids, members };
  }
  if (members.some((entry) => !entry) || screenValues.some((value) => value == null)) {
    return { state: BLANK_STATES.UNKNOWN, confirmed: false, ids, members };
  }
  if (screenValues.every(Boolean)) return { state: BLANK_STATES.ON, confirmed: true, ids, members };
  if (screenValues.every((value) => value === false)) return { state: BLANK_STATES.BLANKED, confirmed: true, ids, members };
  return { state: BLANK_STATES.MIXED, confirmed: true, ids, members };
}

export function blankPresentation(state, scope = 'wall') {
  const single = scope === 'display';
  const room = scope === 'room';
  const blankKey = single ? 'mc.blank.action.blank_display' : room ? 'mc.blank.action.blank_room' : 'mc.blank.action.blank_wall';
  const unblankKey = single ? 'mc.blank.action.unblank_display' : room ? 'mc.blank.action.unblank_room' : 'mc.blank.action.unblank_wall';
  if (state === BLANK_STATES.ON) {
    return { statusKey: 'mc.blank.status.on', actionKey: blankKey, desiredScreenOn: false, disabled: false };
  }
  if (state === BLANK_STATES.BLANKED) {
    return { statusKey: 'mc.blank.status.blanked', actionKey: unblankKey, desiredScreenOn: true, disabled: false };
  }
  if (state === BLANK_STATES.PENDING_BLANK) {
    return { statusKey: 'mc.blank.status.blanking', actionKey: 'mc.blank.action.blanking', desiredScreenOn: false, disabled: true };
  }
  if (state === BLANK_STATES.PENDING_ON) {
    return { statusKey: 'mc.blank.status.unblanking', actionKey: 'mc.blank.action.unblanking', desiredScreenOn: true, disabled: true };
  }
  const statusKey = state === BLANK_STATES.MIXED
    ? 'mc.blank.status.mixed'
    : state === BLANK_STATES.PARTIAL_OFFLINE
      ? 'mc.blank.status.partial_offline'
      : state === BLANK_STATES.ERROR
        ? 'mc.blank.status.error'
        : 'mc.blank.status.unknown';
  return { statusKey, actionKey: unblankKey, desiredScreenOn: true, disabled: false };
}

export function createBlankIntentTracker(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
  const entries = new Map();
  let sequence = 0;

  function pending() {
    return [...entries.values()].map((entry) => ({ ...entry }));
  }

  function findByCommand(commandId) {
    for (const entry of entries.values()) {
      if (entry.commandId === commandId) return entry;
    }
    return null;
  }

  function begin(deviceId, commandId, desiredScreenOn) {
    const entry = {
      deviceId: String(deviceId),
      commandId: String(commandId || ''),
      desiredScreenOn: !!desiredScreenOn,
      phase: 'requested',
      sequence: ++sequence,
      startedAt: now(),
      expiresAt: now() + timeoutMs,
      error: null,
    };
    entries.set(entry.deviceId, entry);
    return { ...entry };
  }

  function pendingFor(deviceId) {
    const entry = entries.get(String(deviceId));
    return entry ? { ...entry } : null;
  }

  function markDelivery(commandId, receipt = {}) {
    const entry = findByCommand(String(commandId || ''));
    if (!entry) return false;
    if (!receipt.delivered && !receipt.queued) {
      entry.phase = 'error';
      entry.error = receipt.reason || 'delivery_failed';
      return true;
    }
    entry.phase = receipt.delivered ? 'delivered' : 'queued';
    return true;
  }

  function acceptAck(ack = {}) {
    const commandId = String(ack.command_id || ack.id || '');
    const targetId = String(ack.target_id || ack.device_id || '');
    const entry = targetId ? entries.get(targetId) : findByCommand(commandId);
    if (!entry || entry.commandId !== commandId) return { accepted: false, confirmed: false };
    if (ack.ok === false || ['failed', 'timeout', 'stale'].includes(String(ack.status || '').toLowerCase())) {
      entry.phase = 'error';
      entry.error = ack.error || ack.status || 'command_failed';
      return { accepted: true, confirmed: false, entry: { ...entry } };
    }
    const actual = ack.state?.screen_on;
    if (typeof actual === 'boolean' && actual === entry.desiredScreenOn) {
      entries.delete(entry.deviceId);
      return { accepted: true, confirmed: true, entry: { ...entry }, state: ack.state };
    }
    entry.phase = 'acknowledged';
    return { accepted: true, confirmed: false, entry: { ...entry }, state: ack.state || null };
  }

  function reconcile(displays) {
    const byId = displayMap(displays);
    for (const [deviceId, entry] of entries) {
      const display = byId.get(deviceId);
      if (!display || display.command_revision !== entry.commandId) continue;
      if (display.screen_on === entry.desiredScreenOn) entries.delete(deviceId);
    }
    return pending();
  }

  function expire() {
    const timestamp = now();
    for (const entry of entries.values()) {
      if (entry.phase !== 'error' && entry.expiresAt <= timestamp) {
        entry.phase = 'error';
        entry.error = 'confirmation_timeout';
      }
    }
    return pending();
  }

  function reset() {
    entries.clear();
  }

  return { acceptAck, begin, expire, markDelivery, pending, pendingFor, reconcile, reset };
}
