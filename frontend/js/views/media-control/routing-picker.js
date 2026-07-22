// routing-picker.js — source target picker for Command Center toolbox taps.
//
// Replaces the old click-to-current-selection broadcast with an explicit,
// touch-friendly target picker. Source routing preserves the wall's current,
// revisioned composition; changing span/split/groups is a separate operation.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';

function unique(list) {
  return [...new Set((list || []).filter(Boolean).map(String))];
}

function wallMembers(wall) {
  return Array.isArray(wall?.devices) ? wall.devices.filter(m => m && m.device_id) : [];
}

function allWallDeviceIds(wall) {
  return unique(wallMembers(wall).map(m => m.device_id));
}

function wallCanvasSize(wall) {
  const members = wallMembers(wall);
  const calibrated = members.filter((member) =>
    Number.isFinite(Number(member.canvas_x)) && Number.isFinite(Number(member.canvas_y))
    && Number(member.canvas_width) > 0 && Number(member.canvas_height) > 0
  );
  if (calibrated.length === members.length && calibrated.length) {
    const minX = Math.min(...calibrated.map((member) => Number(member.canvas_x)));
    const minY = Math.min(...calibrated.map((member) => Number(member.canvas_y)));
    const maxX = Math.max(...calibrated.map((member) => Number(member.canvas_x) + Number(member.canvas_width)));
    const maxY = Math.max(...calibrated.map((member) => Number(member.canvas_y) + Number(member.canvas_height)));
    return { width: Math.round(maxX - minX), height: Math.round(maxY - minY) };
  }
  const columnWidths = new Map();
  const rowHeights = new Map();
  for (const member of members) {
    const column = Number(member.grid_col) || 0;
    const row = Number(member.grid_row) || 0;
    const width = Number(member.canvas_width) || Number(member.screen_width) || 0;
    const height = Number(member.canvas_height) || Number(member.screen_height) || 0;
    columnWidths.set(column, Math.max(columnWidths.get(column) || 0, width));
    rowHeights.set(row, Math.max(rowHeights.get(row) || 0, height));
  }
  const width = [...columnWidths.values()].reduce((sum, value) => sum + value, 0);
  const height = [...rowHeights.values()].reduce((sum, value) => sum + value, 0);
  return width > 0 && height > 0 ? { width: Math.round(width), height: Math.round(height) } : null;
}

function wallSectionBuckets(wall) {
  const members = wallMembers(wall);
  const buckets = { left: [], center: [], right: [] };
  if (members.length === 0) return buckets;

  const withCol = members.filter(m => Number.isInteger(m.grid_col));
  if (withCol.length === members.length) {
    const cols = [...new Set(withCol.map(m => m.grid_col))].sort((a, b) => a - b);
    const min = cols[0];
    const max = cols[cols.length - 1];
    for (const m of withCol) {
      if (m.grid_col === min) buckets.left.push(m.device_id);
      else if (m.grid_col === max) buckets.right.push(m.device_id);
      else buckets.center.push(m.device_id);
    }
    return buckets;
  }

  const sorted = [...members].sort((a, b) => String(a.device_name || a.device_id).localeCompare(String(b.device_name || b.device_id)));
  sorted.forEach((m, idx) => {
    const third = sorted.length <= 2 ? (idx === 0 ? 'left' : 'right') : (idx < sorted.length / 3 ? 'left' : (idx >= sorted.length * 2 / 3 ? 'right' : 'center'));
    buckets[third].push(m.device_id);
  });
  return buckets;
}

function sectionLabel(section) {
  if (section === 'left') return t('mc.route.section_left');
  if (section === 'center') return t('mc.route.section_center');
  return t('mc.route.section_right');
}

function ensureDialog(className, titleId) {
  const dlg = document.createElement('dialog');
  dlg.className = className;
  dlg.setAttribute('aria-labelledby', titleId);
  document.body.appendChild(dlg);
  return dlg;
}

function closeDialog(dlg) {
  try { if (dlg.open) dlg.close(); } catch { /* ignore */ }
  try { dlg.remove(); } catch { /* ignore */ }
}

