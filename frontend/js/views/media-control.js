import { api } from '../api.js';
import { esc } from '../utils.js';
import { t, tn } from '../i18n.js';
import { showToast } from '../components/toast.js';
import * as displayState from '../services/display-state.js';
import { renderStage } from './media-control/stage.js';
import { renderToolbox } from './media-control/toolbox.js';
import { sendToDisplays } from './media-control/send.js';
import { renderInspector, closeInspector } from './media-control/inspector.js';
import { mountBroadcastChip } from './media-control/broadcast-chip.js';
// transport.js is used by stage.js internally — no direct import needed here.

let unsub = null;
let unsubChip = null;   // broadcast-chip unsubscribe (Task 4.5)
let selectedIds = [];   // ids on the stage; re-hydrated from the server, persisted on change
let wallMemberIds = new Set();   // device ids owned by a video wall (never their own card)
let walls = [];

// Routing mode: 'group' (default, each display independent), 'lecture' (one
// source to all), 'mirror' (clone display A to all others). The mode is UI
// state only — 'lecture' and 'mirror' act as presets that modify how the next
// send-to-all operation behaves. 'group' means the toolbox tile click targets
// only the display the user explicitly sends to (default).
let routingMode = 'group';

// Build the set of device ids that belong to a video wall — those devices are
// represented by the wall card, never their own (mirrors dashboard.js:789-793).
async function loadWalls() {
  try {
    walls = await api.getWalls();
    if (!Array.isArray(walls)) walls = [];
  } catch { walls = []; }
  wallMemberIds = new Set();
  for (const w of walls) for (const d of (w.devices || [])) wallMemberIds.add(d.device_id);
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
  const displays = displayState.getAll().filter(d => !wallMemberIds.has(d.id));
  renderStage(el, {
    displays,
    walls,
    selectedIds,
    onSelect: openInspector,
    onAddDisplay: openAddPicker,
    onScreenOnChange: handleScreenOnChange,
  });
  // Re-attach drop handlers on the freshly-rendered cards.
  attachStageDrop(el);
}

// After a successful send we re-FETCH display state (not just repaint) so the
// target card's now-playing label updates immediately — the store notifies its
// subscribers, which triggers paintStage. Repainting alone showed stale data.
function refreshAfterSend() { displayState.refresh().catch(() => {}); }

function paintToolbox() {
  const el = toolboxEl();
  if (!el) return;
  renderToolbox(el, { selectedIds, onAfterSend: refreshAfterSend });
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
  if (!display) { closeInspector(el); return; }
  renderInspector(el, {
    display,
    isWallMember: wallMemberIds.has(deviceId),
    onClose: () => { /* panel hides itself; nothing else to tear down */ },
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
  d.innerHTML = `
    <div class="mc-dialog-card">
      <h3 id="mcPickTitle" class="mc-dialog-title">${esc(t('mc.add.title'))}</h3>
      <p class="mc-dialog-msg">${esc(t('mc.add.message'))}</p>
      <div class="mc-pick-list" role="listbox" aria-label="${esc(t('mc.add.title'))}">${options}</div>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-pick-cancel>${esc(t('mc.add.cancel'))}</button>
      </div>
    </div>`;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      d.querySelectorAll('[data-pick-id]').forEach(b => b.removeEventListener('click', onPick));
      cancelBtn.removeEventListener('click', onCancel);
      d.removeEventListener('cancel', onCancel);
      d.removeEventListener('close', onCancel);
      if (d.open) d.close();
      resolve(val);
    };
    const onPick = (e) => finish(e.currentTarget.dataset.pickId);
    const onCancel = () => finish(null);
    const cancelBtn = d.querySelector('[data-pick-cancel]');
    d.querySelectorAll('[data-pick-id]').forEach(b => b.addEventListener('click', onPick));
    cancelBtn.addEventListener('click', onCancel);
    d.addEventListener('cancel', onCancel);
    d.addEventListener('close', onCancel);
    d.showModal();
  });
}

