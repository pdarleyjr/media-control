'use strict';

const fs = require('fs');
const path = require('path');

const GENERIC_MIMES = new Set([
  '',
  'application/octet-stream',
  'binary/octet-stream',
  'application/zip',
  'application/x-zip-compressed',
]);

const ACTIVE_CONTENT_MIMES = new Set([
  'text/html',
  'application/xhtml+xml',
  'application/javascript',
  'text/javascript',
  'image/svg+xml',
]);

const EXTENSION_MIMES = Object.freeze({
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
});

const MIME_ALIASES = Object.freeze({
  'video/avi': 'video/x-msvideo',
  'video/mkv': 'video/x-matroska',
  'video/mov': 'video/quicktime',
  'image/jpg': 'image/jpeg',
});

const MAX_SNIFF_BYTES = 64 * 1024;
const DEFAULT_MAX_SOURCE_BYTES = 4 * 1024 * 1024 * 1024;
const DEFAULT_MAX_IMAGE_PIXELS = 100 * 1000 * 1000;
const DEFAULT_MAX_DURATION_SECONDS = 6 * 60 * 60;

function canonicalMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return MIME_ALIASES[mime] || mime;
}

function isActiveContentMime(value) {
  return ACTIVE_CONTENT_MIMES.has(canonicalMime(value));
}

function startsWith(buffer, signature) {
  return buffer.length >= signature.length && buffer.subarray(0, signature.length).equals(signature);
}

function bmffBrand(buffer) {
  if (buffer.length < 12 || buffer.toString('ascii', 4, 8) !== 'ftyp') return null;
  return buffer.toString('ascii', 8, Math.min(buffer.length, 32)).toLowerCase();
}

function detectMediaMime(bytes, { filename = '' } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '');
  if (startsWith(buffer, Buffer.from([0xff, 0xd8, 0xff]))) return 'image/jpeg';
  if (startsWith(buffer, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer.length >= 6 && ['GIF87a', 'GIF89a'].includes(buffer.toString('ascii', 0, 6))) return 'image/gif';
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF') {
    const kind = buffer.toString('ascii', 8, 12);
    if (kind === 'WEBP') return 'image/webp';
    if (kind === 'AVI ') return 'video/x-msvideo';
    if (kind === 'WAVE') return 'audio/wav';
  }
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buffer.length >= 2 && buffer.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') return 'application/pdf';

  const brand = bmffBrand(buffer);
  if (brand) {
    if (/(?:avif|avis)/.test(brand)) return 'image/avif';
    if (/(?:heic|heix|hevc|hevx|heif|mif1|msf1)/.test(brand)) return 'image/heic';
    if (brand.startsWith('qt')) return 'video/quicktime';
    return 'video/mp4';
  }
  if (startsWith(buffer, Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    const header = buffer.subarray(0, Math.min(buffer.length, 4096)).toString('latin1').toLowerCase();
    return header.includes('webm') ? 'video/webm' : 'video/x-matroska';
  }

  const text = buffer.subarray(0, Math.min(buffer.length, 4096))
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart()
    .toLowerCase();
  if (/^(?:<!doctype\s+html|<html\b|<head\b|<body\b)/i.test(text)
      || /<script(?:\s|>)/i.test(text)) return 'text/html';
  if (/^<\?xml[\s\S]{0,500}<svg\b/.test(text) || /^<svg\b/.test(text)) return 'image/svg+xml';

  if (startsWith(buffer, Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    return EXTENSION_MIMES[path.extname(filename).toLowerCase()] || 'application/zip';
  }
  if (startsWith(buffer, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
    return EXTENSION_MIMES[path.extname(filename).toLowerCase()] || 'application/x-ole-storage';
  }
  return null;
}

function validateMediaIntegrity({ bytes, claimedMime, filename } = {}) {
  const claimed = canonicalMime(claimedMime);
  const detectedMime = canonicalMime(detectMediaMime(bytes, { filename }));
  if (isActiveContentMime(detectedMime)) {
    return {
      ok: false,
      code: 'ACTIVE_CONTENT_REJECTED',
      detectedMime,
      claimedMime: claimed,
    };
  }
  if (!detectedMime) {
    return {
      ok: false,
      code: 'MIME_UNVERIFIED',
      detectedMime: null,
      claimedMime: claimed,
    };
  }
  if (!GENERIC_MIMES.has(claimed) && claimed !== detectedMime) {
    return {
      ok: false,
      code: 'MIME_MISMATCH',
      detectedMime,
      claimedMime: claimed,
    };
  }
  return {
    ok: true,
    detectedMime,
    claimedMime: claimed,
  };
}

function envLimit(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function mediaLimits() {
  return {
    maxSourceBytes: envLimit('MEDIA_MAX_SOURCE_BYTES', DEFAULT_MAX_SOURCE_BYTES),
    maxImagePixels: envLimit('MEDIA_MAX_IMAGE_PIXELS', DEFAULT_MAX_IMAGE_PIXELS),
    maxDurationSeconds: envLimit('MEDIA_MAX_DURATION_SECONDS', DEFAULT_MAX_DURATION_SECONDS),
  };
}

function pathOutsideContentDirectory() {
  const error = new Error('Media file path is outside the content directory');
  error.code = 'PATH_OUTSIDE_CONTENT_DIRECTORY';
  return error;
}

function constrainedMediaPath(contentDir, filePath) {
  if (!contentDir || !filePath) throw pathOutsideContentDirectory();
  const root = fs.realpathSync(path.resolve(String(contentDir)));
  const candidate = fs.realpathSync(path.resolve(String(filePath)));
  if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) {
    throw pathOutsideContentDirectory();
  }
  return candidate;
}

function inspectMediaFile({
  filePath,
  contentDir,
  claimedMime,
  filename,
  maxSourceBytes,
} = {}) {
  const safePath = constrainedMediaPath(contentDir, filePath);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(safePath, flags);
  let stat;
  let bytes;
  try {
    stat = fs.fstatSync(fd);
    const limit = Number(maxSourceBytes) || mediaLimits().maxSourceBytes;
    if (!stat.isFile() || stat.size <= 0) {
      return { ok: false, code: 'SOURCE_EMPTY', size: stat.size };
    }
    if (stat.size > limit) {
      return { ok: false, code: 'SOURCE_TOO_LARGE', size: stat.size, maxSourceBytes: limit };
    }
    const length = Math.min(stat.size, MAX_SNIFF_BYTES);
    bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, 0);
  } finally {
    fs.closeSync(fd);
  }
  return {
    ...validateMediaIntegrity({ bytes, claimedMime, filename }),
    size: stat.size,
  };
}

module.exports = {
  ACTIVE_CONTENT_MIMES,
  DEFAULT_MAX_DURATION_SECONDS,
  DEFAULT_MAX_IMAGE_PIXELS,
  DEFAULT_MAX_SOURCE_BYTES,
  canonicalMime,
  detectMediaMime,
  inspectMediaFile,
  isActiveContentMime,
  mediaLimits,
  validateMediaIntegrity,
};
