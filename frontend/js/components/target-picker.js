import {
  buildTargetCatalog,
  expandTargetsToDeviceIds,
  findCatalogTarget,
} from '../services/target-catalog.js';
import { esc } from '../utils.js';
import { t } from '../i18n.js';

let dialogSequence = 0;

function targetReference(target) {
  const reference = { type: String(target?.type || 'display'), id: String(target?.id || '') };
  if (target?.type === 'wall') reference.layout_revision = Number(target.layoutRevision) || 0;
  if (target?.type === 'wall-group') {
    reference.wall_id = String(target.wallId || '');
    reference.group_id = String(target.groupId || '');
    reference.layout_revision = Number(target.layoutRevision) || 0;
  }
  return reference;
}

function targetKey(target) {
  const reference = typeof target === 'string' ? parseReference(target) : targetReference(target);
  return reference?.id ? `${reference.type}:${reference.id}` : '';
}

function parseReference(value) {
  if (typeof value === 'string') {
    const separator = value.indexOf(':');
    if (separator > 0) return { type: value.slice(0, separator), id: value.slice(separator + 1) };
    return value ? { type: 'display', id: value } : null;
  }
  const reference = targetReference(value);
  return reference.id ? reference : null;
}

function normalizeCapabilityKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseCapabilities(value) {
  if (typeof value === 'string') {
    try { return parseCapabilities(JSON.parse(value)); } catch { return null; }
  }
  if (Array.isArray(value)) {
    return new Map(value.map((entry) => [normalizeCapabilityKey(entry), true]).filter(([key]) => key));
  }
  if (!value || typeof value !== 'object') return null;
  const entries = Object.entries(value)
    .map(([key, supported]) => [normalizeCapabilityKey(key), supported])
    .filter(([key]) => key);
  return entries.length ? new Map(entries) : null;
}

function declaredCapability(target, capability) {
  const key = normalizeCapabilityKey(capability);
  if (!key) return null;
  const candidates = [
    target?.capabilities,
    target?.capabilities_json,
    target?.raw?.capabilities,
    target?.raw?.capabilities_json,
    target?.confirmedState?.capabilities,
    target?.confirmedState?.capabilities_json,
  ];
  for (const candidate of candidates) {
    const capabilities = parseCapabilities(candidate);
    if (!capabilities || !capabilities.has(key)) continue;
    const value = capabilities.get(key);
    if (value === false || value === 0 || value === 'false' || value === 'unsupported') return false;
    return true;
  }
  return null;
}

function supportsCapability(target, capability) {
  if (!capability) return true;
  if (typeof capability === 'function') {
    try { return capability(target) === true; } catch { return false; }
  }
  if (Array.isArray(capability)) {
    return capability.every((entry) => supportsCapability(target, entry));
  }
  if (target?.type === 'wall' || target?.type === 'wall-group' || target?.type === 'group') {
    return (target.members || []).every((member) => declaredCapability(member, capability) !== false);
  }
  return declaredCapability(target, capability) !== false;
}

function targetHasOnlineMember(target) {
  if (target?.type === 'wall' || target?.type === 'wall-group' || target?.type === 'group') return Number(target.onlineCount) > 0;
  return target?.online === true;
}

function decorateTarget(target, { capability, allowOffline, availability }) {
  const supported = supportsCapability(target, capability);
  const available = targetHasOnlineMember(target);
  const composite = ['wall', 'wall-group', 'group'].includes(target?.type);
  const partial = composite && Number(target.onlineCount) > 0 && Number(target.onlineCount) < Number(target.memberCount);
  const disabledReason = !supported
    ? 'unsupported'
    : (!allowOffline && availability === 'all' && partial ? 'partial' : (!allowOffline && !available ? 'offline' : null));
  return {
    key: targetKey(target),
    reference: targetReference(target),
    target,
    disabled: disabledReason !== null,
    disabledReason,
  };
}

function decorateTargets(targets, options) {
  return (targets || []).map((target) => decorateTarget(target, options));
}

function selectableKeys(model) {
  const keys = new Set();
  for (const section of model.sections) {
    for (const item of section.targets) if (!item.disabled) keys.add(item.key);
  }
  if (model.liveProgram && !model.liveProgram.disabled) keys.add(model.liveProgram.key);
  return keys;
}

/**
 * Create the stable, testable view model used by every target-selection dialog.
 * A known unsupported capability disables a target. Missing legacy capability
 * telemetry remains compatible until that display reports a definitive value.
 */
