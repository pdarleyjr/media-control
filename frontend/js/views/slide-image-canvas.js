// MBFD Media Control Studio — Slide image placement canvas.
// Drag-and-resize editor for images on a single slide. Mutates `slide.images[]`
// in place (the canonical mbfd-deck-v1 placement model) and calls onChange() so
// the parent editor marks the deck dirty. Coordinates are PERCENTAGES of a 16:9
// stage, so they map 1:1 onto a 16:9 display in the deck player regardless of
// resolution. Distortion-free: the box is free-form but the image uses
// object-fit, so resizing never stretches the picture.
//
// CSP-safe: no inline event handlers, no eval; addEventListener + inline style
// attributes only. Pointer events cover mouse AND touch (classroom touch panels).

import { api } from '../api.js';
import { showToast } from '../components/toast.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function rid() {
  // Short, collision-resistant enough for in-deck ids; no Date.now reliance.
  return 'img_' + Math.random().toString(36).slice(2, 10);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// Default placement for a freshly uploaded image: a centered box that matches
// the image's aspect ratio inside the 16:9 stage (so `contain` shows no bars).
function defaultPlacement(natW, natH) {
  let w = 44; // % of stage width
  let h;
  if (natW && natH) {
    // displayed_px_w / displayed_px_h = nat aspect ; box %s are of different dims:
    // h% = w% * (16/9) * (natH/natW)
    h = w * (16 / 9) * (natH / natW);
  } else {
    h = 44 * (16 / 9) * (3 / 4);
  }
  h = clamp(h, 8, 86);
  return { x: clamp((100 - w) / 2, 0, 100), y: clamp((100 - h) / 2, 0, 100), w, h };
}

const CANVAS_BG = 'radial-gradient(120% 120% at 80% 10%, #1E293B 0%, #0F172A 60%, #0B1220 100%)';

// Render the slide's text the way the player does — used as a faint backdrop so
// image placement is WYSIWYG against the real slide content.
function textPreviewHtml(s) {
  const layout = s.layout || 'content';
  const bullets = Array.isArray(s.bullets) ? s.bullets : [];
  if (layout === 'title') {
    return `<div class="mc-cv-col" style="align-items:flex-start">
      <div class="mc-cv-kicker">MEDIA CONTROL STUDIO</div>
      <div class="mc-cv-h1">${esc(s.title || 'Title')}</div>
      ${s.subtitle ? `<div class="mc-cv-sub">${esc(s.subtitle)}</div>` : ''}</div>`;
  }
  if (layout === 'section') {
    return `<div class="mc-cv-col" style="align-items:center;text-align:center">
      <div class="mc-cv-bar"></div><div class="mc-cv-h1">${esc(s.title || 'Section')}</div>
      ${s.subtitle ? `<div class="mc-cv-sub">${esc(s.subtitle)}</div>` : ''}</div>`;
  }
  if (layout === 'quote') {
    return `<div class="mc-cv-col" style="align-items:center;text-align:center">
      <div class="mc-cv-q">"${esc(s.body || s.title || 'Quote')}"</div>
      ${s.subtitle ? `<div class="mc-cv-sub">${esc(s.subtitle)}</div>` : ''}</div>`;
  }
  let inner = `<div class="mc-cv-kicker">${esc(s.title || '')}</div><div class="mc-cv-h2">${esc(s.title || 'Slide')}</div>`;
  if (bullets.length) inner += '<ul class="mc-cv-ul">' + bullets.slice(0, 8).map((b) => `<li>${esc(b)}</li>`).join('') + '</ul>';
  else if (s.body) inner += `<div class="mc-cv-body">${esc(s.body)}</div>`;
  return `<div class="mc-cv-col" style="align-items:flex-start">${inner}</div>`;
}

