'use strict';

const {
  getLayout,
  getProfile,
  listLayoutIds,
  validateDeck,
  intersectsGutter,
  SOURCE_SPEC,
} = require('../lib/presentation-template-registry');
const { styleForObject } = require('../lib/presentation-style-contract');

function elementsOf(slide) {
  return Array.isArray(slide?.elements) ? slide.elements.filter((element) => element && typeof element === 'object') : [];
}

function normalizedBox(element, dimensions) {
  const box = element?.bbox_emu;
  const width = Number(dimensions?.w) || 1;
  const height = Number(dimensions?.h) || 1;
  if (!box || !Number(box.w) || !Number(box.h)) return null;
  return { x: box.x / width, y: box.y / height, w: box.w / width, h: box.h / height };
}

function sourceOrder(elements) {
  return elements.slice().sort((a, b) => {
    const aa = a.normalized_bbox; const bb = b.normalized_bbox;
    if (!aa && !bb) return a.source_order - b.source_order;
    if (!aa) return 1; if (!bb) return -1;
    return aa.y - bb.y || aa.x - bb.x || a.source_order - b.source_order;
  });
}

function makeGroup(id, members, column) {
  const boxes = members.map((member) => member.normalized_bbox).filter(Boolean);
  const left = boxes.length ? Math.min(...boxes.map((box) => box.x)) : 0;
  const top = boxes.length ? Math.min(...boxes.map((box) => box.y)) : 0;
  const right = boxes.length ? Math.max(...boxes.map((box) => box.x + box.w)) : 1;
  const bottom = boxes.length ? Math.max(...boxes.map((box) => box.y + box.h)) : 1;
  return {
    id,
    column,
    members: sourceOrder(members).map((member) => member.id),
    kinds: [...new Set(members.map((member) => member.kind))],
    bbox: { x: left, y: top, w: right - left, h: bottom - top },
  };
}

function buildSlideCompositionIr(slide, sourceDimensions = {}) {
  const elements = elementsOf(slide).map((element, index) => ({
    ...element,
    source_order: index,
    normalized_bbox: normalizedBox(element, sourceDimensions),
  }));
  const titleElement = elements.find((element) => ['title', 'ctrTitle'].includes(element.semantic_role))
    || elements.find((element) => ['paragraph', 'text'].includes(element.kind)
      && String(element.text || '').trim() === String(slide?.title || '').trim());
  const content = elements.filter((element) => element !== titleElement);
  const media = content.filter((element) => ['image', 'video', 'audio', 'youtube'].includes(element.kind));
  const text = content.filter((element) => ['paragraph', 'bullets', 'text', 'text_column'].includes(element.kind));
  const prose = text.filter((element) => ['paragraph', 'text', 'text_column'].includes(element.kind));
  const complex = content.some((element) => ['smartart', 'chart', 'group', 'ole'].includes(element.kind));
  const located = content.filter((element) => element.normalized_bbox);
  const left = located.filter((element) => element.normalized_bbox.x + element.normalized_bbox.w / 2 < 0.5);
  const right = located.filter((element) => element.normalized_bbox.x + element.normalized_bbox.w / 2 >= 0.5);
  const leftText = left.filter((element) => text.includes(element));
  const rightText = right.filter((element) => text.includes(element));
  const isComparison = left.length >= 2 && right.length >= 2 && leftText.length > 0 && rightText.length > 0;
  let groups;
  if (isComparison) {
    groups = [makeGroup('group-left', left, 'left'), makeGroup('group-right', right, 'right')];
  } else {
    groups = [makeGroup('group-main', content, 'main')];
  }
  let semanticShape = 'prose';
  if (complex) semanticShape = 'complex_source';
  else if (isComparison) semanticShape = 'comparison';
  else if (media.length >= 3) semanticShape = 'gallery';
  else if (media.length === 2) semanticShape = 'dual_media';
  else if (media.length === 1 && prose.length) semanticShape = 'prose_with_media';
  else if (media.length === 1 && content.length === 1) semanticShape = 'full_image';
  else if (content.some((element) => element.kind === 'table')) semanticShape = 'table';
  else if (content.some((element) => element.kind === 'bullets')) semanticShape = 'bullets';
  return {
    schema_version: 'mbfd-slide-composition-ir-v1',
    source_slide_number: slide?.source_slide_number || null,
    title: String(slide?.title || ''),
    semantic_shape: semanticShape,
    elements,
    groups,
    counts: { elements: content.length, text: text.length, media: media.length },
  };
}

function layoutCapacity(profileId, layoutId) {
  const names = Object.keys(getLayout(profileId, layoutId).named_objects || {});
  return {
    text: names.filter((name) => /(PARAGRAPH|_BODY|TABLE_TEXT|QUOTE_TEXT)$/.test(name) && !/PANEL/.test(name)).length,
    bullets: names.filter((name) => /_BULLET_\d+$/.test(name)).length,
    media: names.filter((name) => /(_MEDIA(?:_[A-Z])?|_VIDEO|FULL_BLEED_MEDIA|_DIAGRAM)$/.test(name)).length,
  };
}

