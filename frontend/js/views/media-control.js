import { api } from '../api.js';
import * as displayState from '../services/display-state.js';
import { renderStage } from './media-control/stage.js';

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

function stageEl() { return document.getElementById('mc-stage'); }

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
}

// Selecting a stage card opens the inspector (wired fully in Task 4.4); for now
// it is a no-op hook so the click contract exists.
function openInspector(/* deviceId */) {
  // Inspector behavior arrives in Task 4.4. Intentionally inert here.
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
  }
}

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="mc-control">
      <div class="mc-topbar">
        <h1>Media Control</h1>
        <div class="mc-view-toggle"><button data-mode="grid" class="active">Grid</button><button data-mode="wall">Wall</button></div>
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
}