export function createTargetPickerModel(options = {}) {
  const sourceCatalog = options.catalog && typeof options.catalog === 'object'
    ? options.catalog
    : buildTargetCatalog(options.snapshot);
  const catalog = {
    ...sourceCatalog,
    walls: Array.isArray(sourceCatalog.walls) ? sourceCatalog.walls : [],
    wallGroups: Array.isArray(sourceCatalog.wallGroups) ? sourceCatalog.wallGroups : [],
    groups: Array.isArray(sourceCatalog.groups) ? sourceCatalog.groups : [],
    displays: Array.isArray(sourceCatalog.displays) ? sourceCatalog.displays : [],
    standaloneDisplays: Array.isArray(sourceCatalog.standaloneDisplays)
      ? sourceCatalog.standaloneDisplays
      : [],
    physicalMembers: Array.isArray(sourceCatalog.physicalMembers) ? sourceCatalog.physicalMembers : [],
    liveProgram: sourceCatalog.liveProgram || null,
  };
  const selection = options.selection === 'single' ? 'single' : 'multiple';
  const decoratorOptions = {
    capability: options.capability || null,
    allowOffline: options.allowOffline === true,
    availability: options.availability === 'all' ? 'all' : 'any',
  };
  const sections = [];

  if (catalog.walls.length) {
    sections.push({ kind: 'walls', targets: decorateTargets(catalog.walls, decoratorOptions) });
  }
  if (catalog.wallGroups.length) {
    sections.push({ kind: 'wall-groups', targets: decorateTargets(catalog.wallGroups, decoratorOptions) });
  }
  if (catalog.groups.length) {
    sections.push({ kind: 'groups', targets: decorateTargets(catalog.groups, decoratorOptions) });
  }
  if (catalog.standaloneDisplays.length) {
    sections.push({
      kind: 'standalone',
      targets: decorateTargets(catalog.standaloneDisplays, decoratorOptions),
    });
  }
  if (options.allowIndividualWallMembers === true && catalog.physicalMembers.length) {
    sections.push({
      kind: 'wall-members',
      targets: decorateTargets(catalog.physicalMembers, decoratorOptions),
    });
  }

  const liveProgram = options.allowLiveProgram === true && catalog.liveProgram
    ? decorateTarget(catalog.liveProgram, decoratorOptions)
    : null;
  const model = {
    catalog,
    capability: options.capability || null,
    selection,
    allowOffline: decoratorOptions.allowOffline,
    availability: decoratorOptions.availability,
    allowIndividualWallMembers: options.allowIndividualWallMembers === true,
    allowLiveProgram: options.allowLiveProgram === true,
    sections,
    liveProgram,
    initialSelection: new Set(),
  };
  const allowed = selectableKeys(model);
  const requested = Array.isArray(options.selectedTargets)
    ? options.selectedTargets
    : (Array.isArray(options.selected) ? options.selected : []);
  for (const candidate of requested) {
    const key = targetKey(candidate);
    if (!key || !allowed.has(key) || key.startsWith('live-program:')) continue;
    model.initialSelection.add(key);
    if (selection === 'single') break;
  }
  return model;
}

function layoutModeLabel(mode) {
  const normalized = String(mode || 'single').toLowerCase().replace(/[^a-z0-9]/g, '_');
  const known = new Set(['span', 'mirror', 'split', 'groups', 'single', 'custom']);
  return known.has(normalized) ? t(`mc.target_picker.mode_${normalized}`) : String(mode || 'single');
}

function disabledLabel(reason) {
  if (reason === 'unsupported') return t('mc.target_picker.unsupported');
  if (reason === 'offline') return t('mc.target_picker.unavailable');
  if (reason === 'partial') return t('mc.target_picker.requires_all_online');
  return '';
}

function statusLabel(target) {
  if (['wall', 'wall-group', 'group'].includes(target?.type)
      && Number(target.onlineCount) > 0 && Number(target.onlineCount) < Number(target.memberCount)) {
    return t('mc.target_picker.status_partial');
  }
  return targetHasOnlineMember(target)
    ? t('mc.target_picker.status_online')
    : t('mc.target_picker.status_offline');
}

function targetMeta(target) {
  if (target.type === 'wall' || target.type === 'wall-group') {
    return t('mc.target_picker.wall_meta', {
      mode: layoutModeLabel(target.layoutMode),
      dimensions: target.dimensionsLabel,
      online: target.onlineCount,
      total: target.memberCount,
      revision: target.layoutRevision,
    });
  }
  if (target.type === 'group') {
    return t('mc.target_picker.group_meta', {
      online: target.onlineCount,
      total: target.memberCount,
      dimensions: target.dimensionsLabel,
    });
  }
  return t('mc.target_picker.display_meta', {
    status: statusLabel(target),
    dimensions: target.dimensionsLabel,
  });
}

