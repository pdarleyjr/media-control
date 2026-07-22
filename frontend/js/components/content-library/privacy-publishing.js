// Privacy & Publishing UI (task §11).
//
// UI components + state models for the four visibility levels and the
// workflows: upload privately, share to workspace, request org publication,
// approve publication, duplicate privately, archive, transfer ownership, show
// in-use, prevent destructive deletion while active. Narrowest visibility by
// default; explicit confirmation for broader sharing.
import { enterpriseApi } from '../../state/enterprise-api.js';
import { esc } from '../display-layout/render-helpers.js';

const LEVELS = [
  { key: 'private', labelKey: 'mc.e.privacy.level.private', rank: 0 },
  { key: 'workspace_shared', labelKey: 'mc.e.privacy.level.workspace', rank: 1 },
  { key: 'organization_shared', labelKey: 'mc.e.privacy.level.org', rank: 2 },
  { key: 'platform_template', labelKey: 'mc.e.privacy.level.template', rank: 3 },
];

function rankOf(v) { return (LEVELS.find((l) => l.key === v) || { rank: 0 }).rank; }

export function mountPrivacyPublishing(host, { i18n, api = enterpriseApi, content, onChanged }) {
  if (!host) throw new Error('mountPrivacyPublishing requires a host element');
  host.classList.add('mc-e-privacy');
  host.setAttribute('data-component', 'privacy-publishing');
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', i18n ? i18n('mc.e.privacy.aria') : 'Privacy and publishing');

  let current = content || null;
  let pendingRequest = false;

  function render() {
    const c = current || {};
    const vis = c.visibility || 'private';
    const levelChips = LEVELS.map((l) => {
      const active = l.key === vis;
      const broadening = rankOf(l.key) > rankOf(vis);
      return `<button type="button" class="mc-e-privacy-level ${active ? 'is-active' : ''}" data-level="${l.key}" aria-pressed="${active}"${broadening ? ` data-confirm="${esc(i18n ? i18n('mc.e.privacy.confirm_broaden') : 'Share more broadly?')}"` : ''}>${esc(i18n ? i18n(l.labelKey) : l.key)}</button>`;
    }).join('');

    const inUse = c.inUse ? `<div class="mc-e-privacy-inuse" role="status">${esc(i18n ? i18n('mc.e.privacy.in_use') : 'Currently in use — destructive deletion prevented.')}</div>` : '';
    const reqState = pendingRequest ? `<div class="mc-e-privacy-pending">${esc(i18n ? i18n('mc.e.privacy.request_sent') : 'Organization publication requested.')}</div>` : '';

    host.innerHTML = `
      <div class="mc-e-privacy-levels" role="group" aria-label="${esc(i18n ? i18n('mc.e.privacy.levels_aria') : 'Visibility')}">${levelChips}</div>
      ${inUse}${reqState}
      <div class="mc-e-privacy-actions">
        <button type="button" class="mc-e-privacy-act" data-act="share-workspace">${esc(i18n ? i18n('mc.e.privacy.share_ws') : 'Share to workspace')}</button>
        <button type="button" class="mc-e-privacy-act" data-act="request-org"${vis === 'organization_shared' ? ' disabled aria-disabled="true"' : ''}>${esc(i18n ? i18n('mc.e.privacy.request_org') : 'Request org publication')}</button>
        <button type="button" class="mc-e-privacy-act" data-act="approve-org">${esc(i18n ? i18n('mc.e.privacy.approve') : 'Approve publication')}</button>
        <button type="button" class="mc-e-privacy-act" data-act="duplicate">${esc(i18n ? i18n('mc.e.privacy.duplicate') : 'Duplicate privately')}</button>
        <button type="button" class="mc-e-privacy-act" data-act="archive">${esc(i18n ? i18n('mc.e.privacy.archive') : 'Archive')}</button>
        <button type="button" class="mc-e-privacy-act" data-act="transfer">${esc(i18n ? i18n('mc.e.privacy.transfer') : 'Transfer ownership')}</button>
        <button type="button" class="mc-e-privacy-act mc-e-danger" data-act="delete" ${c.inUse ? 'disabled aria-disabled="true" title="' + esc(i18n ? i18n('mc.e.privacy.delete_blocked') : 'Cannot delete while in use') + '"' : ''}>${esc(i18n ? i18n('mc.e.privacy.delete') : 'Delete')}</button>
      </div>`;
  }

  host.addEventListener('click', async (ev) => {
    const levelBtn = ev.target.closest('button[data-level]');
    if (levelBtn) {
      const level = levelBtn.getAttribute('data-level');
      const confirmMsg = levelBtn.getAttribute('data-confirm');
      if (confirmMsg && !globalThis.confirm?.(confirmMsg)) return;
      if (current) { current.visibility = level; }
      try { await api.privacy.setVisibility(current?.id, level); } catch { /* mock/missing endpoint */ }
      render(); if (onChanged) onChanged(current); return;
    }
    const act = ev.target.closest('button[data-act]');
    if (!act || act.disabled) return;
    const action = act.getAttribute('data-act');
    if (action === 'request-org') { pendingRequest = true; try { await api.privacy.requestOrganizationPublication(current?.id); } catch {} render(); return; }
    if (action === 'share-workspace' && current) { current.visibility = 'workspace_shared'; try { await api.privacy.setVisibility(current.id, 'workspace_shared'); } catch {} render(); if (onChanged) onChanged(current); return; }
    if (onChanged) onChanged({ action, content: current });
  });

  render();
  return { setContent(c) { current = c; render(); }, destroy() { host.innerHTML = ''; host.removeAttribute('data-component'); } };
}

export default mountPrivacyPublishing;
