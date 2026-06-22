import { api } from '../api.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';
import { showToast } from '../components/toast.js';
import { identifyDevice, requestScreenshot, sendCommand, getSocket, on as socketOn, off as socketOff } from '../socket.js';
import { COMMAND_TYPES } from '../player-protocol.js';
import { mountTargetSelector } from './media-control/target-selector.js';
import { mountSpanSplit } from './media-control/span-split.js';
import { mountActionDock } from './media-control/action-dock.js';
import * as displayState from '../services/display-state.js';
import { renderStage } from './media-control/stage.js';
import { renderToolbox } from './media-control/toolbox.js';
import { sendToDisplays, sentToast } from './media-control/send.js';
import { renderInspector, closeInspector } from './media-control/inspector.js';
import { renderMultiview, teardownMultiview, buildSplitGridUrl } from './media-control/multiview.js';
import { pickRoutingTargets } from './media-control/routing-picker.js';
import { mountBroadcastChip } from './media-control/broadcast-chip.js';
import { renderCommandBar } from './media-control/command-bar.js';
import { renderRoomPresets } from './media-control/room-presets.js';
import { renderRecentPanel } from './media-control/recent-panel.js';
import { openViewModal, closeViewModal } from './media-control/view-modal.js';
import { confirmDialog } from '../components/confirm.js';
import * as screenShareEngine from '../services/screen-share-engine.js';
import * as schedulesView from './schedules.js';
import {
  hasAdvancedCanvasEndpoint,
  mountAdvancedCanvas,
  routeSourceToAdvancedCanvas,
  setAdvancedCanvasBlanked,
  unmountAdvancedCanvas,
} from './media-control/advanced-canvas.js';
import { mount as mountWhiteboardSurface } from './media-control/whiteboard.js';
// transport.js is used by stage.js internally — no direct import needed here.

// Rail "Room setup" launcher icons (stroke icons, dashboard SVG vocabulary).
const ICON_SETUP_SCHEDULE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
const ICON_SETUP_WALLS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="9" height="8" rx="1"></rect><rect x="13" y="3" width="9" height="8" rx="1"></rect><rect x="2" y="13" width="9" height="8" rx="1"></rect><rect x="13" y="13" width="9" height="8" rx="1"></rect></svg>';
// Library drawer collapse/expand chevron (points right when open → collapse, left when collapsed → reopen).
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';
// Header notification bell (white stroke).
const ICON_BELL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"></path><line x1="13.5" y1="19" x2="10.5" y2="19"></line></svg>';

// Left collapsed icon rail (Command Center shell). Stroke-style SVGs matching
// the dashboard vocabulary already used by ICON_SETUP_* above. Labels live in
// i18n keys mc.cc.rail.* (tooltips only, since the rail stays collapsed).
const ICON_COMMAND = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 19 6 19 14 12 18 5 14 5 6"></polygon><line x1="12" y1="6" x2="12" y2="14"></line><line x1="5" y1="6" x2="12" y2="10"></line><line x1="19" y1="6" x2="12" y2="10"></line></svg>';
const ICON_DISPLAYS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>';
const ICON_WHITEBOARD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19l7-7 3 3-7 7-3-1z"></path><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"></path><path d="M2 2l7.586 7.586"></path><circle cx="11" cy="11" r="2"></circle></svg>';
const ICON_MEDIA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>';
const ICON_DOWNLOADS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>';
const ICON_ADMIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>';
const ICON_LOGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg>';
const ICON_SETTINGS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>';
// ── Phase 1 Command Center: screensaver options for the canvas-level control.
// Mirrors stage.js SCREENSAVER_OPTIONS (kept inline so this view does not depend
// on stage.js exporting its private list). If an asset is re-uploaded, update the
// id here AND in stage.js in lockstep.
const SCREENSAVER_OPTIONS_CC = [
  { value: 'url:https://wall.mbfdhub.com', labelKey: 'mc.saver.dashboard' },
  { value: 'content:4798f022-e9d9-4cba-a0b0-56aeb75a6bff', labelKey: 'mc.saver.bw' },
  { value: 'content:1d01b7a0-1a0c-4d3d-b0fd-6d854ce09ae3', labelKey: 'mc.saver.l1' },
  { value: 'content:7c596f36-27f6-4d7b-9bb0-2c682791d25a', labelKey: 'mc.saver.mbfd_map' },
  // Phase 6 (kept in lockstep with stage.js SCREENSAVER_OPTIONS): the seeded
  // "Screensavers" folder opens the media drawer filtered to it (no broadcast),
  // and "blank:black" broadcasts a pure black still screensaver.
  { value: 'folder:Screensavers', labelKey: 'mc.saver.choose_from_folder' },
  { value: 'blank:black', labelKey: 'mc.saver.blank_black' },
];

// A 1x1 black still the player renders as a "blank black" screensaver. The
// player treats a bare remote_url as a still image; an inline SVG data URL keeps
// this dependency-free and CSP-friendly (no external fetch).
const BLACK_SCREENSAVER_URL = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' fill='%23000'/%3E%3C/svg%3E";

// Open the media drawer and, best-effort, activate the matching folder chip on
// the Media tab. Additive: if the toolbox isn't mounted or the chip is absent,
// it simply opens the drawer and leaves it on "All" (no error path).
function openContentDrawerFiltered(folderName) {
  if (!folderName) return;
  try {
    const drawer = document.getElementById('mc-library-drawer');
    if (drawer) drawer.setAttribute('data-open', 'true');
    const tb = document.getElementById('mc-toolbox');
    if (!tb) return;
    const mediaTab = tb.querySelector('.mc-tb-tab[data-tab="media"]');
    if (mediaTab) mediaTab.click();
    const tryActivate = (attemptsLeft) => {
      const chip = tb.querySelector('.mc-tb-folder[data-folder="' + folderName + '"]');
      if (chip) { chip.click(); return; }
      if (attemptsLeft > 0) setTimeout(() => tryActivate(attemptsLeft - 1), 120);
    };
    tryActivate(12); // ~1.4s for the Media tab to paint
  } catch { /* best-effort; never block the screensaver UI */ }
}

// Active Command Center target: the single wall / display rendered large on the
// central canvas. null = legacy "show the whole room" stage (preserved when no
// target is chosen). The target selector drives this; changing it is VIEW-ONLY.
let activeTarget = null;
let targetApi = null;       // target-selector module API
let transportApi = null;    // canvas-level transport row
let spanSplitApi = null;    // Span | Split toggle
let screensaverApi = null;  // canvas-level screensaver row
let dockApi = null;         // bottom action dock

let unsub = null;
let unsubChip = null;   // broadcast-chip unsubscribe (Task 4.5)
let cmdAckHandler = null;   // Phase-2 command:ack (toast on timeout/failure)
let stateSyncHandler = null;
let selectedIds = [];   // ids on the stage; re-hydrated from the server, persisted on change
let wallMemberIds = new Set();   // device ids owned by a video wall (never their own card)
let walls = [];
let previewKickoff = null;   // one-shot "poke players to capture" timer after socket connect
let previewInterval = null;  // periodic preview refresh for the displays on the stage
let lastStageSig = null;     // structural signature of the last full stage paint (see paintStage)
// Per-wall split-column sources for a SINGLE spanning device (Mosaic): wallId ->
// array indexed by column (0=left). Survives repaint (kept here, NOT in the DOM)
// so dropping on the right column never blanks the left — both columns are re-sent
// together as one composite grid on each drop.
const wallSplitState = {};

// Build the set of device ids that belong to a video wall — those devices are
// represented by the wall card, never their own (mirrors dashboard.js:789-793).
async function loadWalls() {
  try {
    walls = await api.getWalls();
    if (!Array.isArray(walls)) walls = [];
  } catch { walls = []; }
  wallMemberIds = new Set();
  for (const w of walls) {
    for (const d of (w.devices || [])) {
      if (d && d.device_id) wallMemberIds.add(d.device_id);
    }
  }
}

function persistSelection() {
  api.putDisplaysSelection(selectedIds).catch(() => {});
}

// Drop any selected ids that are now wall members (or no longer exist), so a
// device promoted into a wall stops rendering as its own card. Persist if pruned.
function pruneSelection() {
  const known = new Set(displayState.getAll().map(d => d.id));
  const next = selectedIds.filter(id => !wallMemberIds.has(id) && known.has(id));
  if (next.length !== selectedIds.length) {
    selectedIds = next;
    persistSelection();
  }
}

function stageEl()    { return document.getElementById('mc-stage'); }
function toolboxEl()  { return document.getElementById('mc-toolbox'); }
function inspectorEl() { return document.getElementById('mc-inspector'); }
function summaryEl()  { return document.getElementById('mc-summary'); }

// A display is "live" (on-air) when it is online, not blanked, and resolving a
// real source — not idle. Mirrors the stage card's own status logic.
function isLive(d) {
  return !!(d && d.online && d.screen_on !== false &&
            d.now_playing && d.now_playing.kind && d.now_playing.kind !== 'idle');
}

// Glanceable header summary computed from the live store + selection. Real data
// only: "{n} displays · {m} online" plus a red on-air chip when any are live.
function paintSummary() {
  const el = summaryEl();
  if (!el) return;
  const onStage = displayState.getAll().filter(d => selectedIds.includes(d.id) && !wallMemberIds.has(d.id));
  const total = onStage.length + (Array.isArray(walls) ? walls.length : 0);
  if (total === 0) {
    el.innerHTML = `<span class="mc-summary-item mc-summary-muted">${esc(t('mc.summary.empty'))}</span>`;
    return;
  }
  const online = onStage.filter(d => d.online).length;
  const live = onStage.filter(isLive).length;
  const parts = [
    `<span class="mc-summary-item">${esc(tn('mc.summary.displays', total))}</span>`,
    `<span class="mc-summary-dot" aria-hidden="true">·</span>`,
    `<span class="mc-summary-item">${esc(t('mc.summary.online', { n: online }))}</span>`,
  ];
  if (live > 0) {
    parts.push(`<span class="mc-chip mc-chip-live mc-summary-live"><span class="mc-chip-dot" aria-hidden="true"></span>${esc(tn('mc.summary.live', live))}</span>`);
  }
  el.innerHTML = parts.join('');
}

