// Operator Console shell (task §1, §2, §14).
//
// Orchestrates the enterprise workflow:
//   Choose room → choose layout → choose content/source → preview → take/send
//   → receive confirmation → control playback
//
// Maintains a clear distinction between PREVIEW, CLASSROOM PROGRAM, and
// LIVESTREAM PROGRAM surfaces so the operator always knows which surface a
// change targets. High-impact/destructive/public actions require explicit
// confirmation; routine next/prev do not.
//
// Mounts the sub-components into slots and wires them to the shared operator
// store + socket adapter. This is a NEW view entry — it does not replace the
// existing media-control.js view. A minimal navigation entry is documented in
// the integration guide (not applied here).
import { roomState, on as socketOn, off as socketOff, sendCommand as socketSendCommand, selectTarget as socketSelectTarget, clearTarget as socketClearTarget, requestRoomSnapshot as socketRequestRoomSnapshot } from '../../socket.js';
import { createOperatorStore } from '../../state/operator-store.js';
import { createOperatorSocketAdapter } from '../../state/socket-adapter.js';
import { enterpriseApi } from '../../state/enterprise-api.js';
import { ERROR_CODES, recoveryForCode, deriveErrorCode } from '../../state/error-recovery.js';
import { esc } from '../../components/display-layout/render-helpers.js';
import { mountRoomOverview } from '../../components/room-state/room-overview.js';
import { mountLayoutSelector } from '../../components/display-layout/layout-selector.js';
import { mountContentSelector } from '../../components/content-library/content-selector.js';
import { mountPlaybackControl } from '../../components/playback-control/playback-control.js';
import { mountScreenSharePanel } from '../../components/operator-console/screen-share-panel.js';

const SURFACES = {
  PREVIEW: 'preview',
  CLASSROOM: 'classroom',
  LIVESTREAM: 'livestream',
};

