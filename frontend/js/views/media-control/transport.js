// transport.js — transport controls (prev / play_pause / next / restart) and
// blank/unblank toggle for a single display on the unified Media Control stage.
//
// Renders a compact control bar into `container`. Uses `sendCommand` from
// socket.js with COMMAND_TYPES / TRANSPORT_ACTIONS constants from
// player-protocol.js. Transport clicks wait for server delivery AND player
// command:ack confirmation (or timeout → STALE/FAILED) before reporting success.
//
// Public exports:
//   renderTransportBar(container, opts)
//   sendTransportCommand(deviceId, action, payload, opts) — explicit targeted send

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { sendCommand, on as onSocket, off as offSocket, roomState } from '../../socket.js';
import {
  COMMAND_TYPES,
  TRANSPORT_ACTIONS,
  COMMAND_LIFECYCLE,
  DEFAULT_COMMAND_TIMEOUT_MS,
  buildTransportTarget,
  isTransportAction,
} from '../../player-protocol.js';
import { showToast } from '../../components/toast.js';
import { get as getDisplayState, subscribe as subscribeDisplayState } from '../../services/display-state.js';

const STATIC_TRANSPORT_BTNS = [
  { action: TRANSPORT_ACTIONS[1], label: '⏮', titleKey: 'mc.tp.prev' },
  { action: TRANSPORT_ACTIONS[3], label: '↺', titleKey: 'mc.tp.restart' },
  { action: TRANSPORT_ACTIONS[0], label: '⏭', titleKey: 'mc.tp.next' },
];

// Pending transport commands awaiting player confirmation (task §8).
// command_id -> { resolve, timer, deviceId, action, payload, contentInstanceId, acknowledged }
const pendingApply = new Map();

// §8: ACKNOWLEDGED is only RECEIPT. CONFIRMED requires a matching physical
// player-state report. Correlate by device + content instance + the action's
// expected outcome (paused / currentTime / slide_index / idle).
function matchesExpectedState(entry, state) {
  if (!state || typeof state !== 'object') return false;
  if (state.device_id && entry.deviceId && state.device_id !== entry.deviceId) return false;
  if (entry.contentInstanceId && state.content_instance_id
      && state.content_instance_id !== entry.contentInstanceId) return false;
  const action = entry.action;
  if (action === 'pause') return state.paused === true;
  if (action === 'play') return state.paused === false;
  if (action === 'stop') return state.kind === 'idle' || state.paused === true || !state.kind;
  if (action === 'seek') {
    const target = entry.payload?.seconds ?? entry.payload?.position_seconds;
    const ct = state.currentTime ?? state.current_time;
    return target != null && ct != null && Math.abs(Number(ct) - Number(target)) <= 2;
  }
  if (action === 'go_to_slide') {
    const target = entry.payload?.slide ?? entry.payload?.slide_index;
    return target != null && Number(state.slide_index) === Number(target);
  }
  // Transitional actions (next/prev/restart/mute/unmute/volume/scroll): a state
  // report for the right device + content after the command is sufficient.
  return true;
}

// Late-confirmation path: promote an ACKNOWLEDGED (but unconfirmed) command to
// CONFIRMED when the next authoritative state-sync matches. Wired once.
let displayStateConfirmationWired = false;
function ensureDisplayStateConfirmation() {
  if (displayStateConfirmationWired) return;
  displayStateConfirmationWired = true;
  try {
    subscribeDisplayState(() => {
      if (!pendingApply.size) return;
      for (const [commandId, entry] of pendingApply) {
        if (!entry.acknowledged) continue;
        const d = getDisplayState(entry.deviceId);
        const np = d?.now_playing;
        if (!np) continue;
        const state = { ...np, device_id: entry.deviceId, content_instance_id: np.content_id || np.contentId };
        if (matchesExpectedState(entry, state)) {
          pendingApply.delete(commandId);
          clearTimeout(entry.timer);
          entry.resolve({
            ok: true,
            lifecycle: COMMAND_LIFECYCLE.CONFIRMED,
            command_id: commandId,
            status: 'confirmed',
            state,
            confirmed_by: 'state-sync',
          });
        }
      }
    });
  } catch { /* display-state optional */ }
}

