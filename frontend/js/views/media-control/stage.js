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
import { liveEmbedHtml } from './live-preview.js';
import {
  MIXED_SCREENSAVER_VALUE,
  SCREENSAVER_OPTIONS,
  screensaverValueForDisplays,
} from './screensaver-state.js';

// ── Screensaver dropdown (per card) ───────────────────────────────────────
// A small in-card <select> on every display + wall card that broadcasts a
// "screensaver" source to that display. Options are fixed classroom defaults:
//   • Dashboard    → the live wall.mbfdhub.com ops dashboard (framable; the
//                    player iframes *.mbfdhub.com live, not a screenshot)
//   • B&W Wallpaper / L1 Wallpaper → uploaded image content items.
// Render the screensaver <select>. `dataAttrs` carries the target wiring:
// `data-device-id="X"` (single display / split member) or `data-wall-ids="a,b"`
// (whole wall). Its selected value is derived from current player state.
function screensaverSelect(dataAttrs, selectedValue = '') {
  const opts = SCREENSAVER_OPTIONS
    .map(o => `<option value="${esc(o.value)}"${o.value === selectedValue ? ' selected' : ''}>${esc(t(o.labelKey))}</option>`)
    .join('');
  return `<select class="mc-screensaver" ${dataAttrs}
            data-current-value="${esc(selectedValue)}"
            aria-label="${esc(t('mc.saver.aria'))}" title="${esc(t('mc.saver.title'))}">
            <option value=""${selectedValue === '' ? ' selected' : ''}>${esc(t('mc.saver.placeholder'))}</option>
            <option value="${MIXED_SCREENSAVER_VALUE}" disabled${selectedValue === MIXED_SCREENSAVER_VALUE ? ' selected' : ''}>${esc(t('mc.cc.saver.mixed'))}</option>
            ${opts}
          </select>`;
}

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

function wallLockBadge() {
  return `<span class="mc-wall-locked" title="This wall keeps its member set fixed" style="margin-left:8px;padding:2px 8px;border-radius:999px;background:rgba(245,158,11,.16);color:#f59e0b;font-size:11px;font-weight:700;letter-spacing:.02em">Locked</span>`;
}

// Real aspect from geometry; fall back to 16/9 when unknown.
function aspectRatio(width, height) {
  if (width && height && width > 0 && height > 0) return `${width}/${height}`;
  return '16/9';
}

// ── Proportional tile sizing (2026-06-07) ─────────────────────────────────
// A wall is drawn as `perTile × cols` (NOT a fixed-width box divided by cols), so
// every TV tile is the SAME size regardless of how many TVs the wall has, and a
// 3-TV wall is simply wider than a 2-TV wall. The per-tile size scales with the
// panel's PHYSICAL width (video_walls.screen_w_mm) so identical 86" panels get
// identical tiles across walls, and larger panels get larger tiles. The Classroom
// 1 Smartboard (also 86") is given the same single-tile size so it matches one TV.
// The Classroom 1 Smartboard is an 86" panel like the wall TVs; identify it by
// name so its standalone card matches one wall tile (display-state exposes name).
function isSmartboard(display) {
  return /smartboard/i.test((display && display.name) || '');
}
// Render/load order key from the trailing number in a wall name ("Video Wall 1"
// -> 1, "Video Wall 2" -> 2) so VW1 loads before VW2.
function wallOrderKey(w) {
  const m = String((w && w.name) || '').match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 999;
}
// Shared uniform tile size in px = stageWidth / maxCols, clamped so a lone
// display can't balloon and tiny stages stay usable. Set as --mc-tile on the
// stage; cards are sized to cols x --mc-tile in CSS.
const TILE_MIN_PX = 160, TILE_MAX_PX = 520;
function applyTileSize(container, maxCols) {
  // Defer the first layout measure until after stylesheets/layout settle so we
  // do not force layout before CSS is ready (and avoid FOUC sizing jumps).
  const run = () => {
    const w = container.clientWidth || 0;
    if (w <= 0) return; // not laid out yet; ResizeObserver will fire when it is
    const tile = Math.max(TILE_MIN_PX, Math.min(TILE_MAX_PX, Math.floor(w / Math.max(1, maxCols))));
    container.style.setProperty('--mc-tile', tile + 'px');
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(() => requestAnimationFrame(run));
  } else {
    setTimeout(run, 0);
  }
}

