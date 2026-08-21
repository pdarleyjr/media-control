'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const unzipper = require('unzipper');

const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 1024 * 1024 * 1024,
  maxEntries: 5000,
  maxTotalUncompressedBytes: 2 * 1024 * 1024 * 1024,
  maxEntryBytes: 512 * 1024 * 1024,
  maxXmlBytes: 24 * 1024 * 1024,
});

const SAFE_EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

function validateEntryName(name) {
  const value = String(name || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!value || value.includes('\0') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) throw new Error('Unsafe package entry path');
  const segments = value.split('/');
  if (segments.some((segment) => segment === '..' || segment === '')) throw new Error('Unsafe package entry path');
  return value;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function validateXml(xml) {
  const value = String(xml || '');
  if (/<!DOCTYPE|<!ENTITY|<\s*(?:xi:)?include\b/i.test(value)) throw new Error('Unsafe XML declaration (DOCTYPE/ENTITY/include)');
  return value;
}

function validateRelationshipTarget(target, targetMode = 'Internal') {
  const value = decodeXml(target).trim();
  if (!value || value.includes('\0')) throw new Error('Unsafe empty relationship target');
  if (String(targetMode).toLowerCase() === 'external') {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error('Unsafe external relationship target'); }
    if (!SAFE_EXTERNAL_PROTOCOLS.has(parsed.protocol.toLowerCase())) throw new Error('Unsafe external relationship protocol');
    return value;
  }
  const normalized = value.replace(/\\/g, '/');
  // OOXML legitimately uses relative targets such as ../media/image1.png.
  // resolveInternalTarget performs the decisive package-root containment check.
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error('Unsafe internal relationship target');
  }
  return normalized;
}

