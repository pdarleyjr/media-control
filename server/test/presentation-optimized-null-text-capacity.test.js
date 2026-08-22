'use strict';

// Regression coverage for the Instructor Optimized deterministic compiler defect
// (PR #70): an exact-preserve Qwen assignment may set `text: null` and rely on
// deterministic source hydration (source_refs). The pre-compilation validator
// previously only checked capacity when `assignment.text` was an explicit string,
// so a long source paragraph hydrated into a short *_LABEL region slipped past
// validation and only failed the final quality gate (overflow on TV1_A_LABEL /
// TV2_B_LABEL), aborting the matrix. The fix validates the PROJECTED compiled
// value (explicit text OR hydrated source) against the same authoritative
// estimatedCapacity() the final gate uses, so an accepted plan can never overflow.

const test = require('node:test');
const assert = require('node:assert/strict');

const ai = require('../services/ai');
const { convertDeckIr, MODES } = require('../services/presentation-converter');
const { estimatedCapacity } = require('../services/presentation-composition');
const { PROFILE_IDS, getLayout, getProfile } = require('../lib/presentation-template-registry');
const { styleForObject } = require('../lib/presentation-style-contract');

const PID_TWO = PROFILE_IDS.TWO_DISPLAY;
const PID_THREE = PROFILE_IDS.THREE_DISPLAY;

function regionCap(profileId, layoutId, regionId) {
  const object = getLayout(profileId, layoutId).named_objects[regionId];
  return estimatedCapacity(object.bbox_px, styleForObject(regionId));
}

// Short labels (fit a label region) and a long body paragraph (fits a body region
// but overflows a label region).
const SHORT_A = 'Interior';
const SHORT_B = 'Exterior';
const LONG = 'Size-up requires reading the building, announcing conditions, establishing command, and confirming water supply before committing crews to the hazard area.';
assert.ok(LONG.length > regionCap(PID_TWO, 'COMPARISON', 'TV1_A_LABEL'), 'fixture LONG must overflow a label region');
assert.ok(LONG.length < regionCap(PID_TWO, 'COMPARISON', 'TV1_A_BODY'), 'fixture LONG must fit a body region');

function comparisonSource() {
  return {
    source_slide_number: 1,
    title: 'Tactics',
    elements: [
      { id: 'a-head', kind: 'paragraph', text: SHORT_A },
      { id: 'a-body', kind: 'paragraph', text: LONG },
      { id: 'b-head', kind: 'paragraph', text: SHORT_B },
      { id: 'b-body', kind: 'paragraph', text: LONG },
    ],
    speaker_notes: '', relationships: [], warnings: [],
  };
}

function assignment(regionId, sourceRefs, contentType) {
  return {
    region_id: regionId,
    source_refs: sourceRefs,
    content_type: contentType,
    transform: contentType === 'paragraph' ? 'preserve_paragraph' : 'copy_exact',
    text: null,
    media_id: null,
    fit: null,
    preserve_hyperlink: true,
  };
}

function comparisonPlan(profileId, mode, bodyRegionA, bodyRegionB, labelRegionA, labelRegionB) {
  const sourceKey = getProfile(profileId).source_key;
  return {
    source_slide_number: 1,
    wall_mode: sourceKey,
    transfer_mode: mode,
    layout_id: 'COMPARISON',
    reason: 'comparison',
    target_slides: [{
      layout_id: 'COMPARISON',
      continuation_index: 0,
      region_assignments: [
        assignment(labelRegionA, ['a-head'], 'text'),
        assignment(bodyRegionA, ['a-body'], 'paragraph'),
        assignment(labelRegionB, ['b-head'], 'text'),
        assignment(bodyRegionB, ['b-body'], 'paragraph'),
      ],
    }],
    media_actions: [],
    source_accounting: { accounted_source_refs: ['a-head', 'a-body', 'b-head', 'b-body'], unaccounted_source_refs: [] },
    requires_review: false,
    review_reasons: [],
    confidence: 1,
  };
}

test('A) null-text exact-preserve assignment hydrating a long source paragraph into a short *_LABEL region is rejected pre-compilation', () => {
  const plan = comparisonPlan(PID_TWO, 'instructor_optimized', 'TV1_A_LABEL', 'TV2_B_LABEL', 'TV1_A_LABEL', 'TV2_B_LABEL');
  // Swap: the long paragraph is mapped to the label region (a-head goes to body).
  plan.target_slides[0].region_assignments = [
    assignment('TV1_A_LABEL', ['a-body'], 'text'),
    assignment('TV1_A_BODY', ['a-head'], 'text'),
    assignment('TV2_B_LABEL', ['b-head'], 'text'),
    assignment('TV2_B_BODY', ['b-body'], 'paragraph'),
  ];
  const error = ai.validateConversionPlan(plan, comparisonSource(), PID_TWO, 'instructor_optimized');
  assert.match(String(error), /exceeds deterministic capacity for TV1_A_LABEL/);
});

