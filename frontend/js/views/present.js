// Present — the instructor home surface (classroom-UX redesign, 2026-05-29).
//
// Mental model: "pick where → tap what → it's on the wall." This replaces the
// 16-item sidebar hunt with one touch-first control surface:
//   • a target selector (All displays by default; tap one to scope)
//   • big content tiles (Share My Screen, Whiteboard, YouTube, From Library, Scenes)
//   • a live status grid of the room's displays
// The persistent command bar (Start Class / Blank / Clear) is added in P3.
//
// Reuses existing plumbing only: api.getDevices(), api.broadcast() (the same
// /api/broadcast + 409 confirm-all gate the dashboard uses), and routes to the
// already-built screen-share / smartboard / scenes views for interactive sources.
// CSP-clean: addEventListener only, esc() on all dynamic text, no inline handlers.

import { api } from '../api.js';
import { esc } from '../utils.js';
import { showToast } from '../components/toast.js';
import { confirmDialog } from '../components/confirm.js';
import { sendCommand } from '../socket.js';

let devices = [];
let target = 'all';          // 'all' | <deviceId>
let blanked = false;         // best-effort UI state for the Blank toggle

function deviceIdsForTarget() {
  if (target === 'all') return devices.map((d) => d.id);
  return devices.filter((d) => d.id === target).map((d) => d.id);
}

function targetLabel() {
  if (target === 'all') return 'All displays';
  const d = devices.find((x) => x.id === target);
  return d ? d.name : 'All displays';
}

// ---- send helpers (instant-Send; reuse /api/broadcast + confirm-all gate) ----
async function broadcastSource(source, humanLabel) {
  const ids = deviceIdsForTarget();
  if (ids.length === 0) {
    showToast('No displays paired yet — pair a display first (Setup → Displays).', 'error');
    return;
  }
  let result;
  try {
    result = await api.broadcast({ ...source, device_ids: ids });
  } catch (e) {
    showToast(e?.message || 'Could not send to the displays.', 'error');
    return;
  }
  // 409 confirm-all: targeting every display in the workspace.
  if (result && result.code === 'CONFIRM_ALL_REQUIRED') {
    const ok = await confirmDialog({
      title: `Show on ALL ${result.count} displays?`,
      message: `This puts ${humanLabel} on every display in the room.`,
      confirmLabel: 'Show on all',
      tone: 'default',
    });
    if (!ok) return;
    try {
      result = await api.broadcast({ ...source, device_ids: ids, confirm_all: true });
    } catch (e) {
      showToast(e?.message || 'Could not send to the displays.', 'error');
      return;
    }
  }
  if (result && result.success) {
    const offline = (result.total || 0) - (result.sent || 0);
    showToast(`${humanLabel} → ${result.sent} display${result.sent === 1 ? '' : 's'}${offline > 0 ? ` (${offline} offline)` : ''}`, 'success');
  }
}

function promptYouTube() {
  // Small CSP-safe input dialog (paste a URL). We reuse the broadcast remote_url
  // path; the player already embeds YouTube on the CSP-exempt /player surface.
  const dlg = document.createElement('dialog');
  dlg.className = 'mc-dialog';
  dlg.innerHTML = `
    <form method="dialog" class="mc-dialog-card">
      <h3 class="mc-dialog-title">Play a YouTube video</h3>
      <p class="mc-dialog-msg">Paste a YouTube link. It plays on the display — your laptop stays free.</p>
      <input class="input mc-yt-input" type="url" inputmode="url"
             placeholder="https://www.youtube.com/watch?v=…" autocomplete="off" />
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-cancel>Cancel</button>
        <button type="button" class="mc-btn mc-btn-cta" data-go>Show it</button>
      </div>
    </form>`;
  document.body.appendChild(dlg);
  const input = dlg.querySelector('.mc-yt-input');
  const cleanup = () => { if (dlg.open) dlg.close(); dlg.remove(); };
  dlg.querySelector('[data-cancel]').addEventListener('click', cleanup);
  dlg.addEventListener('cancel', cleanup);
  dlg.querySelector('[data-go]').addEventListener('click', async () => {
    const url = (input.value || '').trim();
    if (!/^https?:\/\/(www\.)?(youtube\.com|youtu\.be)\//i.test(url)) {
      showToast('That doesn’t look like a YouTube link.', 'error');
      return;
    }
    cleanup();
    await broadcastSource({ remote_url: url }, 'YouTube video');
  });
  dlg.showModal();
  input.focus();
}

