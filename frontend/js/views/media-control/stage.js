// Stage — the "displays you are controlling" surface of the unified Media
// Control dashboard. Renders one card per SELECTED display at the display's
// TRUE aspect ratio (so a portrait kiosk looks portrait), a live screenshot
// with a freshness caption, a status dot, and the now-playing label.
//
// Each card includes a transport bar (Task 4.6): prev / play_pause / next /
// restart buttons and a Blank toggle via renderTransportBar from transport.js.
//
// Wall members never render as their own card: a video wall is a single
// logical display, so it gets ONE wall card (mirrors dashboard.js:789-793).
// The caller (media-control.js) owns selection persistence + wall de-dup and
// hands us the already-filtered data; we are a pure render function.

import { esc } from '../../utils.js';
import { t, tn } from '../../i18n.js';
import { renderTransportBar } from './transport.js';

// "Updated Ns ago" from a unix-seconds timestamp. > 30s is considered stale.
const STALE_AFTER_S = 30;
function freshness(screenshotAt) {
  if (!screenshotAt) return { text: t('mc.fresh.none'), stale: true };
  const age = Math.max(0, Math.floor(Date.now() / 1000) - screenshotAt);
  const stale = age > STALE_AFTER_S;
  let text;
  if (age < 5) text = t('mc.fresh.just_now');
  else if (age < 60) text = t('mc.fresh.seconds_ago', { n: age });
  else if (age < 3600) text = t('mc.fresh.minutes_ago', { n: Math.floor(age / 60) });
  else text = t('mc.fresh.hours_ago', { n: Math.floor(age / 3600) });
  return { text, stale };
}

// Status-badge icons (1-color stroke, currentColor — the badge colour comes from
// the CSS class, the icon + label make the state readable without relying on
// colour alone, per WCAG 1.4.1 and the .impeccable go-vs-live rule).
const BADGE_ICONS = {
  live:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none"></circle><path d="M5.5 5.5a9 9 0 0 0 0 13M18.5 5.5a9 9 0 0 1 0 13"></path></svg>',
  standby: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="8"></circle></svg>',
  blanked: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10 10 0 0 1 12 20C5 20 1 12 1 12a18 18 0 0 1 5.06-5.94M9.9 4.24A9 9 0 0 1 12 4c7 0 11 8 11 8a18 18 0 0 1-2.16 3.19"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>',
  offline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"></path><line x1="12" y1="2" x2="12" y2="12"></line></svg>',
};

// A display's at-a-glance state. live = online, awake, and showing a real source
// (on-air → red); standby = online + awake but idle; blanked = screen off; offline.
// Each state carries a label + icon, never colour alone.
function statusOf(display) {
  if (!display.online) return { key: 'offline', cls: 'mc-status-offline', label: t('mc.status.offline') };
  if (display.screen_on === false) return { key: 'blanked', cls: 'mc-status-blanked', label: t('mc.status.blanked') };
  const playing = display.now_playing && display.now_playing.kind && display.now_playing.kind !== 'idle';
  if (playing) return { key: 'live', cls: 'mc-status-live', label: t('mc.status.live') };
  return { key: 'standby', cls: 'mc-status-standby', label: t('mc.status.standby') };
}

function statusBadge(s) {
  return `<span class="mc-badge mc-badge-${s.key}">
    <span class="mc-badge-ico" aria-hidden="true">${BADGE_ICONS[s.key] || ''}</span>
    <span class="mc-badge-label">${esc(s.label)}</span>
  </span>`;
}

// Real aspect from geometry; fall back to 16/9 when unknown.
function aspectRatio(width, height) {
  if (width && height && width > 0 && height > 0) return `${width}/${height}`;
  return '16/9';
}

