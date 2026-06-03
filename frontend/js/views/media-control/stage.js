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

// A video wall stands in for all its member screens as one advanced card.
// Clicking deep-links to #/walls (full wall control lives there for now).
function wallCard(wall) {
  const tiles = (wall.devices || []).length;
  return `
    <a class="mc-card mc-wall-card" href="#/walls" data-wall-id="${esc(wall.id)}"
       aria-label="${esc(t('mc.wall.aria', { name: wall.name }))}">
      <div class="mc-card-media" style="aspect-ratio:16/9">
        <div class="mc-card-shot mc-card-shot-empty mc-wall-badge">${esc(t('mc.wall.badge'))}</div>
      </div>
      <div class="mc-card-foot">
        <span class="mc-status-dot" style="background:var(--mc-broadcasting)" aria-hidden="true"></span>
        <span class="mc-card-title">${esc(wall.name)}</span>
        <span class="mc-card-status">${esc(tn('mc.wall.tiles', tiles))}</span>
      </div>
      <div class="mc-card-nowplaying">${esc(t('mc.wall.open'))}</div>
    </a>`;
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
  container.classList.toggle('mc-stage-is-empty', isEmpty);
  container.innerHTML = isEmpty
    ? emptyState()
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

  container.querySelectorAll('[data-mc-add]').forEach(add => {
    add.addEventListener('click', () => { if (typeof onAddDisplay === 'function') onAddDisplay(); });
  });
}