// ---- rendering ----
function renderTargetChips() {
  const all = `<button type="button" class="mc-target-chip${target === 'all' ? ' active' : ''}" data-target="all">All displays</button>`;
  const each = devices.map((d) => {
    const online = d.status === 'online';
    return `<button type="button" class="mc-target-chip${target === d.id ? ' active' : ''}" data-target="${esc(d.id)}">
      <span class="mc-chip-dot" style="background:${online ? 'var(--success)' : 'var(--text-muted)'}"></span>${esc(d.name || 'Display')}
    </button>`;
  }).join('');
  return all + each;
}

function renderDisplayGrid() {
  if (devices.length === 0) {
    return `<div class="empty-state" style="grid-column:1/-1">
      <h3>No displays yet</h3>
      <p>Pair a display from <a href="#/" style="color:var(--accent)">Displays</a> (or open <code>/player</code> on a screen) to start presenting.</p>
    </div>`;
  }
  return devices.map((d) => {
    const online = d.status === 'online';
    const chipClass = online ? 'mc-chip-standby' : 'mc-chip-offline';
    const chipLabel = online ? 'Ready' : 'Offline';
    const res = d.viewport_css_w && d.viewport_css_h ? `${d.viewport_css_w}×${d.viewport_css_h}` : '';
    return `<div class="mc-display-tile" data-device="${esc(d.id)}">
      <div class="mc-display-tile-top">
        <span class="mc-display-name">${esc(d.name || 'Display')}</span>
        <span class="mc-chip ${chipClass}"><span class="mc-chip-dot"></span>${chipLabel}</span>
      </div>
      <div class="mc-display-meta">${esc(res)}</div>
    </div>`;
  }).join('');
}

