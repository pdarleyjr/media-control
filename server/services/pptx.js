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
const {
  DECK_VERSIONS,
  SOURCE_SPEC,
  getProfile,
  getLayout,
  validateDeck,
} = require('../lib/presentation-template-registry');
const { getTemplateAssets } = require('../lib/presentation-template-assets');
const { pptxTextStyle } = require('../lib/presentation-style-contract');
const { resolveStoredContentFile } = require('../lib/trusted-content-file');

// Defense in depth: pptxgenjs uses image-size internally, so disable every
// parser named by the upstream infinite-loop advisories before pptxgenjs loads.
// Media Control only accepts the safe raster formats in PPTX_IMAGE_MIME below.
const { disableTypes, imageSize } = require('image-size');
disableTypes(['heif', 'icns', 'jxl', 'jxl-stream']);

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
// Keep parity with the presentation asset uploader. In particular, do not pass
// ICNS/JXL/HEIF bytes to pptxgenjs' transitive image-size parser: those formats
// currently have upstream infinite-loop advisories and are not slide formats.
const PPTX_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp']);
const PPTX_IMAGE_TYPE = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/bmp', 'bmp'],
]);
const PPTX_VIDEO_MIME = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const PPTX_AUDIO_MIME = new Set(['audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/ogg']);
const PPTX_READY_STATES = new Set(['uploaded', 'ready', 'completed']);

function pct(v, d) { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(100, n)) : d; }

// Resolve a slide image's content row → a data URI we can embed in the pptx.
// Async (fs.promises) so a deck with many/large images doesn't block the event
// loop — this runs in the background sync path.
async function contentAsset(contentId, allowedContentIds) {
  try {
    if (!(allowedContentIds instanceof Set) || !allowedContentIds.has(String(contentId))) return null;
    const c = db.prepare('SELECT filepath, mime_type, processing_status FROM content WHERE id = ?').get(contentId);
    if (!c || !c.filepath || !PPTX_READY_STATES.has(String(c.processing_status || 'uploaded').toLowerCase())) return null;
    const safe = resolveStoredContentFile(config.contentDir, c.filepath);
    if (!safe) return null;
    return { path: safe, mime: String(c.mime_type || '').toLowerCase() };
  } catch { return null; }
}

async function imageData(asset) {
  if (!asset || !PPTX_IMAGE_MIME.has(asset.mime)) return null;
  const buf = await fs.promises.readFile(asset.path).catch(() => null);
  if (!buf) return null;
  const detected = imageSize(buf);
  if (detected.type !== PPTX_IMAGE_TYPE.get(asset.mime)) {
    throw new Error(`Presentation image bytes do not match ${asset.mime}`);
  }
  return `data:${asset.mime};base64,${buf.toString('base64')}`;
}

async function addImages(slide, images, layer, resolveContentAsset) {
  const list = (Array.isArray(images) ? images : []).filter((im) => (im.layer === 'back' ? 'back' : 'front') === layer);
  for (const im of list) {
    const asset = im.content_id ? await resolveContentAsset(im.content_id) : null;
    const data = await imageData(asset);
    if (!data) continue;
    const x = (pct(im.x, 0) / 100) * W;
    const y = (pct(im.y, 0) / 100) * H;
    // Guard against a 0-dimension box (manual/AI deck); pptxgenjs dislikes 0 w/h.
    const w = (Math.max(1, pct(im.w, 40)) / 100) * W;
    const h = (Math.max(1, pct(im.h, 40)) / 100) * H;
    const opt = {
      data, x, y, w, h,
      sizing: { type: im.fit === 'cover' ? 'cover' : 'contain', w, h },
    };
    // NB: pptxgenjs `rounding:true` crops to a CIRCLE (not rounded corners), so we
    // deliberately don't map `im.rounded` here — it's a screen-only aesthetic.
    if (im.shadow) opt.shadow = { type: 'outer', blur: 8, offset: 4, angle: 90, color: '000000', opacity: 0.55 };
    const op = (im.opacity != null && isFinite(Number(im.opacity))) ? Math.max(0, Math.min(1, Number(im.opacity))) : 1;
    if (op < 1) opt.transparency = Math.round((1 - op) * 100);
    slide.addImage(opt);
  }
}

function hex(color, fallback) {
  const value = String(color || '').replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(value) ? value : fallback;
}

function v2TextStyle(name) {
  return pptxTextStyle(name);
}