function displayCard(display) {
  const s = statusOf(display);
  const f = freshness(display.screenshot_at);
  const nowPlaying = display.now_playing && display.now_playing.label
    ? esc(display.now_playing.label)
    : esc(t('mc.card.nothing_playing'));
  const ar = aspectRatio(display.width, display.height);
  const offline = !display.online;
  const preview = display.screenshot_url
    ? `<img class="mc-card-shot${(f.stale || offline) ? ' mc-shot-stale' : ''}" src="${esc(display.screenshot_url)}" alt="${esc(t('mc.card.preview_alt', { name: display.name }))}" loading="lazy">`
    : `<div class="mc-card-shot mc-card-shot-empty">${esc(t('mc.card.no_preview'))}</div>`;

  // data-tp-host is populated after innerHTML injection by mountCardTransport.
  return `
    <button type="button" class="mc-card mc-display-card ${s.cls}"
            data-device-id="${esc(display.id)}"
            aria-label="${esc(t('mc.card.inspect_aria', { name: display.name }))}">
      <div class="mc-card-media" style="aspect-ratio:${ar}">
        ${preview}
        ${statusBadge(s)}
        <span class="mc-card-caption${f.stale ? ' mc-stale' : ''}">${esc(f.text)}</span>
      </div>
      <div class="mc-card-foot">
        <span class="mc-card-title">${esc(display.name)}</span>
      </div>
      <div class="mc-card-nowplaying" title="${nowPlaying}">${nowPlaying}</div>
      <div class="mc-card-transport" data-tp-host data-device-id="${esc(display.id)}"></div>
    </button>`;
}

// A video wall is rendered as a COMPOSITE of its real member screens, laid out on
// the wall's grid (grid_cols x grid_rows) so it mirrors the physical wall — e.g. a
// 3x1 wall shows three screens side by side. Each cell shows that screen's LIVE
// preview + status and is its OWN drop/inspect target (drag a source onto one
// screen, tap it to inspect). A footer strip is the WHOLE-WALL drop target (drag a
// source there to fill every screen at once). Per-screen control reuses the same
// data-device-id path as a standalone display card; the whole-wall strip carries
// data-wall-ids so the caller can fan a single source out to every member. A
// transport bar targeting the wall LEADER lets the operator pause / skip / restart
// / blank the wall's content from the dashboard (the leader drives playback).
const ICON_WALL_ALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"></rect><rect x="14" y="3" width="7" height="7" rx="1"></rect><rect x="3" y="14" width="7" height="7" rx="1"></rect><rect x="14" y="14" width="7" height="7" rx="1"></rect></svg>';

// Merge a wall-membership row (name/status/grid position from the JOIN) with the
// member device's LIVE state from the display-state store (screenshot, now-playing,
// screen_on) so each cell reflects what that screen is actually showing right now.
function wallMemberView(m, byId) {
  const live = byId.get(m.device_id) || {};
  return {
    id: m.device_id,
    name: live.name || m.device_name || t('mc.wall.screen_fallback'),
    online: live.online != null ? live.online : (m.device_status === 'online'),
    screen_on: live.screen_on,
    now_playing: live.now_playing,
    screenshot_url: live.screenshot_url,
    screenshot_at: live.screenshot_at,
    grid_col: m.grid_col,
    grid_row: m.grid_row,
  };
}

function wallCell(member, screenNo) {
  const s = statusOf(member);
  const offline = !member.online;
  const f = freshness(member.screenshot_at);
  const preview = member.screenshot_url
    ? `<img class="mc-wall-cell-shot${(f.stale || offline) ? ' mc-shot-stale' : ''}" src="${esc(member.screenshot_url)}" alt="" loading="lazy">`
    : `<span class="mc-wall-cell-empty">${esc(t('mc.card.no_preview'))}</span>`;
  const np = member.now_playing && member.now_playing.label ? member.now_playing.label : '';
  // The visible cell label is the screen position; the device name + now-playing
  // ride in the title. (No em-dash in the title — anti-slop.)
  const cellLabel = screenNo ? t('mc.wall.screen_n', { n: screenNo }) : member.name;
  const title = np ? `${member.name}: ${np}` : member.name;
  return `
    <div class="mc-wall-cell ${s.cls}" data-device-id="${esc(member.id)}"
         role="button" tabindex="0" title="${esc(title)}"
         aria-label="${esc(t('mc.card.inspect_aria', { name: member.name }))}">
      ${preview}
      ${statusBadge(s)}
      <span class="mc-wall-cell-name">${esc(cellLabel)}</span>
    </div>`;
}