function render(app) {
  const user = (() => { try { return JSON.parse(localStorage.getItem('user')); } catch { return null; } })();
  app.innerHTML = `
    <div class="mc-present">
      <header class="mc-present-header">
        <div>
          <h1 class="mc-present-title">Present</h1>
          <p class="mc-present-sub">You are controlling: <strong class="mc-target-label">${esc(targetLabel())}</strong></p>
        </div>
      </header>

      <section class="mc-target-bar" aria-label="Choose which displays to present to">
        ${renderTargetChips()}
      </section>

      <section class="mc-tiles" aria-label="Choose what to show">
        <button type="button" class="mc-tile" data-act="screen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/><polyline points="9 9 12 6 15 9"/><line x1="12" y1="6" x2="12" y2="14"/></svg>
          <span class="mc-tile-label">Show my screen</span>
          <span class="mc-tile-sub">Mirror this device live</span>
        </button>
        <button type="button" class="mc-tile" data-act="whiteboard">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="13" rx="1"/><path d="M12 17v3"/><path d="M8 20h8"/><path d="M7 12c1.5-2 3-2 5 0s3.5 2 5 0"/></svg>
          <span class="mc-tile-label">Whiteboard</span>
          <span class="mc-tile-sub">Draw on the display</span>
        </button>
        <button type="button" class="mc-tile" data-act="youtube">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2" y="4" width="20" height="16" rx="3"/><polygon points="10 9 16 12 10 15 10 9" fill="currentColor" stroke="none"/></svg>
          <span class="mc-tile-label">YouTube</span>
          <span class="mc-tile-sub">Paste a link, play it</span>
        </button>
        <button type="button" class="mc-tile" data-act="library">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
          <span class="mc-tile-label">From library</span>
          <span class="mc-tile-sub">Slides, videos &amp; files</span>
        </button>
        <button type="button" class="mc-tile" data-act="scenes">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
          <span class="mc-tile-label">Scenes</span>
          <span class="mc-tile-sub">Recall a saved setup</span>
        </button>
      </section>

      <section class="mc-displays" aria-label="Displays in this room">
        <h2 class="mc-section-h">Displays</h2>
        <div class="mc-display-grid">${renderDisplayGrid()}</div>
      </section>

      <div class="mc-cmdbar" role="group" aria-label="Room controls">
        <button type="button" class="mc-btn mc-btn-lg mc-btn-primary" data-cmd="start">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Start Class
        </button>
        <button type="button" class="mc-btn mc-btn-lg mc-cmd-blank" data-cmd="blank">Blank</button>
        <span class="mc-blank-banner" hidden>SCREEN IS BLANK — tap Un-blank to resume</span>
      </div>
    </div>`;

  // Target chips
  app.querySelectorAll('.mc-target-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      target = chip.dataset.target;
      app.querySelectorAll('.mc-target-chip').forEach((c) => c.classList.toggle('active', c === chip));
      const lbl = app.querySelector('.mc-target-label');
      if (lbl) lbl.textContent = targetLabel();
    });
  });

  // Content tiles
  app.querySelectorAll('.mc-tile').forEach((tile) => {
    tile.addEventListener('click', () => {
      switch (tile.dataset.act) {
        case 'screen': window.location.hash = '#/screen-share'; break;
        case 'whiteboard': window.location.hash = '#/smartboard'; break;
        case 'youtube': promptYouTube(); break;
        case 'library': window.location.hash = '#/content'; break;
        case 'scenes': window.location.hash = '#/scenes'; break;
      }
    });
  });

  // Command bar: Start Class (wake/un-blank all) + Blank (same-button toggle on
  // the current target). Reuses the proven screen_on / screen_off device
  // commands over the dashboard socket — no new server plumbing.
  const blankBtn = app.querySelector('.mc-cmd-blank');
  const banner = app.querySelector('.mc-blank-banner');
  const reflectBlank = () => {
    if (blankBtn) {
      blankBtn.textContent = blanked ? 'Un-blank' : 'Blank';
      blankBtn.classList.toggle('mc-btn-danger', blanked);
    }
    if (banner) banner.hidden = !blanked;
  };
  app.querySelector('[data-cmd="start"]')?.addEventListener('click', () => {
    if (!devices.length) { showToast('No displays paired yet — pair one in Setup → Displays.', 'error'); return; }
    devices.forEach((d) => sendCommand(d.id, 'screen_on', {}));
    blanked = false; reflectBlank();
    showToast(`Class started — ${devices.length} display${devices.length === 1 ? '' : 's'} ready.`, 'success');
  });
  blankBtn?.addEventListener('click', () => {
    const ids = deviceIdsForTarget();
    if (!ids.length) { showToast('No displays to blank.', 'error'); return; }
    blanked = !blanked;
    ids.forEach((id) => sendCommand(id, blanked ? 'screen_off' : 'screen_on', {}));
    reflectBlank();
    showToast(blanked ? `Blanked ${targetLabel()}.` : `Resumed ${targetLabel()}.`, 'info');
  });
  reflectBlank();
}

export async function renderView(app) {
  render(app); // immediate shell (no spinner flash)
  try {
    devices = await api.getDevices();
    if (!Array.isArray(devices)) devices = [];
  } catch {
    devices = [];
  }
  // Re-render the dynamic regions now that devices are loaded.
  const grid = app.querySelector('.mc-display-grid');
  const bar = app.querySelector('.mc-target-bar');
  if (grid) grid.innerHTML = renderDisplayGrid();
  if (bar) {
    bar.innerHTML = renderTargetChips();
    bar.querySelectorAll('.mc-target-chip').forEach((chip) => {
      chip.addEventListener('click', () => {
        target = chip.dataset.target;
        bar.querySelectorAll('.mc-target-chip').forEach((c) => c.classList.toggle('active', c === chip));
        const lbl = app.querySelector('.mc-target-label');
        if (lbl) lbl.textContent = targetLabel();
      });
    });
  }
}

// app.js calls view.render(app)
export { renderView as render };