// Pick the preview image for a display / wall screen. Video/web/YouTube captures
// are often black or unhelpful, so they prefer generated posters. Documents and
// PDFs need to mirror slide navigation, so a live screenshot beats the static
// first-page poster whenever one is available.
function shouldPreferPoster(obj) {
  const kind = String(obj?.now_playing?.kind || obj?.content_type || '').toLowerCase();
  if (kind === 'document' || kind === 'pdf') return false;
  if (kind === 'image') {
    const capturedAt = Number(obj?.screenshot_at);
    const age = Number.isFinite(capturedAt)
      ? Math.max(0, Math.floor(Date.now() / 1000) - capturedAt)
      : Infinity;
    return age > STALE_AFTER_S;
  }
  return !!(obj && obj.now_playing && obj.now_playing.poster_url);
}

function shotImg(cls, apiSrc, alt, extra = '') {
  // Always load screenshots via authenticated fetch → blob URL (see refreshPreviewsInPlace).
  // Never put the bare authenticated API path in src — that 401s without Authorization.
  if (!apiSrc) return '';
  if (apiSrc.startsWith('blob:') || apiSrc.startsWith('data:') || apiSrc.startsWith('/api/content/')) {
    return `<img class="${cls}" src="${esc(apiSrc)}" alt="${esc(alt || '')}" loading="lazy"${extra}>`;
  }
  return `<img class="${cls}" src="" data-mc-shot-api="${esc(apiSrc)}" alt="${esc(alt || '')}" loading="lazy"${extra}>`;
}

export function previewSource(obj) {
  const poster = obj && obj.now_playing && obj.now_playing.poster_url;
  const screenshot = obj && obj.screenshot_url;
  // A screenshot is the physical device's frame. Do not compare it with
  // display_states.updated_at: periodic state reports advance that timestamp even
  // when the rendered pixels have not changed, which incorrectly hid valid slides.
  // Still images are the exception: once their device frame is stale, the current
  // content-bound poster is safer than pixels left over from the previous item.
  if (screenshot && !shouldPreferPoster(obj)) return { src: screenshot, poster: false };
  if (poster) return { src: poster, poster: true };
  if (screenshot) return { src: screenshot, poster: false };
  return null;
}

