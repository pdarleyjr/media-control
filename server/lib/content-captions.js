'use strict';

const path = require('path');

const MAX_CAPTION_BYTES = 2 * 1024 * 1024;
const MAX_CUES = 10_000;
const TIMING_LINE = /^((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})\s+-->\s+((?:\d{2,}:)?\d{2}:\d{2}[.,]\d{3})(?:\s+.*)?$/;

function captionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function timestampMs(value) {
  const parts = String(value || '').replace(',', '.').split(':');
  if (parts.length !== 2 && parts.length !== 3) return null;
  const secondsPart = parts.pop();
  const minutes = Number(parts.pop());
  const hours = parts.length ? Number(parts.pop()) : 0;
  const seconds = Number(secondsPart);
  if (
    !Number.isInteger(hours) || hours < 0
    || !Number.isInteger(minutes) || minutes < 0 || minutes > 59
    || !Number.isFinite(seconds) || seconds < 0 || seconds >= 60
  ) return null;
  return ((hours * 3600) + (minutes * 60) + seconds) * 1000;
}

function validateTimingLine(line) {
  const match = String(line || '').match(TIMING_LINE);
  if (!match) return false;
  const start = timestampMs(match[1]);
  const end = timestampMs(match[2]);
  return start !== null && end !== null && end > start;
}

function normalizeLines(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw captionError('caption_empty');
  if (buffer.length > MAX_CAPTION_BYTES) throw captionError('caption_too_large');
  if (buffer.includes(0)) throw captionError('caption_binary');
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw captionError('caption_encoding_invalid');
  }
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (text.split('\n').some(line => line.length > 16_384)) {
    throw captionError('caption_line_too_long');
  }
  return text.trim();
}

function cueCount(text) {
  let count = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('-->')) continue;
    if (!validateTimingLine(line)) throw captionError('caption_invalid_timing');
    count += 1;
    if (count > MAX_CUES) throw captionError('caption_too_many_cues');
  }
  if (!count) throw captionError('caption_invalid');
  return count;
}

function srtToVtt(text) {
  const blocks = text.split(/\n{2,}/).map(block => block.trim()).filter(Boolean);
  const output = ['WEBVTT', ''];
  let cues = 0;
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0]?.trim() || '')) lines.shift();
    if (!lines.length || !lines[0].includes('-->')) throw captionError('caption_invalid');
    const timing = lines.shift().replace(/,/g, '.');
    if (!validateTimingLine(timing)) throw captionError('caption_invalid_timing');
    if (!lines.some(line => line.trim())) throw captionError('caption_empty_cue');
    output.push(timing, ...lines, '');
    cues += 1;
    if (cues > MAX_CUES) throw captionError('caption_too_many_cues');
  }
  if (!cues) throw captionError('caption_invalid');
  return { body: `${output.join('\n').trimEnd()}\n`, cue_count: cues };
}

function searchableCaptionText(vtt) {
  const values = [];
  let inNote = false;
  for (const rawLine of String(vtt || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) {
      inNote = false;
      continue;
    }
    if (/^NOTE(?:\s|$)/.test(line)) {
      inNote = true;
      continue;
    }
    if (
      inNote
      || line === 'WEBVTT'
      || line.includes('-->')
      || /^\d+$/.test(line)
      || /^(STYLE|REGION)(?:\s|$)/.test(line)
    ) continue;
    values.push(line.replace(/<[^>]*>/g, ' '));
  }
  return values.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1_000_000);
}

function normalizeCaption(buffer, { filename = '' } = {}) {
  const text = normalizeLines(buffer);
  const extension = path.extname(String(filename || '')).toLowerCase();
  if (extension !== '.vtt' && extension !== '.srt') {
    throw captionError('caption_extension_invalid');
  }
  if (extension === '.srt') {
    const converted = srtToVtt(text);
    return {
      format: 'vtt',
      source_format: 'srt',
      body: converted.body,
      cue_count: converted.cue_count,
      search_text: searchableCaptionText(converted.body),
    };
  }
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(text)) throw captionError('caption_invalid');
  const body = `${text}\n`;
  return {
    format: 'vtt',
    source_format: 'vtt',
    body,
    cue_count: cueCount(body),
    search_text: searchableCaptionText(body),
  };
}

function publicCaption(row) {
  return {
    id: String(row.id),
    language_code: row.language_code,
    label: row.label,
    kind: row.kind,
    is_default: Number(row.is_default) === 1,
    source_type: row.source_type,
    source_format: row.source_format,
    cue_count: Number(row.cue_count) || 0,
    url: `/api/captions/${encodeURIComponent(String(row.id))}/file`,
  };
}

function captionsForContent(db, contentId) {
  try {
    return db.prepare(`
      SELECT id, language_code, label, kind, is_default, source_type,
             source_format, cue_count
      FROM content_captions
      WHERE content_id=?
      ORDER BY is_default DESC, language_code, created_at, id
    `).all(String(contentId || '')).map(publicCaption);
  } catch {
    return [];
  }
}

function attachCaptionsToItems(db, items) {
  return (Array.isArray(items) ? items : []).map(item => {
    if (!item?.content_id) return item;
    return { ...item, captions: captionsForContent(db, item.content_id) };
  });
}

module.exports = {
  MAX_CAPTION_BYTES,
  attachCaptionsToItems,
  captionsForContent,
  normalizeCaption,
  publicCaption,
  searchableCaptionText,
  timestampMs,
};
