// MBFD Media Control Studio — PPTX renderer (server-side, NO browser/Chromium).
// Converts an mbfd-deck-v1 deck into a .pptx Buffer with pptxgenjs. Images placed
// on slides (slide.images[]) are embedded as base64 from the local content files,
// positioned with the SAME % coordinates the editor/player use (% of a 16:9 stage
// → inches on a 13.33×7.5 widescreen slide). Used by services/nextcloud-sync.js to
// push each saved presentation into the building user's own Nextcloud Files.

const fs = require('fs');
const path = require('path');
const config = require('../config');
const { db } = require('../db/database');

const W = 13.333; // LAYOUT_WIDE inches
const H = 7.5;
const MX = 1.0;   // horizontal text margin (~8%)
const TEXT_W = W - MX * 2;

const SLATE = '0F172A';
const RED = 'DC2626';
const WHITE = 'F8FAFC';
const MUTED = 'CBD5E1';
const BODY = 'E2E8F0';
const FONT = 'Segoe UI';

function pct(v, d) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(100, n)) : d; }

// Resolve a slide image's content row → a data URI we can embed in the pptx.
function imageData(contentId) {
  try {
    const c = db.prepare('SELECT filepath, mime_type FROM content WHERE id = ?').get(contentId);
    if (!c || !c.filepath || !c.mime_type || !c.mime_type.startsWith('image/')) return null;
    const safe = path.resolve(config.contentDir, path.basename(c.filepath));
    if (!safe.startsWith(path.resolve(config.contentDir)) || !fs.existsSync(safe)) return null;
    const b64 = fs.readFileSync(safe).toString('base64');
    return `data:${c.mime_type};base64,${b64}`;
  } catch { return null; }
}

function addImages(slide, images, layer) {
  (Array.isArray(images) ? images : []).filter((im) => (im.layer === 'back' ? 'back' : 'front') === layer).forEach((im) => {
    const data = im.content_id ? imageData(im.content_id) : null;
    if (!data) return;
    const x = (pct(im.x, 0) / 100) * W;
    const y = (pct(im.y, 0) / 100) * H;
    const w = (pct(im.w, 40) / 100) * W;
    const h = (pct(im.h, 40) / 100) * H;
    const opt = {
      data, x, y, w, h,
      sizing: { type: im.fit === 'cover' ? 'cover' : 'contain', w, h },
    };
    if (im.rounded) opt.rounding = true;
    if (im.shadow) opt.shadow = { type: 'outer', blur: 8, offset: 4, angle: 90, color: '000000', opacity: 0.55 };
    const op = (im.opacity != null && isFinite(Number(im.opacity))) ? Math.max(0, Math.min(1, Number(im.opacity))) : 1;
    if (op < 1) opt.transparency = Math.round((1 - op) * 100);
    slide.addImage(opt);
  });
}

function addText(slide, s, deckTitle) {
  const layout = s.layout || 'content';
  const bullets = Array.isArray(s.bullets) ? s.bullets : [];
  if (layout === 'title') {
    slide.addText('MEDIA CONTROL STUDIO', { x: MX, y: 2.4, w: TEXT_W, h: 0.5, color: RED, bold: true, fontSize: 14, charSpacing: 2, fontFace: FONT });
    slide.addText(String(s.title || ''), { x: MX, y: 2.85, w: TEXT_W, h: 1.8, color: WHITE, bold: true, fontSize: 44, fontFace: FONT, valign: 'top' });
    if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 4.7, w: TEXT_W, h: 1.0, color: MUTED, fontSize: 22, fontFace: FONT });
  } else if (layout === 'section') {
    slide.addShape('rect', { x: W / 2 - 0.66, y: 2.6, w: 1.33, h: 0.09, fill: { color: RED } });
    slide.addText(String(s.title || ''), { x: MX, y: 2.9, w: TEXT_W, h: 1.5, color: WHITE, bold: true, fontSize: 40, align: 'center', fontFace: FONT });
    if (s.subtitle) slide.addText(String(s.subtitle), { x: MX, y: 4.4, w: TEXT_W, h: 1.0, color: MUTED, fontSize: 22, align: 'center', fontFace: FONT });
  } else if (layout === 'quote') {
    slide.addText('“' + String(s.body || s.title || '') + '”', { x: MX, y: 2.4, w: TEXT_W, h: 2.5, color: WHITE, italic: true, bold: true, fontSize: 32, align: 'center', fontFace: FONT });
    if (s.subtitle) slide.addText('— ' + String(s.subtitle), { x: MX, y: 5.0, w: TEXT_W, h: 0.8, color: MUTED, fontSize: 20, align: 'center', fontFace: FONT });
  } else {
    if (deckTitle) slide.addText(String(deckTitle).toUpperCase(), { x: MX, y: 0.55, w: TEXT_W, h: 0.4, color: RED, bold: true, fontSize: 12, charSpacing: 2, fontFace: FONT });
    slide.addText(String(s.title || ''), { x: MX, y: 1.0, w: TEXT_W, h: 1.0, color: WHITE, bold: true, fontSize: 30, fontFace: FONT });
    if (bullets.length) {
      slide.addText(bullets.map((b) => ({ text: String(b), options: { bullet: { code: '2022' }, breakLine: true } })), {
        x: MX, y: 2.2, w: TEXT_W, h: 4.6, color: WHITE, fontSize: 20, fontFace: FONT, lineSpacingMultiple: 1.3, valign: 'top',
      });
    } else if (s.body) {
      slide.addText(String(s.body), { x: MX, y: 2.2, w: TEXT_W, h: 4.6, color: BODY, fontSize: 20, fontFace: FONT, valign: 'top' });
    }
  }
}

// Render an mbfd-deck-v1 deck to a .pptx Buffer.
async function renderDeckToPptxBuffer(deck) {
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'MBFD Media Control Studio';
  pptx.company = 'Miami Beach Fire Department';
  pptx.title = String(deck && deck.title || 'Presentation');
  const slides = (deck && Array.isArray(deck.slides)) ? deck.slides : [];
  if (!slides.length) {
    const s = pptx.addSlide(); s.background = { color: SLATE };
    s.addText('Empty presentation', { x: MX, y: 3.2, w: TEXT_W, h: 1, color: MUTED, fontSize: 28, align: 'center', fontFace: FONT });
  }
  for (const sl of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: SLATE };
    addImages(slide, sl.images, 'back'); // behind text
    addText(slide, sl, deck.title);
    addImages(slide, sl.images, 'front'); // in front of text
    if (sl.speaker_notes) { try { slide.addNotes(String(sl.speaker_notes)); } catch { /* notes optional */ } }
  }
  // nodebuffer output (no filesystem write).
  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { renderDeckToPptxBuffer };