// A physical-screen slot with no paired player (only shown when a wall has fewer
// devices than grid slots AND no leader to mirror).
function wallEmptySlot(screenNo) {
  return `
    <div class="mc-wall-cell mc-wall-cell-vacant" aria-hidden="true">
      <span class="mc-wall-cell-empty">${esc(t('mc.wall.screen_n', { n: screenNo }))}</span>
    </div>`;
}

// Render the wall as a grid of its PHYSICAL screens (grid_cols x grid_rows) so the
// card mirrors the real wall — e.g. a 3x1 wall shows three 86" screens. A screen
// slot with an assigned device shows that device; slots without their own device
// mirror the wall's leader (single-player walls drive every screen from one
// player), so all N screens reflect the wall's content. Each screen is its own
// drop/inspect target; the footer strip fills every screen at once.
function wallCard(wall, byId) {
  const members = (wall.devices || []).map(m => wallMemberView(m, byId));
  const cols = Math.max(1, wall.grid_cols || members.reduce((mx, m) => Math.max(mx, (m.grid_col || 0) + 1), 1));
  const rows = Math.max(1, wall.grid_rows || members.reduce((mx, m) => Math.max(mx, (m.grid_row || 0) + 1), 1));
  const slots = cols * rows;
  // Index assigned members by their grid position, and pick the leader (the
  // device every otherwise-unassigned screen mirrors).
  const byPos = new Map();
  members.forEach(m => {
    if (Number.isInteger(m.grid_col) && Number.isInteger(m.grid_row)) byPos.set(m.grid_col + ',' + m.grid_row, m);
  });
  const leader = members.find(m => m.id === wall.leader_device_id) || members[0] || null;

  // Row-major over every physical screen slot; CSS grid auto-places them in order.
  const cells = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      const m = byPos.get(c + ',' + r) || leader;
      cells.push(m ? wallCell(m, n) : wallEmptySlot(n));
    }
  }
  const ids = [...new Set(members.map(m => m.id))].join(',');
  return `
    <section class="mc-card mc-wall" data-wall-id="${esc(wall.id)}" aria-label="${esc(t('mc.wall.aria', { name: wall.name }))}">
      <div class="mc-wall-head">
        <span class="mc-wall-title">${esc(wall.name)}</span>
        <span class="mc-wall-sub">${esc(tn('mc.wall.screens', slots))}</span>
        <a class="mc-wall-edit" href="#/walls">${esc(t('mc.wall.edit'))}</a>
      </div>
      <div class="mc-wall-grid" style="grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);aspect-ratio:${cols} / ${rows}">
        ${cells.join('')}
      </div>
      ${leader ? `<div class="mc-wall-transport" data-tp-host data-device-id="${esc(leader.id)}"></div>` : ''}
      <div class="mc-wall-all" data-wall-ids="${esc(ids)}">
        <span class="mc-wall-all-ico" aria-hidden="true">${ICON_WALL_ALL}</span>
        <span>${esc(t('mc.wall.fill_all'))}</span>
      </div>
    </section>`;
}

// Plus tile shown alongside the populated stage to add another display.
function addTile() {
  return `
    <button type="button" class="mc-card mc-add-tile" data-mc-add aria-label="${esc(t('mc.stage.add_aria'))}">
      <span class="mc-add-plus" aria-hidden="true">+</span>
      <span class="mc-add-label">${esc(t('mc.stage.add'))}</span>
    </button>`;
}