// Called when a blank/unblank command ack updates a display's screen_on value.
// We patch the display-state store client-side so the status dot repaints
// immediately (the next server push will confirm or correct it).
function handleScreenOnChange(deviceId, newScreenOn) {
  // display-state.js does not expose a direct patch() — the store re-merges on
  // each subscriber notification. We trigger a lightweight re-paint here; the
  // authoritative value will be confirmed on the next device-status socket event
  // (which the server emits after writing screen_on per Task 1.4).
  //
  // For immediate visual feedback we directly update the cached value by
  // re-using the store's merge pathway: we fire a synthetic subscriber notify
  // by calling paintStage() after patching via the private merge API.
  // Since display-state.js does not export merge(), we instead call paintStage()
  // with the local knowledge that the card's transport bar already updated its
  // own button label via the ack callback. The next device-status event from the
  // server will sync the store fully. This is correct for the "blanked" status
  // dot rendering — it relies on display.screen_on which comes from the store.
  //
  // To avoid a visually jarring "un-update", we also refresh the store
  // immediately (lightweight GET /api/displays/state).
  displayState.refresh().catch(() => {});
  void deviceId; void newScreenOn; // used above
}

function paintStage() {
  const el = stageEl();
  if (!el) return;
  const all = displayState.getAll();
  // Live state of EVERY display, incl. wall members, so wall composites can show
  // what each member screen is showing right now.
  const byId = new Map(all.map(d => [d.id, d]));
  const displays = all.filter(d => !wallMemberIds.has(d.id));
  // Phase 1 Command Center: when a target is selected, render ONLY that target
  // large on the canvas (its wall card / its single display card). null keeps the
  // legacy "whole room" stage. The persisted selectedIds (drives content sends)
  // is untouched — this is a VIEW filter only, so a target switch never drops a
  // display from the broadcast set.
  let renderWalls = walls;
  let renderSelectedIds = selectedIds;
  if (activeTarget) {
    if (activeTarget.type === 'wall') {
      renderWalls = (walls || []).filter((w) => w.id === activeTarget.id);
      renderSelectedIds = [];
    } else if (activeTarget.type === 'display') {
      renderWalls = [];
      renderSelectedIds = [activeTarget.id];
    }
  }
  renderStage(el, {
    displays,
    walls: renderWalls,
    byId,
    selectedIds: renderSelectedIds,
    onSelect: openInspector,
    onCalibrateWall: showWallCalibration,
    onAddDisplay: openAddPicker,
    onScreenOnChange: handleScreenOnChange,
    onSetWallMode: setWallMode,
    onScreensaver: applyScreensaver,
  });
  // Re-attach drop handlers on the freshly-rendered cards.
  attachStageDrop(el);
  // Record what we just rendered so screenshot-only updates can patch in place
  // (see stageSignature / refreshPreviewsInPlace) instead of rebuilding + flashing.
  lastStageSig = stageSignature();
}

// A compact signature of the STRUCTURE the stage renders: which cards/wall cells
// exist and their at-a-glance state (online, screen_on, now-playing kind, whether
// a preview exists). It deliberately EXCLUDES the screenshot URL/timestamp, which
// change on every capture. So when only a new screenshot arrives the signature is
// unchanged and we patch the <img> src in place (flicker-free) rather than
// rebuilding the whole stage (which reloaded every image and flashed the cards).
function stageSignature() {
  const byId = new Map(displayState.getAll().map(d => [d.id, d]));
  const parts = [];
  const playingSig = (d) => {
    const np = d && d.now_playing;
    if (!np) return '';
    return [np.kind || '', np.contentId || '', np.label || '', np.poster_url || ''].join('~');
  };
  for (const id of selectedIds) {
    if (wallMemberIds.has(id)) continue;
    const d = byId.get(id);
    if (!d) continue;
    parts.push('c:' + id + ':' + (d.online ? 1 : 0) + ':' + (d.screen_on === false ? 0 : 1) +
      ':' + playingSig(d) + ':' + (d.screenshot_url ? 1 : 0) + ':' + ((d.now_playing && d.now_playing.poster_url) ? 'p' : ''));
  }
  for (const w of (walls || [])) {
    parts.push('w:' + w.id + ':' + (w.grid_cols || 0) + 'x' + (w.grid_rows || 0) + ':' + (w.leader_device_id || '') + ':' + (w.layout_mode || 'span'));
    for (const m of (w.devices || [])) {
      const d = byId.get(m.device_id) || {};
      parts.push('m:' + m.device_id + ':' + (d.online ? 1 : 0) + ':' + (d.screen_on === false ? 0 : 1) +
        ':' + playingSig(d) + ':' + (d.screenshot_url ? 1 : 0) + ':' + ((d.now_playing && d.now_playing.poster_url) ? 'p' : ''));
    }
  }
  return parts.join('|');
}

// Patch the preview <img>s already on the stage to the latest screenshot URL,
// without rebuilding the DOM. Setting img.src keeps the current frame visible
// until the new one decodes (no blank flash), which is the whole point.
function refreshPreviewsInPlace() {
  const el = stageEl();
  if (!el) return;
  const byId = new Map(displayState.getAll().map(d => [d.id, d]));
  el.querySelectorAll('img.mc-card-shot, img.mc-wall-cell-shot, img.mc-wall-span-shot').forEach(img => {
    const host = img.closest('[data-device-id]');
    const id = host && host.dataset.deviceId;
    const d = id && byId.get(id);
    if (!d || !d.screenshot_url) return;
    // A cell intentionally showing the content's poster (un-capturable video /
    // deck / web, see stage.previewSource) must NOT be clobbered with the black
    // live screenshot on the next capture tick — leave the poster in place.
    if (d.now_playing && d.now_playing.poster_url) return;
    if (img.getAttribute('src') !== d.screenshot_url) img.setAttribute('src', d.screenshot_url);
  });
}

// After a successful send we re-FETCH display state (not just repaint) so the
// target card's now-playing label updates immediately — the store notifies its
// subscribers, which triggers paintStage. Repainting alone showed stale data.
// We ALSO poke the affected players to capture a fresh screenshot (after a beat,
// so the new content has loaded) — that is what makes the preview show what is
// NOW playing right after a drag-drop / send. `targetIds` is optional; without it
// we refresh every visible display.
function refreshAfterSend(targetIds) {
  displayState.refresh().catch(() => {});
  const ids = (Array.isArray(targetIds) && targetIds.length) ? targetIds : visibleDeviceIds();
  setTimeout(() => { for (const id of ids) requestScreenshot(id); }, 1800);
}

// A screensaver option was chosen on a card's dropdown: broadcast the chosen
// source (the wall.mbfdhub.com dashboard, or a wallpaper image) to that card's
// device(s). Reuses the same send funnel as every other broadcast.
function applyScreensaver(ids, source, label) {
  if (source && source._screensaver === 'folder') {
    // Open the media drawer filtered to that folder; no broadcast. Lets the
    // operator pick a screensaver asset from the seeded "Screensavers" folder.
    openContentDrawerFiltered(source.folder);
    return;
  }
  if (source && source._screensaver === 'blank' && source.variant === 'black') {
    if (!Array.isArray(ids) || ids.length === 0) return;
    sendToDisplays({ remote_url: BLACK_SCREENSAVER_URL }, ids, label || t('mc.saver.blank_black'))
      .then((ok) => { if (ok) refreshAfterSend(ids); });
    return;
  }
  if (!Array.isArray(ids) || ids.length === 0 || !source) return;
  sendToDisplays(source, ids, label).then((ok) => { if (ok) refreshAfterSend(ids); });
}

function showWallCalibration(deviceIds, wallName) {
  const ids = [...new Set(Array.isArray(deviceIds) ? deviceIds : [])];
  if (ids.length === 0) return;
  ids.forEach(id => identifyDevice(id, { mode: 'calibration', duration_ms: 30000 }));
  showToast(t('mc.wall.calibrate_sent', { name: wallName || t('mc.wall.screen_fallback') }), 'success');
}

// Switch a wall's Span/Split template. 'span' = one source stretched across every
// screen (true wall sync); 'split' = each screen plays its own source. The server
// re-pushes fresh payloads to every member (entering/exiting wall mode), so the
// physical screens reconfigure; we reload walls + repaint so the card reflects it.
async function setWallMode(wallId, mode) {
  if (!wallId || (mode !== 'span' && mode !== 'split')) return;
  const wall = (walls || []).find(w => w.id === wallId);
  if (wall && wall.layout_mode === mode) return; // already in this template
  try {
    await api.updateWall(wallId, { layout_mode: mode });
    await loadWalls();
    paintStage();
    paintSummary();
    showToast(t(mode === 'split' ? 'mc.wall.tpl_split_on' : 'mc.wall.tpl_span_on'), 'success');
  } catch (e) {
    showToast(e?.message || t('mc.wall.tpl_error'), 'error');
  }
}

// Drop a source onto ONE column of a single-spanning-device split wall (a PC
// driving N TVs as one Mosaic window). There is only one physical device, so both
// columns must travel together as ONE composite grid URL: we MERGE the new column
// into the wall's kept column state, rebuild the grid, ensure the wall is in split
// mode (so the server gives this device its own playlist, not the shared span one),
// then broadcast the merged grid to that single device. Dropping on the right
// leaves the left intact and vice-versa.
async function dropOnWallHalf(wallId, halfIndex, source, label) {
  const wall = (walls || []).find(w => w.id === wallId);
  if (!wall) return;
  const cols = Math.max(2, wall.grid_cols || 2);
  const leaderId = wall.leader_device_id
    || (wall.devices && wall.devices[0] && wall.devices[0].device_id);
  if (!leaderId) { showToast(t('mc.send.no_displays'), 'error'); return; }

  const arr = wallSplitState[wallId] ? wallSplitState[wallId].slice() : new Array(cols).fill(null);
  arr[halfIndex] = { source, label };
  wallSplitState[wallId] = arr;

  let url;
  try { url = await buildSplitGridUrl(arr, cols); }
  catch { url = null; }
  if (!url) { showToast(t('mc.send.failed'), 'error'); return; }

  // The single device needs its OWN playlist (not the shared span playlist) for the
  // composite to land — that happens only in split mode. Idempotent if already split.
  if (wall.layout_mode !== 'split') {
    try { await api.updateWall(wallId, { layout_mode: 'split' }); await loadWalls(); }
    catch { /* best-effort; broadcast still targets the device directly */ }
  }

  const ok = await sendToDisplays({ remote_url: url }, [leaderId], label || t('mc.wall.split_label'));
  if (ok) { refreshAfterSend([leaderId]); paintStage(); }
}

