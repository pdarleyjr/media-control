'use strict';

const { SOURCE_SPEC } = require('./presentation-template-registry');

const PX_PER_PT = 3;

function hex(value, fallback) {
  const color = String(value || '').replace(/^#/, '').toUpperCase();
  return /^[0-9A-F]{6}$/.test(color) ? color : fallback;
}

function styleForObject(name) {
  const objectName = String(name || '');
  const colors = SOURCE_SPEC.theme.colors;
  const style = {
    semantic_role: 'global',
    font_face: SOURCE_SPEC.theme.font_body,
    font_size_pt: 15,
    bold: false,
    color: hex(colors.white, 'F7FAFD'),
    align: 'left',
    valign: 'mid',
    line_height: 1.22,
    padding_px: { top: 12, right: 18, bottom: 12, left: 18 },
  };
  if (/SECTION_TITLE/.test(objectName)) Object.assign(style, { semantic_role: 'section_title', font_face: SOURCE_SPEC.theme.font_heading, font_size_pt: 40, bold: true, color: hex(colors.gold, 'E8B33D'), align: 'center', line_height: 1.02 });
  else if (/(^|_)TITLE$/.test(objectName)) Object.assign(style, { semantic_role: 'title', font_face: SOURCE_SPEC.theme.font_heading, font_size_pt: 30, bold: true, line_height: 1.05 });
  else if (/SUBTITLE/.test(objectName)) Object.assign(style, { semantic_role: 'subtitle', font_size_pt: 15 });
  else if (/BULLET/.test(objectName)) Object.assign(style, { semantic_role: 'bullet', font_size_pt: 18 });
  else if (/TABLE_TEXT/.test(objectName)) Object.assign(style, { semantic_role: 'table', font_size_pt: 15, valign: 'top', line_height: 1.18 });
  else if (/PARAGRAPH|_BODY|QUOTE_TEXT/.test(objectName)) Object.assign(style, { semantic_role: 'body', font_size_pt: 17, valign: 'top', line_height: 1.3 });
  else if (/TAKEAWAY_TEXT/.test(objectName)) Object.assign(style, { semantic_role: 'takeaway', font_size_pt: 17, bold: true });
  else if (/SLIDE_NUMBER|SECTION_NUMBER/.test(objectName)) Object.assign(style, { semantic_role: 'number', font_face: SOURCE_SPEC.theme.font_heading, font_size_pt: 22, bold: true, align: 'center' });
  else if (/HEADER_MIAMI_BEACH/.test(objectName)) Object.assign(style, { semantic_role: 'header', font_face: SOURCE_SPEC.theme.font_heading, font_size_pt: 17, bold: true });
  else if (/HEADER_FIRE_DEPARTMENT/.test(objectName)) Object.assign(style, { semantic_role: 'header', font_face: SOURCE_SPEC.theme.font_heading, font_size_pt: 22, bold: true });
  else if (/CAPTION|COURSE_SECTION|PRESENTATION_TITLE|SLIDE_LABEL/.test(objectName)) Object.assign(style, { semantic_role: 'caption', font_size_pt: 15 });
  style.font_size_px = style.font_size_pt * PX_PER_PT;
  style.padding_in = Object.fromEntries(Object.entries(style.padding_px).map(([key, value]) => [key, value / 216]));
  return style;
}

function pptxTextStyle(name) {
  const style = styleForObject(name);
  return {
    fontFace: style.font_face,
    fontSize: style.font_size_pt,
    bold: style.bold,
    color: style.color,
    align: style.align,
    valign: style.valign,
    margin: [style.padding_in.top, style.padding_in.right, style.padding_in.bottom, style.padding_in.left],
    breakLine: style.semantic_role === 'body' || style.semantic_role === 'table',
  };
}

module.exports = { PX_PER_PT, styleForObject, pptxTextStyle };


