'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DECK_VERSIONS,
  PROFILE_IDS,
  getProfile,
  getLayout,
  listLayoutIds,
  validateDeck,
  validateRegistry,
  buildRenderPlan,
} = require('../lib/presentation-template-registry');

const EXPECTED_LAYOUTS = [
  'STANDARD_BULLETS', 'STANDARD_PARAGRAPH', 'DUAL_MEDIA', 'FULL_IMAGE',
  'VIDEO_FOCUS', 'COMPARISON', 'DIAGRAM_PROCESS', 'SECTION_DIVIDER',
  'TABLE_DATA', 'QUOTE_TAKEAWAY', 'GALLERY', 'THREE_COLUMN_TEXT',
  'CONTINUATION',
];

test('authoritative registry exposes exact two- and three-display geometry', () => {
  const two = getProfile(PROFILE_IDS.TWO_DISPLAY);
  assert.deepEqual(two.canvas_px, { w: 7680, h: 2160 });
  assert.deepEqual(two.canvas_emu, { w: 32512000, h: 9144000 });
  assert.deepEqual(two.seams_px, [3840]);
  assert.deepEqual(two.critical_content_exclusion_gutters_px, [{ x1: 3648, x2: 4032 }]);

  const three = getProfile(PROFILE_IDS.THREE_DISPLAY);
  assert.deepEqual(three.canvas_px, { w: 11520, h: 2160 });
  assert.deepEqual(three.canvas_emu, { w: 48768000, h: 9144000 });
  assert.deepEqual(three.seams_px, [3840, 7680]);
  assert.deepEqual(three.critical_content_exclusion_gutters_px, [
    { x1: 3648, x2: 4032 }, { x1: 7488, x2: 7872 },
  ]);
});

test('both wall profiles expose the same complete approved layout set', () => {
  for (const profileId of Object.values(PROFILE_IDS)) {
    assert.deepEqual(listLayoutIds(profileId).sort(), EXPECTED_LAYOUTS.slice().sort());
    for (const layoutId of EXPECTED_LAYOUTS) {
      assert.equal(getLayout(profileId, layoutId).layout_id, layoutId);
    }
  }
  assert.deepEqual(validateRegistry(), { valid: true, errors: [] });
});

test('deck validation intentionally supports v1 and canonical v2', () => {
  assert.equal(validateDeck({ version: DECK_VERSIONS.V1, slides: [] }).valid, true);
  const v2 = {
    version: DECK_VERSIONS.V2,
    deck_id: 'deck-test',
    title: 'Test',
    theme_id: 'mbfd-videowall-v2',
    wall_profile: PROFILE_IDS.THREE_DISPLAY,
    template_system_version: '2.0.0',
    slides: [{ id: 'slide_001', template_id: 'STANDARD_PARAGRAPH', slots: { TV1_TITLE: 'Title', TV1_PARAGRAPH: 'Body' } }],
    assets: [],
  };
  assert.equal(validateDeck(v2).valid, true);
  assert.equal(validateDeck({ ...v2, wall_profile: 'invented-wall' }).valid, false);
  assert.equal(validateDeck({ ...v2, slides: [{ ...v2.slides[0], template_id: 'INVENTED_LAYOUT' }] }).valid, false);
});

test('production render plans never contain editor-only seam or safe-area guides', () => {
  const deck = {
    version: DECK_VERSIONS.V2,
    deck_id: 'deck-render', title: 'Render', theme_id: 'mbfd-videowall-v2',
    wall_profile: PROFILE_IDS.TWO_DISPLAY, template_system_version: '2.0.0',
    slides: [{ id: 'slide_001', template_id: 'SECTION_DIVIDER', slots: { SECTION_TITLE: 'Welcome' } }], assets: [],
  };
  const production = buildRenderPlan(deck, { mode: 'production', overlays: { seams: true, safeAreas: true, displayBoundaries: true } });
  assert.equal(production.overlays.seams, false);
  assert.equal(production.overlays.safeAreas, false);
  assert.equal(production.overlays.displayBoundaries, false);
  assert.equal(JSON.stringify(production).includes('seam-guide'), false);
  const editor = buildRenderPlan(deck, { mode: 'editor', overlays: { seams: true, safeAreas: true, displayBoundaries: true } });
  assert.equal(editor.overlays.seams, true);
});