function rankCandidateLayouts(composition, profileId) {
  const preferred = {
    comparison: 'COMPARISON', gallery: 'GALLERY', dual_media: 'DUAL_MEDIA',
    prose_with_media: 'STANDARD_PARAGRAPH', full_image: 'FULL_IMAGE', table: 'TABLE_DATA',
    bullets: 'STANDARD_BULLETS', complex_source: 'FULL_IMAGE', prose: 'STANDARD_PARAGRAPH',
  }[composition.semantic_shape] || 'STANDARD_PARAGRAPH';
  return listLayoutIds(profileId).map((layoutId) => {
    const capacity = layoutCapacity(profileId, layoutId);
    const needsMedia = composition.counts.media > 0;
    const needsText = composition.counts.text > 0;
    const hardReasons = [];
    if (needsMedia && capacity.media === 0) hardReasons.push('missing_media_region');
    if (needsText && capacity.text === 0 && capacity.bullets === 0) hardReasons.push('missing_text_region');
    if (composition.semantic_shape === 'comparison' && layoutId !== 'COMPARISON') hardReasons.push('breaks_parallel_groups');
    const continuationCount = capacity.media > 0 ? Math.max(0, Math.ceil(composition.counts.media / capacity.media) - 1) : composition.counts.media;
    let score = layoutId === preferred ? 100 : 35;
    score += Math.min(composition.counts.media, capacity.media) * 8;
    score += Math.min(composition.counts.text, capacity.text + capacity.bullets) * 5;
    score -= continuationCount * 14;
    score -= Math.abs((capacity.media + capacity.text + capacity.bullets) - composition.counts.elements) * 2;
    if (hardReasons.length) score -= 1000;
    return { layout_id: layoutId, valid: hardReasons.length === 0, score, hard_rejections: hardReasons, capacity, continuation_count: continuationCount };
  }).sort((a, b) => Number(b.valid) - Number(a.valid) || b.score - a.score || a.layout_id.localeCompare(b.layout_id));
}

function textLength(value) {
  if (typeof value === 'string') return value.length;
  if (value?.type === 'linked_text') return String(value.caption || '').length;
  if (value?.type === 'table') return (value.rows || []).flat().join(' ').length;
  return 0;
}

function estimatedCapacity(box, style) {
  if (!box) return 0;
  const innerWidth = Math.max(1, box.w - style.padding_px.left - style.padding_px.right);
  const innerHeight = Math.max(1, box.h - style.padding_px.top - style.padding_px.bottom);
  const columns = innerWidth / (style.font_size_px * 0.52);
  const lines = innerHeight / (style.font_size_px * style.line_height);
  return Math.max(1, Math.floor(columns * lines));
}

function isOccupied(value) {
  return value != null && value !== '';
}

function isMediaSlot(name, value) {
  return /(?:MEDIA|VIDEO|IMAGE|DIAGRAM)/.test(name)
    || Boolean(value && typeof value === 'object' && ['image', 'video', 'youtube'].includes(value.type));
}

function intersectionArea(a, b) {
  if (!a || !b) return 0;
  const width = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return width * height;
}

function sourceMediaAspects(ir) {
  const aspects = new Map();
  for (const slide of ir?.slides || []) {
    for (const element of elementsOf(slide)) {
      const box = element.bbox_emu;
      const aspect = Number(box?.w) > 0 && Number(box?.h) > 0 ? Number(box.w) / Number(box.h) : null;
      const key = element.asset_ref || element.content_id || element.url;
      if (key && aspect && Number.isFinite(aspect)) aspects.set(String(key), aspect);
    }
  }
  return aspects;
}

