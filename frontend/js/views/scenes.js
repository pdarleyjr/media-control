// Phase 3: Scenes ("Operational Activities") view.
//
// A scene is a named snapshot of which content/playlist shows on which
// display. The operator's primary gesture is one tap on a scene's big
// "Trigger" button, which pushes that snapshot to every display in the scene.
//
// This view is intentionally touch-first: large cards, a prominent Trigger
// button per card, and a single "Capture current" action that snapshots the
// live state of every display into a new named scene. Rename/delete are
// secondary actions kept small so they don't compete with Trigger.
//
// Shape mirrors the other view modules (export function render(container) +
// optional cleanup()), and reuses the shared esc()/showToast() helpers like
// playlists.js / dashboard.js.

import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { esc } from '../utils.js';

function formatDate(ts) {
  if (!ts) return '--';
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function render(container) {
  container.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Operational Activities</h1>
        <div class="subtitle">One tap puts the right content on the right displays.</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-primary" id="captureSceneBtn">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/>
            <circle cx="12" cy="13" r="4"/>
          </svg>
          Capture current
        </button>
      </div>
    </div>
    <div id="sceneGrid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px">
      <div style="color:var(--text-muted);padding:40px;text-align:center">Loading...</div>
    </div>
  `;

  container.querySelector('#captureSceneBtn').addEventListener('click', captureCurrentScene);
  loadScenes();
}

export function cleanup() {
  // No timers/sockets held by this view.
}

async function loadScenes() {
  const grid = document.getElementById('sceneGrid');
  if (!grid) return;

  try {
    const scenes = await api.scenes.list();
    if (!Array.isArray(scenes) || scenes.length === 0) {
      grid.innerHTML = `
        <div style="grid-column:1/-1;text-align:center;padding:60px 20px;color:var(--text-muted)">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin:0 auto 16px;display:block;opacity:0.4">
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
          <h3 style="margin-bottom:8px;color:var(--text-primary)">No activities yet</h3>
          <p>Set up your displays the way you want them, then tap <strong>Capture current</strong> to save it as a one-tap activity.</p>
        </div>
      `;
      return;
    }

    grid.innerHTML = scenes.map(renderSceneCard).join('');

    grid.querySelectorAll('.scene-trigger-btn').forEach((btn) => {
      btn.addEventListener('click', () => triggerScene(btn.dataset.sceneId, btn.dataset.sceneName, btn));
    });
    grid.querySelectorAll('.scene-rename-btn').forEach((btn) => {
      btn.addEventListener('click', () => renameScene(btn.dataset.sceneId, btn.dataset.sceneName));
    });
    grid.querySelectorAll('.scene-delete-btn').forEach((btn) => {
      btn.addEventListener('click', () => deleteScene(btn.dataset.sceneId, btn.dataset.sceneName));
    });
  } catch (err) {
    grid.innerHTML = `<div style="grid-column:1/-1;color:var(--text-muted);padding:40px;text-align:center">Couldn't load activities: ${esc(err.message)}</div>`;
  }
}

function renderSceneCard(scene) {
  // display_count is a best-effort hint from the API; fall back to a generic
  // label when the field isn't present so the card still reads well.
  const count = scene.display_count ?? scene.placement_count ?? (Array.isArray(scene.placements) ? scene.placements.length : null);
  const countLabel = count == null
    ? ''
    : `${count} ${count === 1 ? 'display' : 'displays'}`;

  return `
    <div class="device-card scene-card" data-scene-id="${esc(scene.id)}" style="display:flex;flex-direction:column;padding:0;overflow:hidden">
      <div style="padding:18px 18px 14px">
        <div style="font-size:18px;font-weight:700;color:var(--text-primary);line-height:1.25;word-break:break-word">${esc(scene.name)}</div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px;font-size:12px;color:var(--text-muted)">
          ${countLabel ? `<span>${esc(countLabel)}</span>` : ''}
          ${scene.created_at ? `<span>&middot; ${esc(formatDate(scene.created_at))}</span>` : ''}
        </div>
        ${scene.description ? `<div style="font-size:13px;color:var(--text-secondary);margin-top:8px;line-height:1.4">${esc(scene.description)}</div>` : ''}
      </div>
      <button class="btn btn-primary scene-trigger-btn" data-scene-id="${esc(scene.id)}" data-scene-name="${esc(scene.name)}"
        style="margin:0 18px;padding:16px;font-size:16px;font-weight:600;border-radius:var(--radius);display:flex;align-items:center;justify-content:center;gap:8px">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"/></svg>
        Trigger
      </button>
      <div style="display:flex;gap:6px;justify-content:flex-end;padding:12px 18px 16px">
        <button class="btn btn-secondary btn-sm scene-rename-btn" data-scene-id="${esc(scene.id)}" data-scene-name="${esc(scene.name)}" style="padding:4px 10px;font-size:12px">Rename</button>
        <button class="btn btn-secondary btn-sm scene-delete-btn" data-scene-id="${esc(scene.id)}" data-scene-name="${esc(scene.name)}" style="padding:4px 10px;font-size:12px;color:var(--danger)">Delete</button>
      </div>
    </div>
  `;
}

async function triggerScene(id, name, btn) {
  if (!id) return;
  const original = btn ? btn.innerHTML : null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = 'Triggering...';
  }
  try {
    const result = await api.scenes.trigger(id);
    const pushed = result && (result.devices_updated ?? result.pushed ?? result.count);
    const msg = pushed != null
      ? `"${name}" pushed to ${pushed} ${pushed === 1 ? 'display' : 'displays'}`
      : `"${name}" triggered`;
    showToast(msg, 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn && original != null) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  }
}

async function captureCurrentScene() {
  const name = prompt('Name this activity (snapshots what every display is showing right now):');
  if (name === null) return; // cancelled
  const trimmed = name.trim();
  if (!trimmed) { showToast('Please enter a name', 'error'); return; }

  try {
    // Snapshot the live state of ALL displays in the workspace. Pass the full
    // set of device ids so the server records a placement per display.
    const devices = await api.getDevices();
    const device_ids = (devices || []).map((d) => d.id);
    if (device_ids.length === 0) {
      showToast('No displays to capture', 'error');
      return;
    }
    await api.scenes.capture({ name: trimmed, device_ids });
    showToast(`Activity "${trimmed}" saved`, 'success');
    loadScenes();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function renameScene(id, currentName) {
  const name = prompt('Rename activity:', currentName || '');
  if (name === null) return;
  const trimmed = name.trim();
  if (!trimmed) { showToast('Please enter a name', 'error'); return; }
  if (trimmed === currentName) return;
  try {
    await api.scenes.update(id, { name: trimmed });
    showToast('Activity renamed', 'success');
    loadScenes();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function deleteScene(id, name) {
  if (!confirm(`Delete activity "${name}"? Displays will keep showing whatever is on them now.`)) return;
  try {
    await api.scenes.remove(id);
    showToast('Activity deleted', 'success');
    loadScenes();
  } catch (err) {
    showToast(err.message, 'error');
  }
}