function displayCard(display, { livePreview = false } = {}) {
  const s = statusOf(display);
  const f = freshness(display.screenshot_at);
  const nowPlaying = display.now_playing && display.now_playing.label
    ? esc(display.now_playing.label)
    : esc(t('mc.card.nothing_playing'));
  const ar = aspectRatio(display.width, display.height);
  // The 86" Classroom 1 Smartboard is sized to ONE wall TV tile so it visually
  // matches a single screen in the video walls (same hardware class).
  const sb = isSmartboard(display);
  const offline = !display.online;
  const pv = previewSource(display);
  const showingPoster = !!(pv && pv.poster);
  const staleCls = (pv && !pv.poster && (f.stale || offline)) ? ' mc-shot-stale' : '';
  const live = livePreview
    ? liveEmbedHtml(display.now_playing, 'mc-card-shot', { fallbackSrc: pv && pv.src, audioPreview: livePreview })
    : null;
  const preview = live
    ? live
    : (pv
      ? shotImg(`mc-card-shot${staleCls}${pv.poster ? ' mc-shot-poster' : ''}`, pv.src, t('mc.card.preview_alt', { name: display.name }))
      : `<div class="mc-card-shot mc-card-shot-empty">${esc(t('mc.card.no_preview'))}</div>`);
  // A poster is always current (it IS what's playing), so show a neutral caption
  // rather than a misleading "Updated Ns ago" about a screenshot we aren't using.
  const captionText = showingPoster ? t('mc.card.now_showing') : f.text;
  const captionStale = (!showingPoster && f.stale) ? ' mc-stale' : '';

  // data-tp-host is populated after innerHTML injection by mountCardTransport.
  return `
    <button type="button" class="mc-card mc-display-card ${s.cls}${sb ? ' mc-display-card-tile' : ''}"
            data-device-id="${esc(display.id)}"${sb ? ' style="--mc-cols:1"' : ''}
            aria-label="${esc(t('mc.card.inspect_aria', { name: display.name }))}">
      <div class="mc-card-media" style="aspect-ratio:${ar}">
        ${preview}
        ${statusBadge(s)}
        <span class="mc-card-caption${captionStale}">${esc(captionText)}</span>
      </div>
      <div class="mc-card-foot">
        <span class="mc-card-title">${esc(display.name)}</span>
        ${screensaverSelect(`data-device-id="${esc(display.id)}"`, screensaverValueForDisplays([display]))}
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
// A calibration button flashes a non-disruptive overlay on every wall member via
// the existing identify event, keeping the frozen player command protocol intact.
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
    content_type: live.content_type,
    state_updated_at: live.state_updated_at ?? live.live_state?.state_updated_at,
    screenshot_url: live.screenshot_url,
    screenshot_at: live.screenshot_at,
    grid_col: m.grid_col,
    grid_row: m.grid_row,
  };
}

function wallTransportDeviceId(wall, members) {
  if (!wall || !Array.isArray(members) || members.length === 0) return null;
  const onlineLeader = members.find(m => m.id === wall.leader_device_id && m.online);
  if (onlineLeader) return onlineLeader.id;
  const onlineMember = members.find(m => m.online);
  if (onlineMember) return onlineMember.id;
  return wall.leader_device_id || members[0]?.id || null;
}

function wallCell(member, screenNo, { showPreview = true, livePreview = false } = {}) {
  const s = statusOf(member);
  const offline = !member.online;
  const f = freshness(member.screenshot_at);
  const pv = previewSource(member);
  const staleCls = (pv && !pv.poster && (f.stale || offline)) ? ' mc-shot-stale' : '';
  const live = showPreview && livePreview
    ? liveEmbedHtml(member.now_playing, 'mc-wall-cell-shot', { allowVideo: true, fallbackSrc: pv && pv.src, audioPreview: livePreview })
    : null;
  const preview = !showPreview
    ? ''
    : (live
      ? live
      : (pv
        ? shotImg(`mc-wall-cell-shot${staleCls}${pv.poster ? ' mc-shot-poster' : ''}`, pv.src, '')
        : `<span class="mc-wall-cell-empty">${esc(t('mc.card.no_preview'))}</span>`));
  const np = member.now_playing && member.now_playing.label ? member.now_playing.label : '';
  // The visible cell label is the screen position; the device name + now-playing
  // ride in the title. (No em-dash in the title — anti-slop.)
  const cellLabel = screenNo ? t('mc.wall.screen_n', { n: screenNo }) : member.name;
  const title = np ? `${member.name}: ${np}` : member.name;
  return `
    <div class="mc-wall-cell ${s.cls}${showPreview ? '' : ' mc-wall-cell-overlay'}" data-device-id="${esc(member.id)}"
         role="button" tabindex="0" title="${esc(title)}"
         aria-label="${esc(t('mc.card.inspect_aria', { name: member.name }))}">
      ${preview}
      ${statusBadge(s)}
      <span class="mc-wall-cell-name">${esc(cellLabel)}</span>
    </div>`;
}

function wallSpanPreview(leader, livePreview = false) {
  const pv = previewSource(leader);
  // Always allow video in the span preview — the dashboard must mirror what the
  // physical wall is showing. Previously allowVideo=false caused a screenshot
  // fallback which is a black tile for video (canvas capture is tainted).
  const live = leader && livePreview
    ? liveEmbedHtml(leader.now_playing, 'mc-wall-span-shot', { allowVideo: true, fallbackSrc: pv && pv.src, audioPreview: livePreview })
    : null;
  if (live) {
    return `<div class="mc-wall-span-layer" data-device-id="${esc(leader.id)}">${live}</div>`;
  }
  if (!leader || !pv) {
    return `<div class="mc-wall-span-layer mc-wall-span-empty"><span>${esc(t('mc.card.no_preview'))}</span></div>`;
  }
  const f = freshness(leader.screenshot_at);
  const staleCls = (pv && !pv.poster && (f.stale || !leader.online)) ? ' mc-shot-stale' : '';
  // Always overlay a "now playing" label on the span layer so operators can read
  // what is on the wall even when the screenshot is dark (e.g. a screensaver,
  // live ops dashboard, or any dark-background content). The label chip sits at
  // the bottom-left of the card as a translucent pill.
  const npLabel = leader.now_playing && leader.now_playing.label && leader.now_playing.kind !== 'idle'
    ? `<div class="mc-wall-span-np-label">${esc(leader.now_playing.label)}</div>`
    : '';
  return `<div class="mc-wall-span-layer" data-device-id="${esc(leader.id)}">
    ${shotImg(`mc-wall-span-shot${staleCls}${pv.poster ? ' mc-shot-poster' : ''}`, pv.src, t('mc.card.preview_alt', { name: leader.name }))}
    ${npLabel}
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
function wallCard(wall, byId, livePreviewDeviceId = null, overviewMode = false) {
  const members = (wall.devices || []).map(m => wallMemberView(m, byId));
  const cols = Math.max(1, wall.grid_cols || members.reduce((mx, m) => Math.max(mx, (m.grid_col || 0) + 1), 1));
  const rows = Math.max(1, wall.grid_rows || members.reduce((mx, m) => Math.max(mx, (m.grid_row || 0) + 1), 1));
  const slots = cols * rows;
  // Uniform tiling: every TV tile is 1/maxCols of the stage width — set as
  // --mc-cols on the card + --mc-maxcols on the stage (CSS sizes the card to
  // cols x tile and fills it). So identical 86" panels render identically-sized
  // tiles on EVERY wall, a 3-screen wall fills the stage, a 2-screen wall is 2/3
  // as wide, and the single-screen Smartboard is one tile — without any card
  // exceeding the stage width. Cells carry the panel aspect ratio so their height
  // tracks the responsive width.
  const cellAr = (wall.screen_w_mm > 0 && wall.screen_h_mm > 0) ? `${wall.screen_w_mm}/${wall.screen_h_mm}` : '16/9';
  // Index assigned members by their grid position, and pick the leader (the
  // device every otherwise-unassigned screen mirrors).
  const byPos = new Map();
  members.forEach(m => {
    if (Number.isInteger(m.grid_col) && Number.isInteger(m.grid_row)) byPos.set(m.grid_col + ',' + m.grid_row, m);
  });
  const leader = members.find(m => m.id === wall.leader_device_id) || members[0] || null;

  const ids = [...new Set(members.map(m => m.id))].join(',');
  // Span/Split template (2026-06-04). 'span' = one source stretched across every
  // screen (true wall sync); 'split' = each screen plays its own source. The card
  // re-renders to reflect the active template and the fill-strip changes meaning.
  const mode = wall.layout_mode === 'split' ? 'split' : 'span';
  const fillLabel = mode === 'split' ? t('mc.wall.fill_all') : t('mc.wall.fill_span');
  const modeHint = mode === 'split' ? t('mc.wall.split_hint') : t('mc.wall.span_hint');
  const transportId = wallTransportDeviceId(wall, members);
  // Row-major over every physical screen slot; CSS grid auto-places them in order.
  const cells = [];
  let n = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      n++;
      const m = byPos.get(c + ',' + r) || leader;
      cells.push(m ? wallCell(m, n, {
        showPreview: overviewMode || mode === 'split',
        livePreview: m.id === livePreviewDeviceId,
      }) : wallEmptySlot(n));
    }
  }
  const spanLayer = mode === 'span' && !overviewMode
    ? wallSpanPreview(leader, !!leader && leader.id === livePreviewDeviceId)
    : '';
  return `
    <section class="mc-card mc-wall mc-wall-mode-${mode}" data-wall-id="${esc(wall.id)}" data-layout-mode="${mode}" style="--mc-cols:${cols}; --mc-cell-ar:${cellAr}" aria-label="${esc(t('mc.wall.aria', { name: wall.name }))}">
      <div class="mc-wall-head">
        <span class="mc-wall-title">${esc(wall.name)}</span>
        ${wall.is_locked ? wallLockBadge() : ''}
        <span class="mc-wall-sub">${esc(tn('mc.wall.screens', slots))}</span>
        <div class="mc-wall-template" role="group" aria-label="${esc(t('mc.wall.template_aria'))}">
          <button type="button" class="mc-wall-tpl${mode === 'span' ? ' is-active' : ''}" data-wall-mode="span" data-wall-id="${esc(wall.id)}" aria-pressed="${mode === 'span'}" title="${esc(t('mc.wall.span_hint'))}">${esc(t('mc.wall.tpl_span'))}</button>
          <button type="button" class="mc-wall-tpl${mode === 'split' ? ' is-active' : ''}" data-wall-mode="split" data-wall-id="${esc(wall.id)}" aria-pressed="${mode === 'split'}" title="${esc(t('mc.wall.split_hint'))}">${esc(t('mc.wall.tpl_split'))}</button>
        </div>
        <button type="button" class="mc-wall-calibrate" data-wall-calibrate
                data-wall-ids="${esc(ids)}" data-wall-name="${esc(wall.name)}"
                title="${esc(t('mc.wall.calibrate_title'))}">${esc(t('mc.wall.calibrate'))}</button>
        ${screensaverSelect(`data-wall-ids="${esc(ids)}"`, screensaverValueForDisplays(members))}
        <a class="mc-wall-edit" href="#/walls">${esc(t('mc.wall.edit'))}</a>
      </div>
      <div class="mc-wall-hint">${esc(modeHint)}</div>
      <div class="mc-wall-grid" style="grid-template-columns:repeat(${cols}, 1fr)">
        ${spanLayer}
        ${cells.join('')}
      </div>
      ${transportId ? `<div class="mc-wall-transport" data-tp-host data-device-id="${esc(transportId)}" data-transport-ids="${esc(ids)}" data-blank-ids="${esc(ids)}" data-wall-id="${esc(wall.id)}" data-layout-mode="${esc(mode)}"></div>` : ''}
      <div class="mc-wall-all" data-wall-ids="${esc(ids)}">
        <span class="mc-wall-all-ico" aria-hidden="true">${ICON_WALL_ALL}</span>
        <span>${esc(fillLabel)}</span>
      </div>
    </section>`;
}