// ---- Live preview driver ----
//
// Players only capture + send a screenshot when ASKED (device:screenshot-request);
// without a request, a card's screenshot_url stays null and it reads "No preview"
// forever. The retired dashboard poked every card 2s after load + every 30s — the
// unified control surface dropped that driver during consolidation, which is why
// previews never loaded here. Re-add it, scoped to the displays actually on screen:
// the selected non-wall cards PLUS every wall member screen (wall cells each render
// their own member's live preview). Offline devices are a server-side no-op.
function visibleDeviceIds() {
  const ids = new Set(selectedIds.filter(id => id && !wallMemberIds.has(id)));
  for (const id of wallMemberIds) if (id) ids.add(id);
  return [...ids];
}
function requestVisiblePreviews() {
  for (const id of visibleDeviceIds()) requestScreenshot(id);
}
function startPreviewRefresh() {
  stopPreviewRefresh();
  // Let the dashboard socket finish connecting, poke once, then keep them fresh.
  previewKickoff = setTimeout(requestVisiblePreviews, 1500);
  previewInterval = setInterval(requestVisiblePreviews, 20000);
}
function stopPreviewRefresh() {
  if (previewKickoff) { clearTimeout(previewKickoff); previewKickoff = null; }
  if (previewInterval) { clearInterval(previewInterval); previewInterval = null; }
}

// Content-send target scope: the displays on the stage (the current selection).
// Dragging a source onto a single card always targets just that card.
function isLiveStreamTargetId(id) {
  return typeof id === 'string' && id.startsWith('live-stream-program-');
}
function roomDisplayIds() {
  return displayState.getAll().filter(d => !wallMemberIds.has(d.id) && !isLiveStreamTargetId(d.id)).map(d => d.id);
}
function onlineRoomDisplayIds() {
  return displayState.getAll().filter(d => d.online && !wallMemberIds.has(d.id) && !isLiveStreamTargetId(d.id)).map(d => d.id);
}
// The managed "Content for live stream" target must NEVER be an implicit
// broadcast target. It only receives content when the instructor explicitly
// answers "include in live stream" on a send. Excluding it here stops a
// stage-background "send to all on stage" drop from leaking classroom content
// onto the live program.
function effectiveTargets() {
  return selectedIds.filter((id) => !isLiveStreamTargetId(id));
}

// Physical screen-power scope for Blank all: EVERY controllable display PLUS
// every video-wall member device (each wall screen is a real device that must
// receive its own screen_off/screen_on — the wall card alone never would).
function roomCommandIds() {
  const ids = new Set(roomDisplayIds());
  for (const id of wallMemberIds) if (id) ids.add(id);
  return [...ids];
}

function wallDeviceIds(wall) {
  return [...new Set(((wall && wall.devices) || []).map(m => m.device_id).filter(Boolean))];
}

async function applyWallRoutingModes(wallSelections) {
  const changes = [];
  for (const selection of (wallSelections || [])) {
    const wall = selection.wall;
    if (!wall || !wall.id) continue;
    const desired = selection.mode === 'sections' ? 'split' : 'span';
    const current = wall.layout_mode === 'split' ? 'split' : 'span';
    if (current !== desired) changes.push(api.updateWall(wall.id, { layout_mode: desired }));
  }
  if (!changes.length) return;
  await Promise.all(changes);
  await loadWalls();
  paintStage();
  paintSummary();
}

async function chooseRouteTargets(label) {
  const allDisplays = displayState.getAll().filter(d => !wallMemberIds.has(d.id));
  const result = await pickRoutingTargets({ displays: allDisplays, walls, label });
  if (!result) return null;
  const targetIds = [...new Set([
    ...(result.displayIds || []),
    ...(result.wallSelections || []).flatMap(sel => sel.deviceIds || wallDeviceIds(sel.wall)),
  ])];
  if (!targetIds.length) {
    showToast(t('mc.send.no_displays'), 'error');
    return null;
  }
  return { targetIds, wallSelections: result.wallSelections || [] };
}

async function routeSourceWithPicker(source, label = t('mc.tile.content_fallback')) {
  if (hasAdvancedCanvasEndpoint()) {
    return routeSourceToAdvancedCanvas(source, label);
  }
  const route = await chooseRouteTargets(label);
  if (!route) return false;
  try {
    await applyWallRoutingModes(route.wallSelections);
  } catch (e) {
    showToast(e?.message || t('mc.wall.tpl_error'), 'error');
    return false;
  }
  const ok = await sendToDisplays(source, route.targetIds, label);
  if (ok) refreshAfterSend(route.targetIds);
  return ok;
}

async function routeNextcloudWithPicker(path, label = t('mc.tile.content_fallback')) {
  if (hasAdvancedCanvasEndpoint()) {
    try {
      const imported = await api.files.importForCanvas(path);
      return routeSourceToAdvancedCanvas({ content_id: imported.content_id }, label);
    } catch (e) {
      showToast(e?.message || t('mc.send.failed'), 'error');
      return false;
    }
  }
  const route = await chooseRouteTargets(label);
  if (!route) return false;
  try {
    await applyWallRoutingModes(route.wallSelections);
    let result = await api.files.broadcast(path, route.targetIds);
    if (result && result.code === 'CONFIRM_ALL_REQUIRED') {
      const ok = await confirmDialog({
        title: t('mc.send.confirm_all_title', { n: result.count }),
        message: t('mc.send.confirm_all_msg', { label }),
        confirmLabel: t('mc.send.confirm_all_ok'),
        tone: 'default',
      });
      if (!ok) return false;
      result = await api.files.broadcast(path, route.targetIds, { confirm_all: true });
    }
    if (result && result.success) {
      sentToast(label, result.sent, result.total);
      refreshAfterSend(route.targetIds);
      return true;
    }
  } catch (e) {
    showToast(e?.message || t('mc.send.failed'), 'error');
  }
  return false;
}

function paintToolbox() {
  const el = toolboxEl();
  if (!el) return;
  renderToolbox(el, {
    selectedIds: effectiveTargets(),
    onAfterSend: refreshAfterSend,
    onRouteSource: routeSourceWithPicker,
    onRouteNextcloud: routeNextcloudWithPicker,
  });
}

// The library drawer sits BELOW the inspector (z-index 30 vs 40) and is fully
// covered by it when open. While the inspector is open we also mark the drawer
// inert + aria-hidden so keyboard/AT users can't tab into the obscured drawer;
// closing the inspector restores it (and the drawer re-reveals naturally, since
// the inspector just becomes hidden — no extra show/hide coordination needed).
function setLibraryInert(inert) {
  const drawer = document.getElementById('mc-library-drawer');
  if (!drawer) return;
  if (inert) {
    drawer.setAttribute('inert', '');
    drawer.setAttribute('aria-hidden', 'true');
  } else {
    drawer.removeAttribute('inert');
    drawer.removeAttribute('aria-hidden');
  }
}

// Selecting a stage card opens the inspector for that display (Task 4.4):
// display info, "Partition into regions", per-region audio + fit. Closing the
// panel hides it. Wall members never render as their own card, but we still pass
// the (defensive) wall-member flag so the inspector's Partition guard is correct
// even if a selected display was just promoted into a wall.
function openInspector(deviceId) {
  const el = inspectorEl();
  if (!el) return;
  const display = displayState.get(deviceId);
  if (!display) { closeInspector(el); setLibraryInert(false); return; }
  setLibraryInert(true);
  renderInspector(el, {
    display,
    isWallMember: wallMemberIds.has(deviceId),
    onClose: () => { setLibraryInert(false); },
    onDeviceChanged: async () => {
      await displayState.refresh().catch(() => {});
      await loadWalls();
pruneSelection();
  paintStage();
  paintToolbox();
  paintSummary();
    },
  });
}

// Composed, touch-first add-display picker built on the native <dialog> (CSP-safe:
// wired with addEventListener, no inline handlers). Replaces window.prompt — the
// classroom controller must never use prompt()/alert(). Resolves to a device id
// or null. The dialog is created once and reused.
let pickerEl = null;
function pickDisplayDialog(candidates) {
  if (!pickerEl || !document.body.contains(pickerEl)) {
    pickerEl = document.createElement('dialog');
    pickerEl.className = 'mc-dialog mc-pick';
    pickerEl.setAttribute('aria-labelledby', 'mcPickTitle');
    document.body.appendChild(pickerEl);
  }
  const d = pickerEl;
  const options = candidates.map(c =>
    `<button type="button" class="mc-pick-item" data-pick-id="${esc(c.id)}">
       <span class="mc-pick-name">${esc(c.name)}</span>
       ${c.online ? '' : `<span class="mc-pick-offline">${esc(t('mc.add.offline'))}</span>`}
     </button>`).join('');
  const listInner = options || `<p class="mc-pick-empty">${esc(t('mc.add.all_on_stage'))}</p>`;
  d.innerHTML = `
    <div class="mc-dialog-card">
      <h3 id="mcPickTitle" class="mc-dialog-title">${esc(t('mc.add.title'))}</h3>
      <p class="mc-dialog-msg">${esc(t('mc.add.message'))}</p>
      <div class="mc-pick-list" role="listbox" aria-label="${esc(t('mc.add.title'))}">${listInner}</div>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-pick-cancel>${esc(t('mc.add.cancel'))}</button>
        <button type="button" class="mc-btn mc-btn-primary" data-pick-pair>${esc(t('mc.add.pair'))}</button>
      </div>
    </div>`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      d.querySelectorAll('[data-pick-id]').forEach(b => b.removeEventListener('click', onPick));
      cancelBtn.removeEventListener('click', onCancel);
      pairBtn.removeEventListener('click', onPair);
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onCancel);
      if (d.open) d.close();
      resolve(val);
    };
    const onPick = (e) => finish(e.currentTarget.dataset.pickId);
    const onCancel = () => finish(null);
    const onPair = () => finish('__pair__');
    const cancelBtn = d.querySelector('[data-pick-cancel]');
    const pairBtn = d.querySelector('[data-pick-pair]');
    d.querySelectorAll('[data-pick-id]').forEach(b => b.addEventListener('click', onPick));
    cancelBtn.addEventListener('click', onCancel);
    pairBtn.addEventListener('click', onPair);
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onCancel);
    d.showModal();
  });
}

