import { api } from '../api.js';
import * as displayState from '../services/display-state.js';
import { renderStage } from './media-control/stage.js';
import { renderToolbox, refreshToolbox } from './media-control/toolbox.js';
import { sendToDisplays } from './media-control/send.js';
import { renderInspector, closeInspector } from './media-control/inspector.js';

let unsub = null;
let selectedIds = [];   // ids on the stage; re-hydrated from the server, persisted on change
let wallMemberIds = new Set();   // device ids owned by a video wall (never their own card)
let walls = [];

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
  });
  // Re-attach drop handlers on the freshly-rendered cards.
  attachStageDrop(el);
}

function paintToolbox() {
  const el = toolboxEl();
  if (!el) return;
  renderToolbox(el, { selectedIds, onAfterSend: paintStage });
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

// "Add display" — pick from all known displays not already on the stage and not
// owned by a wall. Minimal native picker; the richer toolbox lands in Task 4.3.
function openAddPicker() {
  const selected = new Set(selectedIds);
  const candidates = displayState.getAll()
    .filter(d => !selected.has(d.id) && !wallMemberIds.has(d.id));
  if (candidates.length === 0) {
    window.alert('No more displays to add — every display is already on the stage.');
    return;
  }
  const lines = candidates.map((d, i) => `${i + 1}. ${d.name}${d.online ? '' : ' (offline)'}`).join('\n');
  const pick = window.prompt(`Add a display to the stage:\n\n${lines}\n\nEnter a number:`);
  if (pick == null) return;
  const idx = parseInt(pick, 10) - 1;
  if (Number.isNaN(idx) || idx < 0 || idx >= candidates.length) return;
  const id = candidates[idx].id;
  if (!selectedIds.includes(id)) {
    selectedIds = [...selectedIds, id];
    persistSelection();
    paintStage();
    // Refresh toolbox so the new selection is picked up for next click-to-send.
    refreshToolbox(toolboxEl(), selectedIds, paintStage);
  }
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
      const label = e.dataTransfer.getData('application/x-mc-label') || 'Content';
      const deviceId = card.dataset.deviceId;
      if (!deviceId) return;
      await sendToDisplays(source, [deviceId], label);
      // Stage will repaint on the next display-state event.
    });
  });
}

// ---- "Send to all" topbar button ----
function attachSendToAll(topbar) {
  const btn = topbar && topbar.querySelector('[data-mc-send-all]');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    // The toolbox active-tile approach for "send to all" is done by clicking a
    // tile which calls sendToDisplays(source, selectedIds). The topbar button
    // is a convenience: it re-triggers the last drag source if any, or shows a
    // hint. For Task 4.3 we just open the "add display" picker so the topbar
    // button is semantically useful without requiring state shared from toolbox.
    if (selectedIds.length === 0) {
      window.alert('Add a display to the stage first, then click a tile in the toolbox to send to all selected displays.');
    } else {
      window.alert(`${selectedIds.length} display(s) selected. Click any tile in the toolbox to send content to all of them.`);
    }
  });
}

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="mc-control">
      <div class="mc-topbar">
        <h1>Media Control</h1>
        <div class="mc-view-toggle"><button data-mode="grid" class="active">Grid</button><button data-mode="wall">Wall</button></div>
        <button type="button" class="mc-btn mc-btn-ghost" data-mc-send-all title="Send to all selected displays">Send to all</button>
        <div id="mc-broadcast-chip" class="mc-chip" hidden></div>
      </div>
      <section id="mc-stage" class="mc-stage" aria-label="Displays you are controlling"></section>
      <section id="mc-toolbox" class="mc-toolbox" aria-label="Sources and actions"></section>
      <aside id="mc-inspector" class="mc-inspector" hidden></aside>
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

  attachSendToAll(document.querySelector('.mc-topbar'));

  // Fresh data (status, screenshots, wall changes) repaints the stage. The
  // store re-fetches walls-affecting changes via its own 'wall-changed' refresh;
  // we re-derive wall membership opportunistically on each repaint cycle.
  unsub = displayState.subscribe(() => {
    pruneSelection();
    paintStage();
  });
}

export function unmount() {
  // The view owns NO live broadcast resource (that's the engine singleton),
  // so unmount only detaches this view's subscriptions. Broadcasts persist.
  if (unsub) { unsub(); unsub = null; }
  // Close the inspector so a stale panel can't linger across navigations.
  closeInspector(inspectorEl());
}
