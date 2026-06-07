// Document thumbnail generation for uploaded PDFs and Office/ODF files.
//
// Why this exists: the image/* (sharp) and video/* (ffmpeg) upload branches in
// routes/content.js + lib/finalize-upload.js never produced a thumbnail for a
// PDF or any Office document, so every PDF/PPT/PPTX/DOC/DOCX/XLS/XLSX/ODF landed
// with thumbnail_path = NULL (the "PowerPoint files have no thumbnail" bug).
//
// Strategy (layered, cheapest first, every step non-fatal):
//   1. PDF                -> pdftoppm renders page 1 -> sharp resizes to a jpeg.
//   2. ODF / OOXML        -> try the embedded preview the authoring app may have
//                            saved (ODF always ships Thumbnails/thumbnail.png;
//                            PowerPoint/Word ship docProps/thumbnail.* only when
//                            "save preview" was on) -> sharp.
//   3. Office w/o preview -> LibreOffice (soffice --headless --convert-to pdf)
//                            renders the doc to a PDF, then path (1). This is the
//                            only universal path and covers files like Gamma's
//                            PPTX export, which embed no preview.
//
// Generation runs in the BACKGROUND (kickDocThumbnail) like the YouTube
// transcode, because a LibreOffice cold-convert can take several seconds — the
// upload response must not block on it. generateDocThumbnail itself is pure
// (no DB) so it is unit-testable; kickDocThumbnail wraps it with the row UPDATE.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { v4: uuidv4 } = require('uuid');
const config = require('../config');

const pexecFile = promisify(execFile);

const PDF_MIME = 'application/pdf';

// OOXML (Microsoft) — may carry an embedded docProps/thumbnail.* (often absent).
const OOXML_MIMES = new Set([
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

// OpenDocument — reliably ships Thumbnails/thumbnail.png.
const ODF_MIMES = new Set([
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
]);

const DOC_THUMB_MIMES = new Set([PDF_MIME, ...OOXML_MIMES, ...ODF_MIMES]);

function isDocThumbnailMime(mt) {
  return DOC_THUMB_MIMES.has(mt);
}

// Pull an embedded raster preview out of an OOXML/ODF zip, if present.
// Returns a Buffer (jpeg/png bytes) or null. Uses unzipper (already a direct
// dependency) so no new binary or package is required.
async function embeddedThumbnail(srcPath) {
  let unzipper;
  try { unzipper = require('unzipper'); } catch { return null; }
  // ODF preview first (most reliable), then the OOXML variants.
  const wanted = [
    'Thumbnails/thumbnail.png',
    'docProps/thumbnail.jpeg',
    'docProps/thumbnail.jpg',
    'docProps/thumbnail.png',
  ];
  try {
    const directory = await unzipper.Open.file(srcPath);
    for (const name of wanted) {
      const entry = directory.files.find((f) => f.path === name);
      if (entry) {
        const buf = await entry.buffer();
        if (buf && buf.length) return buf;
      }
    }
  } catch { /* not a zip / corrupt / encrypted — fall through to render */ }
  return null;
}

// Render page 1 of a PDF to a PNG with poppler's pdftoppm (present in the
// container). -singlefile drops the page-number suffix so the output is exactly
// <prefix>.png. Returns the PNG path or throws.
async function renderPdfFirstPage(pdfPath, prefix) {
  await pexecFile(
    'pdftoppm',
    ['-png', '-singlefile', '-f', '1', '-l', '1', '-r', '110', pdfPath, prefix],
    { timeout: 60000 }
  );
  const png = `${prefix}.png`;
  if (!fs.existsSync(png)) throw new Error('pdftoppm produced no output');
  return png;
}

// Convert an Office/ODF document to PDF with headless LibreOffice. A unique
// per-call UserInstallation profile keeps concurrent conversions from fighting
// over a shared profile lock. Returns the produced PDF path or throws.
async function officeToPdf(srcPath, workDir) {
  const profile = `file://${path.join(workDir, 'lo-profile')}`;
  await pexecFile(
    'soffice',
    [
      `-env:UserInstallation=${profile}`,
      '--headless', '--norestore', '--nolockcheck',
      '--convert-to', 'pdf', '--outdir', workDir, srcPath,
    ],
    { timeout: 120000 }
  );
  const pdf = path.join(workDir, `${path.basename(srcPath, path.extname(srcPath))}.pdf`);
  if (!fs.existsSync(pdf)) throw new Error('soffice produced no PDF');
  return pdf;
}

/**
 * Produce a jpeg thumbnail for a PDF/Office/ODF file in contentDir.
 * @returns {Promise<string|null>} the thumbnail filename (e.g. "thumb_<id>.jpg")
 *   on success, or null if no thumbnail could be made (always non-fatal).
 */
async function generateDocThumbnail({ srcPath, mimeType, contentDir, thumbnailWidth } = {}) {
  if (!isDocThumbnailMime(mimeType)) return null;
  if (!srcPath || !fs.existsSync(srcPath)) return null;

  const dir = contentDir || config.contentDir;
  const width = thumbnailWidth || config.thumbnailWidth;
  const outName = `thumb_${path.basename(srcPath).replace(/\.[^.]+$/, '')}.jpg`;
  const outPath = path.join(dir, outName);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcthumb-'));
  const cleanup = () => { try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ } };

  try {
    let imageInput = null; // Buffer (embedded) or a PNG file path (rendered)

    // 1/2: embedded preview for non-PDF docs (cheap, no subprocess).
    if (mimeType !== PDF_MIME) {
      const embedded = await embeddedThumbnail(srcPath);
      if (embedded) imageInput = embedded;
    }

    // 3: render via PDF (PDFs directly; Office via LibreOffice first).
    if (!imageInput) {
      let pdfPath = null;
      if (mimeType === PDF_MIME) {
        pdfPath = srcPath;
      } else {
        pdfPath = await officeToPdf(srcPath, workDir).catch(() => null);
      }
      if (pdfPath) {
        const png = await renderPdfFirstPage(pdfPath, path.join(workDir, `pg-${uuidv4()}`)).catch(() => null);
        if (png) imageInput = png;
      }
    }

    if (!imageInput) { cleanup(); return null; }

    const sharp = require('sharp');
    await sharp(imageInput, { limitInputPixels: false, failOn: 'none' })
      .resize(width)
      .jpeg({ quality: 70 })
      .toFile(outPath);

    cleanup();
    return outName;
  } catch (e) {
    cleanup();
    console.warn('doc-thumbnail generation failed (non-fatal):', e && e.message);
    return null;
  }
}

// Background wrapper: generate then attach to the content row. Mirrors the
// fire-and-forget pattern of transcodeYouTubeInBackground. The AND
// thumbnail_path IS NULL guard avoids clobbering a thumbnail set elsewhere.
function kickDocThumbnail(contentId, srcPath, mimeType) {
  generateDocThumbnail({ srcPath, mimeType })
    .then((thumb) => {
      if (!thumb) return;
      try {
        const { db } = require('../db/database');
        db.prepare('UPDATE content SET thumbnail_path = ? WHERE id = ? AND thumbnail_path IS NULL')
          .run(thumb, contentId);
      } catch (e) {
        console.warn('doc-thumbnail row update failed (non-fatal):', e && e.message);
      }
    })
    .catch((e) => console.warn('doc-thumbnail kick failed (non-fatal):', e && e.message));
}

module.exports = {
  isDocThumbnailMime,
  generateDocThumbnail,
  kickDocThumbnail,
  embeddedThumbnail,
  DOC_THUMB_MIMES,
};
