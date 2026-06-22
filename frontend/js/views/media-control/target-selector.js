// target-selector.js — Command Center header target dropdown. Drives the active
// target rendered large on the central canvas. A video wall is one selectable
// target (its member screens are PASSIVE regions, never selectable individually);
// individual displays that are NOT wall members are selectable too.
//
// Selecting a target is a VIEW-ONLY action: it re-points the canvas at one
// target and never issues a stop / blank / transport command to any other
// target (per the Command Center spec). The host view decides what to render
// in the stage; this module only reports the selection via onTargetChange.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';

// Friendlier wall labels that match the classroom mockup. "Primary Wall" ->
// "Video Wall 1", "Secondary Wall" -> "Video Wall 2"; any other wall keeps its
// own name so bespoke walls still read correctly.
function wallLabel(wall) {
  const name = (wall && wall.name) || '';
  if (/primary\s+wall/i.test(name)) return 'Video Wall 1';
  if (/secondary\s+wall/i.test(name)) return 'Video Wall 2';
  return name || ((wall && wall.id) || '');
}

function optionTag(value, label) {
  return `<option value="${esc(value)}">${esc(label)}</option>`;
}

/**
 * Mount the Command Center target dropdown into `hostEl`.
 *
 * @param {HTMLElement} hostEl
 * @param {object} opts
 * @param {Array} opts.walls     every video wall (each is a selectable target)
 * @param {Array} opts.displays  individual displays NOT owned by a wall
 * @param {(target:object|null)=>void} [opts.onTargetChange] fired on a real change
 * @returns {{ el: HTMLSelectElement, getActiveTarget: () => (object|null),
 *            setActive: (target:object|null)=>void, setOptions: (walls:boolean|Array, displays?:Array)=>void }|null}
 */
export function mountTargetSelector(hostEl, { walls = [], displays = [], onTargetChange } = {}) {
  if (!hostEl) return null;
  hostEl.innerHTML = `<select class="mc-target-select" aria-label="${esc(t('mc.cc.target.placeholder'))}"></select>`;
  const sel = hostEl.querySelector('select.mc-target-select');

  let active = null;
  let currentWalls = Array.isArray(walls) ? walls : [];
  let currentDisplays = Array.isArray(displays) ? displays : [];

  function validValues() {
    const set = new Set();
    for (const w of currentWalls) set.add(`wall:${w.id}`);
    for (const d of currentDisplays) set.add(`display:${d.id}`);
    return set;
  }

  function rebuild() {
    const prev = sel.value;
    const opts = [optionTag('', t('mc.cc.target.placeholder'))];
    for (const w of currentWalls) opts.push(optionTag(`wall:${w.id}`, wallLabel(w)));
    for (const d of currentDisplays) opts.push(optionTag(`display:${d.id}`, d.name || d.id));
    sel.innerHTML = opts.join('');
    // Preserve the current selection if it still exists; otherwise reset to the placeholder.
    sel.value = validValues().has(prev) ? prev : '';
  }
  rebuild();

  sel.addEventListener('change', () => {
    const val = sel.value;
    if (!val) { active = null; if (typeof onTargetChange === 'function') onTargetChange(null); return; }
    const sep = val.indexOf(':');
    const type = sep > 0 ? val.slice(0, sep) : '';
    const id = sep > 0 ? val.slice(sep + 1) : '';
    if (type === 'wall') {
      active = { type: 'wall', id, wall_id: id, supportsModes: true };
    } else if (type === 'display') {
      active = { type: 'display', id, supportsModes: false };
    } else {
      active = null;
    }
    if (typeof onTargetChange === 'function') onTargetChange(active);
  });

  return {
    el: sel,
    getActiveTarget: () => active,
    setActive: (tgt) => {
      if (!tgt) { active = null; sel.value = ''; return; }
      active = tgt;
      sel.value = tgt.type === 'wall' ? `wall:${tgt.id}` : `display:${tgt.id}`;
    },
    setOptions: (nextWalls, nextDisplays) => {
      currentWalls = Array.isArray(nextWalls) ? nextWalls : [];
      currentDisplays = Array.isArray(nextDisplays) ? nextDisplays : [];
      rebuild();
    },
  };
}