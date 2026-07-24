// Room Overview component (task §6, enhanced 2026-07-24).
//
// Renders an at-a-glance physical display map + health/program summary so an
// operator can understand the room in seconds without diagnostic panels. Pure
// consumer of the operator store (no direct socket/api calls). Mount returns a
// cleanup function (matching the codebase convention).
//
// The overview shows:
// - Each wall with its member displays in a responsive grid
// - Standalone displays in a separate section
// - Online/offline status, blank/on status, current content
// - Wall leader, layout mode, audio authority
// - "Open Focus View" action per display/wall
import { OPERATOR_STATE } from '../../state/operator-state.js';
import { stateChip, esc, el } from '../display-layout/render-helpers.js';

function displayPreviewHtml(display) {
  const screenshot = display.screenshot_url;
  const poster = display.now_playing?.poster_url;
  const src = poster || screenshot;
  if (src) {
    return `<img src="${esc(src)}" alt="${esc(display.name || '')}" loading="lazy">`;
  }
  return `<span class="mc-e-ro-display-preview-empty">${esc(display.now_playing?.kind || 'No preview')}</span>`;
}

function displayCardHtml(display, i18n, wallContext) {
  const offline = !display.online;
  const state = display.opState || (offline ? OPERATOR_STATE.OFFLINE : OPERATOR_STATE.STANDBY);
  const content = display.mediaTitle || display.contentType || (i18n ? i18n('mc.e.overview.idle', 'Idle') : 'Idle');
  const wallInfo = wallContext
    ? `<span class="mc-e-ro-wall">${esc(wallContext.name || wallContext.id || '')}</span>`
    : '';
  const deviceId = esc(display.id || '');
  const wallId = esc(display.wallId || '');

  return `<li class="mc-e-ro-display ${offline ? 'is-offline' : ''}" data-display-id="${deviceId}" data-wall-id="${wallId}" data-op-state="${state}">
    <div class="mc-e-ro-display-preview">
      ${displayPreviewHtml(display)}
    </div>
    <div class="mc-e-ro-display-name" title="${esc(display.name || '')}">${esc(display.name || 'Unnamed')}</div>
    <div class="mc-e-ro-display-content" title="${esc(content)}">${esc(content)}</div>
    ${wallInfo}
    ${stateChip(state, i18n)}
    <div class="mc-e-ro-display-action">
      <button type="button" class="mc-e-ro-focus-btn" data-focus-display="${deviceId}" data-focus-wall="${wallId}">
        ${esc(i18n ? i18n('mc.e.overview.open_focus', 'Open Focus View') : 'Open Focus View')}
      </button>
    </div>
  </li>`;
}

function wallSectionHtml(wall, i18n) {
  const members = wall.members || [];
  const leader = members.find((m) => m.id === wall.leaderDeviceId) || members[0];
  const leaderName = leader ? esc(leader.name || leader.id || '') : '—';
  const layoutLabel = wall.layoutMode === 'split' ? 'Split' : wall.layoutMode === 'groups' ? 'Groups' : 'Span';

  return `<section class="mc-e-ro-wall-section" data-wall-id="${esc(wall.id || '')}">
    <header class="mc-e-ro-wall-header">
      <h3 class="mc-e-ro-wall-name">${esc(wall.name || wall.id || 'Wall')}</h3>
      <span class="mc-e-ro-wall-meta">${esc(wall.memberCount || members.length)} displays · ${esc(layoutLabel)} · Leader: ${leaderName}</span>
    </header>
    <ul class="mc-e-ro-map" aria-label="${esc(wall.name || 'Wall displays')}">
      ${members.map((m) => displayCardHtml(m, i18n, { name: wall.name, id: wall.id })).join('') || `<li class="mc-e-ro-empty">${esc(i18n ? i18n('mc.e.overview.no_displays', 'No displays') : 'No displays')}</li>`}
    </ul>
  </section>`;
}

// Audio status block (task §9). Displays CONFIRMED/PENDING/FAILED/STALE/UNAVAILABLE
// based on the real audio-state contract from the room snapshot.
function audioStatusBlock(audioState, stale, i18n) {
  const L = (k, fallback) => esc(i18n ? i18n(k, fallback) : fallback);
  if (!audioState || !audioState.classroomAudio) {
    return `<div class="mc-e-ro-audio mc-e-ro-audio-unavailable" role="status">
      <span class="mc-e-ro-audio-label">${L('mc.e.audio.label', 'Classroom audio')}</span>
      <span class="mc-e-ro-audio-unavailable-reason">${L('mc.e.audio.unavailable', 'Audio state unavailable — controls disabled')}</span>
    </div>`;
  }
  const ca = audioState.classroomAudio;
  let stateClass = 'mc-e-audio-confirmed';
  let stateText = L('mc.e.audio.confirmed', 'Confirmed');
  const details = [];
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
  return `<div class="mc-e-ro-audio ${stateClass}" role="status" data-audio-status="${esc(ca.status || '')}">
    <span class="mc-e-ro-audio-label">${L('mc.e.audio.label', 'Classroom audio')}</span>
    <span class="mc-e-ro-audio-state">${stateText}</span>
    ${ca.rendererName ? `<span class="mc-e-ro-audio-renderer">${esc(ca.rendererName)}</span>` : ''}
    ${detailStr}
  </div>`;
}

