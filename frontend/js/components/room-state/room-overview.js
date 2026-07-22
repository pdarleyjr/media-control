// Room Overview component (task §6).
//
// Renders an at-a-glance physical display map + health/program summary so an
// operator can understand the room in seconds without diagnostic panels. Pure
// consumer of the operator store (no direct socket/api calls). Mount returns a
// cleanup function (matching the codebase convention).
import { OPERATOR_STATE } from '../../state/operator-state.js';
import { stateChip, esc, el } from '../display-layout/render-helpers.js';

function displayCard(display, i18n) {
  const offline = !display.online;
  const state = offline ? OPERATOR_STATE.OFFLINE : display.opState;
  const content = display.mediaTitle || display.contentType || (i18n ? i18n('mc.e.overview.idle') : 'Idle');
  const wall = display.wallId ? `<span class="mc-e-ro-wall">${esc(i18n ? i18n('mc.e.overview.wall') : 'Wall')}: ${esc(display.wallId)}</span>` : '';
  return `<li class="mc-e-ro-display ${offline ? 'is-offline' : ''}" data-display-id="${esc(display.id)}" data-op-state="${state}">
    <div class="mc-e-ro-display-name">${esc(display.name)}</div>
    <div class="mc-e-ro-display-content" title="${esc(content)}">${esc(content)}</div>
    ${wall}
    ${stateChip(state, i18n)}
  </li>`;
}

// Audio status block (task §9). Displays CONFIRMED/PENDING/FAILED/STALE/UNAVAILABLE
// based on the real audio-state contract from the room snapshot. When the contract
// is absent, shows "audio state unavailable" and disables audio controls.
function audioStatusBlock(audioState, stale, i18n) {
  const L = (k, fallback) => esc(i18n ? i18n(k) : fallback);
  if (!audioState) {
    return `<div class="mc-e-ro-audio mc-e-ro-audio-unavailable" role="status">
      <span class="mc-e-ro-audio-label">${L('mc.e.audio.label', 'Classroom audio')}</span>
      <span class="mc-e-ro-audio-unavailable-reason">${L('mc.e.audio.unavailable', 'Audio state unavailable — controls disabled')}</span>
    </div>`;
  }
  const ca = audioState.classroomAudio;
  if (!ca) {
    return `<div class="mc-e-ro-audio mc-e-ro-audio-unavailable" role="status">
      <span class="mc-e-ro-audio-label">${L('mc.e.audio.label', 'Classroom audio')}</span>
      <span class="mc-e-ro-audio-unavailable-reason">${L('mc.e.audio.unavailable', 'Audio state unavailable — controls disabled')}</span>
    </div>`;
  }
  // Map audio status to display state
  let stateClass = 'mc-e-audio-confirmed';
  let stateText = L('mc.e.audio.confirmed', 'Confirmed');
  let details = [];
  if (stale || (ca.lastConfirmedAt && Date.now() - new Date(ca.lastConfirmedAt).getTime() > 60000)) {
    stateClass = 'mc-e-audio-stale';
    stateText = L('mc.e.audio.stale', 'Stale');
  } else if (ca.status === 'error') {
    stateClass = 'mc-e-audio-error';
    stateText = L('mc.e.audio.error', 'Error');
  } else if (ca.status === 'unconfirmed') {
    stateClass = 'mc-e-audio-unconfirmed';
    stateText = L('mc.e.audio.unconfirmed', 'Unconfirmed');
  }
  if (ca.muted) details.push(L('mc.e.audio.muted', 'Muted'));
  if (ca.volume != null) details.push(`${L('mc.e.audio.volume', 'Volume')}: ${Math.round(ca.volume * 100)}%`);
  if (ca.trackPresent === false) details.push(L('mc.e.audio.no_track', 'No audio track received'));
  if (ca.autoplayBlocked) details.push(L('mc.e.audio.autoplay_blocked', 'Browser blocked audio'));
  if (!ca.rendererName && ca.status === 'error') details.push(L('mc.e.audio.classroom_unavailable', 'Classroom output unavailable'));
  const detailStr = details.length ? `<span class="mc-e-ro-audio-details">${details.join(' · ')}</span>` : '';
  return `<div class="mc-e-ro-audio ${stateClass}" role="status" data-audio-status="${esc(ca.status)}">
    <span class="mc-e-ro-audio-label">${L('mc.e.audio.label', 'Classroom audio')}</span>
    <span class="mc-e-ro-audio-state">${stateText}</span>
    ${ca.rendererName ? `<span class="mc-e-ro-audio-renderer">${esc(ca.rendererName)}</span>` : ''}
    ${detailStr}
  </div>`;
}