function wallGroupsCard(wall, byId, livePreviewDeviceId, activeControlTargetId, overviewMode = false) {
  const groups = wall.layout?.groups || [];
  const orderedMembers = [...(wall.devices || [])].sort((a, b) =>
    (Number(a.grid_row) - Number(b.grid_row)) || (Number(a.grid_col) - Number(b.grid_col))
  );
  const regions = groups.map((group) => {
    const memberIds = new Set(group.member_ids || []);
    const members = orderedMembers.filter((member) => memberIds.has(member.device_id));
    const minCol = Math.min(...members.map((member) => Number(member.grid_col) || 0));
    const minRow = Math.min(...members.map((member) => Number(member.grid_row) || 0));
    const regionWall = {
      ...wall,
      id: `${wall.id}:${group.id}`,
      name: group.name || group.id,
      devices: members.map((member) => ({
        ...member,
        grid_col: (Number(member.grid_col) || 0) - minCol,
        grid_row: (Number(member.grid_row) || 0) - minRow,
      })),
      grid_cols: Number(group.geometry?.columns) || Math.max(1, members.length),
      grid_rows: Number(group.geometry?.rows) || 1,
      leader_device_id: group.leader_device_id || group.member_ids?.[0],
      layout_mode: 'span',
      is_locked: false,
    };
    return `<div class="mc-wall-region${group.id === activeControlTargetId ? ' is-active' : ''}"
      data-layout-group-id="${esc(group.id)}" role="button" tabindex="0"
      style="--mc-region-cols:${regionWall.grid_cols}"
      aria-label="${esc(`Control ${regionWall.name}`)}">
      ${wallCard(regionWall, byId, livePreviewDeviceId, overviewMode)}
    </div>`;
  }).join('');
  return `<section class="mc-wall-groups-overview" data-wall-id="${esc(wall.id)}">
    <header class="mc-wall-groups-head">
      <strong>${esc(wall.name)}</strong>
      <span>Select a region to control or drop content directly onto it.</span>
    </header>
    <div class="mc-wall-groups-regions">${regions}</div>
  </section>`;
}

