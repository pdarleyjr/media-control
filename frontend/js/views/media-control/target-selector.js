// target-selector.js — Command Center header target dropdown. Drives the active
// target rendered large on the central canvas. The host decides which displays
// are routable, so split-wall member screens can be listed individually while
// span walls still remain a single composite target.
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
 * @param {Array} opts.displays  routable display targets (may include split-wall members)
 * @param {(target:object|null)=>void} [opts.onTargetChange] fired on a real change
 * @returns {{ el: HTMLSelectElement, getActiveTarget: () => (object|null),
 *            setActive: (target:object|null)=>void, setOptions: (walls:boolean|Array, displays?:Array)=>void }|null}
 */
export function mountTargetSelector(hostEl, { walls = [], groups = [], displays = [], onTargetChange } = {}) {
  if (!hostEl) return null;
  hostEl.innerHTML = `
    <div class="mc-target-control">
      <div class="mc-target-wall-tabs" role="group" aria-label="Video walls"></div>
      <select class="mc-target-select" aria-label="${esc(t('mc.cc.target.placeholder'))}"></select>
    </div>`;
  const sel = hostEl.querySelector('select.mc-target-select');
  const wallTabs = hostEl.querySelector('.mc-target-wall-tabs');

  let active = null;
  let currentWalls = Array.isArray(walls) ? walls : [];
  let currentGroups = Array.isArray(groups) ? groups : [];
  let currentDisplays = Array.isArray(displays) ? displays : [];

  function validValues() {
    const set = new Set();
    for (const w of currentWalls) set.add(`wall:${w.id}`);
    for (const g of currentGroups) set.add(`group:${g.id}`);
    for (const d of currentDisplays) set.add(`display:${d.id}`);
    return set;
  }

  function valueForTarget(target) {
    if (!target || !target.id) return '';
    if (target.type === 'wall') return `wall:${target.id}`;
    if (target.type === 'group') return `group:${target.id}`;
    return `display:${target.id}`;
  }

  function targetForValue(value) {
    const sep = value.indexOf(':');
    const type = sep > 0 ? value.slice(0, sep) : '';
    const id = sep > 0 ? value.slice(sep + 1) : '';
    if (type === 'wall') return { type: 'wall', id, wall_id: id, supportsModes: true };
    if (type === 'group') {
      const group = currentGroups.find((candidate) => candidate.id === id);
      return group ? { type: 'group', ...group, id, supportsModes: false } : null;
    }
    if (type === 'display') return { type: 'display', id, supportsModes: false };
    return null;
  }

  function paintActiveControls() {
    const value = valueForTarget(active);
    sel.value = [...sel.options].some((option) => option.value === value) ? value : '';
    wallTabs.querySelectorAll('[data-target-value]').forEach((button) => {
      const pressed = button.dataset.targetValue === value;
      button.classList.toggle('is-active', pressed);
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
    });
  }

  function activateValue(value, notify = true) {
    active = targetForValue(value);
    paintActiveControls();
    if (notify && typeof onTargetChange === 'function') onTargetChange(active);
  }

  function rebuild() {
    const prev = valueForTarget(active) || sel.value;
    const opts = [optionTag('', t('mc.cc.target.placeholder'))];
    if (currentGroups.length) {
      opts.push(`<optgroup label="Layout groups">${currentGroups.map((group) => optionTag(`group:${group.id}`, group.label || group.name || group.id)).join('')}</optgroup>`);
    }
    if (currentDisplays.length) opts.push('<optgroup label="Individual displays">');
    for (const d of currentDisplays) opts.push(optionTag(`display:${d.id}`, d.name || d.id));
    if (currentDisplays.length) opts.push('</optgroup>');
    sel.innerHTML = opts.join('');
    sel.hidden = currentDisplays.length === 0;
    wallTabs.innerHTML = currentWalls.map((wall) => `
      <button type="button" class="mc-target-wall-btn" data-target-value="wall:${esc(wall.id)}" aria-pressed="false">
        ${esc(wallLabel(wall))}
      </button>`).join('');
    wallTabs.hidden = currentWalls.length === 0;
    if (!validValues().has(prev)) active = null;
    paintActiveControls();
  }
  rebuild();

  wallTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-target-value]');
    if (!button || !wallTabs.contains(button)) return;
    activateValue(button.dataset.targetValue);
  });
  sel.addEventListener('change', () => activateValue(sel.value));

  return {
    el: sel,
    getActiveTarget: () => active,
    setActive: (tgt) => {
      active = tgt || null;
      paintActiveControls();
    },
    setOptions: (nextWalls, nextGroups, nextDisplays) => {
      currentWalls = Array.isArray(nextWalls) ? nextWalls : [];
      currentGroups = Array.isArray(nextGroups) ? nextGroups : [];
      currentDisplays = Array.isArray(nextDisplays) ? nextDisplays : [];
      rebuild();
    },
  };
}
