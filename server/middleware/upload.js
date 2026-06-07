const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.contentDir);
  },
  filename: (req, file, cb) => {
    // busboy decodes the Content-Disposition filename header as latin1 by
    // default. Modern clients send raw UTF-8 bytes for non-ASCII filenames
    // (e.g. browsers + curl on UTF-8 locales send "Begrussungsscreens.jpg"
    // with c3 bc for u-umlaut). Reading those bytes as latin1 produces the
    // string "A-tilde + quarter-mark" which JS then re-encodes as 4 UTF-8
    // bytes on the way to the DB - classic double-encoding mojibake.
    //
    // The `defParamCharset: 'utf8'` option below only takes effect for
    // RFC 5987 encoded `filename*=...` params, which most clients don't send.
    // For the plain `filename="..."` case, re-decode here to recover the
    // original UTF-8 byte sequence. Mutating originalname here propagates to
    // every downstream consumer (route handlers reading req.file.originalname).
    if (file.originalname) {
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    }
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4()}${ext}`);
  }
});

// 2026-05-28: expanded to accept PDF + Microsoft Office documents in addition
// to images and video. PDFs render natively via PDF.js in the player. Office
// docs render via ONLYOFFICE Document Server (running on office.mbfdhub.com)
// as an embedded viewer iframe. Cloudflare's edge plan caps body size at
// 100 MB on Free/Pro / 200 MB on Business — files larger than that will
// 413 at the edge before reaching multer. Document for operators.
const ALLOWED_DOC_TYPES = new Set([
  // PDF
  'application/pdf',
  // Word
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  // Excel
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  // PowerPoint
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // OpenDocument formats
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/bmp',
  // AVIF: modern, widely decoded by the Chromium-based players AND by sharp
  // (libvips heif) for thumbnails. (TIFF/HEIC deliberately excluded — they are
  // not reliably renderable in an <img> on the display players, so accepting
  // them would yield a thumbnail but a blank full-screen render.)
  'image/avif',
]);

const ALLOWED_VIDEO_TYPES = new Set([
  'video/mp4',
  'video/webm',
  'video/avi',
  'video/mkv',
  'video/mov',
  'video/x-msvideo',
  'video/quicktime',
  'video/x-matroska',
]);

function isAllowedUploadMime(mimetype) {
  return ALLOWED_IMAGE_TYPES.has(mimetype) || ALLOWED_VIDEO_TYPES.has(mimetype) || ALLOWED_DOC_TYPES.has(mimetype);
}

// Extension -> canonical MIME, used only to recover the real type when the
// client sends a generic/empty Content-Type. Browsers + OSes frequently label
// .mkv/.mov as application/octet-stream and .pptx/.docx as application/zip or
// octet-stream, which previously caused valid files to be rejected. Only maps
// to types already on the allow-list, so this never widens what is accepted —
// it just stops a correctly-named file from being denied over a bad MIME guess.
const EXT_TO_MIME = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo', '.mov': 'video/quicktime',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
};

// MIME values that mean "the client didn't really tell us" — only for these do
// we fall back to the extension. A specific-but-disallowed MIME is still denied.
const GENERIC_MIMES = new Set([
  '', 'application/octet-stream', 'binary/octet-stream',
  'application/zip', 'application/x-zip-compressed', 'application/vnd.ms-office',
]);

// Returns the canonical allow-listed MIME for an upload, or null if disallowed.
// Mutating the result onto file.mimetype keeps every downstream consumer
// (thumbnail branch, DB row, player) working with the real type.
function resolveUploadMime(file) {
  const mt = (file && file.mimetype || '').toLowerCase();
  if (isAllowedUploadMime(mt)) return mt;
  if (GENERIC_MIMES.has(mt)) {
    const ext = path.extname((file && file.originalname) || '').toLowerCase();
    const inferred = EXT_TO_MIME[ext];
    if (inferred && isAllowedUploadMime(inferred)) return inferred;
  }
  return null;
}

const fileFilter = (req, file, cb) => {
  const canonical = resolveUploadMime(file);
  if (canonical) {
    file.mimetype = canonical;
    cb(null, true);
  } else {
    cb(new Error('Only video, image, PDF, and Office document files are allowed'), false);
  }
};

// `defParamCharset: 'utf8'` only takes effect for RFC 5987 encoded
// `filename*=utf-8''...` params. Most real clients (browsers, curl, programmatic
// HTTP) send the plain `filename="..."` form, where busboy still reads the bytes
// as latin1 regardless of this option. The actual UTF-8 recovery happens in the
// storage.filename callback above via Buffer.from(name,'latin1').toString('utf8').
// Kept here as defense-in-depth for the rare RFC 5987 case.
const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: config.maxFileSize },
  defParamCharset: 'utf8'
});

// Export the multer instance as the default; also surface the doc-type set so
// callers (routes/content.js, frontend file pickers via /api/upload/accept) can
// reuse the canonical list.
module.exports = upload;
module.exports.ALLOWED_DOC_TYPES = ALLOWED_DOC_TYPES;
module.exports.ALLOWED_IMAGE_TYPES = ALLOWED_IMAGE_TYPES;
module.exports.ALLOWED_VIDEO_TYPES = ALLOWED_VIDEO_TYPES;
module.exports.isAllowedUploadMime = isAllowedUploadMime;
module.exports.resolveUploadMime = resolveUploadMime;
module.exports.EXT_TO_MIME = EXT_TO_MIME;
