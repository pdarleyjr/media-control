// target-selector.js — Command Center header quick-focus tabs + target dropdown.
//
// The operator UI always opens in a focused wall/display view (task §5/§6).
// The top navigation shows quick-focus tabs:
//   • Classroom 1 Primary Wall  (always present, default pin)
//   • Classroom 1 Secondary Wall (always present, default pin)
//   • any user-pinned additional targets (per-user, server-authoritative)
// plus a "Customize quick views" action and a dropdown containing every OTHER
// authorized focus target. Selecting any tab or dropdown option is a VIEW-ONLY
// action: it re-points the canvas and never issues a stop/blank/transport
// command (per the Command Center spec). Dropdown selections do NOT auto-pin.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';

// Preserve the operator-configured physical wall name. Renaming real walls to
// ordinal mockup labels made popups disagree with topology, signage, and the
// wall editor (and failed as soon as a third wall was provisioned).
function wallLabel(wall) {
  const name = (wall && wall.name) || '';
  return name || ((wall && wall.id) || '');
}

function refForTarget(target) {
  if (!target || !target.id) return '';
  if (target.type === 'wall') return `wall:${target.id}`;
  if (target.type === 'group') return `group:${target.id}`;
  return `display:${target.id}`;
}

function targetForRef(ref, walls, groups, displays) {
  if (typeof ref !== 'string' || !ref) return null;
  const sep = ref.indexOf(':');
  const type = sep > 0 ? ref.slice(0, sep) : '';
  const id = sep > 0 ? ref.slice(sep + 1) : '';
  if (type === 'wall') {
    const wall = (walls || []).find((w) => w.id === id);
    if (!wall) return null;
    return { type: 'wall', id, wall_id: id, supportsModes: true, name: wall.name };
  }
  if (type === 'display') {
    const d = (displays || []).find((x) => x.id === id);
    if (!d) return null;
    return { type: 'display', id, supportsModes: false, name: d.name || d.id };
  }
  if (type === 'group') {
    const group = (groups || []).find((c) => c.id === id);
    if (!group) return null;
    return { type: 'group', ...group, id, supportsModes: false, name: group.label || group.name || id };
  }
  return null;
}

// The two always-present default quick tabs (task §7). Identified by wall name
// so they survive reprovisioning of wall ids. Primary before Secondary.
function defaultPinRefs(walls) {
  if (!Array.isArray(walls)) return [];
  const find = (frag) => {
    const n = String(frag).toLowerCase();
    const w = walls.find((x) => String(x.name || '').toLowerCase().includes(n));
    return w ? `wall:${w.id}` : null;
  };
  const primary = find('Primary Wall');
  const secondary = find('Secondary Wall');
  const out = [];
  if (primary) out.push(primary);
  if (secondary) out.push(secondary);
  return out;
}

function labelForRef(ref, walls, groups, displays) {
  const tgt = targetForRef(ref, walls, groups, displays);
  if (!tgt) return ref;
  if (tgt.type === 'wall') {
    const w = (walls || []).find((x) => x.id === tgt.id);
    return wallLabel(w) || tgt.id;
  }
  return tgt.name || tgt.id || ref;
}

/**
 * Mount the Command Center quick-focus tabs + target dropdown into `hostEl`.
 *
 * @param {HTMLElement} hostEl
 * @param {object} opts
 * @param {Array} opts.walls     every video wall (each is a selectable target)
 * @param {Array} opts.groups    layout-group targets
 * @param {Array} opts.displays  routable display targets (may include split-wall members)
 * @param {string[]} [opts.pinnedTargets] user-pinned refs (excluding defaults)
 * @param {(target:object|null)=>void} [opts.onTargetChange] fired on a real change
 * @param {(pinnedRefs:string[])=>void} [opts.onPinsChange] fired when pins change
 * @returns {object|null} selector API
 */
