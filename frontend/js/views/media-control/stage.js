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

import { renderTransportBar } from './transport.js';

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// "updated Ns ago" from a unix-seconds timestamp. > 30s is considered stale.
const STALE_AFTER_S = 30;
function freshness(screenshotAt) {
  if (!screenshotAt) return { text: 'no preview yet', stale: true };
  const age = Math.max(0, Math.floor(Date.now() / 1000) - screenshotAt);
  const stale = age > STALE_AFTER_S;
  let text;
  if (age < 5) text = 'updated just now';
  else if (age < 60) text = `updated ${age}s ago`;
  else if (age < 3600) text = `updated ${Math.floor(age / 60)}m ago`;
  else text = `updated ${Math.floor(age / 3600)}h ago`;
  return { text, stale };
}

// online -> green, offline -> grey, screen blanked -> amber "Blanked".
function statusOf(display) {
  if (!display.online) return { cls: 'mc-status-offline', dot: 'var(--mc-standby)', label: 'Offline' };
  if (display.screen_on === false) return { cls: 'mc-status-blanked', dot: 'var(--mc-warning)', label: 'Blanked' };
  return { cls: 'mc-status-online', dot: 'var(--mc-success)', label: 'Online' };
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
    ? escapeHtml(display.now_playing.label)
    : 'Nothing playing';
  const ar = aspectRatio(display.width, display.height);
  const offline = !display.online;
  const preview = display.screenshot_url
    ? `<img class="mc-card-shot${(f.stale || offline) ? ' mc-shot-stale' : ''}" src="${escapeHtml(display.screenshot_url)}" alt="${escapeHtml(display.name)} preview" loading="lazy">`
    : `<div class="mc-card-shot mc-card-shot-empty">No preview</div>`;

  // data-tp-host is populated after innerHTML injection by mountCardTransport.
  return `
    <button type="button" class="mc-card mc-display-card ${s.cls}"
            data-device-id="${escapeHtml(display.id)}"
            aria-label="Inspect ${escapeHtml(display.name)}">
      <div class="mc-card-media" style="aspect-ratio:${ar}">
        ${preview}
        <span class="mc-card-caption${f.stale ? ' mc-stale' : ''}">${escapeHtml(f.text)}</span>
      </div>
      <div class="mc-card-foot">
        <span class="mc-status-dot" style="background:${s.dot}" aria-hidden="true"></span>
        <span class="mc-card-title">${escapeHtml(display.name)}</span>
        <span class="mc-card-status">${escapeHtml(s.label)}</span>
      </div>
      <div class="mc-card-nowplaying" title="${nowPlaying}">${nowPlaying}</div>
      <div class="mc-card-transport" data-tp-host data-device-id="${escapeHtml(display.id)}"></div>
    </button>`;
}

// A video wall stands in for all its member screens as one advanced card.
// Clicking deep-links to #/walls (full wall control lives there for now).
function wallCard(wall) {
  const tiles = (wall.devices || []).length;
  return `
    <a class="mc-card mc-wall-card" href="#/walls" data-wall-id="${escapeHtml(wall.id)}"
       aria-label="Video wall ${escapeHtml(wall.name)} — open wall controls">
      <div class="mc-card-media" style="aspect-ratio:16/9">
        <div class="mc-card-shot mc-card-shot-empty mc-wall-badge">Video Wall</div>
      </div>
      <div class="mc-card-foot">
        <span class="mc-status-dot" style="background:var(--mc-broadcasting)" aria-hidden="true"></span>
        <span class="mc-card-title">${escapeHtml(wall.name)}</span>
        <span class="mc-card-status">${tiles} ${tiles === 1 ? 'tile' : 'tiles'}</span>
      </div>
      <div class="mc-card-nowplaying">Open wall controls →</div>
    </a>`;
}

function addTile() {
  return `
    <button type="button" class="mc-card mc-add-tile" data-mc-add aria-label="Add a display to the stage">
      <span class="mc-add-plus" aria-hidden="true">+</span>
      <span class="mc-add-label">Add display</span>
    </button>`;
}

/**
 * Render the stage into `container`.
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {Array}  opts.displays      selected, NON-wall-member displays to show
 * @param {Array}  [opts.walls]       walls to show as single cards
 * @param {string[]} opts.selectedIds     currently-selected display ids
 * @param {(id:string)=>void} opts.onSelect        a display card was activated
 * @param {()=>void}          opts.onAddDisplay     the "+ Add display" tile was activated
 * @param {(id:string, screenOn:boolean)=>void} [opts.onScreenOnChange]
 *   Called when a blank/unblank ack changes a display's screen_on value so the
 *   caller can patch display-state and trigger a re-paint.
 */
export function renderStage(container, { displays = [], walls = [], selectedIds = [], onSelect, onAddDisplay, onScreenOnChange } = {}) {
  if (!container) return;
  const selected = new Set(selectedIds);

  // Build a lookup map for display data so transport bars can read screen_on.
  const displayMap = new Map(displays.map(d => [d.id, d]));

  const cards = displays
    .filter(d => selected.has(d.id))
    .map(displayCard)
    .join('');
  const wallCards = (walls || []).map(wallCard).join('');

  const isEmpty = !cards && !wallCards;
  container.innerHTML = isEmpty
    ? `<div class="mc-stage-empty">No displays on the stage yet.</div>${addTile()}`
    : `${wallCards}${cards}${addTile()}`;

  // Wall cards are <a href="#/walls"> and navigate natively — no handler.
  // Display cards: clicking anywhere except the transport bar opens the inspector.
  container.querySelectorAll('[data-device-id]:not([data-tp-host])').forEach(el => {
    if (el.classList.contains('mc-display-card')) {
      el.addEventListener('click', () => { if (typeof onSelect === 'function') onSelect(el.dataset.deviceId); });
    }
  });

  // Mount transport bars into each card's [data-tp-host] container.
  container.querySelectorAll('[data-tp-host]').forEach(host => {
    const deviceId = host.dataset.deviceId;
    const display  = displayMap.get(deviceId);
    if (!deviceId || !display) return;
    renderTransportBar(host, {
      deviceId,
      screenOn: display.screen_on !== false,
      onScreenOnChange: (newValue) => {
        if (typeof onScreenOnChange === 'function') onScreenOnChange(deviceId, newValue);
      },
    });
  });

  const add = container.querySelector('[data-mc-add]');
  if (add) add.addEventListener('click', () => { if (typeof onAddDisplay === 'function') onAddDisplay(); });
}