export function mountRoomOverview(host, { store, i18n, onFocusView } = {}) {
  if (!host) throw new Error('mountRoomOverview requires a host element');
  if (!store || typeof store.subscribe !== 'function') throw new Error('mountRoomOverview requires the operator store');

  host.classList.add('mc-e-room-overview');
  host.setAttribute('data-component', 'room-overview');
  host.setAttribute('role', 'region');
  host.setAttribute('aria-label', i18n ? i18n('mc.e.overview.region_label', 'Room overview') : 'Room overview');

  function handleClick(event) {
    const btn = event.target.closest('[data-focus-display]');
    if (!btn) return;
    event.preventDefault();
    event.stopPropagation();
    const displayId = btn.dataset.focusDisplay;
    const wallId = btn.dataset.focusWall;
    if (typeof onFocusView === 'function') {
      if (wallId) {
        onFocusView({ type: 'wall', id: wallId });
      } else if (displayId) {
        onFocusView({ type: 'display', id: displayId });
      }
    }
  }

  host.addEventListener('click', handleClick);

  function render(state) {
    if (!state) {
      host.innerHTML = `<div class="mc-e-ro-loading" role="status">${esc(i18n ? i18n('mc.e.overview.loading', 'Loading room state…') : 'Loading room state…')}</div>`;
      return;
    }
    const walls = state.walls || [];
    const standaloneDisplays = state.standaloneDisplays || [];
    const dh = state.deviceHealth || {};
    const recording = state.recording ? stateChip(state.recording.opState, i18n) : '';
    const stream = state.stream ? stateChip(state.stream.opState, i18n) : '';
    const live = state.livestream
      ? `<span class="mc-e-ro-program" data-program="livestream">${esc(i18n ? i18n('mc.e.overview.livestream', 'Livestream') : 'Livestream')} ${stateChip(state.livestream.opState, i18n)}</span>`
      : '';
    const stale = state.stale ? `<span class="mc-e-ro-stale-flag" role="status">${esc(i18n ? i18n('mc.e.op_state.stale', 'Stale') : 'Stale')}</span>` : '';

    const summary = [
      `${dh.online || 0}/${dh.total || 0} ${esc(i18n ? i18n('mc.e.overview.online', 'online') : 'online')}`,
      dh.offline ? `${dh.offline} ${esc(i18n ? i18n('mc.e.overview.offline', 'offline') : 'offline')}` : '',
      dh.failed ? `${dh.failed} ${esc(i18n ? i18n('mc.e.overview.failed', 'failed') : 'failed')}` : '',
      state.pendingCommands?.length ? `${state.pendingCommands.length} ${esc(i18n ? i18n('mc.e.overview.pending', 'pending') : 'pending')}` : '',
    ].filter(Boolean).join(' · ');

    const wallSections = walls.map((wall) => wallSectionHtml(wall, i18n)).join('');

    const standaloneSection = standaloneDisplays.length > 0
      ? `<section class="mc-e-ro-standalone-section">
          <h3 class="mc-e-ro-standalone-header">${esc(i18n ? i18n('mc.e.overview.standalone', 'Standalone Displays') : 'Standalone Displays')}</h3>
          <ul class="mc-e-ro-map" aria-label="${esc(i18n ? i18n('mc.e.overview.standalone_label', 'Standalone displays') : 'Standalone displays')}">
            ${standaloneDisplays.map((d) => displayCardHtml(d, i18n, null)).join('')}
          </ul>
        </section>`
      : '';

    host.innerHTML = `
      <header class="mc-e-ro-header">
        <h2 class="mc-e-ro-title">${esc(i18n ? i18n('mc.e.overview.title', 'Room Overview') : 'Room Overview')}</h2>
        <div class="mc-e-ro-summary" role="status">${summary}</div>
        ${stale}
      </header>
      <div class="mc-e-ro-aggregate">${stateChip(state.aggregateState, i18n)}</div>
      ${wallSections}
      ${standaloneSection}
      ${audioStatusBlock(state.classroomProgram?.audioState, state.stale, i18n)}
      <footer class="mc-e-ro-footer">
        <span class="mc-e-ro-classroom">${esc(i18n ? i18n('mc.e.overview.classroom_program', 'Classroom program') : 'Classroom program')}: ${state.classroomProgram ? esc(String(state.classroomProgram.targets?.length ?? 0)) : '—'}</span>
        ${live}
        ${recording ? `<span class="mc-e-ro-recording">${esc(i18n ? i18n('mc.e.overview.recording', 'Recording') : 'Recording')} ${recording}</span>` : ''}
        ${stream ? `<span class="mc-e-ro-stream">${esc(i18n ? i18n('mc.e.overview.stream', 'Stream') : 'Stream')} ${stream}</span>` : ''}
      </footer>
    `;
  }

  const unsub = store.subscribe(render);
  render(store.get());
  return () => {
    unsub();
    host.removeEventListener('click', handleClick);
    host.innerHTML = '';
    host.removeAttribute('data-component');
  };
}

export default mountRoomOverview;