function ensureCommandAckBridge() {
  if (ensureCommandAckBridge.wired) return;
  ensureCommandAckBridge.wired = true;
  onSocket('command-ack', (data) => {
    const commandId = data?.command_id || data?.id || null;
    if (!commandId || !pendingApply.has(commandId)) return;
    const entry = pendingApply.get(commandId);
    const status = String(data?.status || '').toLowerCase();
    const ok = data?.ok !== false && status !== 'timeout' && status !== 'failed';
    if (!ok) {
      pendingApply.delete(commandId);
      clearTimeout(entry.timer);
      let lifecycle = COMMAND_LIFECYCLE.FAILED;
      if (status === 'timeout' || status === 'stale') lifecycle = COMMAND_LIFECYCLE.STALE;
      else if (status === 'offline') lifecycle = COMMAND_LIFECYCLE.OFFLINE;
      entry.resolve({
        ok,
        lifecycle,
        command_id: commandId,
        status: status || 'failed',
        error: data?.error || null,
        state: data?.state || null,
        raw: data,
      });
      return;
    }
    const state = data?.state || null;
    if (status === 'acked' || status === 'acknowledged') {
      // ACK proves RECEIPT only. If the ack also carries a matching physical
      // state, promote straight to CONFIRMED. Otherwise stay ACKNOWLEDGED and
      // wait for the next state-sync (ensureDisplayStateConfirmation) or timeout.
      if (matchesExpectedState(entry, state)) {
        pendingApply.delete(commandId);
        clearTimeout(entry.timer);
        entry.resolve({
          ok: true,
          lifecycle: COMMAND_LIFECYCLE.CONFIRMED,
          command_id: commandId,
          status: 'confirmed',
          state,
          confirmed_by: 'ack-state',
          raw: data,
        });
      } else {
        // ACK only — surface ACKNOWLEDGED to the UI, then wait for the matching
        // state-sync (ensureDisplayStateConfirmation) or the timeout (→ STALE).
        entry.acknowledged = true;
        if (typeof entry.onInterim === 'function') entry.onInterim(COMMAND_LIFECYCLE.ACKNOWLEDGED);
        ensureDisplayStateConfirmation();
        // do NOT resolve — the timer remains armed (→ STALE on confirmation timeout)
      }
      return;
    }
    // Any other successful status is treated as confirmed (the player reported ok).
    pendingApply.delete(commandId);
    clearTimeout(entry.timer);
    entry.resolve({
      ok: true,
      lifecycle: COMMAND_LIFECYCLE.CONFIRMED,
      command_id: commandId,
      status: status || 'ok',
      state,
      raw: data,
    });
  });
}

/**
 * Send a transport action with explicit target metadata and full lifecycle.
 * Rejects multi-device fan-out when opts.requireSingleTarget is true.
 */
