// region-editor.js — templates-first partitioning surface for the unified Media
// Control inspector (Task 4.4).
//
// Flow: pick one of the 7 layout presets (one-tap, server-generated, zone-id
// PRESERVING via reconcileZones) → the zones render as draggable / resizable
// percentage boxes on a 16:9 canvas → drag-refine persists IN PLACE via
// PUT /api/layouts/:id/zones/:zoneId (keeps the zone id, so content→zone
// bindings survive). Each zone also exposes a fit_mode select (FIT_MODES from
// player-protocol) and a content-assign dropdown (same model as
// device-detail.js:1062-1096 — api.addAssignment(deviceId,{content_id,zone_id})).
//
// NOTE on the drag math: the plan suggested importing boundsOf/intersect/
// attachDragResize from video-wall.js, but those are module-PRIVATE there
// (boundsOf/intersect are unexported, attachDragResize is a closure over the
// `zoom` variable inside render()). They also operate in absolute data-pixels
// with a zoom factor — a different coordinate space than this editor's pure
// PERCENT-of-canvas model. So the pointer drag/resize is re-implemented here in
// the same shape (pointerdown → capture → move/resize → onChange) but clamped to
// 0..100 percent, which is what layout_zones stores.

import { api } from '../../api.js';
import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { FIT_MODES } from '../../player-protocol.js';
import { showToast } from '../../components/toast.js';

// The 7 presets, mirroring server/lib/layout-presets.js keys exactly; labels
// resolved through t() at render time (mc.re.preset.<key>).
const PRESETS = [
  { key: 'full', labelKey: 'mc.re.preset.full' },
  { key: 'columns_2', labelKey: 'mc.re.preset.columns_2' },
  { key: 'rows_2', labelKey: 'mc.re.preset.rows_2' },
  { key: 'columns_3', labelKey: 'mc.re.preset.columns_3' },
  { key: 'quad', labelKey: 'mc.re.preset.quad' },
  { key: 'main_sidebar', labelKey: 'mc.re.preset.main_sidebar' },
  { key: 'six', labelKey: 'mc.re.preset.six' },
];

const MIN_PCT = 5;   // smallest zone edge, in percent of the canvas
const clampPct = (v) => Math.max(0, Math.min(100, v));

// ---- content list (cached per editor mount; small + cheap) ----
async function loadContentOptions() {
  let items = [];
  try {
    const result = await api.getContent();
    items = Array.isArray(result) ? result : (result && Array.isArray(result.content) ? result.content : []);
  } catch {
    items = [];
  }
  return items;
}

function contentOptionsHtml(items, selectedId) {
  const opts = items.slice(0, 200).map(it => {
    const label = it.filename || it.name || it.title || t('mc.re.content_label');
    const sel = selectedId && String(it.id) === String(selectedId) ? ' selected' : '';
    return `<option value="${esc(it.id)}"${sel}>${esc(label)}</option>`;
  }).join('');
  return `<option value="">${esc(t('mc.re.no_content'))}</option>${opts}`;
}

function fitOptionsHtml(selected) {
  return FIT_MODES.map(m =>
    `<option value="${esc(m)}"${m === selected ? ' selected' : ''}>${esc(m)}</option>`
  ).join('');
}

function presetBarHtml(currentLabel) {
  const btns = PRESETS.map(p =>
    `<button type="button" class="mc-re-preset" data-preset="${esc(p.key)}">${esc(t(p.labelKey))}</button>`
  ).join('');
  return `
    <div class="mc-re-presets" role="group" aria-label="${esc(t('mc.re.presets_aria'))}">${btns}</div>
    <div class="mc-re-current">${currentLabel ? esc(t('mc.re.current', { name: currentLabel })) : esc(t('mc.re.pick_template'))}</div>`;
}

// One zone box on the % canvas: position/size from percent columns, plus the
// resize handles and the inline fit/content controls.
function zoneBoxHtml(zone, contentItems) {
  const x = clampPct(Number(zone.x_percent) || 0);
  const y = clampPct(Number(zone.y_percent) || 0);
  const w = clampPct(Number(zone.width_percent) || 100);
  const h = clampPct(Number(zone.height_percent) || 100);
  const handles = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
    .map(d => `<div class="mc-re-handle mc-re-handle-${d}" data-dir="${d}" aria-hidden="true"></div>`)
    .join('');
  return `
    <div class="mc-re-zone" data-zone-id="${esc(zone.id)}"
         style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"
         aria-label="${esc(zone.name || t('mc.re.zone_fallback'))}">
      <div class="mc-re-zone-head">${esc(zone.name || t('mc.re.zone_fallback'))}</div>
      <div class="mc-re-zone-controls">
        <label class="mc-re-ctl">${esc(t('mc.re.content_label'))}
          <select class="mc-re-content" data-zone-id="${esc(zone.id)}">${contentOptionsHtml(contentItems, null)}</select>
        </label>
        <label class="mc-re-ctl">${esc(t('mc.re.fit_label'))}
          <select class="mc-re-fit" data-zone-id="${esc(zone.id)}">${fitOptionsHtml(zone.fit_mode || 'contain')}</select>
        </label>
      </div>
      ${handles}
    </div>`;
}

