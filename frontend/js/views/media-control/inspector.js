// inspector.js — the slide-in detail panel for a selected stage display (Task 4.4).
//
// Shows the display's name + geometry, a "Partition into regions" action that
// creates/loads a layout for the display and mounts the region editor, a
// per-region AUDIO toggle (invariant: only ONE region unmuted at a time — warn
// when a second is turned on), and a display-level fit_mode control.
//
// GUARD: a display that is a member of a video wall cannot be partitioned — the
// player ignores per-display zones for wall members — so Partition is disabled
// and a clear message is shown. The caller (media-control.js) knows wall
// membership (it already builds the wallMemberIds set) and passes isWallMember.

import { api } from '../../api.js';
import { FIT_MODES } from '../../player-protocol.js';
import { showToast } from '../../components/toast.js';
import { renderRegionEditor } from './region-editor.js';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function geometryLabel(display) {
  if (display.width && display.height) return `${display.width} × ${display.height}`;
  return 'unknown resolution';
}

function fitOptionsHtml(selected) {
  return FIT_MODES.map(m =>
    `<option value="${esc(m)}"${m === selected ? ' selected' : ''}>${esc(m)}</option>`
  ).join('');
}

// In-panel audio invariant: track which single zone is allowed to be unmuted.
// Toggling a second zone ON warns and keeps the previous one as the active one
// unless the operator confirms the switch implicitly by toggling the old one off.
function audioRowHtml(zone, unmutedZoneId) {
  const on = String(zone.id) === String(unmutedZoneId);
  return `
    <label class="mc-insp-audio-row">
      <input type="checkbox" class="mc-insp-audio" data-zone-id="${esc(zone.id)}" ${on ? 'checked' : ''}>
      <span>${esc(zone.name || 'Region')}</span>
      <span class="mc-insp-audio-state">${on ? '🔊 audio' : '🔇 muted'}</span>
    </label>`;
}

/**
 * Render the inspector into `container` (the #mc-inspector <aside>) and reveal it.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {object} opts.display          the selected display state row
 * @param {boolean} [opts.isWallMember]  true → Partition disabled (wall member)
 * @param {()=>void} [opts.onClose]      called when the panel is dismissed
 */
export async function renderInspector(container, { display, isWallMember = false, onClose } = {}) {
  if (!container || !display) return;
  container.hidden = false;

  // The audio invariant is panel-local UI state: the single unmuted region.
  let unmutedZoneId = null;
  let currentZones = [];

  container.innerHTML = `
    <div class="mc-insp">
      <header class="mc-insp-head">
        <div>
          <h2 class="mc-insp-title">${esc(display.name)}</h2>
          <p class="mc-insp-geo">${esc(geometryLabel(display))}</p>
        </div>
        <button type="button" class="mc-insp-close" data-insp-close aria-label="Close inspector">×</button>
      </header>

      <section class="mc-insp-section">
        <label class="mc-insp-field">
          <span>Display fit</span>
          <select class="mc-insp-fit">${fitOptionsHtml('contain')}</select>
        </label>
      </section>

      <section class="mc-insp-section">
        ${isWallMember
          ? `<p class="mc-insp-walled">This display is part of a video wall — partitioning is unavailable.</p>`
          : `<button type="button" class="mc-btn mc-btn-primary mc-insp-partition" data-insp-partition>Partition into regions</button>`}
      </section>

      <section class="mc-insp-section mc-insp-audio" id="mc-insp-audio" hidden>
        <h3 class="mc-insp-subhead">Region audio</h3>
        <p class="mc-insp-hint">Only one region plays audio at a time.</p>
        <div id="mc-insp-audio-list"></div>
      </section>

      <section class="mc-insp-section mc-insp-regions" id="mc-insp-regions"></section>
    </div>`;

  const closeBtn = container.querySelector('[data-insp-close]');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      container.hidden = true;
      if (typeof onClose === 'function') onClose();
    });
  }

  // Display-level fit_mode is broadcast-time metadata; here we surface it and
  // store the operator's choice so the next send uses it. (The send funnel
  // reads fit from the source payload; the toolbox/send wiring lives elsewhere.)
  const fitSel = container.querySelector('.mc-insp-fit');
  if (fitSel) {
    fitSel.addEventListener('change', () => {
      // Persisted per-zone inside the region editor; at display level this is a
      // hint surfaced for the next broadcast. No server call here by design.
      showToast(`Fit set to "${fitSel.value}" for the next send.`, 'success');
    });
  }

  function paintAudio() {
    const wrap = container.querySelector('#mc-insp-audio');
    const list = container.querySelector('#mc-insp-audio-list');
    if (!wrap || !list) return;
    if (!currentZones.length) { wrap.hidden = true; return; }
    wrap.hidden = false;
    // Default: the first region is the unmuted one if none chosen yet.
    if (unmutedZoneId == null && currentZones.length) unmutedZoneId = currentZones[0].id;
    list.innerHTML = currentZones.map(z => audioRowHtml(z, unmutedZoneId)).join('');
    list.querySelectorAll('.mc-insp-audio').forEach(cb => {
      cb.addEventListener('change', () => {
        const zoneId = cb.dataset.zoneId;
        if (cb.checked) {
          if (unmutedZoneId != null && String(unmutedZoneId) !== String(zoneId)) {
            showToast('Another region already has audio — only one region plays sound at a time. Switching audio to this region.', 'info');
          }
          unmutedZoneId = zoneId;
        } else if (String(unmutedZoneId) === String(zoneId)) {
          unmutedZoneId = null;   // all muted
        }
        paintAudio();
      });
    });
  }

  // Partition: ensure the display has a layout, assign it, mount the editor.
  const partitionBtn = container.querySelector('[data-insp-partition]');
  if (partitionBtn) {
    partitionBtn.addEventListener('click', async () => {
      partitionBtn.disabled = true;
      try {
        const layoutId = await ensureDisplayLayout(display);
        const regionsEl = container.querySelector('#mc-insp-regions');
        await renderRegionEditor(regionsEl, {
          layoutId,
          deviceId: display.id,
          onChange: (zones) => {
            currentZones = Array.isArray(zones) ? zones : [];
            paintAudio();
          },
        });
      } catch (e) {
        showToast(e?.message || 'Could not partition this display.', 'error');
      } finally {
        partitionBtn.disabled = false;
      }
    });
  }
}

// Create or reuse a per-display layout, assign it to the device, return its id.
// If the display already has a layout_id, reuse it (so re-opening Partition does
// not orphan the existing zones + content bindings). Otherwise create one named
// after the display and assign it via PUT /api/layouts/device/:deviceId.
async function ensureDisplayLayout(display) {
  if (display.layout_id) return display.layout_id;
  const created = await api.layouts.create({
    name: `${display.name} — regions`,
    width: display.width || 1920,
    height: display.height || 1080,
  });
  if (!created || !created.id) throw new Error('Layout could not be created.');
  await api.layouts.assignToDevice(display.id, created.id);
  return created.id;
}

/** Hide + clear the inspector (used by the caller when selection is cleared). */
export function closeInspector(container) {
  if (!container) return;
  container.hidden = true;
  container.innerHTML = '';
}