export function sendTransportCommand(deviceId, action, payload = {}, opts = {}) {
  ensureCommandAckBridge();
  const resolvedAction = String(action || '').trim();
  if (!deviceId) {
    return Promise.resolve({
      ok: false,
      lifecycle: COMMAND_LIFECYCLE.FAILED,
      error: 'missing_device_id',
    });
  }
  if (!isTransportAction(resolvedAction) && resolvedAction !== COMMAND_TYPES.TRANSPORT) {
    // Allow expanded actions even if list grows without UI restart
  }
  if (!resolvedAction) {
    return Promise.resolve({ ok: false, lifecycle: COMMAND_LIFECYCLE.FAILED, error: 'missing_action' });
  }

  const targetMeta = buildTransportTarget({
    ...(opts.target || {}),
    device_id: deviceId,
    ...(opts.zoneId ? { zone_id: opts.zoneId } : {}),
    ...(opts.cellId ? { cell_id: opts.cellId } : {}),
    ...(opts.contentInstanceId ? { content_instance_id: opts.contentInstanceId } : {}),
    ...(opts.wallId ? { wall_id: opts.wallId } : {}),
    ...(opts.workspaceId ? { workspace_id: opts.workspaceId } : {}),
    ...(opts.roomId ? { room_id: opts.roomId } : {}),
  });
  if (opts.expectedRevision != null) targetMeta.expected_revision = opts.expectedRevision;
  else {
    try {
      const rev = roomState && typeof roomState.getRevision === 'function' ? roomState.getRevision() : null;
      if (rev != null) targetMeta.expected_revision = rev;
    } catch { /* roomState optional */ }
  }

  const body = {
    ...targetMeta,
    ...(payload || {}),
    action: resolvedAction,
  };

  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : DEFAULT_COMMAND_TIMEOUT_MS;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    sendCommand(deviceId, COMMAND_TYPES.TRANSPORT, body, (ack) => {
      if (!ack || (!ack.delivered && !ack.queued)) {
        const offline = ack && (ack.reason === 'offline' || ack.queued);
        finish({
          ok: false,
          lifecycle: offline ? COMMAND_LIFECYCLE.OFFLINE : COMMAND_LIFECYCLE.FAILED,
          delivered: false,
          queued: !!(ack && ack.queued),
          reason: ack?.reason || 'no_ack',
          command_id: ack?.command_id || null,
          error: ack?.error || ack?.reason || 'delivery_failed',
        });
        return;
      }
      if (ack.queued && !ack.delivered) {
        finish({
          ok: false,
          lifecycle: COMMAND_LIFECYCLE.OFFLINE,
          delivered: false,
          queued: true,
          command_id: ack.command_id || null,
          error: 'offline',
        });
        return;
      }
      const commandId = ack.command_id || null;
      if (!commandId || opts.waitForApply === false) {
        finish({
          ok: true,
          lifecycle: COMMAND_LIFECYCLE.DELIVERED,
          delivered: true,
          command_id: commandId,
        });
        return;
      }
      const timer = setTimeout(() => {
        if (!pendingApply.has(commandId)) return;
        pendingApply.delete(commandId);
        finish({
          ok: false,
          lifecycle: COMMAND_LIFECYCLE.STALE,
          delivered: true,
          command_id: commandId,
          error: 'apply_timeout',
        });
      }, timeoutMs);
      pendingApply.set(commandId, {
        resolve: (result) => finish({ ...result, delivered: true }),
        timer,
        deviceId,
        action: resolvedAction,
        payload: payload || {},
        contentInstanceId: opts.contentInstanceId || targetMeta.content_instance_id || null,
        acknowledged: false,
        onInterim: typeof opts.onInterim === 'function' ? opts.onInterim : null,
      });
    });
  });
}

/**
 * Render transport controls + blank toggle into `container`.
 */