// Pair a NEW display from the Command Center: a composed code+name dialog that
// hits the same /api/provision/pair endpoint the Displays view uses. Resolves to
// { code, name } or null. CSP-safe (createElement + addEventListener, esc()).
function pairDisplayDialog() {
  const dlg = document.createElement('dialog');
  dlg.className = 'mc-dialog mc-pair';
  dlg.setAttribute('aria-labelledby', 'mcPairTitle');
  dlg.innerHTML = `
    <form method="dialog" class="mc-dialog-card">
      <h3 id="mcPairTitle" class="mc-dialog-title">${esc(t('mc.pair.title'))}</h3>
      <p class="mc-dialog-msg">${esc(t('mc.pair.message'))}</p>
      <label class="mc-pair-field"><span>${esc(t('mc.pair.code_label'))}</span>
        <input class="input mc-pair-code" type="text" inputmode="numeric" autocomplete="off" maxlength="6" pattern="[0-9]{6}" placeholder="000000"></label>
      <label class="mc-pair-field"><span>${esc(t('mc.pair.name_label'))}</span>
        <input class="input mc-pair-name" type="text" autocomplete="off" placeholder="${esc(t('mc.pair.name_placeholder'))}"></label>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-pair-cancel>${esc(t('mc.pair.cancel'))}</button>
        <button type="button" class="mc-btn mc-btn-primary" data-pair-go>${esc(t('mc.pair.submit'))}</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const codeEl = dlg.querySelector('.mc-pair-code');
  const nameEl = dlg.querySelector('.mc-pair-name');
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; if (dlg.open) dlg.close(); dlg.remove(); resolve(val); };
    dlg.querySelector('[data-pair-cancel]').addEventListener('click', () => finish(null));
    dlg.addEventListener('cancel', () => finish(null));
    dlg.querySelector('[data-pair-go]').addEventListener('click', () => {
      const code = (codeEl.value || '').trim();
      if (!/^[0-9]{6}$/.test(code)) { showToast(t('mc.pair.invalid_code'), 'error'); codeEl.focus(); return; }
      finish({ code, name: (nameEl.value || '').trim() });
    });
    dlg.showModal();
    codeEl.focus();
  });
}

// Pair flow: prompt -> /api/provision/pair -> refresh state -> auto-add the new
// display(s) to the stage. Any member with a login can pair into the shared room.
async function openPairDisplay() {
  const res = await pairDisplayDialog();
  if (!res) return;
  const before = new Set(displayState.getAll().map(d => d.id));
  let paired = null;
  try {
    paired = await api.pairDevice(res.code, res.name || undefined);
  } catch (e) {
    showToast(e?.message || t('mc.pair.failed'), 'error');
    return;
  }
  await displayState.refresh().catch(() => {});
  await loadWalls();
  const fresh = displayState.getAll().map(d => d.id).filter(id => !before.has(id) && !wallMemberIds.has(id));
  const pairedId = paired && paired.id && !wallMemberIds.has(paired.id) ? paired.id : null;
  const addIds = [...fresh, pairedId].filter(Boolean);
  if (addIds.length) { selectedIds = [...new Set([...selectedIds, ...addIds])]; persistSelection(); }
  paintStage();
  paintToolbox();
  paintSummary();
  showToast(t('mc.pair.success'), 'success');
}

// "Add display" — pick a known display not already on the stage (and not owned by
// a wall), OR pair a brand-new one, via the composed picker. The picker always
// offers "Pair a new display" so pairing lives inside the Command Center.
async function openAddPicker() {
  const selected = new Set(selectedIds);
  const candidates = displayState.getAll()
    .filter(d => !selected.has(d.id) && !wallMemberIds.has(d.id));
  const id = await pickDisplayDialog(candidates);
  if (!id) return;
  if (id === '__pair__') { await openPairDisplay(); return; }
  if (selectedIds.includes(id)) return;
  selectedIds = [...selectedIds, id];
  persistSelection();
  requestScreenshot(id); // poke the freshly-added display so its preview loads now
  paintStage();
  // Full toolbox re-render so BOTH the tile-click handlers AND the tab-switch
  // handlers re-bind to the new target set (a partial re-render would leave the
  // tab-switch buttons closed over a stale selection — switch tab, click a tile,
  // and it would send to nothing).
  paintToolbox();
  paintSummary();
}

// ---- Drag-drop: toolbox tiles → stage cards ----
//
// Each toolbox tile sets DataTransfer text with the source JSON payload on
// dragstart (see toolbox.js attachTileHandlers). Stage cards (rendered by
// stage.js) need to become drop targets AFTER the stage is repainted. This
// function wires those handlers onto the freshly-rendered cards.
function dragHasSource(e) {
  return !!e.dataTransfer && (
    e.dataTransfer.types.includes('application/x-mc-source') ||
    e.dataTransfer.types.includes('text/plain'));
}
function parseDragSource(e) {
  const raw = e.dataTransfer.getData('application/x-mc-source') ||
              e.dataTransfer.getData('text/plain');
  if (!raw) return null;
  let source;
  try { source = JSON.parse(raw); } catch { return null; }
  const label = e.dataTransfer.getData('application/x-mc-label') || t('mc.tile.content_fallback');
  return { source, label };
}

function attachStageDrop(stageContainer) {
  // Per-card drop → that ONE display. stopPropagation so the stage-level handler
  // below does not also fire and fan the source out to everyone.
  stageContainer.querySelectorAll('.mc-display-card[data-device-id], .mc-wall-cell[data-device-id]').forEach(card => {
    const isSplitWallCell = card.classList.contains('mc-wall-cell') && card.closest('.mc-wall')?.dataset.layoutMode === 'split';
    const isStandaloneCard = card.classList.contains('mc-display-card');
    if (!isStandaloneCard && !isSplitWallCell) return;
    card.addEventListener('dragover', (e) => {
      if (!dragHasSource(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      card.classList.add('mc-card-dragover');
    });
    card.addEventListener('dragleave', () => card.classList.remove('mc-card-dragover'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      card.classList.remove('mc-card-dragover');
      const parsed = parseDragSource(e);
      const deviceId = card.dataset.deviceId;
      if (!parsed || !deviceId) return;
      await sendToDisplays(parsed.source, [deviceId], parsed.label);
      refreshAfterSend([deviceId]); // re-fetch state + refresh THIS card's preview
    });
  });

  // Single-spanning-device split halves: drop a source onto ONE column of a wall
  // driven by one Mosaic window. Each half pushes its own source into a composite
  // grid on that single device (merge-and-resend; the other column is untouched).
  stageContainer.querySelectorAll('.mc-wall-split-half[data-device-id][data-split-half]').forEach(half => {
    half.addEventListener('dragover', (e) => {
      if (!dragHasSource(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      half.classList.add('mc-card-dragover');
    });
    half.addEventListener('dragleave', () => half.classList.remove('mc-card-dragover'));
    half.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      half.classList.remove('mc-card-dragover');
      const parsed = parseDragSource(e);
      const wallId = half.closest('.mc-wall[data-wall-id]')?.dataset.wallId;
      const idx = parseInt(half.dataset.splitHalf, 10);
      if (!parsed || !wallId || !Number.isInteger(idx)) return;
      await dropOnWallHalf(wallId, idx, parsed.source, parsed.label);
    });
  });

  // Whole-wall drop strips: drop a source here to fill EVERY screen of that wall
  // at once. The strip carries data-wall-ids="id1,id2,…"; stopPropagation so the
  // stage-background handler does not also fire. Re-wired each paint (fresh nodes).
  stageContainer.querySelectorAll('.mc-wall-all[data-wall-ids]').forEach(zone => {
    zone.addEventListener('dragover', (e) => {
      if (!dragHasSource(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      zone.classList.add('mc-wall-all-dragover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('mc-wall-all-dragover'));
    zone.addEventListener('drop', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      zone.classList.remove('mc-wall-all-dragover');
      const parsed = parseDragSource(e);
      if (!parsed) return;
      const ids = (zone.dataset.wallIds || '').split(',').filter(Boolean);
      if (!ids.length) { showToast(t('mc.send.no_displays'), 'error'); return; }
      await sendToDisplays(parsed.source, ids, parsed.label);
      refreshAfterSend(ids);
    });
  });

  // Stage-BACKGROUND drop → every display on the stage (the current selection).
  // Cards stopPropagation, so this only fires for drops on the gaps/background.
  // Wired once — the container node persists across repaints, so guard against
  // stacking duplicate listeners.
  if (stageContainer.__dropWired) return;
  stageContainer.__dropWired = true;
  stageContainer.addEventListener('dragover', (e) => {
    if (!dragHasSource(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    stageContainer.classList.add('mc-stage-dragover');
  });
  stageContainer.addEventListener('dragleave', (e) => {
    if (!stageContainer.contains(e.relatedTarget)) stageContainer.classList.remove('mc-stage-dragover');
  });
  stageContainer.addEventListener('drop', async (e) => {
    e.preventDefault();
    stageContainer.classList.remove('mc-stage-dragover');
    const parsed = parseDragSource(e);
    if (!parsed) return;
    const targets = effectiveTargets();
    if (!targets.length) { showToast(t('mc.send.no_displays'), 'error'); return; }
    await sendToDisplays(parsed.source, targets, parsed.label);
    refreshAfterSend(targets);
  });
}

// ── Phase 1 Command Center helpers ──────────────────────────────────────────
//
// All canvas-level controls (transport row, Span/Split, screensaver, dock, status
// chips, target switch) are VIEW-ONLY with respect to other targets: switching the
// active target never emits a stop/blank to whatever was showing before. Only the
// explicit dock buttons (Blank selected / Blank all / Stop live ...) issue
// commands, and only to the active target (or every room target for "all").

// Device ids the active target commands: every member of the active wall, or just
// the active display.
function activeTargetDeviceIds() {
  if (!activeTarget) return [];
  if (activeTarget.type === 'wall') {
    const w = (walls || []).find((x) => x.id === activeTarget.id);
    return w ? wallDeviceIds(w) : [];
  }
  return activeTarget.id ? [activeTarget.id] : [];
}
// Transport (play/pause/prev/next/restart) targets the wall LEADER (which drives
// wall sync) for a wall, or the display itself.
function activeTargetTransportId() {
  if (activeTarget && activeTarget.type === 'wall') {
    const w = (walls || []).find((x) => x.id === activeTarget.id);
    if (!w) return null;
    return w.leader_device_id || (w.devices && w.devices[0] && w.devices[0].device_id) || null;
  }
  return (activeTarget && activeTarget.id) || null;
}
// The active wall object (or null) — used by the Span/Split toggle.
function activeWall() {
  if (!activeTarget || activeTarget.type !== 'wall') return null;
  return (walls || []).find((x) => x.id === (activeTarget.wall_id || activeTarget.id)) || null;
}
// Content currently assigned to the wall? (Any member showing a real source.)
function wallHasContent(wall) {
  if (!wall || !Array.isArray(wall.devices)) return false;
  const byId = new Map(displayState.getAll().map((d) => [d.id, d]));
  for (const m of wall.devices) {
    const live = byId.get(m.device_id);
    const np = live && live.now_playing;
    if (np && np.kind && np.kind !== 'idle') return true;
  }
  return false;
}

// The active target changed — re-point the canvas + refresh the canvas-level
// controls. Emits NO command: this is a view-only switch.
// TODO(Phase-2 target rooms): join a per-target socket room. socket.js does not
// expose a 'select-target' emit / window.mcSocket today, so we deliberately do
// NOT emit anything here. Wire `dashboard:select-target` once socket.js grows a
// helper (getSocket() would be the entry point then).
function handleTargetChange(tgt) {
  activeTarget = tgt || null;
  paintStage();
  paintSummary();
  paintChips();
  if (transportApi && transportApi.repaint) transportApi.repaint();
  if (spanSplitApi && spanSplitApi.repaint) spanSplitApi.repaint();
  if (screensaverApi && screensaverApi.repaint) screensaverApi.repaint();
}

// Pick the initial canvas target so the canvas opens on ONE large preview (per
// the mockup): the first video wall, else the first online non-wall display,
// else the first non-wall display. Returns a target object or null.
function chooseInitialTarget() {
  if (Array.isArray(walls) && walls.length) {
    const w = walls.slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))[0];
    if (w && w.id) return { type: 'wall', id: w.id, wall_id: w.id, supportsModes: true };
  }
  const all = displayState.getAll().filter((d) => !wallMemberIds.has(d.id) && !isLiveStreamTargetId(d.id));
  const d = all.find((x) => x.online) || all[0];
  return d ? { type: 'display', id: d.id, supportsModes: false } : null;
}

// Canvas-level transport row (Prev · Restart · Play/Pause · Next) bound to the
// active target's transport. White rounded buttons styled in media-control.css.
function mountTransportRow(hostEl) {
  if (!hostEl) return null;
  hostEl.innerHTML = `
    <div class="mc-cc-tp-row" role="toolbar" aria-label="${esc(t('mc.tp.toolbar'))}" hidden>
      <button type="button" class="mc-cc-tp-btn" data-cc-tp="prev"><span class="mc-cc-tp-ico" aria-hidden="true">⏮</span><span class="mc-cc-tp-text">${esc(t('mc.cc.transport.prev'))}</span></button>
      <button type="button" class="mc-cc-tp-btn" data-cc-tp="restart"><span class="mc-cc-tp-ico" aria-hidden="true">↺</span><span class="mc-cc-tp-text">${esc(t('mc.cc.transport.restart'))}</span></button>
      <button type="button" class="mc-cc-tp-btn mc-cc-tp-play" data-cc-tp="play_pause"><span class="mc-cc-tp-ico" aria-hidden="true">⏯</span><span class="mc-cc-tp-text">${esc(t('mc.cc.transport.play'))}</span></button>
      <button type="button" class="mc-cc-tp-btn" data-cc-tp="next"><span class="mc-cc-tp-ico" aria-hidden="true">⏭</span><span class="mc-cc-tp-text">${esc(t('mc.cc.transport.next'))}</span></button>
    </div>`;
  const row = hostEl.querySelector('.mc-cc-tp-row');
  hostEl.querySelectorAll('[data-cc-tp]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = activeTargetTransportId();
      if (!id) return;
      const action = btn.dataset.ccTp; // 'prev' | 'restart' | 'play_pause' | 'next'
      sendCommand(id, COMMAND_TYPES.TRANSPORT, { action });
      // Optimistically refresh the Play/Pause label after a toggle.
      setTimeout(() => transportApi && transportApi.repaint && transportApi.repaint(), 400);
    });
  });
  return {
    repaint() {
      const id = activeTargetTransportId();
      if (row) row.hidden = !id;
      const pp = hostEl.querySelector('[data-cc-tp="play_pause"] .mc-cc-tp-text');
      if (pp && id) {
        const dev = displayState.get(id);
        const playing = !!(dev && dev.now_playing && dev.now_playing.kind && dev.now_playing.kind !== 'idle');
        pp.textContent = playing ? t('mc.cc.transport.pause') : t('mc.cc.transport.play');
      }
    },
  };
}

// Canvas-level Screensaver / Wallpaper dropdown for the active target. Reuses the
// SAME option list as the per-card screensaver (stage.js) and the existing
// applyScreensaver() broadcast funnel. The first option is the non-committal
// "MBFD Default" placeholder per the mockup.
function mountScreensaverRow(hostEl) {
  if (!hostEl) return null;
  const opts = SCREENSAVER_OPTIONS_CC
    .map((o) => `<option value="${esc(o.value)}">${esc(t(o.labelKey))}</option>`)
    .join('');
  hostEl.innerHTML = `
    <div class="mc-screensaver-row" hidden>
      <span class="mc-screensaver-label">${esc(t('mc.cc.saver.label'))}:</span>
      <select class="mc-cc-saver-select" aria-label="${esc(t('mc.cc.saver.label'))}">
        <option value="">${esc(t('mc.cc.saver.default'))}</option>
        ${opts}
      </select>
    </div>`;
  const row = hostEl.querySelector('.mc-screensaver-row');
  const sel = hostEl.querySelector('.mc-cc-saver-select');
  sel.addEventListener('change', () => {
    const val = sel.value;
    sel.value = '';
    if (!val) return;
    const ids = activeTargetDeviceIds();
    if (!ids.length) return;
    let source = null;
    if (val.startsWith('url:')) source = { remote_url: val.slice(4) };
    else if (val.startsWith('content:')) source = { content_id: val.slice(8) };
    else if (val.startsWith('folder:')) source = { _screensaver: 'folder', folder: val.slice(7) };
    else if (val.startsWith('blank:')) source = { _screensaver: 'blank', variant: val.slice(6) };
    if (!source) return;
    const opt = SCREENSAVER_OPTIONS_CC.find((o) => o.value === val);
    applyScreensaver(ids, source, opt ? t(opt.labelKey) : t('mc.cc.saver.label'));
  });
  return {
    repaint() { if (row) row.hidden = !activeTargetDeviceIds().length; },
  };
}

// Phase-2: command:ack surfacing. ok:false (timeout or device-reported failure)
// is NON-silent — show a toast naming the target + flip the chips to Stale/Failed.
// We only toast for acks whose target matches the active target so the operator
// isn't spammed with every command from every target in the shared workspace room.
function targetLabelOf(targetId) {
  if (!targetId) return t('mc.cc.chip.offline');
  const d = displayState.getAll().find((x) => x.id === targetId);
  if (d && d.name) return d.name;
  const w = walls.find((x) => x.id === targetId);
  if (w && w.name) return w.name;
  return String(targetId).slice(0, 8);
}
function activeTargetIds() {
  if (!activeTarget) return [];
  if (activeTarget.wall_id) {
    const w = walls.find((x) => x.id === activeTarget.wall_id);
    return (w && w.devices ? w.devices.map((d) => d.device_id) : []);
  }
  return activeTarget.device_id ? [activeTarget.device_id] : [];
}
function handleCommandAck(data) {
  if (!data) return;
  const related = activeTargetIds().includes(data.target_id || data.device_id)
    || (activeTarget && (activeTarget.wall_id === data.target_id || activeTarget.device_id === data.target_id));
  if (data.ok === false && related) {
    const label = targetLabelOf(data.target_id || data.device_id);
    const msg = data.status === 'timeout'
      ? t('mc.cc.cmd_not_ack', { target: label })
      : (data.error ? (label + ': ' + data.error) : t('mc.cc.cmd_failed', { target: label }));
    showToast(msg, 'error');
    // Force a chip repaint so Stale/Failed reflects immediately.
    try { paintChips(); } catch (_) {}
  }
}
// Display self-report state → refresh chips (keeps Playing/Paused/Synced live).
function handleStateSync(data) {
  try { paintChips(); } catch (_) {}
  void data;
}

// Small unobtrusive status chips above the canvas for the active target. Real
// data only: Online / Synced / Playing-or-Paused / Live / Stale / Offline.
function paintChips() {
  const host = document.getElementById('mc-cc-chips');
  if (!host) return;
  const ids = activeTargetDeviceIds();
  if (!ids.length) { host.innerHTML = ''; return; }
  const byId = new Map(displayState.getAll().map((d) => [d.id, d]));
  const devs = ids.map((id) => byId.get(id)).filter(Boolean);
  if (!devs.length) { host.innerHTML = `<span class="mc-cc-chip mc-cc-chip-offline">${esc(t('mc.cc.chip.offline'))}</span>`; return; }
  const anyOnline = devs.some((d) => d.online);
  const allOnline = devs.every((d) => d.online);
  const anyPlaying = devs.some(isLive);
  const idle = devs.every((d) => !(d.now_playing && d.now_playing.kind && d.now_playing.kind !== 'idle'));
  const nowS = Math.floor(Date.now() / 1000);
  const anyStale = devs.some((d) => d.screenshot_at && (nowS - d.screenshot_at) > 30) || devs.some((d) => !d.screenshot_at);
  const connected = !!(getSocket && getSocket() && getSocket().connected);
  const chips = [];
  if (allOnline) chips.push(['online', t('mc.cc.chip.online')]);
  else if (anyOnline) chips.push(['online', t('mc.cc.chip.online')]);
  else chips.push(['offline', t('mc.cc.chip.offline')]);
  if (connected) chips.push(['synced', t('mc.cc.chip.synced')]);
  if (idle) chips.push(['paused', t('mc.cc.chip.paused')]);
  else chips.push(['playing', t('mc.cc.chip.playing')]);
  if (anyPlaying) chips.push(['live', t('mc.cc.chip.live')]);
  if (anyOnline && anyStale) chips.push(['stale', t('mc.cc.chip.stale')]);
  if (!anyOnline) chips.push(['failed', t('mc.cc.chip.failed')]);
  host.innerHTML = chips.map(([k, l]) => `<span class="mc-cc-chip mc-cc-chip-${k}">${esc(l)}</span>`).join('');
}

// ---- Action-dock command providers (route to existing functionality) ----
function blankActiveTarget() {
  const ids = activeTargetDeviceIds();
  if (!ids.length) { showToast(t('mc.cmd.no_displays'), 'error'); return; }
  ids.forEach((id) => sendCommand(id, COMMAND_TYPES.SCREEN_OFF, {}));
  showToast(t('mc.cmd.blanked'), 'info');
  displayState.refresh().catch(() => {});
}
async function blankAllTargets() {
  const ids = roomCommandIds();
  if (!ids.length) { showToast(t('mc.cmd.no_displays'), 'error'); return; }
  const ok = await confirmDialog({
    title: t('mc.cc.dock.blank_all'),
    message: t('mc.cc.confirm.blank_all'),
    confirmLabel: t('mc.cc.dock.blank_all'),
    tone: 'danger',
  });
  if (!ok) return;
  ids.forEach((id) => sendCommand(id, COMMAND_TYPES.SCREEN_OFF, {}));
  showToast(t('mc.cmd.blanked'), 'info');
  displayState.refresh().catch(() => {});
}
// Open the existing screen-share flow. The active Command Center target decides
// the default share destination per the Phase-8 default-one-region guard:
//   • display target  → share to that one display directly (no picker)
//   • wall target     → show a picker (each member TV label + "Span across wall"
//                       explicit + "Cancel") — auto-stretch across the wall is no
//                       longer the default; the operator must choose it explicitly
//   • no target       → open the share view as before (its own picker)
// The resolved target is handed to the share view via sessionStorage (read by
// views/screen-share.js) which only PRE-HIGHLIGHTS the matching row — the
// existing capture-then-check WebRTC signalling is untouched.
function shareScreenActive() {
  shareScreenActiveAsync().catch(() => { window.location.hash = '#/screen-share'; });
}
async function shareScreenActiveAsync() {
  const target = activeTarget;
  if (target && target.type === 'wall') {
    const wall = (walls || []).find((w) => w.id === target.id);
    const members = (wall && Array.isArray(wall.devices)) ? wall.devices : [];
    const options = members
      .filter((m) => m && m.device_id)
      .map((m) => ({ value: 'device:' + m.device_id, label: m.device_name || t('mc.cc.share.member') }));
    options.push({ value: 'span', label: t('mc.cc.share.span_wall'), tone: 'primary' });
    if (options.length <= 1) {
      // Wall has no exposeable members — fall back to spanning the wall explicitly.
      stagePreselectShareTarget({ kind: 'wall', id: target.id });
      window.location.hash = '#/screen-share';
      return;
    }
    const choice = await pickOptionDialog({
      title: t('mc.cc.share.where'),
      options,
      cancelLabel: t('mc.cc.share.cancel'),
    });
    if (!choice) return; // Cancel — do not open the share view
    if (choice === 'span') stagePreselectShareTarget({ kind: 'wall', id: target.id });
    else if (String(choice).startsWith('device:')) stagePreselectShareTarget({ kind: 'device', id: String(choice).slice(7) });
    window.location.hash = '#/screen-share';
    return;
  }
  if (target && target.type === 'display') {
    stagePreselectShareTarget({ kind: 'device', id: target.id });
  } else {
    stagePreselectShareTarget(null);
  }
  window.location.hash = '#/screen-share';
}
function stagePreselectShareTarget(preselect) {
  try {
    if (preselect) sessionStorage.setItem('ss.preselect', JSON.stringify(preselect));
    else sessionStorage.removeItem('ss.preselect');
  } catch { /* sessionStorage unavailable — share view just opens normally */ }
}
// A transient <dialog> with N options + a Cancel button, reusing the same
// .mc-dialog* classes / structure as components/confirm.js (consistent style,
// no new CSS). Resolves the chosen option's value, or null on cancel/Esc/
// backdrop. Mirrors chooseLiveStreamInclusion() in send.js.
function pickOptionDialog({ title, message, options = [], cancelLabel } = {}) {
  return new Promise((resolve) => {
    let dialogEl = null;
    let settled = false;
    try { dialogEl = document.createElement('dialog'); }
    catch { resolve(null); return; }
    dialogEl.className = 'mc-dialog';
    dialogEl.setAttribute('aria-labelledby', 'mcPickOptionTitle');
    const msgHtml = message ? `<p class="mc-dialog-msg">${esc(message)}</p>` : '';
    const optButtons = options.map((o, i) => {
      const cls = o.tone === 'primary' ? 'mc-btn mc-btn-confirm' : 'mc-btn mc-btn-ghost';
      return `<button type="button" class="${cls}" data-mc-pick="${esc(o.value)}">${esc(o.label)}</button>`;
    }).join('');
    dialogEl.innerHTML = `
      <form method="dialog" class="mc-dialog-card">
        <h3 id="mcPickOptionTitle" class="mc-dialog-title">${esc(title || '')}</h3>
        ${msgHtml}
        <div class="mc-dialog-actions">
          <button type="button" class="mc-btn mc-btn-ghost" data-mc-pick-cancel>${esc(cancelLabel || 'Cancel')}</button>
          ${optButtons}
        </div>
      </form>`;
    document.body.appendChild(dialogEl);
    const cleanup = () => {
      dialogEl.querySelectorAll('[data-mc-pick]').forEach((b) => b.removeEventListener('click', onPick));
      cancelBtn.removeEventListener('click', onCancel);
      dialogEl.removeEventListener('cancel', onCancel);
      dialogEl.removeEventListener('close', onCancel);
      if (dialogEl.parentNode) dialogEl.parentNode.removeChild(dialogEl);
    };
    const finish = (val) => {
      if (settled) return;
      settled = true;
      try { if (dialogEl.open) dialogEl.close(); } catch { /* noop */ }
      cleanup();
      resolve(val);
    };
    const onCancel = (e) => { if (e && e.preventDefault) e.preventDefault(); finish(null); };
    const onPick = (e) => finish(e.currentTarget.dataset.mcPick);
    const cancelBtn = dialogEl.querySelector('[data-mc-pick-cancel]');
    cancelBtn.addEventListener('click', onCancel);
    dialogEl.querySelectorAll('[data-mc-pick]').forEach((b) => b.addEventListener('click', onPick));
    dialogEl.addEventListener('cancel', onCancel);
    dialogEl.addEventListener('close', onCancel);
    try { dialogEl.showModal(); } catch (e) { cleanup(); resolve(null); }
  });
}
async function startLive() {
  const ok = await confirmDialog({
    title: t('mc.cc.dock.start_live'),
    message: t('mc.cc.confirm.start_live'),
    confirmLabel: t('mc.cc.dock.start_live'),
    tone: 'default',
  });
  if (!ok) return;
  try {
    const result = await api.liveStream.start();
    const displayName = result && result.display && result.display.name ? result.display.name : t('mc.cmd.live_display');
    showToast(
      result && result.stream_started ? t('mc.cmd.live_started', { display: displayName }) : t('mc.cmd.live_prepared', { display: displayName, message: t('mc.cmd.live_stream_disabled') }),
      result && result.stream_started ? 'success' : 'info',
    );
  } catch (e) {
    showToast(e && e.message ? e.message : t('mc.cmd.live_failed'), 'error');
  }
}
async function removeLive() {
  try { await api.liveStream.clearContent(); showToast(t('mc.cmd.live_cleared'), 'success'); }
  catch (e) { showToast(e && e.message ? e.message : t('mc.cmd.live_clear_failed'), 'error'); }
}
async function stopLive() {
  const ok = await confirmDialog({
    title: t('mc.cc.dock.stop_live'),
    message: t('mc.cc.confirm.stop_live'),
    confirmLabel: t('mc.cc.dock.stop_live'),
    tone: 'danger',
  });
  if (!ok) return;
  try { await api.liveStream.stop(); showToast(t('mc.cmd.live_stopped'), 'success'); }
  catch (e) { showToast(e && e.message ? e.message : t('mc.cmd.live_stop_failed'), 'error'); }
}

export async function render() {
  const app = document.getElementById('app');
  // Command Center shell: a single appliance-style screen — fixed header,
  // left icon rail + center workspace (canvas > playback > span/split+saver >
  // action dock) + right Content Library tab. NO long scrolling dashboard:
  // the old Room Presets / Recent / Room Setup / command bar (duplicated
  // "Blank all" + Start Class + YouTube) are removed from the default page.
  // Those modules stay defined (renderRoomPresets/renderRecentPanel/
  // renderCommandBar) for future drawers/routes; nothing is deleted.
  app.innerHTML = `
    <div class="mc-cc-shell">
      <header class="mc-cc-head">
        <div class="mc-cc-brand">
          <span class="mc-cc-logo" aria-hidden="true">M</span>
          <div class="mc-cc-brand-text">
            <h1 class="mc-cc-title">${esc(t('mc.cc.brand'))}</h1>
            <div id="mc-summary" class="mc-control-summary" aria-live="polite"></div>
          </div>
        </div>
        <div class="mc-cc-target" id="mc-target-host"></div>
        <div class="mc-cc-tools">
          <div id="mc-broadcast-chip" class="mc-chip mc-chip-live" hidden></div>
          <button type="button" class="mc-cc-bell" id="mc-cc-bell" aria-label="${esc(t('mc.cc.notifications'))}">${ICON_BELL}</button>
          <span class="mc-cc-avatar" aria-hidden="true">U</span>
        </div>
      </header>

      <div class="mc-cc-body">
        <nav class="mc-cc-rail" aria-label="${esc(t('mc.cc.rail.label'))}">
          <button type="button" class="mc-cc-rail-btn is-active" data-mc-rail="command" title="${esc(t('mc.cc.rail.command'))}" aria-label="${esc(t('mc.cc.rail.command'))}">${ICON_COMMAND}</button>
          <button type="button" class="mc-cc-rail-btn" data-mc-rail="displays" title="${esc(t('mc.cc.rail.displays'))}" aria-label="${esc(t('mc.cc.rail.displays'))}">${ICON_DISPLAYS}</button>
          <button type="button" class="mc-cc-rail-btn" data-mc-rail="whiteboard" title="${esc(t('mc.cc.rail.whiteboard'))}" aria-label="${esc(t('mc.cc.rail.whiteboard'))}">${ICON_WHITEBOARD}</button>
          <button type="button" class="mc-cc-rail-btn" data-mc-rail="media" title="${esc(t('mc.cc.rail.media'))}" aria-label="${esc(t('mc.cc.rail.media'))}">${ICON_MEDIA}</button>
          <button type="button" class="mc-cc-rail-btn" data-mc-rail="downloads" title="${esc(t('mc.cc.rail.downloads'))}" aria-label="${esc(t('mc.cc.rail.downloads'))}">${ICON_DOWNLOADS}</button>
          <span class="mc-cc-rail-spacer"></span>
          <a class="mc-cc-rail-btn" href="#/walls" title="${esc(t('mc.cc.rail.admin'))}" aria-label="${esc(t('mc.cc.rail.admin'))}">${ICON_ADMIN}</a>
          <button type="button" class="mc-cc-rail-btn" data-mc-rail="logs" title="${esc(t('mc.cc.rail.logs'))}" aria-label="${esc(t('mc.cc.rail.logs'))}">${ICON_LOGS}</button>
          <button type="button" class="mc-cc-rail-btn" data-mc-rail="settings" title="${esc(t('mc.cc.rail.settings'))}" aria-label="${esc(t('mc.cc.rail.settings'))}">${ICON_SETTINGS}</button>
        </nav>

        <main class="mc-cc-main">
          <section class="mc-cc-canvas-area">
            <div id="mc-cc-chips" class="mc-cc-chips" aria-live="polite"></div>
            <div id="mc-advanced-canvas" class="mc-advanced-canvas-host" hidden></div>
            <div id="mc-multiview" class="mc-multiview-host" hidden></div>
            <section id="mc-stage" class="mc-stage mc-cc-canvas" aria-label="${esc(t('mc.section.displays'))}"></section>
          </section>

          <section class="mc-cc-controls">
            <div id="mc-transport-host" class="mc-transport-row-host"></div>
            <div class="mc-cc-sub-row">
              <div id="mc-span-split-host" class="mc-span-split-host"></div>
              <div id="mc-screensaver-host" class="mc-screensaver-row-host"></div>
            </div>
            <div id="mc-action-dock-host" class="mc-action-dock-host"></div>
          </section>
        </main>

        <aside id="mc-library-drawer" class="mc-library-drawer" data-open="false" aria-label="${esc(t('mc.section.sources'))}" hidden>
          <button type="button" class="mc-library-tab mc-cc-lib-tab" data-library-toggle
                  aria-expanded="false" aria-controls="mc-toolbox"
                  title="${esc(t('mc.library.toggle'))}">
            <span class="mc-library-tab-label">${esc(t('mc.library.title'))}</span>
            <span class="mc-library-tab-ico" aria-hidden="true">${ICON_CHEVRON}</span>
          </button>
          <div class="mc-library-inner">
            <div class="mc-library-head">
              <h2 id="mc-library-title" class="mc-library-title">${esc(t('mc.library.title'))}</h2>
              <button type="button" class="mc-library-collapse" data-library-toggle
                      aria-expanded="false" aria-controls="mc-toolbox"
                      aria-label="${esc(t('mc.library.collapse'))}" title="${esc(t('mc.library.collapse'))}">
                <span aria-hidden="true">${ICON_CHEVRON}</span>
              </button>
            </div>
            <div class="mc-library-body">
              <section id="mc-toolbox" class="mc-toolbox" aria-labelledby="mc-library-title"></section>
            </div>
          </div>
        </aside>

        <aside id="mc-inspector" class="mc-inspector" hidden></aside>
      </div>
    </div>`;

  // The right Content Library tab is now the only fixed right-edge element — the
  // collapsed tab (data-open="false") re-shows itself when the drawer toggles.
  const libDrawer = document.getElementById('mc-library-drawer');
  if (libDrawer && libDrawer.hidden) {
    libDrawer.hidden = false;
    libDrawer.classList.remove('is-open');
  }

  // Re-hydrate the last-controlled selection, learn which devices are wall-owned,
  // and load the live display state — then prune any stale/wall-member ids.
  const [selection] = await Promise.all([
    api.getDisplaysSelection().catch(() => ({ device_ids: [] })),
    loadWalls(),
    displayState.refresh().catch(() => {}),
  ]);
  selectedIds = Array.isArray(selection && selection.device_ids) ? selection.device_ids : [];
  pruneSelection();
  // Shared room: with no saved stage selection yet, default to ALL room displays
  // so every member immediately sees every shared display (and newly-paired ones
  // appear until the operator deliberately curates the stage). NOT persisted — the
  // moment the operator adds/removes a display, that choice persists instead.
  const onlineIds = onlineRoomDisplayIds();
  const selectedHasOnline = displayState.getAll().some(d => selectedIds.includes(d.id) && d.online && !wallMemberIds.has(d.id));
  if (selectedIds.length === 0 || (!selectedHasOnline && onlineIds.length > 0)) {
    selectedIds = onlineIds.length > 0 ? onlineIds : roomDisplayIds();
    persistSelection();
  }
  // Drop any previously-persisted managed live-stream target from the stage
  // selection so it is never an implicit broadcast target.
  if (selectedIds.some(isLiveStreamTargetId)) {
    selectedIds = selectedIds.filter((id) => !isLiveStreamTargetId(id));
    persistSelection();
  }
pruneSelection();

  // ---- Phase 1 Command Center: target-driven canvas + controls ----
  // The header dropdown drives the active target rendered large on the canvas.
  // Switching targets is VIEW-ONLY — it re-points the canvas and emits NO
  // stop/blank to whatever was showing before. The canvas-level controls
  // (transport row, Span|Split, screensaver, action dock) reuse existing
  // functions and route commands to the active target only.
  targetApi = mountTargetSelector(document.getElementById('mc-target-host'), {
    walls,
    displays: displayState.getAll().filter((d) => !wallMemberIds.has(d.id) && !isLiveStreamTargetId(d.id)),
    onTargetChange: handleTargetChange,
  });
  transportApi = mountTransportRow(document.getElementById('mc-transport-host'));
  spanSplitApi = mountSpanSplit(document.getElementById('mc-span-split-host'), {
    getActiveTarget: () => activeTarget,
    getActiveWall: activeWall,
    onSetWallMode: setWallMode,
    hasContent: wallHasContent,
  });
  screensaverApi = mountScreensaverRow(document.getElementById('mc-screensaver-host'));
  // Dock callbacks reference toggleMultiview (a hoisted function declaration below)
  // and openAddPicker (module-level); both resolve at click time, well after the
  // mvHost / mvMounted consts below are initialized.
  dockApi = mountActionDock(document.getElementById('mc-action-dock-host'), {
    onMultiview: () => toggleMultiview(),
    onBlankSelected: blankActiveTarget,
    onBlankAll: blankAllTargets,
    onShare: shareScreenActive,
    onStartLive: startLive,
    onRemoveLive: removeLive,
    onStopLive: stopLive,
    onAddDisplay: openAddPicker,
    onLiveChanged: paintChips,
  });
  // Open on ONE large preview per the mockup (first wall, else first display).
  const initialTarget = chooseInitialTarget();
  if (initialTarget && targetApi) {
    targetApi.setActive(initialTarget);
    handleTargetChange(initialTarget); // paints stage/chips/transport/span/saver
  }

  paintStage();
  paintToolbox();
  paintSummary();
  const canvasEndpoint = await mountAdvancedCanvas(document.getElementById('mc-advanced-canvas'));

  // Phase-2 non-silent ack: surface command:ack ok:false as a toast + chip flip,
  // and refresh chips on display state-sync. Registered for the view's lifetime.
  if (!cmdAckHandler) { cmdAckHandler = (d) => handleCommandAck(d); socketOn('command-ack', cmdAckHandler); }
  if (!stateSyncHandler) { stateSyncHandler = (d) => handleStateSync(d); socketOn('state-sync', stateSyncHandler); }

  // Whiteboard dock stub (Phase 2). Mounts the self-contained whiteboard surface
  // as a full-stage overlay over the Command Center canvas. Minimal entrypoint:
  // window.mcOpenWhiteboard() opens it (optionally with an explicit target); the
  // small dock button in the header is a discoverable launcher for the same call.
  // Wiring target selection to the stage's current selection is intentionally
  // light here — the full Command Center target-model integration is a separate
  // concern and out of scope for this pass.
  let wbApi = null;
  let wbHost = null;
  function whiteboardTarget() {
    const dev = displayState.getAll().find(d => d.online && selectedIds.includes(d.id) && !wallMemberIds.has(d.id));
    if (dev) return { target_type: 'display', target_id: dev.id, label: dev.name || dev.id };
    const w = Array.isArray(walls) && walls[0];
    if (w && w.id) {
      return { target_type: 'wall', target_id: (w.leader_device_id || (w.devices && w.devices[0] && w.devices[0].device_id)) || w.id, wall_id: w.id, label: w.name || w.id };
    }
    return null;
  }
  function closeWhiteboard() {
    if (wbApi) { try { wbApi.unmount(); } catch { /* best-effort */ } wbApi = null; }
    if (wbHost && wbHost.parentNode) wbHost.parentNode.removeChild(wbHost);
    wbHost = null;
  }
  window.mcOpenWhiteboard = function (targetArg) {
    closeWhiteboard();
    const tgt = targetArg || whiteboardTarget();
    wbHost = document.createElement('div');
    wbHost.className = 'mc-wb-host';
    document.body.appendChild(wbHost);
    wbApi = mountWhiteboardSurface(wbHost, { onStatus: (m) => showToast(m) });
    if (tgt) wbApi.setTarget(tgt);
  };
  window.mcCloseWhiteboard = closeWhiteboard;
  const dockHost = document.querySelector('.mc-control-controls');
  if (dockHost && !document.getElementById('mc-wb-dock-btn')) {
    const dockBtn = document.createElement('button');
    dockBtn.type = 'button';
    dockBtn.id = 'mc-wb-dock-btn';
    dockBtn.className = 'mc-chip mc-wb-dock-btn';
    dockBtn.title = esc(t('mc.wb.dock_open'));
    dockBtn.textContent = t('mc.wb.dock_open');
    dockBtn.addEventListener('click', () => window.mcOpenWhiteboard());
    dockHost.appendChild(dockBtn);
  }
  if (canvasEndpoint) {
    const stage = stageEl();
    if (stage) stage.hidden = true;
    const summary = summaryEl();
    if (summary) {
      summary.innerHTML = `<span class="mc-summary-item">${esc(canvasEndpoint.name)}</span><span class="mc-summary-dot" aria-hidden="true">·</span><span class="mc-summary-item">${esc(canvasEndpoint.status === 'online' ? t('mc.canvas.online') : t('mc.canvas.offline'))}</span>`;
    }
  }

  // Multiview builder — mounted directly above the stage (whose first wall
  // card is the classroom primary wall) and toggled by the command bar's "Multiview"
  // button. Lazy-mounted on first open so the heavier composer only renders
  // when asked for. Sends ride the same routing picker + funnel as every tile.
  const mvHost = document.getElementById('mc-multiview');
  let mvMounted = false;
  async function toggleMultiview() {
    if (!mvHost) return;
    const show = mvHost.hidden;
    mvHost.hidden = !show;
    if (show) {
      if (!mvMounted) {
        mvMounted = true;
        await renderMultiview(mvHost, { routeSource: routeSourceWithPicker });
      }
      try { mvHost.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch { /* */ }
    }
  }

  // Mount the classroom command bar (Multiview · Blank all · quick-launch
  // Share screen / YouTube / Library). roomIds() = controllable (non-wall)
  // displays for content sends; blankIds() ALSO includes every wall member so
  // "Blank all" darkens the physical video-wall screens too.
  //
  // Command Bar (Start Class / YouTube / Blank all toggle) is REMOVED from the
  // main instructor page — its "Blank all" duplicated the bottom Action Dock,
  // and Start Class / YouTube belong in an Advanced/Diagnostics drawer (kept
  // defined in command-bar.js for a future drawer route). The Action Dock now
  // owns Multiview / Blank / Share / Live-stream on the main surface.
  // The display-target helpers (roomDisplayIds / roomCommandIds /
  // routeSourceWithPicker / setAdvancedCanvasBlanked) are still wired into the
  // Span|Split + Action Dock + target-selector/transport mounts below.
  // Room Presets + Recent (recent-panel) are likewise removed from the main
  // page; their components remain in room-presets.js / recent-panel.js for a
  // future Logs/Diagnostics route. Renders are skipped (host ids gone).
  const _legacyCmdbarHost = document.getElementById('mc-cmdbar-host');
  if (_legacyCmdbarHost) {
    renderCommandBar(_legacyCmdbarHost, {
      roomIds: roomDisplayIds,
      blankIds: roomCommandIds,
      refreshAfterSend,
      onMultiview: toggleMultiview,
      onRouteSource: routeSourceWithPicker,
      onBlankChange: canvasEndpoint ? setAdvancedCanvasBlanked : null,
    });
  }

  const _legacyPresetsHost = document.getElementById('mc-presets-host');
  if (_legacyPresetsHost) renderRoomPresets(_legacyPresetsHost, { onAfterApply: refreshAfterSend });
  const _legacyRecentHost = document.getElementById('mc-recent-host');
  if (_legacyRecentHost) renderRecentPanel(_legacyRecentHost);

  // Schedules launcher moved to the left rail (Advanced) — the old
  // [data-mc-setup="schedules"] host no longer exists on the main page.
  const schedBtn = document.querySelector('[data-mc-setup="schedules"]');
  if (schedBtn) {
    schedBtn.addEventListener('click', () => {
      openViewModal({ title: t('mc.schedules.title'), module: schedulesView });
    });
  }

  // Content LIBRARY drawer (right side, collapsible). Toggling flips data-open on
  // the drawer; both the docked reopen tab and the in-header collapse button drive
  // it (mirrors the multiview toggle's aria-expanded pattern). The drawer is a
  // FIXED overlay so collapsing/expanding never reflows the stage — the stage's
  // ResizeObserver tiling is untouched. Drag-and-drop is unaffected: tiles keep
  // their draggable + data-drag-source attrs and the drawer never sets
  // pointer-events:none, so an operator can drag a tile from the open drawer onto
  // a stage card exactly as before.
  const libraryDrawer = document.getElementById('mc-library-drawer');
  if (libraryDrawer) {
    // When collapsed, mark the (off-screen) drawer BODY inert so keyboard/AT users
    // don't tab into hidden tiles — but leave the docked reopen tab focusable so
    // it can be pulled back open. The tab lives OUTSIDE .mc-library-inner.
    const libraryInner = libraryDrawer.querySelector('.mc-library-inner');
    const setLibraryOpen = (open) => {
      libraryDrawer.dataset.open = open ? 'true' : 'false';
      libraryDrawer.querySelectorAll('[data-library-toggle]').forEach(btn => {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      if (libraryInner) {
        if (open) { libraryInner.removeAttribute('inert'); }
        else { libraryInner.setAttribute('inert', ''); }
      }
    };
    libraryDrawer.querySelectorAll('[data-library-toggle]').forEach(btn => {
      btn.addEventListener('click', () => {
        setLibraryOpen(libraryDrawer.dataset.open !== 'true');
      });
    });
  }

  // Mount the persistent live-broadcast chip (Task 4.5). The chip subscribes to
  // the engine singleton so it reflects broadcast state even after navigation.
  if (unsubChip) { unsubChip(); unsubChip = null; }
  unsubChip = mountBroadcastChip(document.getElementById('mc-broadcast-chip'));
  // Prime signaling + ICE servers outside the user's click gesture. Browsers are
  // strict about getDisplayMedia() activation; doing network work before the
  // chooser can make first-click Media Control shares fail intermittently.
  screenShareEngine.init().catch(() => {});

  // Fresh data (status, screenshots, wall changes) repaints the stage. The
  // store re-fetches walls-affecting changes via its own 'wall-changed' refresh;
  // we re-derive wall membership opportunistically on each repaint cycle.
  unsub = displayState.subscribe(() => {
    pruneSelection();
    // Screenshot-only change (same structure) → patch previews in place so the
    // cards (especially the wall) don't flash on every capture. Any structural
    // change (device on/offline, blank, now-playing, first preview) → full paint.
    if (stageSignature() === lastStageSig) {
      refreshPreviewsInPlace();
    } else {
      paintStage();
    }
    paintSummary();
    // Keep the canvas-level controls + dropdown in step with live state.
    paintChips();
    if (transportApi && transportApi.repaint) transportApi.repaint();
    if (spanSplitApi && spanSplitApi.repaint) spanSplitApi.repaint();
    if (screensaverApi && screensaverApi.repaint) screensaverApi.repaint();
    if (targetApi) {
      targetApi.setOptions(
        walls,
        displayState.getAll().filter((d) => !wallMemberIds.has(d.id) && !isLiveStreamTargetId(d.id)),
      );
    }
  });

  // Drive live previews: players only send a screenshot when asked, so poke the
  // displays on the stage shortly after the socket connects, then keep them fresh.
  startPreviewRefresh();
}

export function unmount() {
  // The view owns NO live broadcast resource (that's the engine singleton),
  // so unmount only detaches this view's subscriptions. Broadcasts persist.
  // Tear down any open whiteboard overlay so it doesn't outlive this view
  // (its surface took a window resize + canvas pointer listeners we must release).
  if (window.mcCloseWhiteboard) { try { window.mcCloseWhiteboard(); } catch { /* */ } }
  const dockBtn = document.getElementById('mc-wb-dock-btn');
  if (dockBtn) dockBtn.remove();
  if (unsub) { unsub(); unsub = null; }
  if (unsubChip) { unsubChip(); unsubChip = null; }
  if (cmdAckHandler) { try { socketOff('command-ack', cmdAckHandler); } catch (_) {} cmdAckHandler = null; }
  if (stateSyncHandler) { try { socketOff('state-sync', stateSyncHandler); } catch (_) {} stateSyncHandler = null; }
  teardownMultiview();    // stop any local audio monitor so it can't keep playing
  closeViewModal();       // dismiss any open room-setup overlay (e.g. Schedules)
  stopPreviewRefresh();   // stop poking players once we leave the control surface
  unmountAdvancedCanvas();
  // Close the inspector so a stale panel can't linger across navigations.
  closeInspector(inspectorEl());
  // Dismiss the add-display picker if it was left open during navigation.
  if (pickerEl && pickerEl.open) { try { pickerEl.close(); } catch { /* */ } }
  // Drop Command Center target + canvas-control state so a stale preview / target
  // can't survive navigation away from #/control.
  activeTarget = null;
  targetApi = null;
  transportApi = null;
  spanSplitApi = null;
  screensaverApi = null;
  dockApi = null;
}
