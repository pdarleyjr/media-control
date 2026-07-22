// Screen-share panel (task §10).
//
// Shows source connection, received video/audio tracks, resolution, frame rate,
// transport (direct WebRTC vs degraded fallback), selected layout, fit mode,
// camera PiP state, latency/health summary, and stop+restore. Degraded
// fallback is labelled explicitly — never silent. Diagnostics come from the
// existing screen-share-engine via the adapter; mock fixture used in tests.
import { esc } from '../display-layout/render-helpers.js';

export function mountScreenSharePanel(host, { store, i18n, adapter, engine = null, api = null }) {
  if (!host) throw new Error('mountScreenSharePanel requires a host element');
  host.classList.add('mc-e-ss-panel');
  host.setAttribute('data-component', 'screen-share-panel');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', i18n ? i18n('mc.e.ss.aria') : 'Screen share');

  function diagnostics() {
    if (api && typeof api.screenShare?.diagnostics === 'function') return api.screenShare.diagnostics(engine);
    if (engine && typeof engine.getTargetDiagnostics === 'function') return engine.getTargetDiagnostics();
    return null;
  }

  function render() {
    const diag = diagnostics() || {};
    const degraded = diag.degraded === true || diag.transport === 'relay-jpeg' || diag.audioTrack === false;
    const reasons = (diag.degradedReasons || []).map((r) => `<li>${esc(r.replace(/_/g, ' '))}</li>`).join('');
    const video = diag.videoTrack ? '✓' : '✕';
    const audio = diag.audioTrack ? '✓' : '✕';

    host.innerHTML = `
      <header class="mc-e-ss-head">
        <h2 class="mc-e-ss-title">${esc(i18n ? i18n('mc.e.ss.title') : 'Screen share')}</h2>
        ${degraded ? `<span class="mc-e-ss-degraded" role="alert"><strong>${esc(i18n ? i18n('mc.e.ss.degraded') : 'DEGRADED FALLBACK')}</strong></span>` : `<span class="mc-e-ss-direct">${esc(i18n ? i18n('mc.e.ss.direct') : 'Direct WebRTC')}</span>`}
      </header>
      ${degraded ? `<ul class="mc-e-ss-degraded-reasons" role="list">${reasons || `<li>${esc(i18n ? i18n('mc.e.ss.video_only') : 'Video only')}</li>`}</ul>` : ''}
      <dl class="mc-e-ss-stats">
        <dt>${esc(i18n ? i18n('mc.e.ss.source') : 'Source connected')}</dt><dd>${diag.sourceConnected === false ? '✕' : '✓'}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.video_track') : 'Video track')}</dt><dd>${video}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.audio_track') : 'Audio track')}</dt><dd>${audio}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.resolution') : 'Resolution')}</dt><dd>${esc(diag.resolution || '—')}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.fps') : 'Frame rate')}</dt><dd>${diag.frameRate ? `${diag.frameRate} fps` : '—'}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.transport') : 'Transport')}</dt><dd>${esc(diag.transport || '—')}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.fit') : 'Fit mode')}</dt><dd>${esc(diag.fitMode || 'contain')}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.pip') : 'Camera PiP')}</dt><dd>${diag.cameraPip ? '✓' : '✕'}</dd>
        <dt>${esc(i18n ? i18n('mc.e.ss.latency') : 'Latency/health')}</dt><dd>${esc(diag.latencyLabel || (diag.degraded ? 'degraded' : 'good'))}</dd>
      </dl>
      <div class="mc-e-ss-actions">
        <button type="button" class="mc-e-ss-stop" data-ss-action="stop">${esc(i18n ? i18n('mc.e.ss.stop') : 'Stop')}</button>
        <button type="button" class="mc-e-ss-restore" data-ss-action="restore">${esc(i18n ? i18n('mc.e.ss.restore') : 'Restore prior content')}</button>
      </div>`;
  }

  host.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-ss-action]');
    if (!btn) return;
    const action = btn.getAttribute('data-ss-action');
    if (action === 'stop' && engine && typeof engine.stopAll === 'function') engine.stopAll();
    if (action === 'restore' && adapter) {
      const d = (store.get()?.displays || [])[0];
      if (d) adapter.sendCommand(d.id, 'transport', { action: 'restore' });
    }
  });

  const unsub = store.subscribe(render);
  render();
  return () => { unsub(); host.innerHTML = ''; host.removeAttribute('data-component'); };
}

export default mountScreenSharePanel;
