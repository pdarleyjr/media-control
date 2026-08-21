'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DECK_VERSIONS,
  PROFILE_IDS,
  SOURCE_SPEC,
  getLayout,
  getProfile,
} = require('../lib/presentation-template-registry');
const {
  buildSlideCompositionIr,
  rankCandidateLayouts,
  validatePresentationQuality,
  evaluateSlideGeometry,
} = require('../services/presentation-composition');
const { convertDeckIr, MODES } = require('../services/presentation-converter');
const { styleForObject, PX_PER_PT } = require('../lib/presentation-style-contract');

const EMU = 914400;
function box(x, y, w, h) { return { x: x * EMU, y: y * EMU, w: w * EMU, h: h * EMU }; }
function paragraph(id, text, bbox) { return { id, kind: 'paragraph', text, bbox_emu: bbox }; }
function image(id, x, y, w = 2, h = 2) { return { id, kind: 'image', asset_ref: `asset:${id}`, bbox_emu: box(x, y, w, h) }; }

test('composition IR recognizes parallel spatial groups and candidate scoring selects comparison', () => {
  const source = {
    source_slide_number: 1,
    title: 'Compare tactics',
    elements: [
      paragraph('a-heading', 'Interior', box(0.7, 1.2, 4.5, 0.5)),
      paragraph('a-body', 'Advance through the protected stair.', box(0.7, 1.9, 4.5, 1.2)),
      image('a-image', 1.8, 3.3),
      paragraph('b-heading', 'Exterior', box(7.1, 1.2, 4.5, 0.5)),
      paragraph('b-body', 'Coordinate streams from the safe side.', box(7.1, 1.9, 4.5, 1.2)),
      image('b-image', 8.2, 3.3),
    ],
  };
  const composition = buildSlideCompositionIr(source, { w: 13.333 * EMU, h: 7.5 * EMU });
  assert.equal(composition.semantic_shape, 'comparison');
  assert.equal(composition.groups.length, 2);
  const candidates = rankCandidateLayouts(composition, PROFILE_IDS.THREE_DISPLAY);
  assert.equal(candidates[0].layout_id, 'COMPARISON');
  assert.equal(candidates[0].valid, true);
});

test('faithful paragraph plus adjacent image remains coherent on one output slide', async () => {
  const ir = {
    source: { filename: 'coherent.pptx' },
    source_dimensions_emu: { w: 13.333 * EMU, h: 7.5 * EMU },
    assets: [],
    slides: [{
      source_slide_number: 1, title: 'Size-up', elements: [
        paragraph('body', 'Read the building, announce conditions, and establish command.', box(0.8, 1.4, 6.2, 3.5)),
        image('photo', 8.2, 1.5, 4, 3.5),
      ],
    }],
  };
  const deck = await convertDeckIr(ir, { wallProfile: PROFILE_IDS.THREE_DISPLAY, mode: MODES.FAITHFUL });
  assert.equal(deck.slides.length, 1);
  assert.equal(deck.slides[0].template_id, 'STANDARD_PARAGRAPH');
  assert.ok(Object.values(deck.slides[0].slots).some((value) => value?.asset_ref === 'asset:photo'));
  assert.equal(deck.conversion.quality.valid, true);
});

test('two-display prose with media keeps readable prose capacity and moves media to a faithful follow-up slide', async () => {
  const ir = {
    source: { filename: 'two-display-prose-media.pptx' },
    source_dimensions_emu: { w: 13.333 * EMU, h: 7.5 * EMU },
    assets: [],
    slides: [{
      source_slide_number: 1, title: 'Readable narrative', elements: [
        paragraph('source-title', 'Readable narrative', box(0.8, 0.5, 6, 0.5)),
        paragraph('body', 'Keep the complete narrative readable.', box(0.8, 1.4, 6.2, 3.5)),
        image('photo', 8.2, 1.5, 4, 3.5),
      ],
    }],
  };
  const deck = await convertDeckIr(ir, { wallProfile: PROFILE_IDS.TWO_DISPLAY, mode: MODES.FAITHFUL });
  assert.deepEqual(deck.slides.map((slide) => slide.template_id), ['STANDARD_PARAGRAPH', 'FULL_IMAGE']);
  assert.equal(deck.conversion.quality.valid, true);
});