function addV2StaticObjects(slide, namedObjects, deck, slideNumber, templateAssets) {
  const colors = SOURCE_SPEC.theme.colors;
  for (const [name, object] of Object.entries(namedObjects)) {
    const box = object.bbox_in;
    if (!box) continue;
    if (/BACKGROUND$/.test(name)) {
      slide.addShape('rect', { ...box, line: { color: hex(colors.navy_1, '031A33'), transparency: 100 }, fill: { color: hex(colors.navy_1, '031A33') } });
    } else if (/PANEL$/.test(name)) {
      slide.addShape('roundRect', { ...box, rectRadius: 0.06, line: { color: hex(colors.blue, '0B385E'), transparency: 35 }, fill: { color: hex(colors.panel, '041F39') } });
    } else if (/TAKEAWAY_BOX|SLIDE_NUMBER_BLOCK/.test(name)) {
      slide.addShape('roundRect', { ...box, line: { color: hex(colors.gold, 'E8B33D'), transparency: 25 }, fill: { color: hex(colors.blue, '0B385E') } });
    }
  }
  for (const name of ['GLOBAL_MBFD_LOGO', 'GLOBAL_MBFD_WATERMARK']) {
    const object = namedObjects[name];
    const asset = templateAssets && templateAssets.get(name);
    if (!object?.bbox_in || !asset) continue;
    slide.addImage({
      data: `data:${asset.mime};base64,${asset.buffer.toString('base64')}`,
      ...object.bbox_in,
    });
  }
  const globals = {
    GLOBAL_HEADER_MIAMI_BEACH: 'MIAMI BEACH',
    GLOBAL_HEADER_FIRE_DEPARTMENT: 'FIRE DEPARTMENT',
    GLOBAL_FOOTER_MARK: '✦',
    GLOBAL_COURSE_SECTION: String(deck.course_section || 'COURSE / SECTION'),
    GLOBAL_PRESENTATION_TITLE: String(deck.title || ''),
    GLOBAL_SLIDE_LABEL: 'SLIDE #',
    GLOBAL_SLIDE_NUMBER: String(slideNumber).padStart(2, '0'),
  };
  for (const [name, text] of Object.entries(globals)) {
    const object = namedObjects[name];
    if (!object || !object.bbox_in) continue;
    const style = v2TextStyle(name);
    if (name === 'GLOBAL_HEADER_MIAMI_BEACH') Object.assign(style, { fontFace: SOURCE_SPEC.theme.font_heading, bold: true, fontSize: 17 });
    if (name === 'GLOBAL_HEADER_FIRE_DEPARTMENT') Object.assign(style, { fontFace: SOURCE_SPEC.theme.font_heading, bold: true, fontSize: 22 });
    if (name === 'GLOBAL_FOOTER_MARK') Object.assign(style, { color: hex(colors.gold, 'E8B33D'), fontSize: 19 });
    slide.addText(text, { ...object.bbox_in, ...style });
  }
}

async function addV2Value(slide, name, object, value, resolveContentAsset) {
  if (value == null || value === '') return;
  const box = object.bbox_in;
  if (!box) return;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (value.type === 'table' && Array.isArray(value.rows) && value.rows.length) {
      slide.addTable(value.rows.map((row) => (Array.isArray(row) ? row.map(String) : [String(row)])), {
        ...box,
        ...v2TextStyle(name),
        color: hex(SOURCE_SPEC.theme.colors.white, WHITE),
        border: { type: 'solid', color: hex(SOURCE_SPEC.theme.colors.blue, '0B385E'), pt: 1 },
        fill: hex(SOURCE_SPEC.theme.colors.panel, '041F39'),
        margin: 0.06,
      });
      return;
    }
    if (['image', 'media', 'video', 'audio'].includes(value.type) && value.content_id) {
      const asset = await resolveContentAsset(value.content_id);
      const data = await imageData(asset);
      if (data && (value.type === 'image' || value.type === 'media')) {
        slide.addImage({ data, ...box, sizing: { type: value.fit === 'cover' ? 'cover' : 'contain', w: box.w, h: box.h } });
        return;
      }
      const mediaType = PPTX_VIDEO_MIME.has(asset?.mime) ? 'video' : (PPTX_AUDIO_MIME.has(asset?.mime) ? 'audio' : null);
      if (asset && mediaType && (value.type === mediaType || value.type === 'media')) {
        try {
          slide.addMedia({ type: mediaType, path: asset.path, ...box, objectName: String(value.caption || `${mediaType} media`) });
          return;
        } catch { /* keep an editable, visible fallback instead of dropping the object */ }
      }
    }
    const label = value.caption || value.url || (value.type ? `[${value.type}]` : '');
    if (label) {
      const opts = { ...box, ...v2TextStyle(name), align: 'center', color: hex(SOURCE_SPEC.theme.colors.white, WHITE) };
      if (value.url && /^https?:\/\//i.test(value.url)) opts.hyperlink = { url: value.url };
      slide.addText(String(label), opts);
    }
    return;
  }
  slide.addText(String(value), { ...box, ...v2TextStyle(name) });
}