function unavailableExternalFileReference(target) {
  const value = decodeXml(target).trim();
  if (!/^(?:file:|[A-Za-z]:[\\/]|\\\\)/i.test(value)) return null;
  const normalized = value.replace(/\\/g, '/').replace(/[?#].*$/, '').replace(/\/+$/, '');
  const filename = decodeURIComponent(normalized.split('/').pop() || 'linked media').replace(/[\r\n\t]/g, ' ').slice(0, 180);
  return `[external file unavailable] ${filename || 'linked media'}`;
}

function attrs(fragment) {
  const out = {};
  for (const match of String(fragment || '').matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(["'])(.*?)\2/gs)) out[match[1]] = decodeXml(match[3]);
  return out;
}

function relsPath(partPath) {
  const dir = path.posix.dirname(partPath);
  const base = path.posix.basename(partPath);
  return path.posix.join(dir, '_rels', `${base}.rels`);
}

function resolveInternalTarget(partPath, target) {
  const validated = validateRelationshipTarget(target, 'Internal');
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(partPath), validated));
  if (resolved.startsWith('../') || path.posix.isAbsolute(resolved)) throw new Error('Unsafe resolved relationship path');
  return validateEntryName(resolved);
}

function parseRelationships(xml, ownerPath) {
  const relationships = [];
  for (const match of validateXml(xml).matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?\s*>/gi)) {
    const a = attrs(match[1]);
    if (!a.Id || !a.Target) continue;
    const external = String(a.TargetMode || '').toLowerCase() === 'external';
    const unavailableExternal = external ? unavailableExternalFileReference(a.Target) : null;
    const target = unavailableExternal || validateRelationshipTarget(a.Target, external ? 'External' : 'Internal');
    relationships.push({
      id: a.Id,
      type: a.Type || '',
      target,
      target_mode: external ? 'External' : 'Internal',
      resolved_target: external ? target : resolveInternalTarget(ownerPath, target),
      unavailable_external: Boolean(unavailableExternal),
    });
  }
  return relationships;
}

function extensionKind(packagePath, relationshipType = '') {
  const ext = path.posix.extname(String(packagePath || '')).toLowerCase();
  if (/video/.test(relationshipType) || ['.mp4', '.mov', '.m4v', '.webm', '.avi', '.wmv'].includes(ext)) return 'video';
  if (/audio/.test(relationshipType) || ['.mp3', '.m4a', '.wav', '.aac', '.ogg', '.wma'].includes(ext)) return 'audio';
  if (/image/.test(relationshipType) || ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.emf', '.wmf', '.svg'].includes(ext)) return 'image';
  return 'binary';
}

function extractText(fragment) {
  return Array.from(String(fragment || '').matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/gi), (match) => decodeXml(match[1])).join('');
}

function extractBox(fragment) {
  const off = String(fragment).match(/<a:off\b([^>]*)\/?\s*>/i);
  const ext = String(fragment).match(/<a:ext\b([^>]*)\/?\s*>/i);
  if (!off || !ext) return null;
  const o = attrs(off[1]);
  const e = attrs(ext[1]);
  return { x: Number(o.x) || 0, y: Number(o.y) || 0, w: Number(e.cx) || 0, h: Number(e.cy) || 0 };
}

function parseShape(shapeXml, relationships, slideNumber, elementIndex) {
  const properties = shapeXml.match(/<p:cNvPr\b([^>]*)>/i);
  const ph = shapeXml.match(/<p:ph\b([^>]*)\/?\s*>/i);
  const pAttrs = properties ? attrs(properties[1]) : {};
  const phAttrs = ph ? attrs(ph[1]) : {};
  const paragraphs = Array.from(shapeXml.matchAll(/<a:p(?:\s[^>]*)?>([\s\S]*?)<\/a:p>/gi), (match) => match[1]);
  const textParagraphs = paragraphs.map((paragraph) => {
    const pPr = paragraph.match(/<a:pPr\b([^>]*)>/i);
    return {
      text: extractText(paragraph).trim(),
      bullet: /<a:(?:buChar|buAutoNum)\b/i.test(paragraph),
      level: Number(pPr ? attrs(pPr[1]).lvl : 0) || 0,
    };
  }).filter((paragraph) => paragraph.text);
  const box = extractBox(shapeXml);
  const id = `s${slideNumber}-obj-${pAttrs.id || elementIndex}`;
  const presetGeometry = shapeXml.match(/<a:prstGeom\b([^>]*)>/i);
  const preset = presetGeometry ? String(attrs(presetGeometry[1]).prst || '').toLowerCase() : '';
  const complexGeometry = /<a:custGeom\b/i.test(shapeXml) || Boolean(preset && preset !== 'rect');
  if (!textParagraphs.length) {
    if (ph || !complexGeometry && !preset) return null;
    return {
      id,
      kind: 'graphic',
      text: '',
      bbox_emu: box,
      source_name: pAttrs.name || null,
      source_geometry: preset || (/a:custGeom/i.test(shapeXml) ? 'custom' : null),
    };
  }
  const bulletParagraphs = textParagraphs.filter((paragraph) => paragraph.bullet);
  const hyperlinkIds = Array.from(shapeXml.matchAll(/<a:hlinkClick\b([^>]*)>/gi), (match) => attrs(match[1])['r:id']).filter(Boolean);
  const hyperlinkRelationships = hyperlinkIds.map((relId) => relationships.find((rel) => rel.id === relId)).filter(Boolean);
  return {
    id,
    kind: complexGeometry ? 'graphic' : (bulletParagraphs.length ? 'bullets' : 'paragraph'),
    text: bulletParagraphs.length ? undefined : textParagraphs.map((paragraph) => paragraph.text).join('\n'),
    items: bulletParagraphs.length ? bulletParagraphs.map((paragraph) => paragraph.text) : undefined,
    paragraphs: textParagraphs,
    bbox_emu: box,
    style: {},
    semantic_role: phAttrs.type || null,
    source_name: pAttrs.name || null,
    source_geometry: complexGeometry ? (preset || 'custom') : null,
    hyperlinks: hyperlinkRelationships.map((rel) => rel.target),
  };
}

function parseConnector(connectorXml, relationships, slideNumber, elementIndex) {
  const parsed = parseShape(connectorXml, relationships, slideNumber, elementIndex);
  if (parsed) {
    parsed.kind = 'graphic';
    parsed.source_geometry = parsed.source_geometry || 'connector';
    return parsed;
  }
  const properties = connectorXml.match(/<p:cNvPr\b([^>]*)>/i);
  const pAttrs = properties ? attrs(properties[1]) : {};
  return {
    id: `s${slideNumber}-obj-${pAttrs.id || elementIndex}`,
    kind: 'graphic',
    text: extractText(connectorXml).trim(),
    bbox_emu: extractBox(connectorXml),
    source_name: pAttrs.name || null,
    source_geometry: 'connector',
  };
}

function parsePicture(pictureXml, relationships, slideNumber, elementIndex) {
  const properties = pictureXml.match(/<p:cNvPr\b([^>]*)>/i);
  const pAttrs = properties ? attrs(properties[1]) : {};
  const blip = pictureXml.match(/<a:blip\b([^>]*)>/i);
  const bAttrs = blip ? attrs(blip[1]) : {};
  const relId = bAttrs['r:embed'] || bAttrs['r:link'];
  const rel = relationships.find((candidate) => candidate.id === relId);
  return {
    id: `s${slideNumber}-obj-${pAttrs.id || elementIndex}`,
    kind: rel ? extensionKind(rel.resolved_target, rel.type) : 'image',
    asset_ref: rel && rel.target_mode === 'Internal' ? `asset:${rel.resolved_target}` : null,
    url: rel && rel.target_mode === 'External' && !rel.unavailable_external ? rel.target : null,
    external: Boolean(rel && rel.target_mode === 'External'),
    bbox_emu: extractBox(pictureXml),
    source_name: pAttrs.name || null,
    description: pAttrs.descr || '',
  };
}

function parseGraphicFrame(frameXml, slideNumber, elementIndex) {
  const table = /<a:tbl\b/i.test(frameXml);
  const chart = /\/chart["']|<c:chart\b/i.test(frameXml);
  const diagram = /\/diagram|<dgm:/i.test(frameXml);
  const rows = table
    ? Array.from(frameXml.matchAll(/<a:tr(?:\s[^>]*)?>([\s\S]*?)<\/a:tr>/gi), (row) => Array.from(row[1].matchAll(/<a:tc(?:\s[^>]*)?>([\s\S]*?)<\/a:tc>/gi), (cell) => extractText(cell[1])))
    : undefined;
  return {
    id: `s${slideNumber}-obj-${elementIndex}`,
    kind: table ? 'table' : chart ? 'chart' : diagram ? 'smartart' : 'graphic',
    rows,
    text: !table ? extractText(frameXml) : undefined,
    bbox_emu: extractBox(frameXml),
  };
}

function parseMediaElements(slideXml, relationships, slideNumber, startIndex) {
  const elements = [];
  const seen = new Set();
  const pictures = Array.from(String(slideXml).matchAll(/<p:pic(?:\s[^>]*)?>([\s\S]*?)<\/p:pic>/gi), (match) => match[0]);
  let elementIndex = startIndex;
  for (const rel of relationships) {
    const kind = extensionKind(rel.resolved_target, rel.type);
    if (!['video', 'audio'].includes(kind)) continue;
    const key = `${kind}:${rel.resolved_target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const picture = pictures.find((fragment) => fragment.includes(`r:link="${rel.id}"`) || fragment.includes(`r:embed="${rel.id}"`));
    const youtube = kind === 'video' && /(?:youtube\.com|youtu\.be)/i.test(rel.target);
    elements.push({
      id: `s${slideNumber}-obj-${++elementIndex}`,
      kind: youtube ? 'youtube' : kind,
      asset_ref: rel.target_mode === 'Internal' ? `asset:${rel.resolved_target}` : null,
      url: rel.target_mode === 'External' && !rel.unavailable_external ? rel.target : null,
      external: rel.target_mode === 'External',
      bbox_emu: picture ? extractBox(picture) : null,
      caption: path.posix.basename(rel.resolved_target || `${kind} media`),
    });
  }
  return elements;
}

async function entryText(entry, limits) {
  const size = Number(entry.vars && entry.vars.uncompressedSize) || Number(entry.uncompressedSize) || 0;
  if (size > limits.maxXmlBytes) throw new Error(`XML entry exceeds limit: ${entry.path}`);
  const buffer = await entry.buffer();
  if (buffer.length > limits.maxXmlBytes) throw new Error(`XML entry exceeds limit: ${entry.path}`);
  return validateXml(buffer.toString('utf8'));
}

async function openSafePackage(filePath, customLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...customLimits };
  const stat = await fs.promises.stat(filePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error('PPTX package is empty');
  if (stat.size > limits.maxArchiveBytes) throw new Error('PPTX package archive size exceeds limit');
  const archive = await unzipper.Open.file(filePath);
  if (archive.files.length > limits.maxEntries) throw new Error('PPTX package entry count exceeds limit');
  let total = 0;
  for (const entry of archive.files) {
    validateEntryName(entry.path);
    const size = Number(entry.vars && entry.vars.uncompressedSize) || Number(entry.uncompressedSize) || 0;
    if (size > limits.maxEntryBytes) throw new Error(`PPTX package entry exceeds limit: ${entry.path}`);
    total += size;
    if (total > limits.maxTotalUncompressedBytes) throw new Error('PPTX package decompressed size exceeds limit');
  }
  const entries = new Map();
  for (const entry of archive.files.filter((candidate) => candidate.type !== 'Directory')) {
    if (entries.has(entry.path)) throw new Error(`PPTX package contains duplicate entry: ${entry.path}`);
    entries.set(entry.path, entry);
  }
  return { archive, entries, limits };
}

async function extractPptxToSlideIr(filePath, options = {}) {
  const { entries, limits } = await openSafePackage(filePath, options.limits);
  const presentationEntry = entries.get('ppt/presentation.xml');
  const presentationRelsEntry = entries.get('ppt/_rels/presentation.xml.rels');
  if (!presentationEntry || !presentationRelsEntry) throw new Error('Malformed PPTX: presentation parts missing');
  const presentationXml = await entryText(presentationEntry, limits);
  const presentationRels = parseRelationships(await entryText(presentationRelsEntry, limits), 'ppt/presentation.xml');
  const dimensions = presentationXml.match(/<p:sldSz\b([^>]*)>/i);
  const sizeAttrs = dimensions ? attrs(dimensions[1]) : {};
  const slideIds = Array.from(presentationXml.matchAll(/<p:sldId\b([^>]*)>/gi), (match) => attrs(match[1])['r:id']).filter(Boolean);
  const assetsByPath = new Map();
  const slides = [];

  for (let index = 0; index < slideIds.length; index += 1) {
    const presentationRel = presentationRels.find((rel) => rel.id === slideIds[index]);
    if (!presentationRel || presentationRel.target_mode === 'External') throw new Error(`Malformed PPTX: slide ${index + 1} relationship missing`);
    const slidePath = presentationRel.resolved_target;
    const slideEntry = entries.get(slidePath);
    if (!slideEntry) throw new Error(`Malformed PPTX: ${slidePath} missing`);
    const slideXml = await entryText(slideEntry, limits);
    const slideRelsEntry = entries.get(relsPath(slidePath));
    const relationships = slideRelsEntry ? parseRelationships(await entryText(slideRelsEntry, limits), slidePath) : [];
    const elements = [];
    let elementIndex = 0;
    for (const match of slideXml.matchAll(/<p:sp(?:\s[^>]*)?>([\s\S]*?)<\/p:sp>/gi)) {
      const element = parseShape(match[0], relationships, index + 1, ++elementIndex);
      if (element) elements.push(element);
    }
    for (const match of slideXml.matchAll(/<p:cxnSp(?:\s[^>]*)?>([\s\S]*?)<\/p:cxnSp>/gi)) {
      elements.push(parseConnector(match[0], relationships, index + 1, ++elementIndex));
    }
    for (const match of slideXml.matchAll(/<p:pic(?:\s[^>]*)?>([\s\S]*?)<\/p:pic>/gi)) {
      const element = parsePicture(match[0], relationships, index + 1, ++elementIndex);
      elements.push(element);
    }
    for (const match of slideXml.matchAll(/<p:graphicFrame(?:\s[^>]*)?>([\s\S]*?)<\/p:graphicFrame>/gi)) {
      elements.push(parseGraphicFrame(match[0], index + 1, ++elementIndex));
    }
    const mediaElements = parseMediaElements(slideXml, relationships, index + 1, elementIndex);
    elements.push(...mediaElements); elementIndex += mediaElements.length;
    const warnings = [];
    if (elements.some((element) => element.kind === 'graphic')) warnings.push('Vector shapes require rendered-fallback review');
    for (const match of slideXml.matchAll(/<p:grpSp(?:\s[^>]*)?>([\s\S]*?)<\/p:grpSp>/gi)) {
      elements.push({ id: `s${index + 1}-obj-${++elementIndex}`, kind: 'group', text: extractText(match[0]), bbox_emu: extractBox(match[0]) });
    }
    if (/<p:grpSp\b/i.test(slideXml)) warnings.push('Grouped shapes require rendered-fallback review');
    const oleRelationships = relationships.filter((rel) => /oleObject|package/i.test(rel.type));
    if (/<p:oleObj\b|oleObject|\/oleObject/i.test(slideXml) || oleRelationships.length) {
      elements.push({ id: `s${index + 1}-obj-${++elementIndex}`, kind: 'ole', text: 'Embedded OLE/package object', external: oleRelationships.some((rel) => rel.target_mode === 'External'), bbox_emu: null });
      warnings.push('OLE object preserved as inert data; execution is disabled');
    }
    if (relationships.some((rel) => rel.target_mode === 'External' && /audio|video|media/i.test(rel.type))) warnings.push('External linked media unavailable — source file required');
    for (const rel of relationships) {
      if (rel.target_mode !== 'Internal') continue;
      const kind = extensionKind(rel.resolved_target, rel.type);
      if (kind === 'binary') continue;
      const mediaEntry = entries.get(rel.resolved_target);
      if (!mediaEntry) { warnings.push(`Missing embedded media relationship: ${rel.resolved_target}`); continue; }
      if (!assetsByPath.has(rel.resolved_target)) {
        const size = Number(mediaEntry.vars && mediaEntry.vars.uncompressedSize) || 0;
        assetsByPath.set(rel.resolved_target, {
          id: `asset:${rel.resolved_target}`,
          kind,
          package_path: rel.resolved_target,
          filename: path.posix.basename(rel.resolved_target),
          size_bytes: size,
          sha256: null,
        });
      }
    }
    let speakerNotes = '';
    const notesRel = relationships.find((rel) => /notesSlide$/.test(rel.type));
    if (notesRel && notesRel.target_mode === 'Internal' && entries.has(notesRel.resolved_target)) {
      speakerNotes = extractText(await entryText(entries.get(notesRel.resolved_target), limits)).trim();
    }
    const titleElement = elements.find((element) => ['title', 'ctrTitle'].includes(element.semantic_role))
      || elements.find((element) => element.kind === 'paragraph');
    const title = titleElement ? String(titleElement.text || titleElement.items && titleElement.items.join(' ') || '') : '';
    const relationRecords = relationships.filter((rel) => rel.target_mode === 'External').map((rel) => ({
      id: rel.id,
      kind: /hyperlink/i.test(rel.type) ? 'hyperlink' : extensionKind(rel.target, rel.type),
      target: rel.target,
      external: true,
      unavailable_external: rel.unavailable_external === true,
    }));
    slides.push({
      source_slide_number: index + 1,
      title,
      elements,
      speaker_notes: speakerNotes,
      relationships: relationRecords,
      warnings,
    });
  }

  return {
    schema_version: 'mbfd-slide-ir-v1',
    source: { filename: path.basename(filePath), format: 'pptx' },
    source_dimensions_emu: { w: Number(sizeAttrs.cx) || 0, h: Number(sizeAttrs.cy) || 0 },
    slides,
    assets: Array.from(assetsByPath.values()),
  };
}

async function extractAssetBuffer(filePath, packagePath, options = {}) {
  const { entries, limits } = await openSafePackage(filePath, options.limits);
  const safePath = validateEntryName(packagePath);
  const entry = entries.get(safePath);
  if (!entry) throw new Error('Embedded asset not found');
  const buffer = await entry.buffer();
  if (buffer.length > limits.maxEntryBytes) throw new Error('Embedded asset exceeds extraction limit');
  return { buffer, sha256: crypto.createHash('sha256').update(buffer).digest('hex') };
}

module.exports = {
  DEFAULT_LIMITS,
  validateEntryName,
  validateRelationshipTarget,
  validateXml,
  parseRelationships,
  extractPptxToSlideIr,
  extractAssetBuffer,
};
