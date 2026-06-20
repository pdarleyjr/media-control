import { api } from '../api.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';
import { showToast } from '../components/toast.js';
import { identifyDevice, requestScreenshot } from '../socket.js';
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
// transport.js is used by stage.js internally — no direct import needed here.

// Rail "Room setup" launcher icons (stroke icons, dashboard SVG vocabulary).
const ICON_SETUP_SCHEDULE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
const ICON_SETUP_WALLS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="9" height="8" rx="1"></rect><rect x="13" y="3" width="9" height="8" rx="1"></rect><rect x="2" y="13" width="9" height="8" rx="1"></rect><rect x="13" y="13" width="9" height="8" rx="1"></rect></svg>';
// Library drawer collapse/expand chevron (points right when open → collapse, left when collapsed → reopen).
const ICON_CHEVRON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>';

let unsub = null;
let unsubChip = null;   // broadcast-chip unsubscribe (Task 4.5)
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
  renderStage(el, {
    displays,
    walls,
    byId,
    selectedIds,
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

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-studio-wrap mc-control">
        <header class="mc-control-head">
          <div class="mc-control-id">
            <h1 class="mc-control-title">${esc(t('mc.title'))}</h1>
            <div id="mc-summary" class="mc-control-summary" aria-live="polite"></div>
          </div>
          <div class="mc-control-controls">
            <div id="mc-broadcast-chip" class="mc-chip mc-chip-live" hidden></div>
          </div>
        </header>

        <div id="mc-cmdbar-host" class="mc-cmdbar-host"></div>

        <div class="mc-control-body">
          <div class="mc-control-main">
            <section class="mc-control-zone" aria-labelledby="mc-stage-head">
              <div class="mc-section-head">
                <h2 id="mc-stage-head" class="mc-section-title">${esc(t('mc.section.displays'))}</h2>
                <p class="mc-section-hint">${esc(t('mc.section.displays_hint'))}</p>
                <a class="mc-section-link" href="#/">${esc(t('mc.section.manage_displays'))}</a>
                <a class="mc-section-link" href="#/walls">${esc(t('mc.section.video_walls'))}</a>
              </div>
              <div id="mc-advanced-canvas" class="mc-advanced-canvas-host" hidden></div>
              <!-- Multiview builder mounts here, directly ABOVE the stage (whose
                   first wall card is the classroom primary wall). Toggled by the command
                   bar's "Multiview" button; lazy-mounted on first open. -->
              <div id="mc-multiview" class="mc-multiview-host" hidden></div>
              <section id="mc-stage" class="mc-stage" aria-label="${esc(t('mc.section.displays'))}"></section>
            </section>

            <section class="mc-control-bottom" aria-label="${esc(t('mc.rail.label'))}">
              <div id="mc-presets-host"></div>
              <div id="mc-recent-host"></div>
              <section class="mc-setup-panel" aria-labelledby="mc-setup-head">
                <h3 id="mc-setup-head" class="mc-rail-title">${esc(t('mc.setup.title'))}</h3>
                <div class="mc-setup-links">
                  <button type="button" class="mc-setup-link" data-mc-setup="schedules">
                    <span class="mc-setup-ico" aria-hidden="true">${ICON_SETUP_SCHEDULE}</span>
                    <span class="mc-setup-link-label">${esc(t('mc.setup.schedules'))}</span>
                  </button>
                  <a class="mc-setup-link" href="#/walls">
                    <span class="mc-setup-ico" aria-hidden="true">${ICON_SETUP_WALLS}</span>
                    <span class="mc-setup-link-label">${esc(t('mc.setup.walls'))}</span>
                  </a>
                </div>
              </section>
            </section>
          </div>
        </div>

        <aside id="mc-library-drawer" class="mc-library-drawer" data-open="true" aria-label="${esc(t('mc.section.sources'))}">
          <button type="button" class="mc-library-tab" data-library-toggle
                  aria-expanded="true" aria-controls="mc-toolbox"
                  title="${esc(t('mc.library.toggle'))}">
            <span class="mc-library-tab-ico" aria-hidden="true">${ICON_CHEVRON}</span>
            <span class="mc-library-tab-label">${esc(t('mc.library.title'))}</span>
          </button>
          <div class="mc-library-inner">
            <div class="mc-library-head">
              <h2 id="mc-library-title" class="mc-library-title">${esc(t('mc.library.title'))}</h2>
              <button type="button" class="mc-library-collapse" data-library-toggle
                      aria-expanded="true" aria-controls="mc-toolbox"
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
  paintStage();
  paintToolbox();
  paintSummary();
  const canvasEndpoint = await mountAdvancedCanvas(document.getElementById('mc-advanced-canvas'));
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
  renderCommandBar(document.getElementById('mc-cmdbar-host'), {
    roomIds: roomDisplayIds,
    blankIds: roomCommandIds,
    refreshAfterSend,
    onMultiview: toggleMultiview,
    onRouteSource: routeSourceWithPicker,
    onBlankChange: canvasEndpoint ? setAdvancedCanvasBlanked : null,
  });

  // Mount the right rail: Room Presets (one-tap scene recall, the Command-360
  // "Layouts" analog) + Recent (recent presentations + activity, folding in the
  // Studio Home panels). Both are read-only/self-contained — no cleanup needed.
  renderRoomPresets(document.getElementById('mc-presets-host'), { onAfterApply: refreshAfterSend });
  renderRecentPanel(document.getElementById('mc-recent-host'));

  // Room-setup launchers (fold in the retired Operate links): Schedules is
  // self-contained, so it opens as an in-dashboard overlay — the operator never
  // leaves #/control. Video walls is a plain link to the canvas editor (a focused
  // full screen, launched from the dashboard instead of a sidebar item).
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
  });

  // Drive live previews: players only send a screenshot when asked, so poke the
  // displays on the stage shortly after the socket connects, then keep them fresh.
  startPreviewRefresh();
}

export function unmount() {
  // The view owns NO live broadcast resource (that's the engine singleton),
  // so unmount only detaches this view's subscriptions. Broadcasts persist.
  if (unsub) { unsub(); unsub = null; }
  if (unsubChip) { unsubChip(); unsubChip = null; }
  teardownMultiview();    // stop any local audio monitor so it can't keep playing
  closeViewModal();       // dismiss any open room-setup overlay (e.g. Schedules)
  stopPreviewRefresh();   // stop poking players once we leave the control surface
  unmountAdvancedCanvas();
  // Close the inspector so a stale panel can't linger across navigations.
  closeInspector(inspectorEl());
  // Dismiss the add-display picker if it was left open during navigation.
  if (pickerEl && pickerEl.open) { try { pickerEl.close(); } catch { /* */ } }
}