// SPLIT template (2026-06-09): a video wall in 'split' mode is NOT one composite
// surface — each physical screen plays independently. So instead of the single
// composite wallCard, we render each member screen as its OWN standalone display
// card (drag a different source onto each, blank/transport each separately) under
// a compact header that keeps the Span/Split toggle (so the operator can recombine
// into a spanned wall) and Calibrate. The member cards reuse displayCard, so they
// inherit the full drop / inspect / transport / screensaver wiring with no extra
// per-card plumbing.
// One column of a SINGLE-spanning-device split wall (e.g. a PC driving N TVs as
// one Mosaic window): an independent drop target that pushes its OWN source into
// column `half` of the composite grid on that one device. The preview crops the
// device's live screenshot to this column so each half shows what is actually on
// that TV. data-device-id = the spanning (leader) device; data-split-half = index.
function wallSplitHalfCell(leader, half, cols) {
  const pv = previewSource(leader);
  const label = cols === 2
    ? (half === 0 ? t('mc.wall.half_left') : t('mc.wall.half_right'))
    : t('mc.wall.screen_n', { n: half + 1 });
  // Crop the composite screenshot to this column via background sizing.
  const posX = cols > 1 ? (half * 100 / (cols - 1)) : 0;
  const bg = pv
    ? ` style="background-image:url('${esc(pv.src)}');background-size:${cols * 100}% 100%;background-position:${posX}% 0;background-repeat:no-repeat;"`
    : '';
  const empty = pv ? '' : `<span class="mc-wall-cell-empty">${esc(t('mc.card.no_preview'))}</span>`;
  return `
    <div class="mc-wall-split-half" data-device-id="${esc(leader.id)}" data-split-half="${half}"
         role="button" tabindex="0" aria-label="${esc(t('mc.wall.split_drop_aria', { label }))}"${bg}>
      ${empty}
      <span class="mc-wall-cell-name">${esc(label)}</span>
    </div>`;
}