test('B) the same long source paragraph assigned to an appropriate *_BODY region is accepted', () => {
  const plan = comparisonPlan(PID_TWO, 'instructor_optimized', 'TV1_A_BODY', 'TV2_B_BODY', 'TV1_A_LABEL', 'TV2_B_LABEL');
  const error = ai.validateConversionPlan(plan, comparisonSource(), PID_TWO, 'instructor_optimized');
  assert.equal(error, null);
});

test('C) an oversized body assignment is rejected, and an explicit chunked split preserves 100% source content', () => {
  const source = comparisonSource();
  // Single long paragraph mapped to one body region via hydration -> rejected.
  const overflowPlan = {
    source_slide_number: 1,
    wall_mode: getProfile(PID_TWO).source_key,
    transfer_mode: 'instructor_optimized',
    layout_id: 'COMPARISON',
    target_slides: [{
      layout_id: 'COMPARISON',
      region_assignments: [
        assignment('TV1_A_LABEL', ['a-head'], 'text'),
        assignment('TV1_A_BODY', ['a-body'], 'paragraph'),
        assignment('TV2_B_LABEL', ['b-head'], 'text'),
        assignment('TV2_B_BODY', ['b-body'], 'paragraph'),
      ],
    }],
    media_actions: [],
    source_accounting: { accounted_source_refs: ['a-head', 'a-body', 'b-head', 'b-body'], unaccounted_source_refs: [] },
    requires_review: false,
    review_reasons: [],
    confidence: 1,
  };
  assert.equal(ai.validateConversionPlan(overflowPlan, source, PID_TWO, 'instructor_optimized'), null);
  // Now overflow a single body region (cap < LONG) with explicit text and expect rejection.
  const tooLong = LONG.repeat(3);
  assert.ok(tooLong.length > regionCap(PID_TWO, 'COMPARISON', 'TV1_A_BODY'));
  const badBody = {
    ...overflowPlan,
    target_slides: [{
      layout_id: 'COMPARISON',
      region_assignments: [
        assignment('TV1_A_LABEL', ['a-head'], 'text'),
        { ...assignment('TV1_A_BODY', ['a-body'], 'paragraph'), text: tooLong },
        assignment('TV2_B_LABEL', ['b-head'], 'text'),
        assignment('TV2_B_BODY', ['b-body'], 'paragraph'),
      ],
    }],
  };
  assert.match(String(ai.validateConversionPlan(badBody, source, PID_TWO, 'instructor_optimized')), /exceeds deterministic capacity for TV1_A_BODY/);

  // Approved split: two continuation body regions each carry an explicit chunk under capacity.
  const half = Math.ceil(tooLong.length / 2);
  const chunk1 = tooLong.slice(0, half);
  const chunk2 = tooLong.slice(half);
  assert.ok(chunk1.length <= regionCap(PID_TWO, 'CONTINUATION', 'TV1_BODY'));
  assert.ok(chunk2.length <= regionCap(PID_TWO, 'CONTINUATION', 'TV1_BODY'));
  const splitPlan = {
    source_slide_number: 1,
    wall_mode: getProfile(PID_TWO).source_key,
    transfer_mode: 'instructor_optimized',
    layout_id: 'COMPARISON',
    target_slides: [
      {
        layout_id: 'CONTINUATION',
        region_assignments: [
          { region_id: 'TV1_BODY', source_refs: ['a-body'], content_type: 'paragraph', transform: 'split', text: chunk1, media_id: null, fit: null, preserve_hyperlink: true },
        ],
      },
      {
        layout_id: 'CONTINUATION',
        region_assignments: [
          { region_id: 'TV1_BODY', source_refs: ['a-body'], content_type: 'paragraph', transform: 'split', text: chunk2, media_id: null, fit: null, preserve_hyperlink: true },
        ],
      },
    ],
    media_actions: [],
    source_accounting: { accounted_source_refs: ['a-body'], unaccounted_source_refs: [] },
    requires_review: false,
    review_reasons: [],
    confidence: 1,
  };
  assert.equal(ai.validateConversionPlan(splitPlan, { source_slide_number: 1, elements: [{ id: 'a-body', kind: 'paragraph', text: tooLong }], speaker_notes: '', relationships: [], warnings: [] }, PID_TWO, 'instructor_optimized'), null);
});

async function optimizedDeck(profileId, source, plan) {
  return convertDeckIr({ source: { filename: 'comparison.pptx' }, slides: [source], assets: [] }, {
    wallProfile: profileId,
    mode: MODES.OPTIMIZED,
    title: 'Comparison fixture',
    ai: {
      mapSlide: async () => ({ template_id: 'COMPARISON', requires_review: false, review_reasons: [], raw_plan: plan }),
    },
  });
}