export function mountOperatorConsole(host, { socket, i18n, api = enterpriseApi, engine = null } = {}) {
  if (!host) throw new Error('mountOperatorConsole requires a host element');
  const sock = socket || getSocketStub();
  const roomStore = (socket && socket.roomStore) || roomState;
  const operatorStore = createOperatorStore({ roomStore });
  const adapter = createOperatorSocketAdapter({ socket: sock, roomStore, operatorStore });
  adapter.connect();

  host.classList.add('mc-e-console');
  host.setAttribute('data-component', 'operator-console');

  const cleanups = [];
  let destroyed = false;
  let selectedRoom = null;
  let selectedLayout = null;
  let selectedContent = null;
  let activeSurface = SURFACES.CLASSROOM;
  let lastError = null;

  function surfaceLabel(s) {
    const map = { preview: 'mc.e.surface.preview', classroom: 'mc.e.surface.classroom', livestream: 'mc.e.surface.livestream' };
    return i18n ? i18n(map[s]) : s;
  }

  function confirmAction(message) {
    if (typeof globalThis.confirm === 'function') return globalThis.confirm(message);
    return true; // tests without window.confirm
  }

  function setError(code, signal) {
    const c = code || deriveErrorCode(signal || {});
    const recovery = recoveryForCode(c);
    lastError = recovery ? { code: c, recovery } : null;
    renderError();
  }

  function clearError() { lastError = null; renderError(); }

  function renderError() {
    const el = host.querySelector('[data-slot="error"]');
    if (!el) return;
    if (!lastError) { el.innerHTML = ''; return; }
    const r = lastError.recovery;
    el.innerHTML = `<div class="mc-e-error" role="alert" data-error-code="${lastError.code}">
      <strong>${esc(r.titleKey)}</strong>
      <p>${esc(i18n ? i18n(r.whatHappenedKey) : 'An operational error occurred.')}</p>
      <p>${esc(i18n ? i18n(r.remainsActiveKey) : '')}</p>
      <p>${esc(i18n ? i18n(r.actionKey) : '')}</p>
      <p class="mc-e-error-retry">${esc(i18n ? i18n('mc.e.err.retry_safe') : 'Retry safe')}: ${r.retrySafe ? '✓' : '✕'}</p>
    </div>`;
  }

  function render() {
    host.innerHTML = `
      <div class="mc-e-console-grid">
        <section class="mc-e-pane mc-e-pane-overview" data-slot="overview" aria-label="${esc(surfaceLabel(activeSurface))}"></section>
        <section class="mc-e-pane mc-e-pane-steps">
          <ol class="mc-e-workflow" aria-label="${esc(i18n ? i18n('mc.e.workflow.aria') : 'Operator workflow')}">
            <li class="mc-e-step" data-step="room"><span class="mc-e-step-label">${esc(i18n ? i18n('mc.e.step.room') : 'Choose room')}</span><span class="mc-e-step-value" data-step-value="room">—</span></li>
            <li class="mc-e-step" data-step="layout"><span class="mc-e-step-label">${esc(i18n ? i18n('mc.e.step.layout') : 'Choose layout')}</span><span class="mc-e-step-value" data-step-value="layout">—</span></li>
            <li class="mc-e-step" data-step="content"><span class="mc-e-step-label">${esc(i18n ? i18n('mc.e.step.content') : 'Choose content')}</span><span class="mc-e-step-value" data-step-value="content">—</span></li>
          </ol>
          <div class="mc-e-surface-switch" role="tablist" aria-label="${esc(i18n ? i18n('mc.e.surface.aria') : 'Target surface')}">
            <button type="button" role="tab" data-surface="preview" aria-selected="${activeSurface === SURFACES.PREVIEW}">${esc(surfaceLabel(SURFACES.PREVIEW))}</button>
            <button type="button" role="tab" data-surface="classroom" aria-selected="${activeSurface === SURFACES.CLASSROOM}">${esc(surfaceLabel(SURFACES.CLASSROOM))}</button>
            <button type="button" role="tab" data-surface="livestream" aria-selected="${activeSurface === SURFACES.LIVESTREAM}">${esc(surfaceLabel(SURFACES.LIVESTREAM))}</button>
          </div>
          <div data-slot="layout"></div>
          <div data-slot="content"></div>
          <div class="mc-e-send-actions">
            <button type="button" class="mc-e-send-preview" data-send="preview">${esc(i18n ? i18n('mc.e.send.preview') : 'Preview')}</button>
            <button type="button" class="mc-e-send-classroom mc-e-primary" data-send="classroom">${esc(i18n ? i18n('mc.e.send.classroom') : 'Send to classroom')}</button>
            <button type="button" class="mc-e-send-livestream" data-send="livestream">${esc(i18n ? i18n('mc.e.send.livestream') : 'Take to livestream')}</button>
          </div>
          <div data-slot="error" aria-live="polite"></div>
        </section>
        <section class="mc-e-pane mc-e-pane-playback" data-slot="playback"></section>
        <section class="mc-e-pane mc-e-pane-screenshare" data-slot="screenshare"></section>
      </div>`;

    cleanups.forEach((c) => { try { c(); } catch {} });
    cleanups.length = 0;

    cleanups.push(mountRoomOverview(host.querySelector('[data-slot="overview"]'), { store: operatorStore, i18n }));
    cleanups.push(mountLayoutSelector(host.querySelector('[data-slot="layout"]'), {
      store: operatorStore, i18n,
      onSelect: (card) => { selectedLayout = card; updateStepValue('layout', card.key); clearError(); },
    }));
    cleanups.push(mountContentSelector(host.querySelector('[data-slot="content"]'), {
      store: operatorStore, i18n,
      onSelect: ({ id, type, item }) => { selectedContent = { id, type, item }; updateStepValue('content', item?.title || id); clearError(); },
    }));
    cleanups.push(mountPlaybackControl(host.querySelector('[data-slot="playback"]'), { store: operatorStore, i18n, adapter }));
    cleanups.push(mountScreenSharePanel(host.querySelector('[data-slot="screenshare"]'), { store: operatorStore, i18n, adapter, engine, api }));

    renderError();
    refreshSteps();
  }

  function updateStepValue(step, value) {
    const el = host.querySelector(`[data-step-value="${step}"]`);
    if (el) el.textContent = value;
  }

  function refreshSteps() {
    updateStepValue('room', selectedRoom?.name || (i18n ? i18n('mc.e.step.room_none') : 'Not selected'));
    updateStepValue('layout', selectedLayout?.key || '—');
    updateStepValue('content', selectedContent?.item?.title || '—');
  }

  host.addEventListener('click', onClick);
  function onClick(ev) {
    if (destroyed) return;
    handleSurfaceClick(ev).catch(() => {});
  }
  async function handleSurfaceClick(ev) {
    const surfaceBtn = ev.target.closest('button[data-surface]');
    if (surfaceBtn) {
      activeSurface = surfaceBtn.getAttribute('data-surface');
      host.querySelectorAll('[data-surface]').forEach((b) => b.setAttribute('aria-selected', String(b === surfaceBtn)));
      return;
    }
    const sendBtn = ev.target.closest('button[data-send]');
    if (!sendBtn) return;
    const surface = sendBtn.getAttribute('data-send');
    const d = (operatorStore.get()?.displays || [])[0];
    const highImpact = (surface === 'classroom' || surface === 'livestream');
    if (highImpact && !confirmAction(i18n ? i18n('mc.e.send.confirm') : 'Confirm: apply to the active surface?')) return;
    if (surface === 'preview' && !selectedContent) { setError(ERROR_CODES.CONTENT_PROCESSING); return; }
    try {
      if (surface === 'preview') {
        // Preview does not send to displays; it stages selection.
        adapter.selectTarget('display', d?.id);
      } else if (surface === 'classroom' && selectedContent) {
        const res = await api_broadcast(adapter, selectedContent, false);
        if (!res) setError(null, { status: 409 });
      } else if (surface === 'livestream' && selectedContent) {
        const res = await api_broadcast(adapter, selectedContent, true);
        if (!res) setError(null, { service: 'obs' });
      }
      clearError();
    } catch (err) {
      setError(null, { status: err?.status, reason: err?.message, code: err?.code });
    }
  }

  // Minimal broadcast via the existing api.broadcast (confirmed-all gate handled there).
  async function api_broadcast(_adapter, content, includeLive) {
    const { api: realApi } = await import('../../api.js');
    try {
      const res = await realApi.broadcast({ content_id: content.id, targets: [], include_live_stream: includeLive });
      return !res?.code;
    } catch (e) {
      setError(null, { status: e?.status, reason: e?.message });
      return false;
    }
  }

  // Pick a default room from the adapter.
  api.rooms.list().then((rooms) => {
    if (destroyed) return;
    selectedRoom = (rooms || [])[0] || null;
    refreshSteps();
  }).catch(() => {});

  render();

  return {
    destroy() {
      destroyed = true;
      host.removeEventListener('click', onClick);
      cleanups.forEach((c) => { try { c(); } catch {} });
      cleanups.length = 0;
      adapter.disconnect();
      host.innerHTML = '';
      host.removeAttribute('data-component');
    },
  };
}

function getSocketStub() {
  // Late import keeps the shell usable in tests that stub socket.js.
  return globalThis.__MC_SOCKET_STUB || null;
}

// App-router compatibility: app.js calls `currentView.render(app)`. Mount the
// console into the provided host (the #app container) and keep a module-level
// handle so the router's cleanup/unmount contract can be wired at integration.
let _active = null;
function realSocketInterface() {
  return {
    roomStore: roomState,
    on: socketOn,
    off: socketOff,
    sendCommand: socketSendCommand,
    selectTarget: socketSelectTarget,
    clearTarget: socketClearTarget,
    requestRoomSnapshot: socketRequestRoomSnapshot,
  };
}
export function render(host, ..._rest) {
  if (_active) { try { _active.destroy(); } catch {} }
  _active = mountOperatorConsole(host, { socket: realSocketInterface() });
  return _active;
}

export default mountOperatorConsole;
