// action-dock.js — Command Center bottom action dock + live-stream ladder.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { api } from '../../api.js';
import { showToast } from '../../components/toast.js';
import { confirmDialog } from '../../components/confirm.js';
import {
  deriveLiveLadder,
  formatLiveFailure,
  LIVE_LADDER,
} from '../../state/live-stream-ui.js';
import { isClassroomModeEnabled } from '../../state/feature-flags.js';

let liveActive = false;
let liveStateKnown = false;
let liveCompositionAvailable = false;
let livePhase = null;
let lastLadder = { state: LIVE_LADDER.UNKNOWN, canStart: false, reason: null };
let startInFlight = false;
let recordingActive = false;
let recordingSessionId = null;
let compositionRevision = 0;
let compositionLayout = 'camera_only';
let compositionContentInstanceId = null;
let compositionAudioPolicy = 'camera';
let compositionBusy = false;
// Classroom Mode (task §5): when the server reports classroom mode active,
// live-production services are stopped server-side and the dashboard must NOT
// poll them. operator-state / recording / camera-health polling is suspended so
// the classroom surface does not generate disabled-workload traffic. An admin
// who explicitly opens a live-production diagnostic re-enables on-demand calls;
// the periodic 5s health timer stays cancelled while classroom mode is on.
let classroomModeActive = false;

export function isLiveActive() {
  return liveActive;
}

export function isLiveStateKnown() {
  return liveStateKnown;
}

export function isLiveCompositionAvailable() {
  return liveCompositionAvailable;
}

export function getLiveLadder() {
  return lastLadder;
}