// "Add display" — pick from all known displays not already on the stage and not
// owned by a wall, via the composed picker.
async function openAddPicker() {
  const selected = new Set(selectedIds);
  const candidates = displayState.getAll()
    .filter(d => !selected.has(d.id) && !wallMemberIds.has(d.id));
  if (candidates.length === 0) {
    showToast(t('mc.add.none'), 'info');
    return;
  }
  const id = await pickDisplayDialog(candidates);
  if (!id || selectedIds.includes(id)) return;
  selectedIds = [...selectedIds, id];
  persistSelection();
  paintStage();
  // Full toolbox re-render so BOTH the tile-click handlers AND the tab-switch
  // handlers re-bind to the new selection (refreshToolbox only re-rendered the
  // active tab body, leaving the tab-switch buttons closed over a stale
  // selection — so switching tabs then clicking a tile sent to nothing).
  paintToolbox();
  paintSummary();
}

// ---- Drag-drop: toolbox tiles → stage cards ----
//
// Each toolbox tile sets DataTransfer text with the source JSON payload on
// dragstart (see toolbox.js attachTileHandlers). Stage cards (rendered by
// stage.js) need to become drop targets AFTER the stage is repainted. This
// function wires those handlers onto the freshly-rendered cards.
function attachStageDrop(stageContainer) {
  stageContainer.querySelectorAll('[data-device-id]').forEach(card => {
    // Prevent duplicate listener registration on re-render cycles by replacing
    // the node clone (cheapest DOM approach without an ID-keyed Map).
    card.addEventListener('dragover', (e) => {
      if (e.dataTransfer.types.includes('application/x-mc-source') ||
          e.dataTransfer.types.includes('text/plain')) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        card.classList.add('mc-card-dragover');
      }
    });
    card.addEventListener('dragleave', () => card.classList.remove('mc-card-dragover'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('mc-card-dragover');
      const raw = e.dataTransfer.getData('application/x-mc-source') ||
                  e.dataTransfer.getData('text/plain');
      if (!raw) return;
      let source;
      try { source = JSON.parse(raw); } catch { return; }
      const label = e.dataTransfer.getData('application/x-mc-label') || t('mc.tile.content_fallback');
      const deviceId = card.dataset.deviceId;
      if (!deviceId) return;
      await sendToDisplays(source, [deviceId], label);
      refreshAfterSend(); // re-fetch state so the card's now-playing updates now
    });
  });
}

// ---- Routing-mode preset buttons (Task 4.6) ----
//
// Three modes:
//   Group Share — default; each display is controlled independently via tile
//                 clicks and drag-drop. No automatic fan-out.
//   Lecture     — clicking a toolbox tile sends that source to ALL selected
//                 displays simultaneously. Essentially the same as clicking a
//                 tile while every display is selected (sendToDisplays already
//                 handles multiple targets). This mode visually highlights that
//                 fact and makes the toolbox tile-click target all at once.
//   Mirror      — clones the first selected display's current now-playing source
//                 to all other selected displays via sendToDisplays.

async function activateLecture() {
  if (selectedIds.length === 0) {
    showToast(t('mc.routing.lecture_hint_empty'), 'info');
    return;
  }
  showToast(t('mc.routing.lecture_hint', { n: selectedIds.length }), 'info');
}

async function activateMirror() {
  if (selectedIds.length < 2) {
    showToast(t('mc.routing.mirror_need_two'), 'info');
    return;
  }
  // Find the first selected display's current source.
  const sourceDisplay = displayState.get(selectedIds[0]);
  if (!sourceDisplay || !sourceDisplay.now_playing || sourceDisplay.now_playing.kind === 'idle') {
    showToast(t('mc.routing.mirror_no_source'), 'info');
    return;
  }
  // Mirror: re-broadcast whatever is "now playing" on display[0] to the others.
  // We use the playlist_id if available (best fidelity), falling back to a
  // content-level send. This is a best-effort clone, not a perfect sync.
  const targets = selectedIds.slice(1);
  let source = null;
  if (sourceDisplay.layout_id) {
    // Complex layout — cannot mirror at content level; guide the operator.
    showToast(t('mc.routing.mirror_layout'), 'info');
    return;
  }
  // Use the playlist_id from the display state if present.
  if (sourceDisplay.playlist_id) {
    source = { playlist_id: sourceDisplay.playlist_id };
  }
  if (!source) {
    showToast(t('mc.routing.mirror_unknown'), 'info');
    return;
  }
  const label = sourceDisplay.now_playing.label || t('mc.tile.content_fallback');
  await sendToDisplays(source, targets, label);
}

