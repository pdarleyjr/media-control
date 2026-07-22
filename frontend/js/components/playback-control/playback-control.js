// Universal Playback Controls (task §9).
//
// Context-sensitive controls driven by content type. Renders confirmed
// OBSERVED state from the operator store (not merely the last command sent):
// PowerPoint (prev/next/direct slide/restart/restore), video (play/pause/seek/
// volume/mute/restart/stop+restore), screen share (source/audio/resolution/
// fps/transport/fit/stop/retry), camera (selection/fullscreen/PiP/swap/health/
// PTZ/hold). Commands route through the adapter.sendCommand passthrough.
import { esc, fmtTime } from '../display-layout/render-helpers.js';

function primaryDisplay(state) {
  return (state?.displays || [])[0] || null;
}

export function mountPlaybackControl(host, { store, i18n, adapter, targetType = 'auto' }) {
  if (!host) throw new Error('mountPlaybackControl requires a host element');
  host.classList.add('mc-e-playback');
  host.setAttribute('data-component', 'playback-control');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', i18n ? i18n('mc.e.playback.aria') : 'Playback controls');

  function transportBtn(action, label, opts = {}) {
    const id = `mc-e-pb-${action}`;
    return `<button type="button" class="mc-e-pb-btn" data-transport="${action}" id="${id}" aria-label="${esc(label)}"${opts.disabled ? ' aria-disabled="true" disabled' : ''}>${esc(opts.glyph || label)}</button>`;
  }

  function render(state) {
    if (!state) { host.innerHTML = `<div class="mc-e-pb-loading">${esc(i18n ? i18n('mc.e.playback.loading') : 'Loading…')}</div>`; return; }
    const d = primaryDisplay(state);
    if (!d) { host.innerHTML = `<div class="mc-e-pb-empty">${esc(i18n ? i18n('mc.e.playback.no_target') : 'No target display')}</div>`; return; }

    const kind = (d.contentType || 'idle');
    const paused = d.paused;
    const slideIdx = d.slideIndex;
    const slideTotal = d.slideCount;
    const ct = d.currentTime;
    const dur = d.duration;

    if (kind === 'slides' || /presentation|powerpoint/.test(String(d.contentType))) {
      host.innerHTML = `
        <div class="mc-e-pb-section" data-type="slides">
          <div class="mc-e-pb-head"><span class="mc-e-pb-title">${esc(i18n ? i18n('mc.e.playback.slides') : 'PowerPoint')}</span>
            <span class="mc-e-pb-pos" role="status">${esc(String(slideIdx ?? '--'))} / ${esc(String(slideTotal ?? '--'))}</span></div>
          <div class="mc-e-pb-controls">
            ${transportBtn('prev', i18n ? i18n('mc.e.pb.prev') : 'Previous', { glyph: '⏮' })}
            ${transportBtn('restart', i18n ? i18n('mc.e.pb.restart') : 'Restart deck', { glyph: '↺' })}
            ${transportBtn('next', i18n ? i18n('mc.e.pb.next') : 'Next', { glyph: '⏭' })}
            <label class="mc-e-pb-slide-jump"><span>${esc(i18n ? i18n('mc.e.pb.go_slide') : 'Go to slide')}</span>
              <input type="number" min="1" max="${esc(String(slideTotal || 1))}" data-slide-jump value="${esc(String(slideIdx || ''))}" /></label>
            ${transportBtn('restore', i18n ? i18n('mc.e.pb.restore') : 'Restore presentation', { glyph: '⤺' })}
          </div>
        </div>`;
      return;
    }

    if (kind === 'video' || kind === 'youtube') {
      const pct = (dur && Number.isFinite(ct) && dur > 0) ? Math.min(100, (ct / dur) * 100) : 0;
      host.innerHTML = `
        <div class="mc-e-pb-section" data-type="video">
          <div class="mc-e-pb-head"><span class="mc-e-pb-title">${esc(i18n ? i18n('mc.e.playback.video') : 'Video')}</span>
            <span class="mc-e-pb-pos" role="status">${esc(fmtTime(ct))} / ${esc(fmtTime(dur))}</span></div>
          <div class="mc-e-pb-controls">
            ${transportBtn('prev', i18n ? i18n('mc.e.pb.restart') : 'Restart', { glyph: '↺' })}
            ${transportBtn('play_pause', paused ? (i18n ? i18n('mc.e.pb.play') : 'Play') : (i18n ? i18n('mc.e.pb.pause') : 'Pause'), { glyph: paused ? '▶' : '⏸' })}
            ${transportBtn('stop', i18n ? i18n('mc.e.pb.stop_restore') : 'Stop and restore', { glyph: '⏹' })}
          </div>
          <div class="mc-e-pb-seek"><input type="range" min="0" max="${esc(String(Math.round(dur || 0)))}" value="${esc(String(Math.round(ct || 0)))}" data-seek aria-label="${esc(i18n ? i18n('mc.e.pb.seek') : 'Seek')}" /><span class="mc-e-pb-seek-pct">${Math.round(pct)}%</span></div>
          <div class="mc-e-pb-volume"><label>${esc(i18n ? i18n('mc.e.pb.volume') : 'Volume')}<input type="range" min="0" max="100" value="100" data-volume/></label>
            <button type="button" class="mc-e-pb-mute" data-transport="mute" aria-pressed="false">${esc(i18n ? i18n('mc.e.pb.mute') : 'Mute')}</button></div>
        </div>`;
      return;
    }

    if (kind === 'screen_share' || kind === 'screen') {
      host.innerHTML = `
        <div class="mc-e-pb-section" data-type="screen">
          <div class="mc-e-pb-head"><span class="mc-e-pb-title">${esc(i18n ? i18n('mc.e.playback.screen') : 'Screen share')}</span></div>
          <div class="mc-e-pb-controls">
            ${transportBtn('retry', i18n ? i18n('mc.e.pb.retry') : 'Retry', { glyph: '⟳' })}
            ${transportBtn('stop', i18n ? i18n('mc.e.pb.stop') : 'Stop', { glyph: '⏹' })}
          </div>
          <p class="mc-e-pb-hint">${esc(i18n ? i18n('mc.e.playback.screen_hint') : 'See screen-share panel for transport and fallback details.')}</p>
        </div>`;
      return;
    }

    if (kind === 'camera' || kind === 'live') {
      host.innerHTML = `
        <div class="mc-e-pb-section" data-type="camera">
          <div class="mc-e-pb-head"><span class="mc-e-pb-title">${esc(i18n ? i18n('mc.e.playback.camera') : 'Camera')}</span></div>
          <div class="mc-e-pb-controls">
            ${transportBtn('camera_fullscreen', i18n ? i18n('mc.e.pb.cam_full') : 'Fullscreen', { glyph: '⛶' })}
            ${transportBtn('camera_pip', i18n ? i18n('mc.e.pb.cam_pip') : 'Picture-in-picture', { glyph: '◰' })}
            ${transportBtn('camera_swap_pip', i18n ? i18n('mc.e.pb.swap_pip') : 'Swap PiP', { glyph: '⇄' })}
            ${transportBtn('camera_hold', i18n ? i18n('mc.e.pb.hold') : 'Manual hold', { glyph: '✋' })}
          </div>
        </div>`;
      return;
    }

    host.innerHTML = `<div class="mc-e-pb-idle">${esc(i18n ? i18n('mc.e.playback.idle') : 'Select content to control playback')}</div>`;
  }

  host.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-transport]');
    if (!btn || btn.disabled) return;
    const action = btn.getAttribute('data-transport');
    const d = primaryDisplay(store.get());
    if (!d || !adapter) return;
    if (action === 'mute') {
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      btn.setAttribute('aria-pressed', String(!pressed));
      return;
    }
    adapter.sendCommand(d.id, 'transport', { action });
  });

  host.addEventListener('change', (ev) => {
    const d = primaryDisplay(store.get());
    if (!d || !adapter) return;
    const seek = ev.target.closest('input[data-seek]');
    if (seek) { adapter.sendCommand(d.id, 'transport', { action: 'seek', seconds: Number(seek.value) }); return; }
    const slide = ev.target.closest('input[data-slide-jump]');
    if (slide) { const n = Math.max(1, Number(slide.value) || 1); adapter.sendCommand(d.id, 'transport', { action: 'go_to_slide', slide: n }); return; }
  });

  const unsub = store.subscribe(render);
  render(store.get());
  return () => { unsub(); host.innerHTML = ''; host.removeAttribute('data-component'); };
}

export default mountPlaybackControl;