test('D) COMPARISON mapping with short labels + long bodies compiles to a valid deck (quality.valid, overflow 0)', async () => {
  const plan = comparisonPlan(PID_TWO, 'instructor_optimized', 'TV1_A_BODY', 'TV2_B_BODY', 'TV1_A_LABEL', 'TV2_B_LABEL');
  const deck = await optimizedDeck(PID_TWO, comparisonSource(), plan);
  assert.equal(deck.conversion.quality.valid, true);
  assert.equal(deck.conversion.quality.overflow_count, 0);
  assert.equal(deck.conversion.source_accounting_percent, 100);
  assert.ok(['optimized', 'partial'].includes(deck.conversion.optimization_status));
  // Short source text lands in the label region; long source text in the body region.
  const labelSlot = deck.slides[0].slots.TV1_A_LABEL;
  const bodySlot = deck.slides[0].slots.TV1_A_BODY;
  assert.equal(labelSlot, SHORT_A);
  assert.equal(bodySlot, LONG);
});

test('E) 2-display Instructor Optimized dense comparison representative case is valid end-to-end', async () => {
  const plan = comparisonPlan(PID_TWO, 'instructor_optimized', 'TV1_A_BODY', 'TV2_B_BODY', 'TV1_A_LABEL', 'TV2_B_LABEL');
  const deck = await optimizedDeck(PID_TWO, comparisonSource(), plan);
  const q = deck.conversion.quality;
  assert.equal(q.valid, true);
  assert.equal(q.overflow_count, 0);
  assert.equal(q.seam_violation_count, 0);
  assert.equal(q.outside_canvas_count, 0);
  assert.equal(deck.conversion.source_accounting_percent, 100);
});

test('F) 3-display Instructor Optimized dense comparison representative case is valid end-to-end', async () => {
  // 3-display COMPARISON uses TV1_A_* on display 1 and TV3_B_* on display 3.
  const plan = comparisonPlan(PID_THREE, 'instructor_optimized', 'TV1_A_BODY', 'TV3_B_BODY', 'TV1_A_LABEL', 'TV3_B_LABEL');
  const deck = await optimizedDeck(PID_THREE, comparisonSource(), plan);
  const q = deck.conversion.quality;
  assert.equal(q.valid, true);
  assert.equal(q.overflow_count, 0);
  assert.equal(q.seam_violation_count, 0);
  assert.equal(deck.conversion.source_accounting_percent, 100);
});

test('G) regression: forbidden geometry, media-region, and source-accounting guards remain enforced', () => {
  const source = comparisonSource();
  const plan = comparisonPlan(PID_TWO, 'instructor_optimized', 'TV1_A_BODY', 'TV2_B_BODY', 'TV1_A_LABEL', 'TV2_B_LABEL');
  // Forbidden geometry is rejected before capacity logic.
  plan.target_slides[0].region_assignments[0].x = 4000;
  assert.match(String(ai.validateConversionPlan(plan, source, PID_TWO, 'instructor_optimized')), /forbidden geometry/);
  delete plan.target_slides[0].region_assignments[0].x;
  // Omitting source content is rejected.
  const omit = comparisonPlan(PID_TWO, 'instructor_optimized', 'TV1_A_BODY', 'TV2_B_BODY', 'TV1_A_LABEL', 'TV2_B_LABEL');
  omit.source_accounting.accounted_source_refs = ['a-head', 'a-body', 'b-head'];
  assert.match(String(ai.validateConversionPlan(omit, source, PID_TWO, 'instructor_optimized')), /omits source content/);
});

test('H) end-to-end: mapSlideToV2 refuses to compile a null-text label overflow and fails deterministically', async (t) => {
  const originalFetch = global.fetch;
  const badRaw = comparisonPlan(PID_TWO, 'instructor_optimized', 'TV1_A_LABEL', 'TV2_B_LABEL', 'TV1_A_LABEL', 'TV2_B_LABEL');
  badRaw.target_slides[0].region_assignments = [
    assignment('TV1_A_LABEL', ['a-body'], 'text'),
    assignment('TV1_A_BODY', ['a-head'], 'text'),
    assignment('TV2_B_LABEL', ['b-head'], 'text'),
    assignment('TV2_B_BODY', ['b-body'], 'paragraph'),
  ];
  global.fetch = async () => new Response(JSON.stringify({ message: { content: JSON.stringify(badRaw) } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  t.after(() => { global.fetch = originalFetch; });
  await assert.rejects(
    ai.mapSlideToV2(comparisonSource(), { wallProfile: PID_TWO, mode: 'instructor_optimized' }),
    /exceeds deterministic capacity/
  );
});