async function renderV2DeckToPptxBuffer(deck, options = {}) {
  const validation = validateDeck(deck);
  if (!validation.valid) throw new Error(`Cannot export invalid mbfd-deck-v2: ${validation.errors.join('; ')}`);
  const profile = getProfile(deck.wall_profile);
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  const layoutName = deck.wall_profile.replace(/[^A-Za-z0-9]/g, '_').toUpperCase();
  pptx.defineLayout({ name: layoutName, width: profile.canvas_in.w, height: profile.canvas_in.h });
  pptx.layout = layoutName;
  pptx.author = 'MBFD Media Control Presentation Studio';
  pptx.company = 'Miami Beach Fire Department';
  pptx.subject = `MBFD Videowall ${profile.source_key}`;
  pptx.title = String(deck.title || 'Presentation');
  pptx.lang = 'en-US';
  const templateAssets = await getTemplateAssets(deck.wall_profile);
  const allowedContentIds = options.allowedContentIds instanceof Set
    ? options.allowedContentIds
    : new Set(Array.isArray(options.allowedContentIds) ? options.allowedContentIds.map(String) : []);
  const resolveContentAsset = options.resolveContentAsset || ((contentId) => contentAsset(contentId, allowedContentIds));
  for (let index = 0; index < deck.slides.length; index += 1) {
    const deckSlide = deck.slides[index];
    const layout = getLayout(deck.wall_profile, deckSlide.template_id);
    const slide = pptx.addSlide();
    slide.background = { color: hex(SOURCE_SPEC.theme.colors.navy_1, '031A33') };
    addV2StaticObjects(slide, layout.named_objects, deck, index + 1, templateAssets);
    for (const [name, value] of Object.entries(deckSlide.slots || {})) {
      if (name.startsWith('GLOBAL_')) continue;
      await addV2Value(slide, name, layout.named_objects[name], value, resolveContentAsset);
    }
    if (deckSlide.speaker_notes) {
      try { slide.addNotes(String(deckSlide.speaker_notes)); } catch { /* notes remain optional for old PptxGenJS */ }
    }
  }
  if (!deck.slides.length) {
    const slide = pptx.addSlide();
    slide.background = { color: hex(SOURCE_SPEC.theme.colors.navy_1, '031A33') };
    slide.addText('Empty presentation', { x: 1, y: 4.2, w: profile.canvas_in.w - 2, h: 1, align: 'center', fontFace: SOURCE_SPEC.theme.font_body, fontSize: 24, color: hex(SOURCE_SPEC.theme.colors.white, WHITE) });
  }
  return pptx.write({ outputType: 'nodebuffer' });
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
async function renderDeckToPptxBuffer(deck, options = {}) {
  if (deck && deck.version === DECK_VERSIONS.V2) return renderV2DeckToPptxBuffer(deck, options);
  const PptxGenJS = require('pptxgenjs');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'MBFD Media Control Studio';
  pptx.company = 'Miami Beach Fire Department';
  pptx.title = String(deck && deck.title || 'Presentation');
  const slides = (deck && Array.isArray(deck.slides)) ? deck.slides : [];
  const allowedContentIds = options.allowedContentIds instanceof Set
    ? options.allowedContentIds
    : new Set(Array.isArray(options.allowedContentIds) ? options.allowedContentIds.map(String) : []);
  const resolveContentAsset = options.resolveContentAsset || ((contentId) => contentAsset(contentId, allowedContentIds));
  if (!slides.length) {
    const s = pptx.addSlide(); s.background = { color: SLATE };
    s.addText('Empty presentation', { x: MX, y: 3.2, w: TEXT_W, h: 1, color: MUTED, fontSize: 28, align: 'center', fontFace: FONT });
  }
  for (const sl of slides) {
    const slide = pptx.addSlide();
    slide.background = { color: SLATE };
    await addImages(slide, sl.images, 'back', resolveContentAsset); // behind text
    addText(slide, sl, deck.title);
    await addImages(slide, sl.images, 'front', resolveContentAsset); // in front of text
    if (sl.speaker_notes) { try { slide.addNotes(String(sl.speaker_notes)); } catch { /* notes optional */ } }
  }
  // nodebuffer output (no filesystem write).
  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { renderDeckToPptxBuffer, renderV2DeckToPptxBuffer };