/**
 * Render the region editor into `container`.
 *
 * @param {HTMLElement} container
 * @param {object} opts
 * @param {string} opts.layoutId         the layout to edit (already assigned to the display)
 * @param {string} [opts.deviceId]       device the layout is on (for content→zone assignment)
 * @param {(zones:Array)=>void} [opts.onChange]  called after zones change (preset/drag/assign)
 */
export async function renderRegionEditor(container, { layoutId, deviceId, onChange } = {}) {
  if (!container) return;
  if (!layoutId) {
    container.innerHTML = `<div class="mc-re-empty">${esc(t('mc.re.no_layout'))}</div>`;
    return;
  }

  container.innerHTML = `<div class="mc-re-loading">${esc(t('mc.re.loading'))}</div>`;

  let layout;
  let contentItems = [];
  try {
    [layout, contentItems] = await Promise.all([api.layouts.get(layoutId), loadContentOptions()]);
  } catch (e) {
    container.innerHTML = `<div class="mc-re-error">${esc(t('mc.re.load_error', { error: e?.message || '' }))}</div>`;
    return;
  }

  // Local zone state — mutated in place during drag, persisted to the server on
  // drag-end. The server is authoritative on preset apply; we re-read then.
  let zones = Array.isArray(layout.zones) ? layout.zones.map(z => ({ ...z })) : [];
  const labelOf = (l) => l && l.name ? l.name : '';

  function repaint() {
    const canvas = container.querySelector('.mc-re-canvas');
    if (!canvas) return;
    canvas.innerHTML = zones.map(z => zoneBoxHtml(z, contentItems)).join('') ||
      `<div class="mc-re-canvas-empty">${esc(t('mc.re.canvas_empty'))}</div>`;
    attachZoneHandlers(canvas);
  }

  function render() {
    container.innerHTML = `
      <div class="mc-re">
        ${presetBarHtml(labelOf(layout))}
        <div class="mc-re-stage">
          <div class="mc-re-canvas" role="application" aria-label="${esc(t('mc.re.canvas_aria'))}"></div>
        </div>
      </div>`;
    attachPresetHandlers();
    repaint();
  }

  function attachPresetHandlers() {
    container.querySelectorAll('.mc-re-preset').forEach(btn => {
      btn.addEventListener('click', async () => {
        const preset = btn.dataset.preset;
        btn.disabled = true;
        try {
          const result = await api.layouts.applyPreset(layoutId, preset);
          // Server returns the reconciled zone set (zone ids PRESERVED slot-wise).
          zones = Array.isArray(result?.zones) ? result.zones.map(z => ({ ...z })) : zones;
          repaint();
          if (typeof onChange === 'function') onChange(zones);
          showToast(t('mc.re.applied'), 'success');
        } catch (e) {
          showToast(e?.message || t('mc.re.apply_failed'), 'error');
        } finally {
          btn.disabled = false;
        }
      });
    });
  }

  // Persist a single zone's geometry IN PLACE (keeps its id → bindings survive).
  async function persistZoneGeometry(zone) {
    try {
      await api.layouts.updateZone(layoutId, zone.id, {
        x_percent: Math.round(zone.x_percent * 100) / 100,
        y_percent: Math.round(zone.y_percent * 100) / 100,
        width_percent: Math.round(zone.width_percent * 100) / 100,
        height_percent: Math.round(zone.height_percent * 100) / 100,
      });
      if (typeof onChange === 'function') onChange(zones);
    } catch (e) {
      showToast(e?.message || t('mc.re.save_failed'), 'error');
    }
  }

  function attachZoneHandlers(canvas) {
    canvas.querySelectorAll('.mc-re-zone').forEach(box => {
      const zoneId = box.dataset.zoneId;
      const zone = zones.find(z => String(z.id) === String(zoneId));
      if (!zone) return;
      attachDragResize(box, canvas, zone, () => {
        // Live visual update while dragging.
        box.style.left = `${clampPct(zone.x_percent)}%`;
        box.style.top = `${clampPct(zone.y_percent)}%`;
        box.style.width = `${clampPct(zone.width_percent)}%`;
        box.style.height = `${clampPct(zone.height_percent)}%`;
      }, () => persistZoneGeometry(zone));

      // fit_mode select — persists in place.
      const fitSel = box.querySelector('.mc-re-fit');
      if (fitSel) {
        fitSel.addEventListener('pointerdown', (e) => e.stopPropagation());
        fitSel.addEventListener('change', async () => {
          try {
            await api.layouts.updateZone(layoutId, zone.id, { fit_mode: fitSel.value });
            zone.fit_mode = fitSel.value;
            if (typeof onChange === 'function') onChange(zones);
          } catch (e) {
            showToast(e?.message || t('mc.re.fit_failed'), 'error');
          }
        });
      }

      // content-assign select — same model as device-detail.js:1062-1096:
      // assigning content to a zone creates a device playlist assignment bound
      // to that zone_id. Requires a deviceId (the layout is on a display).
      const contentSel = box.querySelector('.mc-re-content');
      if (contentSel) {
        contentSel.addEventListener('pointerdown', (e) => e.stopPropagation());
        contentSel.addEventListener('change', async () => {
          const contentId = contentSel.value || null;
          if (!contentId) return;
          if (!deviceId) { showToast(t('mc.re.no_display'), 'error'); return; }
          try {
            await api.addAssignment(deviceId, { content_id: contentId, duration_sec: 0, zone_id: zone.id });
            showToast(t('mc.re.assigned'), 'success');
            if (typeof onChange === 'function') onChange(zones);
          } catch (e) {
            showToast(e?.message || t('mc.re.assign_failed'), 'error');
          }
        });
      }
    });
  }

  // Pointer drag (move) + handle drag (resize) in PERCENT space, clamped 0..100.
  // Mirrors video-wall.js attachDragResize's shape but for a % canvas.
  function attachDragResize(box, canvas, zone, onMove, onEnd) {
    box.addEventListener('pointerdown', (ev) => {
      // Ignore drags that begin on the inline controls.
      if (ev.target.closest('.mc-re-content, .mc-re-fit')) return;
      const handle = ev.target.closest('.mc-re-handle');
      const dir = handle ? handle.dataset.dir : null;
      const mode = dir ? `resize:${dir}` : 'move';
      ev.preventDefault();
      ev.stopPropagation();
      box.setPointerCapture(ev.pointerId);

      const rect = canvas.getBoundingClientRect();
      const startX = ev.clientX;
      const startY = ev.clientY;
      const start = {
        x: Number(zone.x_percent) || 0,
        y: Number(zone.y_percent) || 0,
        w: Number(zone.width_percent) || 100,
        h: Number(zone.height_percent) || 100,
      };

      function move(e) {
        // Convert pixel delta → percent of the canvas.
        const dx = rect.width ? ((e.clientX - startX) / rect.width) * 100 : 0;
        const dy = rect.height ? ((e.clientY - startY) / rect.height) * 100 : 0;
        if (mode === 'move') {
          zone.x_percent = clampPct(Math.min(start.x + dx, 100 - start.w));
          zone.y_percent = clampPct(Math.min(start.y + dy, 100 - start.h));
        } else {
          applyResizePct(mode.slice(7), dx, dy, start, zone);
        }
        onMove();
      }
      function up() {
        box.releasePointerCapture(ev.pointerId);
        box.removeEventListener('pointermove', move);
        box.removeEventListener('pointerup', up);
        box.removeEventListener('pointercancel', up);
        onEnd();
      }
      box.addEventListener('pointermove', move);
      box.addEventListener('pointerup', up);
      box.addEventListener('pointercancel', up);
    });
  }

  render();
}

// Resize in percent space with a 5% minimum edge; keeps the box inside 0..100.
function applyResizePct(dir, dx, dy, start, zone) {
  let { x, y, w, h } = start;
  if (dir.includes('e')) w = Math.max(MIN_PCT, Math.min(start.w + dx, 100 - start.x));
  if (dir.includes('s')) h = Math.max(MIN_PCT, Math.min(start.h + dy, 100 - start.y));
  if (dir.includes('w')) {
    const newW = Math.max(MIN_PCT, Math.min(start.w - dx, start.x + start.w));
    x = start.x + (start.w - newW);
    w = newW;
  }
  if (dir.includes('n')) {
    const newH = Math.max(MIN_PCT, Math.min(start.h - dy, start.y + start.h));
    y = start.y + (start.h - newH);
    h = newH;
  }
  zone.x_percent = clampPct(x);
  zone.y_percent = clampPct(y);
  zone.width_percent = clampPct(w);
  zone.height_percent = clampPct(h);
}