export function mountTargetSelector(hostEl, { walls = [], groups = [], displays = [], pinnedTargets = [], onTargetChange, onPinsChange } = {}) {
  if (!hostEl) return null;
  hostEl.innerHTML = `
    <div class="mc-target-control">
      <div class="mc-target-wall-tabs" role="tablist" aria-label="Quick focus targets"></div>
      <button type="button" class="mc-target-customize" data-customize aria-expanded="false" aria-controls="mc-target-cust-panel" title="${esc(t('mc.cc.target.customize') || 'Customize quick views')}" aria-label="${esc(t('mc.cc.target.customize') || 'Customize quick views')}">＋</button>
      <select class="mc-target-select" aria-label="${esc(t('mc.cc.target.placeholder'))}"></select>
      <div class="mc-target-customize-panel" id="mc-target-cust-panel" role="dialog" aria-modal="false" aria-label="${esc(t('mc.cc.target.customize') || 'Customize quick views')}" hidden inert></div>
    </div>`;

  const sel = hostEl.querySelector('select.mc-target-select');
  const wallTabs = hostEl.querySelector('.mc-target-wall-tabs');
  const customizeBtn = hostEl.querySelector('[data-customize]');
  const customizePanel = hostEl.querySelector('.mc-target-customize-panel');

  let active = null;
  let currentWalls = Array.isArray(walls) ? walls : [];
  let currentGroups = Array.isArray(groups) ? groups : [];
  let currentDisplays = Array.isArray(displays) ? displays : [];
  let userPins = Array.isArray(pinnedTargets) ? [...pinnedTargets] : [];

  function defaultRefs() { return defaultPinRefs(currentWalls); }
  function allPins() {
    const out = [...defaultRefs()];
    for (const r of userPins) if (!out.includes(r)) out.push(r);
    return out;
  }

  function validValues() {
    const set = new Set();
    for (const w of currentWalls) set.add(`wall:${w.id}`);
    for (const g of currentGroups) set.add(`group:${g.id}`);
    for (const d of currentDisplays) set.add(`display:${d.id}`);
    return set;
  }

  function valueForTarget(target) { return refForTarget(target); }

  function paintActiveControls() {
    const value = valueForTarget(active);
    sel.value = [...sel.options].some((option) => option.value === value) ? value : '';
    wallTabs.querySelectorAll('[data-target-value]').forEach((button) => {
      const pressed = button.dataset.targetValue === value;
      button.classList.toggle('is-active', pressed);
      button.setAttribute('aria-selected', pressed ? 'true' : 'false');
    });
  }

  function activateValue(value, notify = true) {
    active = targetForRef(value, currentWalls, currentGroups, currentDisplays);
    paintActiveControls();
    if (notify && typeof onTargetChange === 'function') onTargetChange(active);
  }

  function dropdownOptions() {
    // Dropdown contains every authorized target NOT already pinned to a tab.
    const pinned = new Set(allPins());
    const opts = [optionTag('', t('mc.cc.target.placeholder'))];
    const remainingWalls = currentWalls.filter((w) => !pinned.has(`wall:${w.id}`));
    if (remainingWalls.length) {
      opts.push('<optgroup label="Walls">');
      for (const w of remainingWalls) opts.push(optionTag(`wall:${w.id}`, wallLabel(w)));
      opts.push('</optgroup>');
    }
    if (currentGroups.length) {
      const remainingGroups = currentGroups.filter((g) => !pinned.has(`group:${g.id}`));
      if (remainingGroups.length) {
        opts.push('<optgroup label="Layout groups">');
        for (const g of remainingGroups) opts.push(optionTag(`group:${g.id}`, g.label || g.name || g.id));
        opts.push('</optgroup>');
      }
    }
    const remainingDisplays = currentDisplays.filter((d) => !pinned.has(`display:${d.id}`));
    if (remainingDisplays.length) {
      opts.push('<optgroup label="Individual displays">');
      for (const d of remainingDisplays) opts.push(optionTag(`display:${d.id}`, d.name || d.id));
      opts.push('</optgroup>');
    }
    return opts.join('');
  }

  function optionTag(value, label) {
    return `<option value="${esc(value)}">${esc(label)}</option>`;
  }

  function rebuildTabs() {
    const pins = allPins();
    wallTabs.innerHTML = pins.map((ref) => {
      const tgt = targetForRef(ref, currentWalls, currentGroups, currentDisplays);
      if (!tgt) return ''; // retired/removed pin: drop silently
      const label = labelForRef(ref, currentWalls, currentGroups, currentDisplays);
      const isDefault = defaultRefs().includes(ref);
      return `<button type="button" class="mc-target-wall-btn${isDefault ? ' mc-target-pin-default' : ''}" role="tab" data-target-value="${esc(ref)}" aria-selected="false" title="${esc(label)}">${esc(label)}</button>`;
    }).join('');
    wallTabs.hidden = pins.every((r) => !targetForRef(r, currentWalls, currentGroups, currentDisplays));
  }

  function rebuild() {
    const prev = valueForTarget(active) || sel.value;
    // Prune user pins whose targets no longer exist (retired/removed/unauthorized).
    const valid = validValues();
    userPins = userPins.filter((r) => valid.has(r));
    rebuildTabs();
    sel.innerHTML = dropdownOptions();
    sel.hidden = currentDisplays.length === 0 && currentWalls.length === 0;
    if (!valid.has(prev)) active = null;
    paintActiveControls();
  }
  rebuild();

  wallTabs.addEventListener('click', (event) => {
    const button = event.target.closest('[data-target-value]');
    if (!button || !wallTabs.contains(button)) return;
    activateValue(button.dataset.targetValue);
  });
  sel.addEventListener('change', () => activateValue(sel.value));

  // ── Customize quick views panel ─────────────────────────────────────────
  customizeBtn.addEventListener('click', () => toggleCustomizePanel());

  function allAuthorizedRefs() {
    const refs = [];
    for (const w of currentWalls) refs.push(`wall:${w.id}`);
    for (const g of currentGroups) refs.push(`group:${g.id}`);
    for (const d of currentDisplays) refs.push(`display:${d.id}`);
    return refs;
  }

  function renderCustomizePanel() {
    const defaultSet = new Set(defaultRefs());
    const defaultArr = [...defaultRefs()];
    const pinned = new Set(allPins());

    function buildRows() {
      return allAuthorizedRefs().map((ref) => {
        const tgt = targetForRef(ref, currentWalls, currentGroups, currentDisplays);
        if (!tgt) return '';
        const label = labelForRef(ref, currentWalls, currentGroups, currentDisplays);
        const isPinned = pinned.has(ref);
        const isDefaultPin = defaultSet.has(ref);
        const disabled = isDefaultPin ? 'disabled' : '';
        const checked = isPinned ? 'checked' : '';
        return `<li class="mc-target-cust-row" data-ref="${esc(ref)}">
          <label class="mc-target-cust-label"><input type="checkbox" data-pin ${checked} ${disabled}/> ${esc(label)}${isDefaultPin ? ' <span class="mc-target-cust-default">(default)</span>' : ''}</label>
          <span class="mc-target-cust-order" ${isPinned && !isDefaultPin ? '' : 'hidden'}>
            <button type="button" data-up aria-label="Move ${esc(label)} up">▲</button>
            <button type="button" data-down aria-label="Move ${esc(label)} down">▼</button>
          </span>
        </li>`;
      }).join('');
    }

    customizePanel.innerHTML = `
      <div class="mc-target-cust-head">
        <h3>${esc(t('mc.cc.target.customize') || 'Customize quick views')}</h3>
        <button type="button" data-close aria-label="Close">✕</button>
      </div>
      <p class="mc-target-cust-hint">Primary Wall and Secondary Wall are always included.</p>
      <span class="mc-target-cust-status" role="status" aria-live="polite"></span>
      <ul class="mc-target-cust-list">${buildRows()}</ul>
      <div class="mc-target-cust-actions">
        <button type="button" data-reset>Reset to defaults</button>
        <span class="mc-target-cust-spacer"></span>
        <button type="button" data-cancel>Cancel</button>
        <button type="button" class="mc-target-cust-save" data-save>Save</button>
      </div>`;

    const statusRegion = customizePanel.querySelector('.mc-target-cust-status');
    const listEl = customizePanel.querySelector('.mc-target-cust-list');
    let working = [...userPins];

    // Announce position changes via the aria-live region.
    function announcePosition(ref) {
      const ordered = [...defaultArr, ...working];
      const pos = ordered.indexOf(ref) + 1;
      const label = labelForRef(ref, currentWalls, currentGroups, currentDisplays);
      if (statusRegion) statusRegion.textContent = `${label} moved to position ${pos}`;
    }

    // Reorder the visible DOM immediately: move the <li> for the moved ref
    // to its new position in the pinned sequence.
    function visuallyReorder() {
      const ordered = [...defaultArr, ...working];
      const rows = Array.from(listEl.querySelectorAll('.mc-target-cust-row'));
      // Sort rows by their position in the ordered list; unpinned rows stay at the end.
      rows.sort((a, b) => {
        const aPos = ordered.indexOf(a.dataset.ref);
        const bPos = ordered.indexOf(b.dataset.ref);
        if (aPos < 0 && bPos < 0) return 0;
        if (aPos < 0) return 1;
        if (bPos < 0) return -1;
        return aPos - bPos;
      });
      // Re-append in sorted order (moves DOM nodes without recreating them).
      for (const row of rows) listEl.appendChild(row);
    }

    const refreshOrderControls = () => {
      customizePanel.querySelectorAll('.mc-target-cust-row').forEach((li) => {
        const ref = li.dataset.ref;
        const isDefault = defaultSet.has(ref);
        const isPinned = isDefault || working.includes(ref);
        const orderSpan = li.querySelector('.mc-target-cust-order');
        orderSpan.hidden = !(isPinned && !isDefault);
        const cb = li.querySelector('[data-pin]');
        if (!isDefault) cb.checked = isPinned;
      });
      visuallyReorder();
    };
    refreshOrderControls();

    customizePanel.querySelector('[data-close]').addEventListener('click', () => closeCustomizePanel());
    customizePanel.querySelector('[data-cancel]').addEventListener('click', () => closeCustomizePanel());
    customizePanel.querySelector('[data-reset]').addEventListener('click', () => {
      working = [];
      refreshOrderControls();
      if (statusRegion) statusRegion.textContent = 'Reset to defaults';
    });
    customizePanel.querySelector('[data-save]').addEventListener('click', () => {
      userPins = working;
      rebuild();
      if (typeof onPinsChange === 'function') onPinsChange(userPins);
      closeCustomizePanel();
    });

    customizePanel.querySelectorAll('.mc-target-cust-row').forEach((li) => {
      const ref = li.dataset.ref;
      const cb = li.querySelector('[data-pin]');
      cb.addEventListener('change', () => {
        if (cb.checked && !working.includes(ref)) working.push(ref);
        if (!cb.checked) working = working.filter((r) => r !== ref);
        refreshOrderControls();
      });
      const move = (dir, btn) => {
        const idx = working.indexOf(ref);
        if (idx < 0) return;
        const swap = dir === 'up' ? idx - 1 : idx + 1;
        if (swap < 0 || swap >= working.length) return;
        [working[idx], working[swap]] = [working[swap], working[idx]];
        refreshOrderControls();
        announcePosition(ref);
        // Keep focus on the button that was pressed (it moved with its <li>).
        if (btn && typeof btn.focus === 'function') { try { btn.focus({ preventScroll: false }); } catch { /* */ } }
      };
      li.querySelector('[data-up]').addEventListener('click', (e) => move('up', e.currentTarget));
      li.querySelector('[data-down]').addEventListener('click', (e) => move('down', e.currentTarget));
    });

    // Escape closes the panel and returns focus to the opener.
    const escHandler = (event) => {
      if (event.key === 'Escape' && !customizePanel.hidden) {
        event.preventDefault();
        closeCustomizePanel();
      }
    };
    customizePanel._escHandler = escHandler;
    document.addEventListener('keydown', escHandler);

    // Outside click closes the panel (but not when clicking inside it or the opener).
    const outsideHandler = (event) => {
      if (customizePanel.hidden) return;
      if (customizePanel.contains(event.target) || customizeBtn.contains(event.target)) return;
      closeCustomizePanel();
    };
    customizePanel._outsideHandler = outsideHandler;
    setTimeout(() => document.addEventListener('click', outsideHandler), 0);
  }

  function toggleCustomizePanel() {
    if (customizePanel.hidden) {
      renderCustomizePanel();
      customizePanel.hidden = false;
      customizePanel.removeAttribute('inert');
      customizeBtn.setAttribute('aria-expanded', 'true');
      // Move focus into the panel (to the close button or heading).
      try { (customizePanel.querySelector('[data-close]') || customizePanel).focus({ preventScroll: true }); } catch { /* */ }
    } else {
      closeCustomizePanel();
    }
  }
  function closeCustomizePanel() {
    // Clean up event listeners.
    if (customizePanel._escHandler) { document.removeEventListener('keydown', customizePanel._escHandler); customizePanel._escHandler = null; }
    if (customizePanel._outsideHandler) { document.removeEventListener('click', customizePanel._outsideHandler); customizePanel._outsideHandler = null; }
    customizePanel.hidden = true;
    customizePanel.setAttribute('inert', '');
    customizeBtn.setAttribute('aria-expanded', 'false');
    // Return focus to the opener button.
    try { customizeBtn.focus({ preventScroll: true }); } catch { /* */ }
  }

  return {
    el: sel,
    getActiveTarget: () => active,
    setActive: (tgt) => { active = tgt || null; paintActiveControls(); },
    setPinned: (refs) => { userPins = Array.isArray(refs) ? [...refs] : []; rebuild(); },
    getPinned: () => [...userPins],
    setOptions: (nextWalls, nextGroups, nextDisplays) => {
      currentWalls = Array.isArray(nextWalls) ? nextWalls : [];
      currentGroups = Array.isArray(nextGroups) ? nextGroups : [];
      currentDisplays = Array.isArray(nextDisplays) ? nextDisplays : [];
      rebuild();
    },
  };
}
