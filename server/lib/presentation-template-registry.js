'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_DIR = path.join(__dirname, '..', 'presentation-templates');
const SPEC_PATH = path.join(TEMPLATE_DIR, 'MBFD_Videowall_Template_Spec_v2.json');
const SOURCE_SPEC = Object.freeze(JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8')));

const DECK_VERSIONS = Object.freeze({ V1: 'mbfd-deck-v1', V2: 'mbfd-deck-v2' });
const PROFILE_IDS = Object.freeze({
  TWO_DISPLAY: 'wall-2x4k-7680x2160',
  THREE_DISPLAY: 'wall-3x4k-11520x2160',
});
const SOURCE_PROFILE_KEYS = Object.freeze({
  [PROFILE_IDS.TWO_DISPLAY]: '2-display',
  [PROFILE_IDS.THREE_DISPLAY]: '3-display',
});
const PROFILE_EMU = Object.freeze({
  [PROFILE_IDS.TWO_DISPLAY]: Object.freeze({ w: 32512000, h: 9144000 }),
  [PROFILE_IDS.THREE_DISPLAY]: Object.freeze({ w: 48768000, h: 9144000 }),
});
const PROFILE_TEMPLATE_FILES = Object.freeze({
  [PROFILE_IDS.TWO_DISPLAY]: 'MBFD_Videowall_2Screen_Production_Template_v2.pptx',
  [PROFILE_IDS.THREE_DISPLAY]: 'MBFD_Videowall_3Screen_Production_Template_v2.pptx',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function sourceProfileKey(profileId) {
  const key = SOURCE_PROFILE_KEYS[profileId];
  if (!key) throw new Error(`Unknown presentation wall profile: ${profileId}`);
  return key;
}

function getProfile(profileId) {
  const sourceKey = sourceProfileKey(profileId);
  const source = SOURCE_SPEC.wall_modes[sourceKey];
  return clone({
    id: profileId,
    source_key: sourceKey,
    ...source,
    canvas_emu: PROFILE_EMU[profileId],
    production_template: PROFILE_TEMPLATE_FILES[profileId],
    production_template_path: path.join(TEMPLATE_DIR, PROFILE_TEMPLATE_FILES[profileId]),
  });
}

function listProfiles() {
  return Object.values(PROFILE_IDS).map(getProfile);
}

function listLayouts(profileId) {
  const layouts = SOURCE_SPEC.layout_library[sourceProfileKey(profileId)];
  if (!Array.isArray(layouts)) throw new Error(`Template registry has no layouts for ${profileId}`);
  return clone(layouts);
}

function listLayoutIds(profileId) {
  return listLayouts(profileId).map((layout) => layout.layout_id);
}

function getLayout(profileId, layoutId) {
  const layout = listLayouts(profileId).find((candidate) => candidate.layout_id === layoutId);
  if (!layout) throw new Error(`Unknown presentation layout ${layoutId} for ${profileId}`);
  return layout;
}

function decorateLayoutStyles(layout) {
  const { styleForObject } = require('./presentation-style-contract');
  const decorated = clone(layout);
  for (const [name, object] of Object.entries(decorated.named_objects || {})) {
    object.style = styleForObject(name);
  }
  return decorated;
}

function intersectsGutter(box, gutter) {
  if (!box || !gutter) return false;
  return box.x < gutter.x2 && box.x + box.w > gutter.x1;
}

function isCriticalNamedObject(name, object) {
  if (!object || !object.bbox_px) return false;
  if (/BACKGROUND|PANEL|BOX|BLOCK|WATERMARK|PLACEHOLDER_ICON|BULLET_MARK|FULL_BLEED/.test(name)) return false;
  return /TITLE|SUBTITLE|BODY|BULLET|TEXT|LABEL|CAPTION|QUOTE|COURSE|SLIDE_NUMBER|MEDIA|VIDEO|IMAGE|LOGO|COLUMN|STEP|TAKEAWAY/.test(name)
    || Boolean(object.placeholder_text);
}

function validateRegistry() {
  const errors = [];
  const expectedIds = null;
  let sharedIds = expectedIds;
  for (const profileId of Object.values(PROFILE_IDS)) {
    const profile = getProfile(profileId);
    const layoutIds = listLayoutIds(profileId);
    if (new Set(layoutIds).size !== layoutIds.length) errors.push(`${profileId}: duplicate layout id`);
    if (!sharedIds) sharedIds = layoutIds.slice().sort();
    else if (JSON.stringify(sharedIds) !== JSON.stringify(layoutIds.slice().sort())) errors.push(`${profileId}: layout ids differ`);
    if (!fs.existsSync(profile.production_template_path)) errors.push(`${profileId}: production template missing`);
    for (const layout of listLayouts(profileId)) {
      for (const [name, object] of Object.entries(layout.named_objects || {})) {
        if (!isCriticalNamedObject(name, object)) continue;
        for (const gutter of profile.critical_content_exclusion_gutters_px) {
          if (intersectsGutter(object.bbox_px, gutter)) errors.push(`${profileId}/${layout.layout_id}/${name}: intersects critical gutter`);
        }
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function validateDeck(deck) {
  const errors = [];
  if (!deck || typeof deck !== 'object' || Array.isArray(deck)) return { valid: false, errors: ['deck must be an object'] };
  if (deck.version === DECK_VERSIONS.V1) {
    if (!Array.isArray(deck.slides)) errors.push('v1 slides must be an array');
    return { valid: errors.length === 0, errors };
  }
  if (deck.version !== DECK_VERSIONS.V2) return { valid: false, errors: ['unsupported deck version'] };
  if (!Object.values(PROFILE_IDS).includes(deck.wall_profile)) errors.push('invalid wall_profile');
  if (!Array.isArray(deck.slides)) errors.push('slides must be an array');
  if (!Array.isArray(deck.assets)) errors.push('assets must be an array');
  if (typeof deck.title !== 'string' || !deck.title.trim()) errors.push('title is required');
  if (deck.template_system_version !== SOURCE_SPEC.spec_version) errors.push('invalid template_system_version');
  if (!errors.includes('invalid wall_profile') && Array.isArray(deck.slides)) {
    const ids = new Set();
    for (const [index, slide] of deck.slides.entries()) {
      if (!slide || typeof slide !== 'object') { errors.push(`slide ${index + 1} must be an object`); continue; }
      if (!slide.id || ids.has(slide.id)) errors.push(`slide ${index + 1} id is missing or duplicated`);
      ids.add(slide.id);
      let layout;
      try { layout = getLayout(deck.wall_profile, slide.template_id); }
      catch { errors.push(`slide ${index + 1} has invalid template_id`); continue; }
      if (!slide.slots || typeof slide.slots !== 'object' || Array.isArray(slide.slots)) errors.push(`slide ${index + 1} slots must be an object`);
      else {
        const allowed = new Set(Object.keys(layout.named_objects || {}));
        for (const name of Object.keys(slide.slots)) if (!allowed.has(name)) errors.push(`slide ${index + 1} has unknown slot ${name}`);
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

function buildRenderPlan(deck, options = {}) {
  const validation = validateDeck(deck);
  if (!validation.valid) throw new Error(`Invalid deck: ${validation.errors.join('; ')}`);
  const mode = options.mode === 'editor' ? 'editor' : 'production';
  const requested = options.overlays || {};
  const overlays = {
    seams: mode === 'editor' && requested.seams === true,
    safeAreas: mode === 'editor' && requested.safeAreas === true,
    displayBoundaries: mode === 'editor' && requested.displayBoundaries === true,
  };
  if (deck.version === DECK_VERSIONS.V1) return { version: deck.version, mode, overlays, slides: clone(deck.slides) };
  const profile = getProfile(deck.wall_profile);
  return {
    version: deck.version,
    mode,
    profile,
    theme: clone(SOURCE_SPEC.theme),
    overlays,
    slides: deck.slides.map((slide) => {
      const layout = decorateLayoutStyles(getLayout(deck.wall_profile, slide.template_id));
      return {
        id: slide.id,
        template_id: slide.template_id,
        duration_seconds: Number(slide.duration_seconds) > 0 ? Number(slide.duration_seconds) : 12,
        speaker_notes: String(slide.speaker_notes || ''),
        objects: clone(layout.named_objects),
        slots: Object.entries(slide.slots || {}).map(([name, value]) => ({
          name,
          value: clone(value),
          geometry: layout.named_objects[name],
          style: layout.named_objects[name]?.style,
        })),
      };
    }),
  };
}

module.exports = {
  SOURCE_SPEC,
  TEMPLATE_DIR,
  DECK_VERSIONS,
  PROFILE_IDS,
  getProfile,
  listProfiles,
  getLayout,
  decorateLayoutStyles,
  listLayouts,
  listLayoutIds,
  intersectsGutter,
  validateRegistry,
  validateDeck,
  buildRenderPlan,
};