function wallSplitGroup(wall, byId, livePreviewDeviceId = null) {
  const members = (wall.devices || []).map(m => wallMemberView(m, byId));
  const ids = [...new Set(members.map(m => m.id))].join(',');
  const cols = Math.max(1, wall.grid_cols || members.length || 1);

  // SINGLE spanning device (one PC via NVIDIA Mosaic / extended desktop driving N
  // TVs as ONE window): there is only one member device but grid_cols > 1, so the
  // per-device-card split below can't express "drop onto screen 2" (no 2nd device).
  // Render N independent half drop cells instead; each drop composites its source
  // into one column of a grid pushed to the single window (see dropOnWallHalf).
  if (members.length === 1 && cols > 1) {
    const leader = members[0];
    const transportId = wallTransportDeviceId(wall, members) || leader.id;
    const halves = [];
    for (let i = 0; i < cols; i++) halves.push(wallSplitHalfCell(leader, i, cols));
    return `
    <section class="mc-card mc-wall mc-wall-split mc-wall-split-one" data-wall-id="${esc(wall.id)}" data-layout-mode="split" style="--mc-cols:${cols}" aria-label="${esc(t('mc.wall.aria', { name: wall.name }))}">
      <div class="mc-wall-head">
        <span class="mc-wall-title">${esc(wall.name)}</span>
        ${wall.is_locked ? wallLockBadge() : ''}
        <span class="mc-wall-sub">${esc(t('mc.wall.split_badge'))}</span>
        <div class="mc-wall-template" role="group" aria-label="${esc(t('mc.wall.template_aria'))}">
          <button type="button" class="mc-wall-tpl" data-wall-mode="span" data-wall-id="${esc(wall.id)}" aria-pressed="false" title="${esc(t('mc.wall.span_hint'))}">${esc(t('mc.wall.tpl_span'))}</button>
          <button type="button" class="mc-wall-tpl is-active" data-wall-mode="split" data-wall-id="${esc(wall.id)}" aria-pressed="true" title="${esc(t('mc.wall.split_hint'))}">${esc(t('mc.wall.tpl_split'))}</button>
        </div>
        <button type="button" class="mc-wall-calibrate" data-wall-calibrate
                data-wall-ids="${esc(ids)}" data-wall-name="${esc(wall.name)}"
                title="${esc(t('mc.wall.calibrate_title'))}">${esc(t('mc.wall.calibrate'))}</button>
        ${screensaverSelect(`data-wall-ids="${esc(ids)}"`, screensaverValueForDisplays(members))}
        <a class="mc-wall-edit" href="#/walls">${esc(t('mc.wall.edit'))}</a>
      </div>
      <div class="mc-wall-hint">${esc(t('mc.wall.split_one_hint'))}</div>
      <div class="mc-wall-grid" style="grid-template-columns:repeat(${cols}, 1fr)">
        ${halves.join('')}
      </div>
      ${transportId ? `<div class="mc-wall-transport" data-tp-host data-device-id="${esc(transportId)}" data-transport-ids="${esc(ids)}" data-blank-ids="${esc(ids)}" data-wall-id="${esc(wall.id)}" data-layout-mode="split"></div>` : ''}
    </section>`;
  }

  // Multi-device split: each physical screen is its OWN device → its own card.
  const memberCards = members
    .map(m => { const live = byId.get(m.id); return live ? displayCard(live, { livePreview: live.id === livePreviewDeviceId }) : ''; })
    .join('');
  return `
    <section class="mc-card mc-wall mc-wall-split" data-wall-id="${esc(wall.id)}" data-layout-mode="split" style="--mc-cols:${cols}" aria-label="${esc(t('mc.wall.aria', { name: wall.name }))}">
      <div class="mc-wall-head">
        <span class="mc-wall-title">${esc(wall.name)}</span>
        ${wall.is_locked ? wallLockBadge() : ''}
        <span class="mc-wall-sub">${esc(t('mc.wall.split_badge'))}</span>
        <div class="mc-wall-template" role="group" aria-label="${esc(t('mc.wall.template_aria'))}">
          <button type="button" class="mc-wall-tpl" data-wall-mode="span" data-wall-id="${esc(wall.id)}" aria-pressed="false" title="${esc(t('mc.wall.span_hint'))}">${esc(t('mc.wall.tpl_span'))}</button>
          <button type="button" class="mc-wall-tpl is-active" data-wall-mode="split" data-wall-id="${esc(wall.id)}" aria-pressed="true" title="${esc(t('mc.wall.split_hint'))}">${esc(t('mc.wall.tpl_split'))}</button>
        </div>
        <button type="button" class="mc-wall-calibrate" data-wall-calibrate
                data-wall-ids="${esc(ids)}" data-wall-name="${esc(wall.name)}"
                title="${esc(t('mc.wall.calibrate_title'))}">${esc(t('mc.wall.calibrate'))}</button>
        <a class="mc-wall-edit" href="#/walls">${esc(t('mc.wall.edit'))}</a>
      </div>
      <div class="mc-wall-hint">${esc(t('mc.wall.split_hint'))}</div>
      <div class="mc-wall-split-members">${memberCards}</div>
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
 * @param {(ids:string[], name:string)=>void} [opts.onCalibrateWall]
 * @param {()=>void}          opts.onAddDisplay     the "+ Add display" tile was activated
 * @param {(id:string, screenOn:boolean)=>void} [opts.onScreenOnChange]
 *   Called when a blank/unblank ack changes a display's screen_on value so the
 *   caller can patch display-state and trigger a re-paint.
 * @param {(ids:string[], action:string)=>void} [opts.onTransportAction]
 *   Called after transport sends so the caller can refresh state/previews.
 * @param {(ids:string[], source:object, label:string)=>void} [opts.onScreensaver]
 *   A screensaver option was chosen on a card; broadcast `source` to `ids`.
 */
export function renderStage(container, { displays = [], walls = [], byId = new Map(), selectedIds = [], livePreviewDeviceId = null, activeControlTargetId = null, overviewMode = false, onSelect, onSelectGroup, onCalibrateWall, onAddDisplay, onScreenOnChange, onTransportAction, onSetWallMode, onScreensaver } = {}) {
  if (!container) return;
  const selected = new Set(selectedIds);

  // Build a lookup map for display data so transport bars can read screen_on.
  const displayMap = new Map(displays.map(d => [d.id, d]));

  // Load/render order: Video Wall 1, then Video Wall 2, ... (by the trailing
  // number in the name), with the single-screen Smartboard LAST among displays —
  // so the room loads VW1 -> VW2 -> Smartboard.
  const wallList = (walls || []).slice().sort((a, b) => wallOrderKey(a) - wallOrderKey(b) || String(a.name || '').localeCompare(String(b.name || '')));
  // Uniform-tile budget: the widest wall's column count drives a shared tile size
  // (stage width / maxCols). Every 86" panel then renders an identically-sized
  // tile across walls + the Smartboard, Video Wall 1 fills the stage, and no card
  // exceeds it. --mc-tile is recomputed here + on resize (CSS reads it).
  const maxCols = Math.max(1, ...wallList.map(w => Math.max(1, w.grid_cols || 1)));
  container.style.setProperty('--mc-maxcols', String(maxCols));
  applyTileSize(container, maxCols);
  if (!container._mcTileRO && typeof ResizeObserver !== 'undefined') {
    container._mcTileMax = maxCols;
    container._mcTileRO = new ResizeObserver(() => applyTileSize(container, container._mcTileMax || 1));
    container._mcTileRO.observe(container);
  } else {
    container._mcTileMax = maxCols;
  }

  const cards = displays
    .filter(d => selected.has(d.id))
    .sort((a, b) => (isSmartboard(a) ? 1 : 0) - (isSmartboard(b) ? 1 : 0))
    .map((display) => displayCard(display, { livePreview: display.id === livePreviewDeviceId }))
    .join('');
  // Span walls render as one composite card; SPLIT walls render each member as
  // its own independent display card (see wallSplitGroup).
  const wallCards = wallList.map(w => (w.layout_mode === 'groups'
    ? wallGroupsCard(w, byId, livePreviewDeviceId, activeControlTargetId, overviewMode)
    : (w.layout_mode === 'split'
      ? wallSplitGroup(w, byId, livePreviewDeviceId)
      : wallCard(w, byId, livePreviewDeviceId, overviewMode)))).join('');

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
  container.querySelectorAll('[data-layout-group-id]').forEach((region) => {
    const select = (event) => {
      if (event.target.closest('button, select, a, [data-tp-host]')) return;
      if (typeof onSelectGroup === 'function') onSelectGroup(region.dataset.layoutGroupId);
    };
    region.addEventListener('click', select);
    region.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        select(event);
      }
    });
  });

  container.querySelectorAll('[data-wall-calibrate]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ids = String(btn.dataset.wallIds || '').split(',').filter(Boolean);
      if (ids.length && typeof onCalibrateWall === 'function') onCalibrateWall(ids, btn.dataset.wallName || '');
    });
  });

  // Span/Split template toggle: switch the wall's layout_mode. stopPropagation so
  // the wall card's other handlers don't fire. The caller persists via the API
  // and repaints the stage so the card reflects the chosen template.
  container.querySelectorAll('.mc-wall-tpl[data-wall-mode]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = btn.dataset.wallId;
      const mode = btn.dataset.wallMode;
      if (id && mode && typeof onSetWallMode === 'function') onSetWallMode(id, mode);
    });
  });

  // Mount transport bars into each card's [data-tp-host] container. Standalone
  // display cards resolve from displayMap; wall card state uses the leader, then
  // fans transport to every member listed in data-transport-ids — but only for
  // span lockstep modes. Split walls render per-member cards with single ids.
  container.querySelectorAll('[data-tp-host]').forEach(host => {
    const deviceId = host.dataset.deviceId;
    const display  = displayMap.get(deviceId) || byId.get(deviceId);
    if (!deviceId || !display) return;
    const wallCard = host.closest('[data-layout-mode]');
    const layoutMode = wallCard?.dataset?.layoutMode || host.dataset.layoutMode || '';
    // Span walls may list every member so doc/deck slides stay in lockstep.
    // Split / single / zone-targeted hosts must NEVER fan-out.
    const rawTransportIds = String(host.dataset.transportIds || '').split(',').filter(Boolean);
    const blankIds = String(host.dataset.blankIds || '').split(',').filter(Boolean);
    const zoneId = host.dataset.zoneId || host.dataset.cellId || '';
    const cellId = host.dataset.cellId || '';
    const wallId = host.dataset.wallId || wallCard?.dataset?.wallId || '';
    const transportIds = (layoutMode === 'span' && !zoneId && rawTransportIds.length)
      ? rawTransportIds
      : [deviceId];
    const paused = display.now_playing ? display.now_playing.paused : undefined;
    renderTransportBar(host, {
      deviceId,
      transportDeviceIds: transportIds,
      blankDeviceIds: blankIds.length ? blankIds : undefined,
      screenOn: display.screen_on !== false,
      paused,
      target: display,
      zoneId: zoneId || undefined,
      cellId: cellId || undefined,
      wallId: wallId || undefined,
      contentInstanceId: display.now_playing?.content_id || display.now_playing?.contentId || undefined,
      requireSingleTarget: layoutMode === 'split' || !!zoneId,
      onScreenOnChange: (newValue) => {
        if (typeof onScreenOnChange === 'function') onScreenOnChange(deviceId, newValue);
      },
      onTransportAction: (ids, action) => {
        if (typeof onTransportAction === 'function') onTransportAction(ids && ids.length ? ids : [deviceId], action);
      },
    });
  });

  // Per-card Screensaver dropdown. stopPropagation so opening/changing it never
  // bubbles to the card's inspector-open click. Keep the chosen option visible;
  // the next authoritative display-state paint confirms or corrects it.
  container.querySelectorAll('select.mc-screensaver').forEach(sel => {
    ['pointerdown', 'mousedown', 'click'].forEach(ev => sel.addEventListener(ev, e => e.stopPropagation()));
    sel.addEventListener('change', (e) => {
      e.stopPropagation();
      const val = sel.value;
      if (!val || val === MIXED_SCREENSAVER_VALUE || typeof onScreensaver !== 'function') return;
      const ids = sel.dataset.deviceId
        ? [sel.dataset.deviceId]
        : String(sel.dataset.wallIds || '').split(',').filter(Boolean);
      if (!ids.length) return;
      let source = null;
      if (val.startsWith('url:')) source = { remote_url: val.slice(4) };
      else if (val.startsWith('content:')) source = { content_id: val.slice(8) };
      else if (val.startsWith('folder:')) source = { _screensaver: 'folder', folder: val.slice(7) };
      else if (val.startsWith('blank:')) source = { _screensaver: 'blank', variant: val.slice(6) };
      if (!source) return;
      const opt = SCREENSAVER_OPTIONS.find(o => o.value === val);
      if (source._screensaver === 'folder') sel.value = sel.dataset.currentValue || '';
      const result = onScreensaver(ids, source, opt ? t(opt.labelKey) : t('mc.saver.title'));
      Promise.resolve(result).then((ok) => {
        if (ok === false) sel.value = sel.dataset.currentValue || '';
      }).catch(() => { sel.value = sel.dataset.currentValue || ''; });
    });
  });

  container.querySelectorAll('[data-mc-add]').forEach(add => {
    add.addEventListener('click', () => { if (typeof onAddDisplay === 'function') onAddDisplay(); });
  });
}