export function renderTransportBar(container, {
  deviceId,
  transportDeviceIds,
  blankDeviceIds,
  screenOn = true,
  paused,
  target,
  zoneId,
  cellId,
  wallId,
  contentInstanceId,
  requireSingleTarget = false,
  onScreenOnChange,
  onTransportAction,
  onCommandLifecycle,
} = {}) {
  if (!container) return;

  const transportIds = (Array.isArray(transportDeviceIds) && transportDeviceIds.length)
    ? [...new Set(transportDeviceIds.filter(Boolean))]
    : (deviceId ? [deviceId] : []);

  const blankIds = (Array.isArray(blankDeviceIds) && blankDeviceIds.length)
    ? [...new Set(blankDeviceIds.filter(Boolean))]
    : (deviceId ? [deviceId] : []);

  const staticHtml = STATIC_TRANSPORT_BTNS.map(b => {
    const title = t(b.titleKey);
    return `<button type="button" class="mc-tp-btn" data-tp-action="${esc(b.action)}" title="${esc(title)}" aria-label="${esc(title)}"><span class="mc-tp-ico" aria-hidden="true">${b.label}</span><span class="mc-tp-text">${esc(title)}</span></button>`;
  });

  const ppLabel = paused === true ? '▶' : paused === false ? '⏸' : '⏯';
  const ppTitle = paused === true ? t('mc.tp.play') : paused === false ? t('mc.tp.pause') : t('mc.tp.play_pause');
  const ppHtml = `<button type="button" class="mc-tp-btn mc-tp-playpause" data-tp-action="${esc(TRANSPORT_ACTIONS[2])}" title="${esc(ppTitle)}" aria-label="${esc(ppTitle)}"><span class="mc-tp-ico" aria-hidden="true">${ppLabel}</span><span class="mc-tp-text">${esc(ppTitle)}</span></button>`;

  const allBtns = [...staticHtml.slice(0, 2), ppHtml, ...staticHtml.slice(2)];
  // Direct slide jump when the display has reported a slide deck.
  const slideCount = target?.slideCount ?? target?.now_playing?.slideCount;
  const slideIndex = target?.slideIndex ?? target?.now_playing?.slideIndex;
  const goToHtml = (Number(slideCount) > 0)
    ? `<label class="mc-tp-goto"><span class="sr-only">Go to slide</span>
        <input type="number" min="1" max="${esc(String(slideCount))}" step="1"
          class="mc-tp-goto-input" data-tp-goto
          value="${esc(String(slideIndex > 0 ? slideIndex : 1))}"
          title="Go to slide" aria-label="Go to slide" />
        <button type="button" class="mc-tp-btn mc-tp-goto-btn" data-tp-goto-send title="Go to slide">#</button>
      </label>`
    : '';

  const blankLabel = screenOn ? t('mc.tp.blank') : t('mc.tp.unblank');
  const blankTitle = screenOn ? t('mc.tp.blank_title') : t('mc.tp.unblank_title');
  const blankClass = screenOn ? 'mc-tp-blank' : 'mc-tp-blank mc-tp-blank-active';

  const lifecycleChip = `<span class="mc-tp-lifecycle" data-tp-lifecycle aria-live="polite"></span>`;

  container.innerHTML = `
    <div class="mc-transport-bar" role="toolbar" aria-label="${esc(t('mc.tp.toolbar'))}"
         data-device-id="${esc(deviceId || '')}"
         data-zone-id="${esc(zoneId || '')}"
         data-cell-id="${esc(cellId || '')}"
         data-wall-id="${esc(wallId || '')}">
      <div class="mc-tp-group">${allBtns.join('')}${goToHtml}</div>
      ${lifecycleChip}
      <button type="button" class="${blankClass}" data-tp-blank
              title="${esc(blankTitle)}"
              aria-pressed="${screenOn ? 'false' : 'true'}">${esc(blankLabel)}</button>
    </div>`;

  const lifecycleEl = container.querySelector('[data-tp-lifecycle]');
  const setLifecycle = (lifecycle, detail) => {
    if (lifecycleEl) {
      lifecycleEl.dataset.state = lifecycle || '';
      lifecycleEl.textContent = lifecycle ? String(lifecycle).toLowerCase() : '';
      lifecycleEl.title = detail ? String(detail) : '';
    }
    if (typeof onCommandLifecycle === 'function') onCommandLifecycle(lifecycle, detail);
  };

  container.querySelectorAll('.mc-tp-btn, [data-tp-blank], [data-tp-goto], [data-tp-goto-send]').forEach(btn => {
    btn.addEventListener('click', e => e.stopPropagation());
  });

  async function dispatchTransport(resolvedAction, extraPayload = {}) {
    if (requireSingleTarget && transportIds.length !== 1) {
      setLifecycle(COMMAND_LIFECYCLE.FAILED, 'ambiguous_target_set');
      showToast('Select a single display or zone before controlling playback', 'error');
      return;
    }
    if (!transportIds.length) {
      setLifecycle(COMMAND_LIFECYCLE.FAILED, 'missing_target');
      showToast('No playback target selected', 'error');
      return;
    }

    setLifecycle(COMMAND_LIFECYCLE.REQUESTED, resolvedAction);
    const results = [];
    for (const id of transportIds) {
      setLifecycle(COMMAND_LIFECYCLE.PENDING, id);
      // eslint-disable-next-line no-await-in-loop
      const result = await sendTransportCommand(id, resolvedAction, extraPayload, {
        target,
        zoneId,
        cellId,
        wallId,
        contentInstanceId,
        timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
        onInterim: (lc) => setLifecycle(lc, 'awaiting player confirmation'),
      });
      results.push({ id, result });
      setLifecycle(result.lifecycle, result.error || result.command_id);
      if (!result.ok) {
        const msg = result.lifecycle === COMMAND_LIFECYCLE.OFFLINE
          ? 'Display offline — command queued or dropped'
          : result.lifecycle === COMMAND_LIFECYCLE.STALE
            ? 'Playback command timed out waiting for player confirmation'
            : (result.error && result.error.message) || result.error || 'Playback command failed';
        showToast(typeof msg === 'string' ? msg : 'Playback command failed', 'error');
      }
    }
    if (typeof onTransportAction === 'function') onTransportAction(transportIds, resolvedAction, results);
  }

  container.querySelectorAll('[data-tp-action]').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.tpAction;
      if (!TRANSPORT_ACTIONS.includes(action) && !isTransportAction(action)) return;
      // Authoritative paused state comes from the display-state store — NOT from
      // the render-time `paused` closure which can be stale after rerenders.
      // This is the core fix for the "paused video resumes after unrelated UI
      // actions" defect: the play/pause button never uses a stale value.
      let authoritativePaused = paused;
      try {
        const d = getDisplayState ? getDisplayState(deviceId) : null;
        if (d && d.now_playing && typeof d.now_playing.paused === 'boolean') {
          authoritativePaused = d.now_playing.paused;
        }
      } catch { /* display-state optional */ }
      const resolvedAction = action === 'play_pause' && authoritativePaused !== undefined
        ? (authoritativePaused ? 'play' : 'pause')
        : action;
      btn.disabled = true;
      dispatchTransport(resolvedAction).finally(() => { btn.disabled = false; });
    });
  });

  const gotoInput = container.querySelector('[data-tp-goto]');
  const gotoBtn = container.querySelector('[data-tp-goto-send]');
  if (gotoBtn && gotoInput) {
    gotoBtn.addEventListener('click', () => {
      const slide = parseInt(gotoInput.value, 10);
      if (!Number.isInteger(slide) || slide < 1) {
        showToast('Enter a valid slide number', 'error');
        return;
      }
      if (Number(slideCount) > 0 && slide > Number(slideCount)) {
        showToast(`Slide must be between 1 and ${slideCount}`, 'error');
        return;
      }
      gotoBtn.disabled = true;
      dispatchTransport('go_to_slide', { slide, page: slide, slide_index: slide }).finally(() => {
        gotoBtn.disabled = false;
      });
    });
  }

  const blankBtn = container.querySelector('[data-tp-blank]');
  if (blankBtn) {
    blankBtn.addEventListener('click', () => {
      const turningOn = blankBtn.classList.contains('mc-tp-blank-active');
      const type = turningOn ? COMMAND_TYPES.SCREEN_ON : COMMAND_TYPES.SCREEN_OFF;
      blankBtn.disabled = true;
      blankIds.filter(id => id && id !== deviceId).forEach(id => sendCommand(id, type, {}));
      sendCommand(deviceId, type, {}, (ack) => {
        blankBtn.disabled = false;
        if (!ack || (!ack.delivered && !ack.queued)) {
          showToast(turningOn ? t('mc.tp.unblank_failed') : t('mc.tp.blank_failed'), 'error');
          return;
        }
        const newScreenOn = turningOn;
        blankBtn.textContent = newScreenOn ? t('mc.tp.blank') : t('mc.tp.unblank');
        blankBtn.title = newScreenOn ? t('mc.tp.blank_title') : t('mc.tp.unblank_title');
        blankBtn.setAttribute('aria-pressed', newScreenOn ? 'false' : 'true');
        if (newScreenOn) blankBtn.classList.remove('mc-tp-blank-active');
        else blankBtn.classList.add('mc-tp-blank-active');
        if (typeof onScreenOnChange === 'function') onScreenOnChange(newScreenOn);
      });
    });
  }
}

// Keep offSocket referenced so dead-code tooling doesn't drop the import contract.
export function _disposeTransportAckForTests() {
  pendingApply.forEach((entry) => clearTimeout(entry.timer));
  pendingApply.clear();
  if (typeof offSocket === 'function') {/* reserved */}
}