test('six related photos compile to two gallery slides instead of six orphan full-image slides', async () => {
  const photos = Array.from({ length: 6 }, (_, index) => image(`photo-${index + 1}`, 0.7 + (index % 3) * 4.1, 1.2 + Math.floor(index / 3) * 2.6, 3.6, 2.2));
  const ir = {
    source: { filename: 'gallery.pptx' },
    source_dimensions_emu: { w: 13.333 * EMU, h: 7.5 * EMU },
    assets: [],
    slides: [{ source_slide_number: 1, title: 'Occupancy indicators', elements: photos }],
  };
  const deck = await convertDeckIr(ir, { wallProfile: PROFILE_IDS.THREE_DISPLAY, mode: MODES.FAITHFUL });
  assert.equal(deck.slides.length, 2);
  assert.ok(deck.slides.every((slide) => slide.template_id === 'GALLERY'));
  assert.ok(deck.slides.every((slide) => Object.values(slide.slots).filter((value) => value?.asset_ref).length === 3));
  assert.equal(deck.conversion.quality.orphan_continuation_count, 0);
});

test('a rendered fallback replaces covered complex placeholders without duplicate continuation slides', async () => {
  const ir = {
    source: { filename: 'rendered-complex.pptx' },
    source_dimensions_emu: { w: 13.333 * EMU, h: 7.5 * EMU },
    assets: [{ id: 'asset:fallback', kind: 'image', mime: 'image/png' }],
    slides: [{
      source_slide_number: 1,
      title: 'Complex diagram',
      elements: [
        { id: 'chart', kind: 'chart', rendered_fallback_covered: true, bbox_emu: box(1, 1, 5, 4) },
        { id: 'fallback', kind: 'image', asset_ref: 'asset:fallback', rendered_fallback: true, bbox_emu: box(0, 0, 13.333, 7.5) },
      ],
    }],
  };
  const deck = await convertDeckIr(ir, { wallProfile: PROFILE_IDS.THREE_DISPLAY, mode: MODES.FAITHFUL });
  assert.equal(deck.slides.length, 1);
  assert.equal(deck.slides[0].template_id, 'FULL_IMAGE');
  assert.equal(deck.conversion.quality.orphan_continuation_count, 0);
  assert.equal(deck.conversion.accounting.find((item) => item.source_element_id === 'chart').disposition, 'rendered_fallback');
});

test('conversion reports per-slide activity and a measurable quality report', async () => {
  const events = [];
  const ir = {
    source: { filename: 'progress.pptx' }, source_dimensions_emu: { w: 13.333 * EMU, h: 7.5 * EMU }, assets: [],
    slides: [1, 2].map((n) => ({ source_slide_number: n, title: `Slide ${n}`, elements: [paragraph(`p${n}`, `Body ${n}`, box(1, 1.5, 5, 2))] })),
  };
  const deck = await convertDeckIr(ir, {
    wallProfile: PROFILE_IDS.THREE_DISPLAY,
    onProgress: (detail) => events.push(detail),
  });
  assert.deepEqual(events.filter((event) => event.step === 'analyzing-source-slide').map((event) => event.slide_current), [1, 2]);
  assert.ok(events.some((event) => event.step === 'validating-fit'));
  assert.deepEqual(validatePresentationQuality(deck, ir), deck.conversion.quality);
  assert.equal(deck.conversion.quality.source_accounting, 100);
});

test('exceptionally dense prose may use three slides only with an explicit density warning', async () => {
  const ir = {
    source: { filename: 'dense-prose.pptx' }, source_dimensions_emu: { w: 13.333 * EMU, h: 7.5 * EMU }, assets: [],
    slides: [{
      source_slide_number: 1,
      title: 'Ventilation coordination',
      elements: [
        paragraph('source-title', 'Ventilation coordination', box(0.8, 0.5, 7.2, 0.5)),
        paragraph('dense-body', 'Preserve every instructor-authored detail. '.repeat(95), box(0.8, 1.3, 7.2, 4.8)),
      ],
    }],
  };
  const deck = await convertDeckIr(ir, { wallProfile: PROFILE_IDS.TWO_DISPLAY, mode: MODES.FAITHFUL });
  assert.equal(deck.slides.length, 3);
  assert.equal(deck.conversion.quality.valid, true);
  assert.ok(deck.conversion.quality.review_required.includes('EXCEPTIONAL_DENSITY_CONTINUATIONS:1(3)'));
});