export function mountRoomOverview(host, { store, i18n }) {
  if (!host) throw new Error('mountRoomOverview requires a host element');
  if (!store || typeof store.subscribe !== 'function') throw new Error('mountRoomOverview requires the operator store');

  host.classList.add('mc-e-room-overview');
  host.setAttribute('data-component', 'room-overview');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', i18n ? i18n('mc.e.overview.region_label') : 'Room overview');

  function render(state) {
    if (!state) {
      host.innerHTML = `<div class="mc-e-ro-loading" role="status">${esc(i18n ? i18n('mc.e.overview.loading') : 'Loading room state…')}</div>`;
      return;
    }
    const displays = state.displays || [];
    const dh = state.deviceHealth || {};
    const recording = state.recording ? stateChip(state.recording.opState, i18n) : '';
    const stream = state.stream ? stateChip(state.stream.opState, i18n) : '';
    const live = state.livestream
      ? `<span class="mc-e-ro-program" data-program="livestream">${esc(i18n ? i18n('mc.e.overview.livestream') : 'Livestream')} ${stateChip(state.livestream.opState, i18n)}</span>`
      : '';
    const stale = state.stale ? `<span class="mc-e-ro-stale-flag" role="status">${esc(i18n ? i18n('mc.e.op_state.stale') : 'Stale')}</span>` : '';

    const summary = [
      `${dh.online}/${dh.total} ${esc(i18n ? i18n('mc.e.overview.online') : 'online')}`,
      dh.offline ? `${dh.offline} ${esc(i18n ? i18n('mc.e.overview.offline') : 'offline')}` : '',
      dh.failed ? `${dh.failed} ${esc(i18n ? i18n('mc.e.overview.failed') : 'failed')}` : '',
      state.pendingCommands?.length ? `${state.pendingCommands.length} ${esc(i18n ? i18n('mc.e.overview.pending') : 'pending')}` : '',
    ].filter(Boolean).join(' · ');

    host.innerHTML = `
      <header class="mc-e-ro-header">
        <h2 class="mc-e-ro-title">${esc(i18n ? i18n('mc.e.overview.title') : 'Room overview')}</h2>
        <div class="mc-e-ro-summary" role="status">${summary}</div>
        ${stale}
      </header>
      <div class="mc-e-ro-aggregate">${stateChip(state.aggregateState, i18n)}</div>
      <ul class="mc-e-ro-map" aria-label="${esc(i18n ? i18n('mc.e.overview.map_label') : 'Display map')}">
        ${displays.map((d) => displayCard(d, i18n)).join('') || `<li class="mc-e-ro-empty">${esc(i18n ? i18n('mc.e.overview.no_displays') : 'No displays')}</li>`}
      </ul>
      ${audioStatusBlock(state.classroomProgram?.audioState, state.stale, i18n)}
      <footer class="mc-e-ro-footer">
        <span class="mc-e-ro-classroom">${esc(i18n ? i18n('mc.e.overview.classroom_program') : 'Classroom program')}: ${state.classroomProgram ? esc(String(state.classroomProgram.targets?.length ?? 0)) : '—'}</span>
        ${live}
        ${recording ? `<span class="mc-e-ro-recording">${esc(i18n ? i18n('mc.e.overview.recording') : 'Recording')} ${recording}</span>` : ''}
        ${stream ? `<span class="mc-e-ro-stream">${esc(i18n ? i18n('mc.e.overview.stream') : 'Stream')} ${stream}</span>` : ''}
      </footer>
    `;
  }

  const unsub = store.subscribe(render);
  render(store.get());
  return () => { unsub(); host.innerHTML = ''; host.removeAttribute('data-component'); };
}

export default mountRoomOverview;