// One-time stylesheet injection for the canvas chrome (kept out of the global
// CSS files so this module is self-contained; matches the player's slate look).
function ensureStyles() {
  if (document.getElementById('mc-img-canvas-styles')) return;
  const st = document.createElement('style');
  st.id = 'mc-img-canvas-styles';
  st.textContent = `
  .mc-cv-wrap{position:relative;width:100%;aspect-ratio:16/9;border-radius:var(--mc-radius-md,10px);overflow:hidden;
    background:${CANVAS_BG};box-shadow:inset 0 0 0 1px rgba(255,255,255,.06);user-select:none;touch-action:none;container-type:size}
  /* Text sized in cqw so this 16:9 frame is a proportional replica of the player
     (which sizes the same content in vw against a 16:9 viewport). */
  .mc-cv-textlayer{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:6cqh 8cqw;z-index:2;pointer-events:none}
  .mc-cv-col{width:100%;max-width:100cqw;display:flex;flex-direction:column;color:#F8FAFC;font-family:'Plus Jakarta Sans',system-ui,sans-serif}
  .mc-cv-kicker{color:#DC2626;font-weight:700;letter-spacing:.08em;text-transform:uppercase;font-size:1.1cqw;margin-bottom:2.2cqh;min-height:1.1cqw}
  .mc-cv-h1{font-size:5.2cqw;line-height:1.05;font-weight:800;letter-spacing:-.02em}
  .mc-cv-h2{font-size:3.6cqw;line-height:1.1;font-weight:800;margin-bottom:3cqh}
  .mc-cv-sub{font-size:2cqw;color:#CBD5E1;margin-top:2.5cqh;font-weight:500}
  .mc-cv-bar{width:90px;max-width:9cqw;height:.6cqh;min-height:4px;border-radius:3px;background:#DC2626;margin:0 auto 4cqh}
  .mc-cv-q{font-size:3.4cqw;line-height:1.3;font-style:italic;font-weight:600;max-width:80cqw}
  .mc-cv-ul{list-style:none;display:flex;flex-direction:column;gap:1.8cqh;margin-top:1cqh;padding:0}
  .mc-cv-ul li{display:flex;gap:1.2cqw;align-items:flex-start;font-size:2.1cqw;line-height:1.3}
  .mc-cv-ul li::before{content:'';flex:0 0 auto;width:.9cqw;height:.9cqw;border-radius:50%;background:#DC2626;margin-top:1.1cqh}
  .mc-cv-body{font-size:2cqw;line-height:1.5;color:#E2E8F0;max-width:70cqw}
  .mc-imgbox{position:absolute;cursor:move;outline:0 solid transparent;transition:outline-color .1s}
  .mc-imgbox img{width:100%;height:100%;display:block;pointer-events:none}
  .mc-imgbox.sel{outline:2px solid #38BDF8;outline-offset:1px;box-shadow:0 0 0 3px rgba(56,189,248,.25)}
  .mc-imgbox .mc-h{position:absolute;width:16px;height:16px;background:#38BDF8;border:2px solid #fff;border-radius:50%;
    right:-9px;bottom:-9px;cursor:nwse-resize;display:none;touch-action:none}
  .mc-imgbox.sel .mc-h{display:block}
  .mc-cv-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:3;
    color:#94A3B8;font-size:13px;text-align:center;pointer-events:none;padding:0 24px}
  `;
  document.head.appendChild(st);
}