function renderMemberTopology(target) {
  if (!['wall', 'wall-group'].includes(target.type) || !target.members?.length) return '';
  const memberDescription = target.members
    .map((member) => `${member.name}: ${statusLabel(member)}`)
    .join('; ');
  const label = t('mc.target_picker.wall_topology', {
    online: target.onlineCount,
    total: target.memberCount,
    members: memberDescription,
  });
  const markers = target.members.map((member) => `
    <span class="mc-target-picker-member ${member.online ? 'is-online' : 'is-offline'}"
      role="listitem" title="${esc(`${member.name}: ${statusLabel(member)}`)}">
      <span aria-hidden="true"></span>
      <span class="mc-visually-hidden">${esc(`${member.name}: ${statusLabel(member)}`)}</span>
    </span>`).join('');
  return `<span class="mc-target-picker-topology" role="list" aria-label="${esc(label)}">${markers}</span>`;
}

function renderChoice(
  item,
  model,
  selectedKeys,
  { liveAcknowledged = false, radioName = 'mc-target-picker-selection' } = {},
) {
  const selectionType = model.selection === 'single' ? 'radio' : 'checkbox';
  const isLive = item.target.type === 'live-program';
  const disabled = item.disabled || (isLive && !liveAcknowledged);
  const selected = !disabled && selectedKeys.has(item.key);
  const stateClass = item.disabledReason ? ` is-${item.disabledReason}` : '';
  const liveClass = isLive ? ' is-live-program' : '';
  const state = disabledLabel(item.disabledReason);
  return `<label class="mc-target-picker-choice${stateClass}${liveClass}"${disabled ? ' aria-disabled="true"' : ''}>
    <input type="${selectionType}" name="${esc(radioName)}" value="${esc(item.key)}"
      data-target-key="${esc(item.key)}"${selected ? ' checked' : ''}${disabled ? ' disabled' : ''}>
    <span class="mc-target-picker-choice-body">
      <span class="mc-target-picker-choice-heading">
        <strong>${esc(item.target.name)}</strong>
        <span class="mc-target-picker-status ${targetHasOnlineMember(item.target) ? 'is-online' : 'is-offline'}">
          <span aria-hidden="true"></span>${esc(statusLabel(item.target))}
        </span>
      </span>
      <span class="mc-target-picker-meta">${esc(targetMeta(item.target))}</span>
      ${renderMemberTopology(item.target)}
      ${state ? `<span class="mc-target-picker-reason">${esc(state)}</span>` : ''}
    </span>
  </label>`;
}

function sectionTitle(kind) {
  return t(`mc.target_picker.section_${kind.replace('-', '_')}`);
}

/** Render the dialog body separately so behavior and accessibility can be tested without a browser. */
export function renderTargetPickerContent(model, state = {}) {
  const titleId = state.titleId || 'mcTargetPickerTitle';
  const selectedKeys = state.selectedKeys instanceof Set ? state.selectedKeys : model.initialSelection;
  const selectionHint = model.selection === 'single'
    ? t('mc.target_picker.hint_single')
    : t('mc.target_picker.hint_multiple');
  const physicalSections = model.sections.map((section) => `
    <section class="mc-target-picker-section" aria-labelledby="${esc(titleId)}-${esc(section.kind)}">
      <h4 id="${esc(titleId)}-${esc(section.kind)}">${esc(sectionTitle(section.kind))}</h4>
      <div class="mc-target-picker-grid">
        ${section.targets.map((item) => renderChoice(item, model, selectedKeys, { ...state, radioName: `${titleId}-selection` })).join('')}
      </div>
    </section>`).join('');
  const liveSection = model.liveProgram ? `
    <section class="mc-target-picker-section mc-target-picker-live" aria-labelledby="${esc(titleId)}-live">
      <h4 id="${esc(titleId)}-live">${esc(t('mc.target_picker.section_live'))}</h4>
      <p class="mc-target-picker-live-warning" id="${esc(titleId)}-live-warning">
        <span aria-hidden="true">●</span> ${esc(t('mc.target_picker.live_warning'))}
      </p>
      <label class="mc-target-picker-live-guard">
        <input type="checkbox" data-target-live-guard aria-describedby="${esc(titleId)}-live-warning"
          ${state.liveAcknowledged ? 'checked' : ''}>
        <span>${esc(t('mc.target_picker.live_guard'))}</span>
      </label>
      <div class="mc-target-picker-grid">
        ${renderChoice(model.liveProgram, model, selectedKeys, { ...state, radioName: `${titleId}-selection` })}
      </div>
    </section>` : '';
  const empty = !physicalSections && !liveSection
    ? `<p class="mc-target-picker-empty">${esc(t('mc.target_picker.empty'))}</p>`
    : '';
  return `<div class="mc-dialog-card mc-target-picker-card">
    <header class="mc-target-picker-header">
      <h3 id="${esc(titleId)}" class="mc-dialog-title">${esc(t('mc.target_picker.title'))}</h3>
      <p class="mc-dialog-msg">${esc(t('mc.target_picker.message'))}</p>
      <p class="mc-target-picker-hint">${esc(selectionHint)}</p>
    </header>
    <div class="mc-target-picker-scroll">${physicalSections}${liveSection}${empty}</div>
    <p class="mc-target-picker-error" role="alert" ${state.showError ? '' : 'hidden'}>
      ${esc(t('mc.target_picker.pick_one'))}
    </p>
    <div class="mc-dialog-actions">
      <button type="button" class="mc-btn mc-btn-ghost" data-target-cancel>${esc(t('mc.target_picker.cancel'))}</button>
      <button type="button" class="mc-btn mc-btn-primary" data-target-continue>${esc(t('mc.target_picker.continue'))}</button>
    </div>
  </div>`;
}

