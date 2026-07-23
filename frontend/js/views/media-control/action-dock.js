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
import { openPrepareLiveProductionModal } from './prepare-live-production.js';

let liveActive = false;
let liveStateKnown = false;
let livePhase = null;
let lastLadder = { state: LIVE_LADDER.UNKNOWN, canStart: false, reason: null };
let startInFlight = false;
let activeProductionPlan = null;
let recordingActive = false;
let recordingSessionId = null;

export function isLiveActive() {
  return liveActive;
}

export function isLiveStateKnown() {
  return liveStateKnown;
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
      <button type="button" class="mc-dock-btn mc-dock-prepare" data-dock="prepare-live" aria-pressed="false">${esc(t('mc.cc.dock.prepare_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="record-toggle" id="mc-dock-record-btn">${esc('Start Recording')}</button>
      <button type="button" class="mc-dock-btn mc-dock-live" data-dock="start-live">${esc(t('mc.cc.dock.start_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-default" data-dock="remove-live" hidden>${esc(t('mc.cc.dock.remove_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-danger" data-dock="stop-live" hidden>${esc(t('mc.cc.dock.stop_live'))}</button>
      <button type="button" class="mc-dock-btn mc-dock-add" data-dock="add-display" aria-label="${esc(t('mc.cc.dock.add_display'))}">
        <span class="mc-dock-add-text">${esc(t('mc.cc.dock.add_display'))}</span>
        <span class="mc-dock-add-plus" aria-hidden="true">+</span>
      </button>
      <div class="mc-live-ladder" id="mc-live-ladder" role="status" aria-live="polite">
        <span class="mc-live-ladder-state" data-live-state>—</span>
        <span class="mc-live-ladder-reason" data-live-reason hidden></span>
      </div>
      <div class="mc-cam-health-wrap">
        <button type="button" class="mc-cam-health mc-cam-unknown" id="mc-cam-health"
                title="${esc(t('mc.cc.camera.details'))}" aria-live="polite" aria-expanded="false">
          <span class="mc-cam-health-dot"></span><span class="mc-cam-health-label">${esc(t('mc.cc.camera.loading'))}</span>
        </button>
        <div class="mc-cam-health-detail" id="mc-cam-health-detail" role="status" hidden></div>
      </div>
    </div>`;

  const prepareBtn = hostEl.querySelector('[data-dock="prepare-live"]');
  const recordBtn = hostEl.querySelector('[data-dock="record-toggle"]');
  const startBtn = hostEl.querySelector('[data-dock="start-live"]');
  const removeBtn = hostEl.querySelector('[data-dock="remove-live"]');
  const stopBtn = hostEl.querySelector('[data-dock="stop-live"]');
  const blankBtn = hostEl.querySelector('[data-dock="blank-toggle"]');
  const ladderEl = hostEl.querySelector('#mc-live-ladder');

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

  let programPrepared = false;

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
    if (prepareBtn) {
      prepareBtn.hidden = onAir;
      prepareBtn.disabled = livePhase === 'preparing' || livePhase === 'starting' || livePhase === 'stopping';
      prepareBtn.classList.toggle('is-prepared', programPrepared);
      prepareBtn.setAttribute('aria-pressed', programPrepared ? 'true' : 'false');
      prepareBtn.textContent = t(programPrepared ? 'mc.cc.dock.program_ready' : 'mc.cc.dock.prepare_live');
    }
    if (startBtn) {
      startBtn.hidden = onAir;
      const block = onAir || startInFlight || livePhase === 'starting' || livePhase === 'stopping' || lastLadder.canStart === false;
      startBtn.disabled = block;
      startBtn.title = lastLadder.reason || (block ? (lastLadder.state || '') : t('mc.cc.dock.start_live'));
      startBtn.setAttribute('aria-disabled', block ? 'true' : 'false');
    }
    if (removeBtn) removeBtn.hidden = !onAir;
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
  }

  function repaintCamHealth(director) {
    const badge = hostEl.querySelector('#mc-cam-health');
    const detail = hostEl.querySelector('#mc-cam-health-detail');
    if (!badge) return;
    const lbl = badge.querySelector('.mc-cam-health-label');
    const data = director && director.data;
    if (!data) {
      badge.className = 'mc-cam-health mc-cam-unknown';
      if (lbl) lbl.textContent = t('mc.cc.camera.unavailable');
      if (detail) detail.innerHTML = `<span>${esc(t('mc.cc.camera.unavailable'))}</span>`;
      return;
    }
    const cams = [
      { n: 1, name: 'Focus 210', online: !!data.kamrui_camera_1_stream },
      { n: 2, name: 'Camera 2', online: !!data.kamrui_camera_2_stream },
      { n: 3, name: 'ANNKE', online: !!data.annke_camera_3_stream },
    ];
    const up = cams.filter((cam) => cam.online).length;
    const active = Number(data.director && data.director.active_camera) || null;
    const cls = up === cams.length ? 'mc-cam-green' : (up > 0 ? 'mc-cam-yellow' : 'mc-cam-red');
    const txt = active && cams.some((cam) => cam.n === active && cam.online)
      ? t('mc.cc.camera.active', { n: active, count: up })
      : t('mc.cc.camera.online', { count: up });
    badge.className = 'mc-cam-health ' + cls;
    if (lbl) lbl.textContent = txt;
    if (detail) {
      const audioMode = data.audio_mode || data.effective_audio_mode || null;
      const modeLine = audioMode
        ? `<span class="mc-cam-detail-row"><b>Audio</b><em>${esc(String(audioMode))}</em></span>`
        : '';
      const aiLine = `<span class="mc-cam-detail-row"><b>AI</b><em>${esc(String(data.director_mode || data.mode || 'manual'))}${data.autoswitch_enabled ? ' · autoswitch' : ''}</em></span>`;
      detail.innerHTML = cams.map((cam) => {
        const selected = active === cam.n;
        const state = selected && cam.online         
          ? t('mc.cc.camera.selected')
          : (cam.online ? t('mc.cc.camera.ready') : t('mc.cc.camera.offline'));
        return `<span class="mc-cam-detail-row${selected ? ' is-active' : ''}"><b>${esc(cam.name)}</b><em>${esc(state)}</em></span>`;
      }).join('') + modeLine + aiLine;
    }
  }

  let syncingLive = false;
  async function syncLive() {
    if (syncingLive) return;
    syncingLive = true;
    let director = null;
    let status = null;
    try {
      status = await api.liveStream.status();
      director = status && status.ai_director;
      const data = director && director.data;
      const onAir = !!(data && data.stream_active === true)
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
      if (status?.program_prepared === true || status?.capabilities?.program_prepared === true) {
        programPrepared = true;
      }
      if (status?.production_plan) activeProductionPlan = status.production_plan;
      recordingActive = !!(data && data.recording_active === true)
        || status?.recording_state === 'active'
        || status?.recording_active === true;
      lastLadder = deriveLiveLadder(status, { phase: livePhase });
    } catch {
      if (!startInFlight) liveActive = false;
      lastLadder = { state: LIVE_LADDER.UNKNOWN, canStart: false, reason: 'Status unavailable' };
    } finally {
      liveStateKnown = true;
      syncingLive = false;
    }
    repaintLive();
    repaintCamHealth(director);
  }

  const cameraBadge = hostEl.querySelector('#mc-cam-health');
  const cameraDetail = hostEl.querySelector('#mc-cam-health-detail');
  if (cameraBadge && cameraDetail) {
    cameraBadge.addEventListener('click', () => {
      cameraDetail.hidden = !cameraDetail.hidden;
      cameraBadge.setAttribute('aria-expanded', cameraDetail.hidden ? 'false' : 'true');
    });
  }

  async function onPrepareLive() {
    if (!prepareBtn || prepareBtn.disabled) return;
    prepareBtn.disabled = true;
    livePhase = 'preparing';
    lastLadder = deriveLiveLadder(null, { phase: 'preparing' });
    repaintLive();
    try {
      const plan = await openPrepareLiveProductionModal();
      if (!plan) {
        livePhase = null;
        return;
      }
      activeProductionPlan = plan;
      programPrepared = true;
      livePhase = null;
      showToast(t('mc.cc.live.prepared'), 'success');
    } catch (e) {
      programPrepared = false;
      livePhase = null;
      showToast(formatLiveFailure(e), 'error');
    } finally {
      prepareBtn.disabled = false;
      await syncLive();
    }
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
    if (!activeProductionPlan || !activeProductionPlan.production_plan_id) {
      const plan = await openPrepareLiveProductionModal();
      if (!plan) return;
      activeProductionPlan = plan;
      programPrepared = true;
    }
    const plan = activeProductionPlan;
    const summary = [
      `Mode: ${plan.production_mode}`,
      `Director: ${plan.director_mode}`,
      plan.camera_id ? `Camera: ${plan.camera_id}` : null,
      `Audio: ${plan.audio_mode}`,
      `Recording: ${plan.recording_requested ? 'yes' : 'no'}`,
    ].filter(Boolean).join('\n');
    const ok = await confirmDialog({
      title: t('mc.cc.confirm.start_live_title'),
      message: `${t('mc.cc.confirm.start_live')}\n\n${summary}`,
      confirmLabel: t('mc.cc.dock.start_live'),
      tone: 'default',
    });
    if (!ok) return;
    startInFlight = true;
    livePhase = 'starting';
    lastLadder = deriveLiveLadder(null, { phase: 'starting' });
    repaintLive();
    try {
      await api.liveStream.start({
        production_plan_id: plan.production_plan_id,
        production_mode: plan.production_mode,
        director_mode: plan.director_mode,
        camera_id: plan.camera_id,
        scene_name: plan.scene_name,
        audio_mode: plan.audio_mode,
        recording_requested: !!plan.recording_requested,
        confirm_auto_canary: plan.production_mode === 'ai_director' || !!plan.confirm_auto_canary,
        initiator: 'operator',
      });
      programPrepared = true;
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

  async function onRemoveLive() {
    if (!liveActive) {
      showToast(t('mc.cc.live.not_active'), 'info');
      return;
    }
    try {
      await api.liveStream.clearContent();
      showToast(t('mc.cc.live.cleared'), 'success');
      if (typeof cb.onLiveChanged === 'function') cb.onLiveChanged();
    } catch (e) {
      showToast(formatLiveFailure(e), 'error');
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
        case 'prepare-live': await onPrepareLive(); break;
        case 'record-toggle': await onRecordToggle(); break;
        case 'start-live': await onStartLive(); break;
        case 'stop-live': await onStopLive(); break;
        case 'remove-live': await onRemoveLive(); await syncLive(); break;
        case 'add-display': if (typeof cb.onAddDisplay === 'function') cb.onAddDisplay(); break;
      }
    });
  });

  syncLive();
  const healthTimer = setInterval(() => syncLive(), 5000);
  return {
    syncLive,
    repaintBlank,
    destroy() { clearInterval(healthTimer); },
  };
}