function evaluateSlideGeometry(slide, layout, profile, sourceAspects = new Map()) {
  const canvas = profile?.canvas_px || {};
  const canvasWidth = Number(canvas.w) || 0;
  const canvasHeight = Number(canvas.h) || 0;
  const occupied = [];
  const outsideCanvas = [];
  const overlaps = [];
  const cropViolations = [];
  const mediaAspectViolations = [];
  const alignmentViolations = [];
  const whitespaceViolations = [];
  const minimumFontViolations = [];
  let occupiedArea = 0;

  for (const [name, value] of Object.entries(slide?.slots || {})) {
    if (!isOccupied(value)) continue;
    const box = layout?.named_objects?.[name]?.bbox_px;
    if (!box || ![box.x, box.y, box.w, box.h].every((number) => Number.isFinite(Number(number)))
      || Number(box.w) <= 0 || Number(box.h) <= 0) {
      outsideCanvas.push(`${slide.id}:${name}:missing_geometry`);
      continue;
    }
    occupied.push({ name, value, box });
    occupiedArea += Number(box.w) * Number(box.h);
    if (Number(box.x) < 0 || Number(box.y) < 0
      || Number(box.x) + Number(box.w) > canvasWidth
      || Number(box.y) + Number(box.h) > canvasHeight) outsideCanvas.push(`${slide.id}:${name}`);

    const displayMatch = name.match(/^TV(\d+)_/);
    if (displayMatch) {
      const display = (profile.displays || [])[Number(displayMatch[1]) - 1];
      if (!display || Number(box.x) < Number(display.x) || Number(box.x) + Number(box.w) > Number(display.x) + Number(display.w)) {
        alignmentViolations.push(`${slide.id}:${name}`);
      }
    }

    if (textLength(value) > 0) {
      const fontSize = Number(styleForObject(name).font_size_pt) || 0;
      if (fontSize < Number(SOURCE_SPEC.global_rules.minimum_body_font_pt)) minimumFontViolations.push(`${slide.id}:${name}`);
    }

    if (isMediaSlot(name, value)) {
      const fit = value && typeof value === 'object' && value.fit ? String(value.fit) : 'contain';
      if (!['contain', 'cover'].includes(fit)) mediaAspectViolations.push(`${slide.id}:${name}:invalid_fit`);
      const key = value && typeof value === 'object' ? value.asset_ref || value.content_id || value.url : null;
      const sourceAspect = key ? Number(sourceAspects.get(String(key))) : null;
      const targetAspect = Number(box.w) / Number(box.h);
      if (sourceAspect && Number.isFinite(sourceAspect)) {
        const aspectRatioDelta = Math.max(sourceAspect / targetAspect, targetAspect / sourceAspect);
        const visibleFraction = 1 / aspectRatioDelta;
        if (aspectRatioDelta > 4) mediaAspectViolations.push(`${slide.id}:${name}:${aspectRatioDelta.toFixed(2)}`);
        if (fit === 'cover' && 1 - visibleFraction > 0.25) cropViolations.push(`${slide.id}:${name}:${(1 - visibleFraction).toFixed(2)}`);
        if (fit === 'contain' && visibleFraction < 0.25) whitespaceViolations.push(`${slide.id}:${name}:media_coverage_${visibleFraction.toFixed(2)}`);
      } else if (fit === 'cover') cropViolations.push(`${slide.id}:${name}:unverified`);
    }
  }

  for (let index = 0; index < occupied.length; index += 1) {
    for (let other = index + 1; other < occupied.length; other += 1) {
      const a = occupied[index]; const b = occupied[other];
      if (/FULL_BLEED/.test(a.name) || /FULL_BLEED/.test(b.name)) continue;
      if (intersectionArea(a.box, b.box) > 1) overlaps.push(`${slide.id}:${a.name}+${b.name}`);
    }
  }

  const mediaNames = occupied.filter((item) => isMediaSlot(item.name, item.value)).map((item) => item.name);
  const balanceViolations = [];
  if (slide.template_id === 'DUAL_MEDIA' && mediaNames.length !== 2) balanceViolations.push(`${slide.id}:dual_media_requires_two`);
  if (slide.template_id === 'GALLERY' && mediaNames.length < 2) balanceViolations.push(`${slide.id}:gallery_requires_two`);
  if (slide.template_id === 'COMPARISON') {
    const hasA = occupied.some((item) => /_A_/.test(item.name));
    const hasB = occupied.some((item) => /_B_/.test(item.name));
    if (!hasA || !hasB) balanceViolations.push(`${slide.id}:comparison_requires_both_sides`);
  }
  if (!occupied.length || canvasWidth * canvasHeight > 0 && occupiedArea / (canvasWidth * canvasHeight) < 0.005) {
    whitespaceViolations.push(`${slide.id}:insufficient_occupied_area`);
  }

  return {
    outside_canvas: outsideCanvas,
    overlaps,
    crop_violations: cropViolations,
    media_aspect_violations: mediaAspectViolations,
    alignment_violations: alignmentViolations,
    balance_violations: balanceViolations,
    whitespace_violations: whitespaceViolations,
    minimum_font_violations: minimumFontViolations,
  };
}

