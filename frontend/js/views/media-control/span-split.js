// span-split.js — the Command Center "Span | Split" layout toggle shown under the
// canvas for VIDEO WALL targets only. Toggles the wall's layout_mode via the
// existing setWallMode() path (host view persists + reloads + repaints). Because
// span/split re-arranges the physical screens, switching is gated by a confirm
// when content is currently assigned to the wall.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { confirmDialog } from '../../components/confirm.js';

/**
 * @param {HTMLElement} hostEl
 * @param {object} opts
 * @param {()=>object|null} opts.getActiveTarget
 * @param {()=>object|null} opts.getActiveWall   the wall object for the active target
 * @param {(wallId:string, mode:string)=>void|Promise<void>} opts.onSetWallMode
 * @param {(wall:object)=>boolean} [opts.hasContent] content currently assigned to the wall?
 * @returns {{ repaint: ()=>void }}
 */
export function mountSpanSplit(hostEl, { getActiveTarget, getActiveWall, onSetWallMode, onSetWallLayout, hasContent } = {}) {
  if (!hostEl) return { repaint() {} };
  hostEl.innerHTML = `
    <div class="mc-span-split" role="group" aria-label="${esc(t('mc.cc.span'))} / ${esc(t('mc.cc.split'))}" hidden>
      <button type="button" class="mc-ss-btn" data-ss-mode="span" aria-pressed="false">${esc(t('mc.cc.span'))}</button>
      <button type="button" class="mc-ss-btn" data-ss-mode="split" aria-pressed="false">${esc(t('mc.cc.split'))}</button>
      <button type="button" class="mc-ss-btn mc-ss-preset" data-layout-preset="span-left" hidden>[ 1 + 2 ] [ 3 ]</button>
      <button type="button" class="mc-ss-btn mc-ss-preset" data-layout-preset="span-right" hidden>[ 1 ] [ 2 + 3 ]</button>
    </div>`;
  const wrap = hostEl.querySelector('.mc-span-split');
  const spanBtn = wrap.querySelector('[data-ss-mode="span"]');
  const splitBtn = wrap.querySelector('[data-ss-mode="split"]');

  function repaint() {
    const tgt = getActiveTarget && getActiveTarget();
    if (!tgt || tgt.type !== 'wall') { wrap.hidden = true; return; }
    const wall = getActiveWall && getActiveWall();
    if (!wall) { wrap.hidden = true; return; }
    wrap.hidden = false;
    const mode = wall.layout_mode === 'split' ? 'split' : 'span';
    spanBtn.classList.toggle('is-active', mode === 'span');
    spanBtn.setAttribute('aria-pressed', mode === 'span' ? 'true' : 'false');
    splitBtn.classList.toggle('is-active', mode === 'split');
    splitBtn.setAttribute('aria-pressed', mode === 'split' ? 'true' : 'false');
    wrap.querySelectorAll('[data-layout-preset]').forEach((button) => {
      button.hidden = (wall.devices || []).length !== 3;
      const groups = wall.layout && wall.layout.groups || [];
      const signature = groups.map((group) => group.member_ids.length).join('+');
      const activePreset = button.dataset.layoutPreset === 'span-left' ? signature === '2+1' : signature === '1+2';
      button.classList.toggle('is-active', activePreset && wall.layout_mode === 'groups');
      button.setAttribute('aria-pressed', activePreset && wall.layout_mode === 'groups' ? 'true' : 'false');
    });
  }

  async function onClick(mode) {
    const tgt = getActiveTarget && getActiveTarget();
    if (!tgt || tgt.type !== 'wall') return;
    const wall = getActiveWall && getActiveWall();
    if (!wall || wall.layout_mode === mode) return;
    if (typeof hasContent === 'function' && hasContent(wall)) {
      const ok = await confirmDialog({
        title: `${t('mc.cc.span')} / ${t('mc.cc.split')}`,
        message: t('mc.cc.confirm.switch_mode'),
        confirmLabel: mode === 'split' ? t('mc.cc.split') : t('mc.cc.span'),
        tone: 'default',
      });
      if (!ok) return;
    }
    if (typeof onSetWallMode === 'function') {
      try { await onSetWallMode(wall.id, mode); } catch { /* best-effort; host toasts */ }
    }
    repaint();
  }

  spanBtn.addEventListener('click', () => onClick('span'));
  splitBtn.addEventListener('click', () => onClick('split'));
  wrap.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-layout-preset]');
    if (!button) return;
    const wall = getActiveWall && getActiveWall();
    if (!wall || typeof onSetWallLayout !== 'function') return;
    if (typeof hasContent === 'function' && hasContent(wall)) {
      const ok = await confirmDialog({
        title: 'Layout groups',
        message: t('mc.cc.confirm.switch_mode'),
        confirmLabel: 'Apply layout',
        tone: 'default',
      });
      if (!ok) return;
    }
    await onSetWallLayout(wall.id, button.dataset.layoutPreset, wall.layout?.revision || 0);
    repaint();
  });

  return { repaint };
}