// Composed empty state — icon + heading + the primary "Add display" action
// (orange CTA). Never a bare sentence. The CTA reuses [data-mc-add] wiring.
function emptyState() {
  return `
    <div class="mc-stage-empty">
      <span class="mc-empty-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="2" y="3" width="20" height="14" rx="2"></rect>
          <path d="M8 21h8M12 17v4"></path>
        </svg>
      </span>
      <h3 class="mc-empty-title">${esc(t('mc.stage.empty_title'))}</h3>
      <p class="mc-empty-desc">${esc(t('mc.stage.empty_desc'))}</p>
      <button type="button" class="mc-btn mc-btn-cta mc-btn-lg" data-mc-add>${esc(t('mc.stage.add'))}</button>
    </div>`;
}

/**
 * Render the stage into `container`.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {Array}  opts.displays      selected, NON-wall-member displays to show
 * @param {Array}  [opts.walls]       walls to render as composite member-screen grids
 * @param {Map<string,object>} [opts.byId]  live state of EVERY display (incl. wall
 *   members) keyed by id, so wall cells can show what each screen is showing now
 * @param {string[]} opts.selectedIds     currently-selected display ids
 * @param {(id:string)=>void} opts.onSelect        a display card / wall screen was activated
 * @param {()=>void}          opts.onAddDisplay     the "+ Add display" tile was activated
 * @param {(id:string, screenOn:boolean)=>void} [opts.onScreenOnChange]
 *   Called when a blank/unblank ack changes a display's screen_on value so the
 *   caller can patch display-state and trigger a re-paint.
 */
export function renderStage(container, { displays = [], walls = [], byId = new Map(), selectedIds = [], onSelect, onAddDisplay, onScreenOnChange } = {}) {
  if (!container) return;
  const selected = new Set(selectedIds);

  // Build a lookup map for display data so transport bars can read screen_on.
  const displayMap = new Map(displays.map(d => [d.id, d]));

  const cards = displays
    .filter(d => selected.has(d.id))
    .map(displayCard)
    .join('');
  const wallCards = (walls || []).map(w => wallCard(w, byId)).join('');

  const isEmpty = !cards && !wallCards;
  container.classList.toggle('mc-stage-is-empty', isEmpty);
  container.innerHTML = isEmpty
    ? emptyState()
    : `${wallCards}${cards}${addTile()}`;

  // Display cards (<button>) and wall screen cells (<div role=button>) both open
  // the inspector for that display. The whole-wall <a href="#/walls"> "Edit" link
  // navigates natively. Transport bars live inside display cards (data-tp-host)
  // and stopPropagation, so they never trigger the inspector.
  container.querySelectorAll('.mc-display-card[data-device-id]').forEach(el => {
    el.addEventListener('click', () => { if (typeof onSelect === 'function') onSelect(el.dataset.deviceId); });
  });
  container.querySelectorAll('.mc-wall-cell[data-device-id]').forEach(el => {
    el.addEventListener('click', () => { if (typeof onSelect === 'function') onSelect(el.dataset.deviceId); });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (typeof onSelect === 'function') onSelect(el.dataset.deviceId); }
    });
  });

  // Mount transport bars into each card's [data-tp-host] container. Standalone
  // display cards resolve from displayMap; the wall card's transport host targets
  // the wall LEADER (a wall member, so it lives in byId, not displays) — falling
  // back to byId lets the wall be paused/skipped/blanked like any other display.
  container.querySelectorAll('[data-tp-host]').forEach(host => {
    const deviceId = host.dataset.deviceId;
    const display  = displayMap.get(deviceId) || byId.get(deviceId);
    if (!deviceId || !display) return;
    renderTransportBar(host, {
      deviceId,
      screenOn: display.screen_on !== false,
      onScreenOnChange: (newValue) => {
        if (typeof onScreenOnChange === 'function') onScreenOnChange(deviceId, newValue);
      },
    });
  });

  container.querySelectorAll('[data-mc-add]').forEach(add => {
    add.addEventListener('click', () => { if (typeof onAddDisplay === 'function') onAddDisplay(); });
  });
}