export function mountActionDock(hostEl, opts = {}) {
  if (!hostEl) return { syncLive() { return Promise.resolve(); }, repaintBlank() {}, destroy() {} };
  liveStateKnown = true;
  const cb = opts || {};
  hostEl.innerHTML = `
    <div class="mc-action-dock" role="toolbar" aria-label="${esc(t('mc.cc.brand'))}">
      <button type="button" class="mc-dock-btn mc-dock-primary" data-dock="multiview">${esc(t('mc.cc.dock.multiview'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="blank-toggle" id="mc-dock-blank-btn">${esc(t('mc.cc.dock.blank_all'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="share">${esc(t('mc.cc.dock.share'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="record-toggle" id="mc-dock-record-btn">${esc('Start Recording')}</button>
      <button type="button" class="mc-dock-btn mc-dock-live" data-dock="start-live">${esc(t('mc.cc.dock.start_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-danger" data-dock="stop-live" hidden>${esc(t('mc.cc.dock.stop_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-add" data-dock="add-display" aria-label="${esc(t('mc.cc.dock.add_display'))}">
        <span class="mc-dock-add-text">${esc(t('mc.cc.dock.add_display'))}</span>
        <span class="mc-dock-add-plus" aria-hidden="true">+</span>
      </button>
      <div class="mc-live-ladder" id="mc-live-ladder" role="status" aria-live="polite">
        <span class="mc-live-ladder-state" data-live-state>—</span>
        <span class="mc-live-ladder-reason" data-live-reason hidden></span>
      </div>
      <div class="mc-composition-control" data-composition-control hidden
           role="group" aria-label="${esc(t('mc.live.composition.aria'))}">
        <span class="mc-composition-tally" aria-live="polite">
          <span class="mc-composition-tally-dot" aria-hidden="true"></span>
          <span data-composition-revision>${esc(t('mc.live.composition.on_air'))}</span>
        </span>
        <button type="button" data-composition-layout="camera_only">${esc(t('mc.live.composition.camera_only'))}</button>
        <button type="button" data-composition-layout="content_main_camera_pip">${esc(t('mc.live.composition.content_main'))}</button>
        <button type="button" data-composition-layout="camera_main_content_pip">${esc(t('mc.live.composition.camera_main'))}</button>
        <button type="button" class="mc-composition-remove" data-composition-remove>${esc(t('mc.live.composition.remove'))}</button>
      </div>
      <div class="mc-cam-health-wrap">
        <button type="button" class="mc-cam-health mc-cam-unknown" id="mc-cam-health"
                title="${esc(t('mc.cc.camera.details'))}" aria-live="polite" aria-expanded="false">
          <span class="mc-cam-health-dot"></span><span class="mc-cam-health-label">${esc(t('mc.cc.camera.loading'))}</span>
        </button>
        <div class="mc-cam-health-detail" id="mc-cam-health-detail" role="status" hidden></div>
      </div>
    </div>`;

  const recordBtn = hostEl.querySelector('[data-dock="record-toggle"]');
  const startBtn = hostEl.querySelector('[data-dock="start-live"]');
  const stopBtn = hostEl.querySelector('[data-dock="stop-live"]');
  const blankBtn = hostEl.querySelector('[data-dock="blank-toggle"]');
  const ladderEl = hostEl.querySelector('#mc-live-ladder');
  const compositionEl = hostEl.querySelector('[data-composition-control]');

  function repaintBlank() {
    if (!blankBtn) return;
    const getIds = typeof cb.getActiveTargetDeviceIds === 'function' ? cb.getActiveTargetDeviceIds : () => [];
    const getDs  = typeof cb.getDisplayState === 'function' ? cb.getDisplayState : () => null;
    const ids = getIds();
    const ds  = getDs();
    if (!ids.length || !ds) {
      blankBtn.textContent = t('mc.cc.dock.blank_all');
      blankBtn.classList.remove('mc-dock-blank-active');
      return;
    }
    const all = ds.getAll ? ds.getAll() : [];
    const byId = new Map(all.map((d) => [d.id, d]));
    const anyBlanked = ids.some((id) => { const d = byId.get(id); return d && d.screen_on === false; });
    blankBtn.textContent = anyBlanked ? t('mc.cmd.unblank') : t('mc.cc.dock.blank_all');
    if (anyBlanked) blankBtn.classList.add('mc-dock-blank-active');
    else blankBtn.classList.remove('mc-dock-blank-active');
  }

  function paintLadder(ladder) {
    lastLadder = ladder || lastLadder;
    if (!ladderEl) return;
    const st = ladderEl.querySelector('[data-live-state]');
    const rs = ladderEl.querySelector('[data-live-reason]');
    if (st) st.textContent = lastLadder.state || LIVE_LADDER.UNKNOWN;
    if (rs) {
      if (lastLadder.reason) {
        rs.hidden = false;
        rs.textContent = lastLadder.reason;
      } else {
        rs.hidden = true;
        rs.textContent = '';
      }
    }
    ladderEl.dataset.state = (lastLadder.state || '').toLowerCase().replace(/\s+/g, '-');
  }

  function repaintLive() {
    const onAir = liveActive || lastLadder.state === LIVE_LADDER.ON_AIR;
    if (startBtn) {
      startBtn.hidden = onAir;
      const block = onAir || startInFlight || livePhase === 'starting' || livePhase === 'stopping' || lastLadder.canStart === false;
      startBtn.disabled = block;
      startBtn.title = lastLadder.reason || (block ? (lastLadder.state || '') : t('mc.cc.dock.start_live'));
      startBtn.setAttribute('aria-disabled', block ? 'true' : 'false');
    }
    if (stopBtn) {
      stopBtn.hidden = !onAir;
      stopBtn.disabled = livePhase === 'stopping' || startInFlight;
    }
    paintLadder(lastLadder);
    if (recordBtn) {
      recordBtn.textContent = recordingActive ? 'Stop Recording' : 'Start Recording';
      recordBtn.classList.toggle('is-recording', recordingActive);
      recordBtn.disabled = livePhase === 'starting' || livePhase === 'stopping';
    }
    if (compositionEl) {
      compositionEl.hidden = !onAir || !liveCompositionAvailable;
      compositionEl.querySelectorAll('[data-composition-layout]').forEach((button) => {
        const selected = button.dataset.compositionLayout === compositionLayout;
        button.classList.toggle('is-active', selected);
        button.setAttribute('aria-pressed', selected ? 'true' : 'false');
        button.disabled = compositionBusy
          || (button.dataset.compositionLayout !== 'camera_only' && !compositionContentInstanceId);
      });
      const remove = compositionEl.querySelector('[data-composition-remove]');
      if (remove) remove.disabled = compositionBusy || !compositionContentInstanceId;
      const revision = compositionEl.querySelector('[data-composition-revision]');
      if (revision) {
        revision.textContent = t('mc.live.composition.on_air_revision', {
          revision: compositionRevision,
        });
      }
    }
  }

  function repaintCamHealth(data) {
    const badge = hostEl.querySelector('#mc-cam-health');
    const detail = hostEl.querySelector('#mc-cam-health-detail');
    if (!badge) return;
    const lbl = badge.querySelector('.mc-cam-health-label');
    if (!data) {
      badge.className = 'mc-cam-health mc-cam-unknown';
      if (lbl) lbl.textContent = t('mc.cc.camera.unavailable');
      if (detail) detail.innerHTML = `<span>${esc(t('mc.cc.camera.unavailable'))}</span>`;
      return;
    }
    const cams = [
      { id: 'anpviz', name: t('mc.live_source.anpviz'), online: !!data.anpviz_stream },
    ];
    const up = cams.filter((cam) => cam.online).length;
    const active = data.active_source === 'anpviz' ? 'anpviz' : null;
    const cls = up === cams.length ? 'mc-cam-green' : (up > 0 ? 'mc-cam-yellow' : 'mc-cam-red');
    const txt = active && cams.some((cam) => cam.id === active && cam.online)
      ? t('mc.cc.camera.active', { count: up })
      : t('mc.cc.camera.online', { count: up });
    badge.className = 'mc-cam-health ' + cls;
    if (lbl) lbl.textContent = txt;
    if (detail) {
      const audioMode = data.audio_mode || data.effective_audio_mode || null;
      const audioLine = audioMode
        ? `<span class="mc-cam-detail-row"><b>Audio</b><em>${esc(String(audioMode))}</em></span>`
        : '';
      const publisherLine = `<span class="mc-cam-detail-row"><b>Publisher</b><em>${esc(String(data.publisher_mode || 'direct_camera'))}</em></span>`;
      detail.innerHTML = cams.map((cam) => {
        const selected = active === cam.id;
        const state = selected && cam.online         
          ? t('mc.cc.camera.selected')
          : (cam.online ? t('mc.cc.camera.ready') : t('mc.cc.camera.offline'));
        return `<span class="mc-cam-detail-row${selected ? ' is-active' : ''}"><b>${esc(cam.name)}</b><em>${esc(state)}</em></span>`;
      }).join('') + audioLine + publisherLine;
    }
  }

  let syncingLive = false;
  async function syncLive() {
    // Fixed-camera livestream is always polled — Start Livestream is
    // capability-driven, not gated by a blanket classroom-mode flag.
    if (syncingLive) return;
    syncingLive = true;
    let cameraEdge = null;
    let status = null;
    try {
      status = await api.liveStream.operatorState();
      cameraEdge = status?.camera_edge || null;
      const onAir = status?.publisher?.active === true
        || status?.stream_state === 'on_air'
        || status?.stream_active === true
        || status?.capabilities?.stream_state === 'on_air';
      // Never optimistic-set On Air outside of confirmed status.
      if (!startInFlight && livePhase !== 'starting') {
        liveActive = onAir;
      } else if (onAir) {
        liveActive = true;
        livePhase = null;
        startInFlight = false;
      }
      liveCompositionAvailable = status?.publisher?.mode === 'fixed_compositor'
        && status?.compositor?.available === true;
      const composition = status?.composition || status?.compositor_state || null;
      const authoritativeComposition = composition?.confirmed_layout
        ? composition
        : (status?.compositor_state || null);
      if (authoritativeComposition) {
        compositionRevision = Number(authoritativeComposition.revision) || 0;
        compositionLayout = authoritativeComposition.confirmed_layout || 'camera_only';
        compositionContentInstanceId = authoritativeComposition.content_instance_id || null;
        compositionAudioPolicy = authoritativeComposition.compositor_state?.audio_policy || 'camera';
      }
      recordingActive = cameraEdge?.recording_active === true
        || status?.recording_state === 'active'
        || status?.recording_active === true;
      lastLadder = deriveLiveLadder(status, { phase: livePhase });
    } catch {
      if (!startInFlight) liveActive = false;
      liveCompositionAvailable = false;
      lastLadder = { state: LIVE_LADDER.UNKNOWN, canStart: false, reason: 'Status unavailable' };
    } finally {
      liveStateKnown = true;
      syncingLive = false;
    }
    repaintLive();
    repaintCamHealth(cameraEdge);
  }

  const cameraBadge = hostEl.querySelector('#mc-cam-health');
  const cameraDetail = hostEl.querySelector('#mc-cam-health-detail');
  if (cameraBadge && cameraDetail) {
    cameraBadge.addEventListener('click', () => {
      cameraDetail.hidden = !cameraDetail.hidden;
      cameraBadge.setAttribute('aria-expanded', cameraDetail.hidden ? 'false' : 'true');
    });
  }

  async function onRecordToggle() {
    if (!recordBtn || recordBtn.disabled) return;
    recordBtn.disabled = true;
    try {
      if (recordingActive) {
        await api.liveStream.recordingStop({ session_id: recordingSessionId });
        recordingActive = false;
        recordingSessionId = null;
        showToast('Recording stopped', 'success');
      } else {
        const res = await api.liveStream.recordingStart({});
        recordingActive = true;
        recordingSessionId = res?.session_id || null;
        showToast('Recording started', 'success');
      }
    } catch (e) {
      showToast(formatLiveFailure(e) || e?.message || 'Recording failed', 'error');
    } finally {
      recordBtn.disabled = false;
      repaintLive();
      await syncLive();
    }
  }

  async function onStartLive() {
    if (startInFlight || (startBtn && startBtn.disabled)) {
      if (lastLadder.reason) showToast(lastLadder.reason, 'error');
      return;
    }
    await syncLive();
    if (lastLadder.canStart === false) {
      showToast(lastLadder.reason || 'Start is disabled', 'error');
      return;
    }
    startInFlight = true;
    livePhase = 'starting';
    lastLadder = deriveLiveLadder(null, { phase: 'starting' });
    repaintLive();
    try {
      await api.liveStream.start({
        initiator: 'operator',
      });
      showToast(t('mc.cc.live.started'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      liveActive = false;
      showToast(formatLiveFailure(e), 'error');
    } finally {
      startInFlight = false;
      livePhase = null;
      await syncLive();
    }
  }

  async function onStopLive() {
    const ok = await confirmDialog({
      title: t('mc.cc.dock.stop_live'),
      message: t('mc.cc.confirm.stop_live'),
      confirmLabel: t('mc.cc.dock.stop_live'),
      tone: 'danger',
    });
    if (!ok) return;
    livePhase = 'stopping';
    lastLadder = deriveLiveLadder(null, { phase: 'stopping' });
    repaintLive();
    try {
      await api.liveStream.stop();
      liveActive = false;
      showToast(t('mc.cc.live.stopped'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      showToast(formatLiveFailure(e), 'error');
    } finally {
      livePhase = null;
      await syncLive();
    }
  }

  function nextCompositionKey(action) {
    return globalThis.crypto?.randomUUID?.()
      || `composition-${action}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function acceptComposition(result) {
    compositionRevision = Number(result?.revision) || compositionRevision;
    compositionLayout = result?.confirmed_layout || compositionLayout;
    compositionContentInstanceId = result?.content_instance_id || null;
    compositionAudioPolicy = result?.compositor_state?.audio_policy || compositionAudioPolicy;
  }

  async function onCompositionLayout(layout) {
    if (compositionBusy || !liveActive || layout === compositionLayout) return;
    if (layout !== 'camera_only' && !compositionContentInstanceId) {
      showToast(t('mc.live.composition.send_content_first'), 'info');
      return;
    }
    compositionBusy = true;
    repaintLive();
    try {
      const result = await api.liveStream.compositionLayout({
        layout,
        audio_policy: layout === 'camera_only' ? 'camera' : compositionAudioPolicy,
        confirm_content_audio: layout !== 'camera_only'
          && compositionAudioPolicy === 'content_replace',
        expected_compositor_revision: compositionRevision,
        idempotency_key: nextCompositionKey('layout'),
      });
      acceptComposition(result);
      showToast(t('mc.live.composition.changed'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      showToast(formatLiveFailure(e), 'error');
    } finally {
      compositionBusy = false;
      repaintLive();
      await syncLive();
    }
  }

  async function onRemoveContent() {
    if (compositionBusy || !compositionContentInstanceId) return;
    compositionBusy = true;
    repaintLive();
    try {
      const result = await api.liveStream.compositionClear({
        content_instance_id: compositionContentInstanceId,
        expected_compositor_revision: compositionRevision,
        idempotency_key: nextCompositionKey('remove'),
      });
      acceptComposition(result);
      showToast(t('mc.live.composition.removed'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      showToast(formatLiveFailure(e), 'error');
    } finally {
      compositionBusy = false;
      repaintLive();
      await syncLive();
    }
  }

  hostEl.querySelectorAll('[data-dock]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      switch (btn.dataset.dock) {
        case 'multiview': if (typeof cb.onMultiview === 'function') cb.onMultiview(); break;
        case 'blank-selected': if (typeof cb.onBlankSelected === 'function') cb.onBlankSelected(); break;
        case 'blank-toggle':
          if (typeof cb.onBlankToggle === 'function') await cb.onBlankToggle();
          else if (typeof cb.onBlankAll === 'function') await cb.onBlankAll();
          repaintBlank();
          break;
        case 'blank-all': if (typeof cb.onBlankAll === 'function') await cb.onBlankAll(); break;
        case 'share': if (typeof cb.onShare === 'function') cb.onShare(); break;
        case 'record-toggle': await onRecordToggle(); break;
        case 'start-live': await onStartLive(); break;
        case 'stop-live': await onStopLive(); break;
        case 'add-display': if (typeof cb.onAddDisplay === 'function') cb.onAddDisplay(); break;
      }
    });
  });

  hostEl.querySelectorAll('[data-composition-layout]').forEach((button) => {
    button.addEventListener('click', () => onCompositionLayout(button.dataset.compositionLayout));
  });
  const compositionRemove = hostEl.querySelector('[data-composition-remove]');
  if (compositionRemove) {
    compositionRemove.addEventListener('click', onRemoveContent);
  }

  // Live-production health timer. The fixed-camera livestream is independent
  // of the AI Director, so we always poll — Start Livestream is enabled or
  // disabled based on actual camera-edge capabilities, not a blanket flag.
  let healthTimer = null;
  isClassroomModeEnabled().then((on) => {
    classroomModeActive = !!on;
    // Always poll regardless of classroom mode — the capability ladder
    // (deriveLiveLadder) handles precise disabled reasons.
    syncLive();
    healthTimer = setInterval(() => syncLive(), 5000);
  }).catch(() => {
    syncLive();
    healthTimer = setInterval(() => syncLive(), 5000);
  });
  return {
    syncLive,
    repaintBlank,
    destroy() { if (healthTimer) { clearInterval(healthTimer); healthTimer = null; } },
  };
}