export function buildTargetSelectionResult(catalog, selectedTargets = []) {
  const references = [];
  const resolvedTargets = [];
  const seen = new Set();
  for (const selected of selectedTargets) {
    const reference = parseReference(selected);
    const key = targetKey(reference);
    if (!reference || !key || seen.has(key)) continue;
    const target = findCatalogTarget(catalog, reference);
    if (!target) continue;
    seen.add(key);
    references.push(targetReference(target));
    resolvedTargets.push(target);
  }
  const liveProgram = resolvedTargets.find((target) => target.type === 'live-program') || null;
  return {
    references,
    targets: resolvedTargets,
    deviceIds: expandTargetsToDeviceIds(references, catalog),
    liveProgram,
    includesLiveProgram: liveProgram !== null,
  };
}

/**
 * Open the reusable authoritative destination picker.
 * Resolves to a typed selection result or null when the operator cancels.
 */
export function openTargetPicker(options = {}) {
  if (typeof document === 'undefined' || !document.body) return Promise.resolve(null);
  const model = createTargetPickerModel(options);
  const dialog = document.createElement('dialog');
  const titleId = `mcTargetPickerTitle-${++dialogSequence}`;
  const selectedKeys = new Set(model.initialSelection);
  let liveAcknowledged = false;
  let showError = false;
  let settled = false;

  dialog.className = 'mc-dialog mc-target-picker';
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  document.body.appendChild(dialog);

  function render(focusKey = '') {
    dialog.innerHTML = renderTargetPickerContent(model, {
      titleId,
      selectedKeys,
      liveAcknowledged,
      showError,
    });
    if (focusKey) {
      [...dialog.querySelectorAll('[data-target-key]')]
        .find((element) => element.dataset.targetKey === focusKey)
        ?.focus();
    }
  }

  function cleanup() {
    dialog.removeEventListener('change', onChange);
    dialog.removeEventListener('click', onClick);
    dialog.removeEventListener('cancel', onCancel);
    dialog.removeEventListener('close', onClose);
    try { if (dialog.open) dialog.close(); } catch { /* browser already closed it */ }
    dialog.remove();
  }

  let resolvePromise;
  function finish(value) {
    if (settled) return;
    settled = true;
    cleanup();
    resolvePromise(value);
  }

  function onCancel(event) {
    event.preventDefault();
    finish(null);
  }

  function onClose() {
    finish(null);
  }

  function onChange(event) {
    const element = event.target;
    if (element?.matches?.('[data-target-live-guard]')) {
      liveAcknowledged = element.checked === true;
      if (!liveAcknowledged && model.liveProgram) selectedKeys.delete(model.liveProgram.key);
      showError = false;
      render(model.liveProgram?.key || '');
      return;
    }
    if (!element?.matches?.('[data-target-key]')) return;
    if (model.selection === 'single') selectedKeys.clear();
    if (element.checked) selectedKeys.add(element.dataset.targetKey);
    else selectedKeys.delete(element.dataset.targetKey);
    showError = false;
  }

  function onClick(event) {
    if (event.target === dialog) {
      finish(null);
      return;
    }
    if (event.target.closest?.('[data-target-cancel]')) {
      finish(null);
      return;
    }
    if (!event.target.closest?.('[data-target-continue]')) return;
    if (!selectedKeys.size) {
      showError = true;
      render();
      dialog.querySelector('[role="alert"]')?.focus?.();
      return;
    }
    finish(buildTargetSelectionResult(model.catalog, [...selectedKeys]));
  }

  render();
  dialog.addEventListener('change', onChange);
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('cancel', onCancel);
  dialog.addEventListener('close', onClose);

  return new Promise((resolve) => {
    resolvePromise = resolve;
    try { dialog.showModal(); } catch { finish(null); }
  });
}