function validatePresentationQuality(deck, ir) {
  const structural = validateDeck(deck);
  let overflowCount = 0;
  const overflowSlots = [];
  let seamViolationCount = 0;
  let minimumFontPt = Infinity;
  let orphanContinuationCount = 0;
  const reviewRequired = [];
  const geometry = {
    outside_canvas: [], overlaps: [], crop_violations: [], media_aspect_violations: [],
    alignment_violations: [], balance_violations: [], whitespace_violations: [], minimum_font_violations: [],
  };
  const sourceAspects = sourceMediaAspects(ir);
  for (const slide of deck?.slides || []) {
    let occupied = 0;
    const layout = getLayout(deck.wall_profile, slide.template_id);
    for (const [name, value] of Object.entries(slide.slots || {})) {
      const object = layout.named_objects[name];
      const style = styleForObject(name);
      minimumFontPt = Math.min(minimumFontPt, style.font_size_pt);
      if (textLength(value) > estimatedCapacity(object?.bbox_px, style)) {
        overflowCount += 1;
        overflowSlots.push(`${slide.id}:${name}`);
      }
      if (value != null && value !== '') occupied += 1;
      if (!/FULL_BLEED|BACKGROUND|PANEL|BOX|BLOCK/.test(name)) {
        for (const gutter of (getProfile(deck.wall_profile).critical_content_exclusion_gutters_px || [])) {
          if (intersectsGutter(object?.bbox_px, gutter)) seamViolationCount += 1;
        }
      }
    }
    if (slide.template_id === 'CONTINUATION' && occupied <= 1) orphanContinuationCount += 1;
    const slideGeometry = evaluateSlideGeometry(slide, layout, getProfile(deck.wall_profile), sourceAspects);
    for (const key of Object.keys(geometry)) geometry[key].push(...slideGeometry[key]);
  }
  const sourceCount = Math.max(1, Array.isArray(ir?.slides) ? ir.slides.length : 0);
  const expansion = Number(((deck?.slides?.length || 0) / sourceCount).toFixed(2));
  const sourceAccounting = Number(deck?.conversion?.source_accounting_percent) || 0;
  const sourceSlides = new Map((ir?.slides || []).map((slide) => [Number(slide.source_slide_number), slide]));
  const exceptionalDensity = [];
  const unjustifiedExpansion = [];
  const hardExpansion = [];
  for (const mapping of deck?.conversion?.source_slide_mappings || []) {
    const outputCount = new Set(mapping?.output_slide_ids || []).size;
    if (outputCount < 3) continue;
    const sourceNumber = Number(mapping.source_slide_number);
    const sourceElements = elementsOf(sourceSlides.get(sourceNumber));
    const characters = sourceElements.reduce((sum, element) => sum
      + String(element.text || '').length
      + (Array.isArray(element.items) ? element.items.join('').length : 0)
      + (Array.isArray(element.rows) ? element.rows.flat().join('').length : 0), 0);
    const dense = characters > 2000 || sourceElements.length > 6;
    const label = `${sourceNumber}(${outputCount})`;
    if (outputCount > 6) hardExpansion.push(label);
    else if (dense) exceptionalDensity.push(label);
    else unjustifiedExpansion.push(label);
  }
  if (unjustifiedExpansion.length) reviewRequired.push(`SLIDE_EXPANSION_QUALITY_GATE:${unjustifiedExpansion.join(',')}`);
  if (hardExpansion.length) reviewRequired.push(`SLIDE_EXPANSION_HARD_LIMIT:${hardExpansion.join(',')}`);
  if (exceptionalDensity.length) reviewRequired.push(`EXCEPTIONAL_DENSITY_CONTINUATIONS:${exceptionalDensity.join(',')}`);
  if (orphanContinuationCount) reviewRequired.push('ORPHAN_CONTINUATION_REVIEW');
  const hardRejects = [];
  for (const [key, values] of Object.entries(geometry)) {
    if (values.length) hardRejects.push(`${key.toUpperCase()}:${values.join(',')}`);
  }
  return {
    valid: structural.valid && sourceAccounting === 100 && overflowCount === 0
      && seamViolationCount === 0 && unjustifiedExpansion.length === 0 && hardExpansion.length === 0
      && hardRejects.length === 0,
    source_accounting: sourceAccounting,
    slide_expansion_ratio: expansion,
    overflow_count: overflowCount,
    overflow_slots: overflowSlots,
    seam_violation_count: seamViolationCount,
    orphan_continuation_count: orphanContinuationCount,
    minimum_font_pt: Number.isFinite(minimumFontPt) ? minimumFontPt : 15,
    outside_canvas_count: geometry.outside_canvas.length,
    overlap_count: geometry.overlaps.length,
    crop_violation_count: geometry.crop_violations.length,
    media_aspect_violation_count: geometry.media_aspect_violations.length,
    alignment_violation_count: geometry.alignment_violations.length,
    balance_violation_count: geometry.balance_violations.length,
    whitespace_violation_count: geometry.whitespace_violations.length,
    minimum_font_violation_count: geometry.minimum_font_violations.length,
    hard_rejects: hardRejects,
    review_required: reviewRequired,
    structural_errors: structural.errors,
  };
}

module.exports = {
  buildSlideCompositionIr,
  rankCandidateLayouts,
  validatePresentationQuality,
  estimatedCapacity,
  evaluateSlideGeometry,
};