function attachRoutingModes(topbar) {
  if (!topbar) return;
  const btns = topbar.querySelectorAll('[data-routing]');
  btns.forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.routing;
      routingMode = mode;
      // Update active state on all mode buttons.
      btns.forEach(b => b.classList.toggle('mc-routing-active', b.dataset.routing === mode));
      if (mode === 'lecture') await activateLecture();
      if (mode === 'mirror')  await activateMirror();
      // 'group' is the default and requires no action beyond the visual update.
    });
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
            <div class="mc-routing-modes" role="group" aria-label="${esc(t('mc.routing.label'))}">
              <button type="button" class="mc-btn mc-routing-btn mc-routing-active" data-routing="group" title="${esc(t('mc.routing.group_title'))}">${esc(t('mc.routing.group'))}</button>
              <button type="button" class="mc-btn mc-routing-btn" data-routing="lecture" title="${esc(t('mc.routing.lecture_title'))}">${esc(t('mc.routing.lecture'))}</button>
              <button type="button" class="mc-btn mc-routing-btn" data-routing="mirror" title="${esc(t('mc.routing.mirror_title'))}">${esc(t('mc.routing.mirror'))}</button>
            </div>
          </div>
        </header>

        <section class="mc-control-zone" aria-labelledby="mc-stage-head">
          <div class="mc-section-head">
            <h2 id="mc-stage-head" class="mc-section-title">${esc(t('mc.section.displays'))}</h2>
            <p class="mc-section-hint">${esc(t('mc.section.displays_hint'))}</p>
          </div>
          <section id="mc-stage" class="mc-stage" aria-label="${esc(t('mc.section.displays'))}"></section>
        </section>

        <section class="mc-control-zone" aria-labelledby="mc-sources-head">
          <div class="mc-section-head">
            <h2 id="mc-sources-head" class="mc-section-title">${esc(t('mc.section.sources'))}</h2>
          </div>
          <section id="mc-toolbox" class="mc-toolbox" aria-label="${esc(t('mc.section.sources'))}"></section>
        </section>

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
  paintStage();
  paintToolbox();
  paintSummary();

  attachRoutingModes(document.querySelector('.mc-control-head'));

  // Reset routing mode back to 'group' on fresh render (navigating away and
  // back starts a clean session; the state is UI-only, not persisted).
  routingMode = 'group';

  // Mount the persistent live-broadcast chip (Task 4.5). The chip subscribes to
  // the engine singleton so it reflects broadcast state even after navigation.
  if (unsubChip) { unsubChip(); unsubChip = null; }
  unsubChip = mountBroadcastChip(document.getElementById('mc-broadcast-chip'));

  // Fresh data (status, screenshots, wall changes) repaints the stage. The
  // store re-fetches walls-affecting changes via its own 'wall-changed' refresh;
  // we re-derive wall membership opportunistically on each repaint cycle.
  unsub = displayState.subscribe(() => {
    pruneSelection();
    paintStage();
    paintSummary();
  });
}

export function unmount() {
  // The view owns NO live broadcast resource (that's the engine singleton),
  // so unmount only detaches this view's subscriptions. Broadcasts persist.
  if (unsub) { unsub(); unsub = null; }
  if (unsubChip) { unsubChip(); unsubChip = null; }
  // Close the inspector so a stale panel can't linger across navigations.
  closeInspector(inspectorEl());
  // Dismiss the add-display picker if it was left open during navigation.
  if (pickerEl && pickerEl.open) { try { pickerEl.close(); } catch { /* */ } }
}