test('per-source slide expansion beyond six outputs is a hard quality failure', async () => {
  const ir = {
    source: { filename: 'pathological-expansion.pptx' }, source_dimensions_emu: { w: 13.333 * EMU, h: 7.5 * EMU }, assets: [],
    slides: [{
      source_slide_number: 1,
      title: 'Pathological expansion',
      elements: [paragraph('body', 'Dense source detail. '.repeat(190), box(0.8, 1.3, 7.2, 4.8))],
    }],
  };
  const deck = await convertDeckIr(ir, { wallProfile: PROFILE_IDS.TWO_DISPLAY, mode: MODES.FAITHFUL });
  while (deck.slides.length < 7) {
    const clone = JSON.parse(JSON.stringify(deck.slides.at(-1)));
    clone.id = `forced_expansion_${deck.slides.length + 1}`;
    deck.slides.push(clone);
  }
  deck.conversion.source_slide_mappings[0].output_slide_ids = deck.slides.map((slide) => slide.id);
  const quality = validatePresentationQuality(deck, ir);
  assert.equal(quality.valid, false);
  assert.ok(quality.review_required.includes('SLIDE_EXPANSION_HARD_LIMIT:1(7)'));
});

test('authoritative style contract keeps browser pixels and PowerPoint points in exact parity', () => {
  const body = styleForObject('STANDARD_PARAGRAPH_BODY');
  const title = styleForObject('STANDARD_PARAGRAPH_TITLE');
  assert.equal(PX_PER_PT, 3);
  assert.ok(body.font_size_pt >= 15);
  assert.equal(body.font_size_px, body.font_size_pt * PX_PER_PT);
  assert.ok(title.font_size_pt >= 28 && title.font_size_pt <= 42);
  assert.equal(title.font_size_px, title.font_size_pt * PX_PER_PT);
  const layout = getLayout(PROFILE_IDS.THREE_DISPLAY, 'STANDARD_PARAGRAPH');
  assert.ok(Object.keys(layout.named_objects).some((name) => /PARAGRAPH/.test(name)));
});

test('quality gate hard-rejects overlap, unsafe crop, and extreme media-aspect mismatch', () => {
  const ir = {
    source_dimensions_emu: { w: 100 * EMU, h: EMU },
    slides: [{
      source_slide_number: 1,
      elements: [{ id: 'extreme', kind: 'image', asset_ref: 'asset:extreme', bbox_emu: box(0, 0, 100, 1) }],
    }],
  };
  const deck = {
    version: DECK_VERSIONS.V2,
    deck_id: 'bad-geometry',
    title: 'Bad geometry',
    theme_id: 'mbfd-videowall-v2',
    wall_profile: PROFILE_IDS.THREE_DISPLAY,
    template_system_version: SOURCE_SPEC.spec_version,
    assets: [{ id: 'asset:extreme', kind: 'image' }],
    slides: [{
      id: 'bad-slide',
      template_id: 'FULL_IMAGE',
      slots: {
        FULL_BLEED_MEDIA: { type: 'image', asset_ref: 'asset:extreme', fit: 'cover' },
        TV1_TEXT_PANEL: 'occupied panel',
        TV1_TITLE: 'Overlapping title',
      },
    }],
    conversion: {
      source_accounting_percent: 100,
      source_slide_mappings: [{ source_slide_number: 1, output_slide_ids: ['bad-slide'] }],
    },
  };
  const quality = validatePresentationQuality(deck, ir);
  assert.equal(quality.valid, false);
  assert.ok(quality.overlap_count > 0);
  assert.ok(quality.crop_violation_count > 0);
  assert.ok(quality.media_aspect_violation_count > 0);
  assert.ok(quality.hard_rejects.some((item) => item.startsWith('OVERLAPS:')));
});

test('quality geometry checks reject off-canvas panel alignment, unbalanced galleries, and empty whitespace', () => {
  const profile = getProfile(PROFILE_IDS.TWO_DISPLAY);
  const offCanvas = evaluateSlideGeometry(
    { id: 'off-canvas', template_id: 'STANDARD_PARAGRAPH', slots: { TV1_TITLE: 'Misplaced' } },
    { named_objects: { TV1_TITLE: { bbox_px: { x: 7600, y: 100, w: 300, h: 100 } } } },
    profile,
  );
  assert.equal(offCanvas.outside_canvas.length, 1);
  assert.equal(offCanvas.alignment_violations.length, 1);

  const gallery = evaluateSlideGeometry(
    { id: 'gallery', template_id: 'GALLERY', slots: { TV1_MEDIA: { type: 'image', fit: 'contain' } } },
    getLayout(PROFILE_IDS.TWO_DISPLAY, 'GALLERY'),
    profile,
  );
  assert.deepEqual(gallery.balance_violations, ['gallery:gallery_requires_two']);

  const empty = evaluateSlideGeometry(
    { id: 'empty', template_id: 'STANDARD_PARAGRAPH', slots: {} },
    getLayout(PROFILE_IDS.TWO_DISPLAY, 'STANDARD_PARAGRAPH'),
    profile,
  );
  assert.deepEqual(empty.whitespace_violations, ['empty:insufficient_occupied_area']);
});