function showPrimaryTargetDialog({ displays = [], walls = [], label = '' }) {
  const dlg = ensureDialog('mc-dialog mc-route-dialog', 'mcRouteTitle');
  const displayRows = displays.map(d => {
    const status = d.online ? t('mc.status.online') : t('mc.status.offline');
    return `<label class="mc-route-row">
      <input type="checkbox" value="${esc(d.id)}" data-route-display>
      <span class="mc-route-row-main">
        <span class="mc-route-name">${esc(d.name || t('mc.wall.screen_fallback'))}</span>
        <span class="mc-route-meta">${esc(status)}</span>
      </span>
    </label>`;
  }).join('');
  const wallRows = walls.map(w => {
    const members = wallMembers(w);
    const count = allWallDeviceIds(w).length;
    const onlineCount = members.filter((member) => member.device_status === 'online').length;
    const canvas = wallCanvasSize(w);
    const mode = w.layout_mode === 'groups' ? 'custom groups' : (w.layout_mode || 'span');
    const dimensions = canvas ? `${canvas.width}×${canvas.height}` : 'geometry pending';
    const revision = Number(w.layout_revision) || 0;
    const topology = members.map((member) => {
      const online = member.device_status === 'online';
      return `<span class="mc-route-member${online ? ' is-online' : ' is-offline'}" title="${esc(member.device_name || member.device_id)}">${online ? '●' : '○'}</span>`;
    }).join('');
    return `<label class="mc-route-row mc-route-wall-row">
      <input type="checkbox" value="${esc(w.id)}" data-route-wall>
      <span class="mc-route-row-main">
        <span class="mc-route-name">${esc(w.name || t('mc.route.wall_fallback'))}</span>
        <span class="mc-route-meta">${esc(`${mode} · ${dimensions} · ${onlineCount}/${count} online · r${revision}`)}</span>
        <span class="mc-route-topology" data-route-topology aria-label="${esc(`${onlineCount} of ${count} wall displays online`)}">${topology}</span>
      </span>
    </label>`;
  }).join('');
  const empty = !displayRows && !wallRows
    ? `<p class="mc-route-empty">${esc(t('mc.route.empty'))}</p>`
    : '';
  dlg.innerHTML = `
    <div class="mc-dialog-card mc-route-card">
      <h3 id="mcRouteTitle" class="mc-dialog-title">${esc(t('mc.route.title'))}</h3>
      <p class="mc-dialog-msg">${esc(t('mc.route.message', { label }))}</p>
      <div class="mc-route-list" aria-label="${esc(t('mc.route.title'))}">
        ${walls.length ? `<h4 class="mc-route-group">${esc(t('mc.route.video_walls'))}</h4>${wallRows}` : ''}
        ${displays.length ? `<h4 class="mc-route-group">${esc(t('mc.route.displays'))}</h4>${displayRows}` : ''}
        ${empty}
      </div>
      <p class="mc-route-error" data-route-error hidden>${esc(t('mc.route.pick_one'))}</p>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-route-cancel>${esc(t('mc.route.cancel'))}</button>
        <button type="button" class="mc-btn mc-btn-primary" data-route-next>${esc(t('mc.route.continue'))}</button>
      </div>
    </div>`;

  return new Promise(resolve => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      closeDialog(dlg);
      resolve(value);
    };
    const onCancel = (e) => { if (e) e.preventDefault(); finish(null); };
    dlg.addEventListener('cancel', onCancel);
    dlg.querySelector('[data-route-cancel]').addEventListener('click', onCancel);
    dlg.querySelector('[data-route-next]').addEventListener('click', () => {
      const displayIds = [...dlg.querySelectorAll('[data-route-display]:checked')].map(el => el.value);
      const wallIds = [...dlg.querySelectorAll('[data-route-wall]:checked')].map(el => el.value);
      if (!displayIds.length && !wallIds.length) {
        const err = dlg.querySelector('[data-route-error]');
        if (err) err.hidden = false;
        return;
      }
      finish({ displayIds, wallIds });
    });
    dlg.showModal();
  });
}

