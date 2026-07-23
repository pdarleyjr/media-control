import {
  expandTargetsToDeviceIds,
  findCatalogTarget,
} from './target-catalog.js';

export const VIEW_MODE = Object.freeze({
  OVERVIEW: 'overview',
  FOCUS: 'focus',
});

function targetReference(target) {
  if (!target || typeof target !== 'object') return null;
  const type = String(target.type || 'display');
  const id = String(target.id || '');
  if (!id) return null;
  const reference = { type, id };
  if (type === 'wall') {
    reference.layout_revision = Number(target.layoutRevision ?? target.layout_revision) || 0;
  } else if (type === 'wall-group') {
    reference.wall_id = String(target.wallId ?? target.wall_id ?? '');
    reference.group_id = String(target.groupId ?? target.group_id ?? '');
    reference.layout_revision = Number(target.layoutRevision ?? target.layout_revision) || 0;
  }
  return reference;
}

function targetKey(reference) {
  return reference ? `${reference.type}:${reference.id}` : '';
}

function isRetiredTarget(target) {
  if (!target) return true;
  const raw = target.raw || target.confirmedState || {};
  if (target.retired === true || raw.retired === true) return true;
  if (target.enabled === false || raw.enabled === false) return true;
  const state = String(target.status || raw.status || '').toLowerCase();
  const disposition = String(target.disposition || raw.disposition || '').toLowerCase();
  const tags = []
    .concat(target.tags || target.labels || raw.tags || raw.labels || [])
    .map((value) => String(value).toLowerCase());
  return state === 'retired' || disposition === 'retired' || tags.includes('retired');
}

export function buildBroadcastSelection(catalog, selectedTargets = []) {
  const references = [];
  const seen = new Set();
  for (const selected of (Array.isArray(selectedTargets) ? selectedTargets : [selectedTargets])) {
    const selectedReference = targetReference(selected);
    if (!selectedReference) continue;
    const target = findCatalogTarget(catalog, selectedReference);
    if (!target || isRetiredTarget(target)) continue;
    const reference = targetReference(target);
    const key = targetKey(reference);
    if (!reference || !key || seen.has(key)) continue;
    seen.add(key);
    references.push(reference);
  }
  return {
    broadcastTargets: references,
    physicalResolvedTargets: expandTargetsToDeviceIds(references, catalog),
  };
}

export function buildRoomBroadcastSelection(catalog) {
  const walls = Array.isArray(catalog?.walls) ? catalog.walls : [];
  const standalone = Array.isArray(catalog?.standaloneDisplays)
    ? catalog.standaloneDisplays
    : [];
  return buildBroadcastSelection(catalog, [
    ...walls.filter((target) => !isRetiredTarget(target)),
    ...standalone.filter((target) => !isRetiredTarget(target)),
  ]);
}

export function createCommandCenterState(initial = {}) {
  return {
    viewMode: VIEW_MODE.OVERVIEW,
    focusedViewTarget: null,
    controlTarget: null,
    broadcastTargets: Array.isArray(initial.broadcastTargets)
      ? [...initial.broadcastTargets]
      : [],
    physicalResolvedTargets: Array.isArray(initial.physicalResolvedTargets)
      ? [...initial.physicalResolvedTargets]
      : [],
  };
}

export function enterFocusView(state, target) {
  if (!target) return showRoomOverview(state);
  return {
    ...state,
    viewMode: VIEW_MODE.FOCUS,
    focusedViewTarget: { ...target },
  };
}

export function showRoomOverview(state) {
  return {
    ...state,
    viewMode: VIEW_MODE.OVERVIEW,
    focusedViewTarget: null,
  };
}

export function setControlTarget(state, target) {
  return {
    ...state,
    controlTarget: target ? { ...target } : null,
  };
}

export function setBroadcastTargets(state, selection = {}) {
  return {
    ...state,
    broadcastTargets: Array.isArray(selection.broadcastTargets)
      ? [...selection.broadcastTargets]
      : [],
    physicalResolvedTargets: Array.isArray(selection.physicalResolvedTargets)
      ? [...selection.physicalResolvedTargets]
      : [],
  };
}