// Build the controller. `slide` is mutated in place. Returns { destroy }.
export function createImageEditor({ mount, slide, presId, onChange }) {
  ensureStyles();
  let selectedId = null;
  let activeMove = null; // teardown fn for an in-flight drag/resize

  function imgs() { return Array.isArray(slide.images) ? slide.images : []; }
  function setImgs(arr) {
    if (arr.length) slide.images = arr;
    else delete slide.images; // keep deck_json clean for image-free slides
  }
  function mark() { if (onChange) onChange(); }

  mount.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
      <button id="mcImgAdd" type="button" style="background:var(--mc-surface);border:1px solid var(--mc-border-medium);border-radius:var(--mc-radius-sm);padding:8px 14px;cursor:pointer;color:var(--mc-text-primary);font-weight:var(--mc-fw-semibold)">＋ Add image</button>
      <span id="mcImgHint" style="font-size:var(--mc-font-size-xs);color:var(--mc-text-tertiary)">Drag to move · drag the corner to resize · drop an image onto the slide</span>
      <input id="mcImgFile" type="file" accept="image/*" style="display:none">
    </div>
    <div class="mc-cv-wrap" id="mcCanvas">
      <div class="mc-cv-textlayer" id="mcText"></div>
      <div class="mc-cv-empty" id="mcEmpty">No images on this slide yet — click <b style="margin:0 4px">＋ Add image</b> or drop a file here.</div>
    </div>
    <div id="mcImgTools" style="margin-top:12px"></div>`;

  const canvas = mount.querySelector('#mcCanvas');
  const textLayer = mount.querySelector('#mcText');
  const emptyHint = mount.querySelector('#mcEmpty');
  const tools = mount.querySelector('#mcImgTools');
  const fileInput = mount.querySelector('#mcImgFile');
  const addBtn = mount.querySelector('#mcImgAdd');

  textLayer.innerHTML = textPreviewHtml(slide);

  function styleFor(im) {
    const r = im.rounded ? 'border-radius:14px;overflow:hidden;' : '';
    const sh = im.shadow ? 'filter:drop-shadow(0 10px 24px rgba(0,0,0,.55));' : '';
    return `left:${im.x}%;top:${im.y}%;width:${im.w}%;height:${im.h}%;opacity:${im.opacity != null ? im.opacity : 1};z-index:${im.layer === 'back' ? 1 : 5};${r}${sh}`;
  }

  function renderBoxes() {
    // Remove existing boxes (keep text + empty layers).
    canvas.querySelectorAll('.mc-imgbox').forEach((n) => n.remove());
    const list = imgs();
    emptyHint.style.display = list.length ? 'none' : 'flex';
    list.forEach((im) => {
      const box = document.createElement('div');
      box.className = 'mc-imgbox' + (im.id === selectedId ? ' sel' : '');
      box.dataset.id = im.id;
      box.setAttribute('style', styleFor(im));
      const pic = document.createElement('img');
      pic.src = im.url;
      pic.alt = '';
      pic.style.objectFit = im.fit === 'cover' ? 'cover' : 'contain';
      box.appendChild(pic);
      const handle = document.createElement('div');
      handle.className = 'mc-h';
      box.appendChild(handle);
      canvas.appendChild(box);
      wireBox(box, im, handle);
    });
  }

  function select(id) { selectedId = id; renderBoxes(); renderTools(); }

  function wireBox(box, im, handle) {
    box.addEventListener('pointerdown', (e) => {
      if (e.target === handle) return; // resize handled separately
      e.preventDefault();
      select(im.id);
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, x0 = im.x, y0 = im.y;
      const onMove = (ev) => {
        const dx = ((ev.clientX - sx) / rect.width) * 100;
        const dy = ((ev.clientY - sy) / rect.height) * 100;
        im.x = clamp(x0 + dx, 0, 100 - im.w);
        im.y = clamp(y0 + dy, 0, 100 - im.h);
        box.style.left = im.x + '%';
        box.style.top = im.y + '%';
      };
      beginDrag(onMove);
    });
    handle.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      select(im.id);
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY, w0 = im.w, h0 = im.h;
      const onMove = (ev) => {
        const dw = ((ev.clientX - sx) / rect.width) * 100;
        const dh = ((ev.clientY - sy) / rect.height) * 100;
        im.w = clamp(w0 + dw, 5, 100 - im.x);
        im.h = clamp(h0 + dh, 5, 100 - im.y);
        box.style.width = im.w + '%';
        box.style.height = im.h + '%';
      };
      beginDrag(onMove);
    });
  }

  function beginDrag(onMove) {
    if (activeMove) activeMove();
    const up = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', up);
      activeMove = null;
      mark();
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', up);
    activeMove = () => { document.removeEventListener('pointermove', onMove); document.removeEventListener('pointerup', up); activeMove = null; };
  }

  // Deselect when clicking empty canvas.
  canvas.addEventListener('pointerdown', (e) => {
    if (e.target === canvas || e.target === textLayer || e.target === emptyHint) { selectedId = null; renderBoxes(); renderTools(); }
  });

  function renderTools() {
    const im = imgs().find((x) => x.id === selectedId);
    if (!im) { tools.innerHTML = ''; return; }
    const chk = (id, label, on) => `<label style="display:inline-flex;align-items:center;gap:6px;font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary);cursor:pointer"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}>${label}</label>`;
    tools.innerHTML = `
      <div class="mc-panel" style="padding:14px;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;gap:16px;flex-wrap:wrap;align-items:center">
          <div style="display:flex;gap:6px">
            <button type="button" id="mcFitContain" class="mc-seg ${im.fit !== 'cover' ? 'on' : ''}">Contain</button>
            <button type="button" id="mcFitCover" class="mc-seg ${im.fit === 'cover' ? 'on' : ''}">Cover</button>
          </div>
          <label style="display:flex;align-items:center;gap:8px;font-size:var(--mc-font-size-sm);color:var(--mc-text-secondary)">Opacity
            <input type="range" id="mcOpacity" min="20" max="100" value="${Math.round((im.opacity != null ? im.opacity : 1) * 100)}" style="vertical-align:middle">
          </label>
          ${chk('mcRounded', 'Rounded', im.rounded)}
          ${chk('mcShadow', 'Shadow', im.shadow)}
          ${chk('mcBehind', 'Behind text', im.layer === 'back')}
        </div>
        <div style="display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid var(--mc-border-light);padding-top:12px">
          <button type="button" id="mcFill" class="mc-seg">⛶ Fill slide</button>
          <button type="button" id="mcCenter" class="mc-seg">⊕ Center</button>
          <button type="button" id="mcReset" class="mc-seg">↺ Reset size</button>
          <button type="button" id="mcDel" class="mc-seg" style="margin-left:auto;color:var(--mc-danger);border-color:var(--mc-border-medium)">🗑 Remove</button>
        </div>
      </div>`;
    // segmented-button styling, scoped inline so we don't depend on global CSS
    tools.querySelectorAll('.mc-seg').forEach((b) => {
      b.style.cssText += ';background:' + (b.classList.contains('on') ? 'var(--mc-live-dim,#FEE2E2)' : 'var(--mc-surface)') +
        ';border:1px solid ' + (b.classList.contains('on') ? 'var(--mc-primary,#DC2626)' : 'var(--mc-border-medium)') +
        ';border-radius:var(--mc-radius-sm);padding:7px 13px;cursor:pointer;color:var(--mc-text-primary);font-weight:var(--mc-fw-semibold);font-size:var(--mc-font-size-sm)';
    });
    const g = (id) => tools.querySelector('#' + id);
    g('mcFitContain').addEventListener('click', () => { im.fit = 'contain'; mark(); renderBoxes(); renderTools(); });
    g('mcFitCover').addEventListener('click', () => { im.fit = 'cover'; mark(); renderBoxes(); renderTools(); });
    g('mcOpacity').addEventListener('input', (e) => { im.opacity = clamp(parseInt(e.target.value, 10) / 100, 0.2, 1); mark(); renderBoxes(); });
    g('mcRounded').addEventListener('change', (e) => { im.rounded = e.target.checked; mark(); renderBoxes(); });
    g('mcShadow').addEventListener('change', (e) => { im.shadow = e.target.checked; mark(); renderBoxes(); });
    g('mcBehind').addEventListener('change', (e) => { im.layer = e.target.checked ? 'back' : 'front'; mark(); renderBoxes(); });
    g('mcFill').addEventListener('click', () => { im.x = 0; im.y = 0; im.w = 100; im.h = 100; mark(); renderBoxes(); });
    g('mcCenter').addEventListener('click', () => { im.x = clamp((100 - im.w) / 2, 0, 100); im.y = clamp((100 - im.h) / 2, 0, 100); mark(); renderBoxes(); });
    g('mcReset').addEventListener('click', () => { const p = defaultPlacement(im.natural_w, im.natural_h); Object.assign(im, p); mark(); renderBoxes(); });
    g('mcDel').addEventListener('click', () => {
      setImgs(imgs().filter((x) => x.id !== im.id));
      selectedId = null; mark(); renderBoxes(); renderTools();
    });
  }

  async function doUpload(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) { showToast('Only image files can be added to slides', 'info'); return; }
    addBtn.disabled = true;
    const prevLabel = addBtn.textContent;
    addBtn.textContent = 'Uploading…';
    try {
      const r = await api.presentations.uploadAsset(presId, file);
      const p = defaultPlacement(r.width, r.height);
      const im = { id: rid(), content_id: r.content_id, url: r.url, natural_w: r.width || null, natural_h: r.height || null,
        x: p.x, y: p.y, w: p.w, h: p.h, fit: 'contain', opacity: 1, rounded: false, shadow: false, layer: 'front' };
      setImgs(imgs().concat([im]));
      mark();
      select(im.id);
      showToast('Image added', 'success');
    } catch (e) {
      showToast(e.message || 'Upload failed', 'error');
    } finally {
      addBtn.disabled = false;
      addBtn.textContent = prevLabel;
    }
  }

  addBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; doUpload(f); });

  // Drag-and-drop onto the canvas.
  ['dragover', 'dragenter'].forEach((ev) => canvas.addEventListener(ev, (e) => { e.preventDefault(); canvas.style.boxShadow = 'inset 0 0 0 2px #38BDF8'; }));
  ['dragleave', 'drop'].forEach((ev) => canvas.addEventListener(ev, (e) => { e.preventDefault(); canvas.style.boxShadow = ''; }));
  canvas.addEventListener('drop', (e) => { const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) doUpload(f); });

  renderBoxes();
  renderTools();

  return {
    destroy() {
      if (activeMove) activeMove();
      mount.innerHTML = '';
    },
  };
}