function showWallModeDialog({ selectedWalls = [] }) {
  const dlg = ensureDialog('mc-dialog mc-route-dialog mc-route-wall-dialog', 'mcRouteWallTitle');
  const wallCards = selectedWalls.map((wall, index) => {
    const buckets = wallSectionBuckets(wall);
    const sections = ['left', 'center', 'right'].map(section => {
      const count = buckets[section].length;
      return `<label class="mc-route-section${count ? '' : ' is-disabled'}">
        <input type="checkbox" data-route-section="${section}" data-wall-index="${index}" ${count ? '' : 'disabled'}>
        <span>${esc(sectionLabel(section))}</span>
        <small>${esc(t('mc.route.section_meta', { n: count }))}</small>
      </label>`;
    }).join('');
    return `<fieldset class="mc-route-wall-choice" data-wall-index="${index}">
      <legend>${esc(wall.name || t('mc.route.wall_fallback'))}</legend>
      <label class="mc-route-mode">
        <input type="radio" name="route-wall-${index}" value="span" checked>
        <span><strong>${esc(t('mc.route.wall_span'))}</strong><small>${esc(t('mc.route.wall_span_hint'))}</small></span>
      </label>
      <label class="mc-route-mode">
        <input type="radio" name="route-wall-${index}" value="sections">
        <span><strong>${esc(t('mc.route.wall_sections'))}</strong><small>${esc(t('mc.route.wall_sections_hint'))}</small></span>
      </label>
      <div class="mc-route-sections">${sections}</div>
    </fieldset>`;
  }).join('');

  dlg.innerHTML = `
    <div class="mc-dialog-card mc-route-card">
      <h3 id="mcRouteWallTitle" class="mc-dialog-title">${esc(t('mc.route.wall_title'))}</h3>
      <p class="mc-dialog-msg">${esc(t('mc.route.wall_message'))}</p>
      <div class="mc-route-list">${wallCards}</div>
      <p class="mc-route-error" data-route-error hidden>${esc(t('mc.route.section_pick_one'))}</p>
      <div class="mc-dialog-actions">
        <button type="button" class="mc-btn mc-btn-ghost" data-route-back>${esc(t('mc.route.cancel'))}</button>
        <button type="button" class="mc-btn mc-btn-primary" data-route-send>${esc(t('mc.route.send'))}</button>
      </div>
    </div>`;

  return new Promise(resolve => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.removeEventListener('cancel', onCancel);
      closeDialog(dlg);
      resolve(value);
    };
    const onCancel = (e) => { if (e) e.preventDefault(); finish(null); };
    dlg.addEventListener('cancel', onCancel);
    dlg.querySelector('[data-route-back]').addEventListener('click', onCancel);
    dlg.querySelector('[data-route-send]').addEventListener('click', () => {
      const selections = [];
      for (let i = 0; i < selectedWalls.length; i++) {
        const wall = selectedWalls[i];
        const mode = dlg.querySelector(`input[name="route-wall-${i}"]:checked`)?.value || 'span';
        if (mode === 'span') {
          selections.push({ wall, mode, deviceIds: allWallDeviceIds(wall), sections: [] });
          continue;
        }
        const buckets = wallSectionBuckets(wall);
        const sections = [...dlg.querySelectorAll(`[data-route-section][data-wall-index="${i}"]:checked`)].map(el => el.dataset.routeSection);
        const deviceIds = unique(sections.flatMap(section => buckets[section] || []));
        if (!deviceIds.length) {
          const err = dlg.querySelector('[data-route-error]');
          if (err) err.hidden = false;
          return;
        }
        selections.push({ wall, mode, deviceIds, sections });
      }
      finish(selections);
    });
    dlg.showModal();
  });
}

export async function pickRoutingTargets({ displays = [], walls = [], label = '' } = {}) {
  const primary = await showPrimaryTargetDialog({ displays, walls, label });
  if (!primary) return null;
  const selectedWalls = primary.wallIds
    .map(id => (walls || []).find(w => String(w.id) === String(id)))
    .filter(Boolean);
  const wallSelections = selectedWalls.map((wall) => ({
    wall,
    mode: 'preserve',
    deviceIds: allWallDeviceIds(wall),
    sections: [],
  }));
  return {
    displayIds: unique(primary.displayIds),
    wallSelections: wallSelections || [],
  };
}
