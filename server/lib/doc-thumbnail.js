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
const { sha256File } = require('./asset-manifest');
const { emitContentUpdated } = require('./content-finalization');
const { mediaLimits } = require('./media-integrity');

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
    await sharp(imageInput, {
      limitInputPixels: mediaLimits().maxImagePixels,
      failOn: 'error',
    })
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

function safeUnlink(filePath) {
  try { if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch { /* best effort */ }
}

async function commitGeneratedThumbnail(options = {}) {
  const {
    db,
    io,
    contentId,
    expectedVersion,
    expectedFilepath,
    expectedSha256,
    sourcePath,
    thumbnailPath,
    thumbnailFilename,
    provenance,
  } = options;
  if (!db || !contentId || !expectedFilepath || !expectedSha256
      || !sourcePath || !thumbnailPath || !thumbnailFilename) {
    throw new Error('invalid_thumbnail_commit');
  }
  const currentHash = await (options.sha256File || sha256File)(sourcePath).catch(() => null);
  let row = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
  if (!row
      || String(row.filepath) !== String(expectedFilepath)
      || Number(row.version) !== Number(expectedVersion)
      || currentHash !== expectedSha256) {
    safeUnlink(thumbnailPath);
    return { status: 'stale', content_id: contentId };
  }

  const now = Number(options.now) || Math.floor(Date.now() / 1000);
  const commit = db.transaction(() => {
    const result = db.prepare(`
      UPDATE content SET thumbnail_path=?, updated_at=?
      WHERE id=? AND filepath=? AND COALESCE(version, 1)=?
    `).run(thumbnailFilename, now, contentId, expectedFilepath, expectedVersion);
    if (!result.changes) return false;
    try {
      db.prepare(`
        INSERT INTO content_media_metadata (
          content_id, workspace_id, thumbnail_generation,
          thumbnail_source_sha256, thumbnail_source_filepath,
          thumbnail_provenance, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_id) DO UPDATE SET
          workspace_id=excluded.workspace_id,
          thumbnail_generation=excluded.thumbnail_generation,
          thumbnail_source_sha256=excluded.thumbnail_source_sha256,
          thumbnail_source_filepath=excluded.thumbnail_source_filepath,
          thumbnail_provenance=excluded.thumbnail_provenance,
          updated_at=excluded.updated_at
      `).run(
        contentId,
        row.workspace_id || null,
        Number(expectedVersion),
        expectedSha256,
        expectedFilepath,
        provenance || 'generated',
        now,
        now,
      );
    } catch (error) {
      // Upgrade/test databases may not have the additive metadata table yet.
      // The guarded content update remains valid; metadata is not an auth gate.
      if (!/no such table/i.test(error.message)) throw error;
    }
    return true;
  });
  if (!commit()) {
    safeUnlink(thumbnailPath);
    return { status: 'stale', content_id: contentId };
  }
  row = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
  emitContentUpdated(io, row, Number(expectedVersion));
  return {
    status: 'ready',
    content_id: contentId,
    generation: Number(expectedVersion),
    thumbnail_path: thumbnailFilename,
  };
}

// Background wrapper: generate then attach to the content row. Mirrors the
// fire-and-forget pattern of transcodeYouTubeInBackground. The AND
// thumbnail_path IS NULL guard avoids clobbering a thumbnail set elsewhere.
function kickDocThumbnail(contentId, srcPath, mimeType) {
  let expected = null;
  let db = null;
  Promise.resolve()
    .then(async () => {
      ({ db } = require('../db/database'));
      expected = db.prepare('SELECT * FROM content WHERE id=?').get(contentId);
      if (!expected || expected.filepath !== path.basename(srcPath)) return null;
      const sourceHash = await sha256File(srcPath);
      const thumb = await generateDocThumbnail({ srcPath, mimeType });
      if (!thumb) return null;
      return commitGeneratedThumbnail({
        db,
        contentId,
        expectedVersion: Math.max(1, Number(expected.version) || 1),
        expectedFilepath: expected.filepath,
        expectedSha256: sourceHash,
        sourcePath: srcPath,
        thumbnailPath: path.join(config.contentDir, thumb),
        thumbnailFilename: thumb,
        provenance: mimeType === PDF_MIME ? 'pdf_page_1' : 'document_page_1',
      });
    })
    .catch((e) => console.warn('doc-thumbnail kick failed (non-fatal):', e && e.message));
}

module.exports = {
  isDocThumbnailMime,
  generateDocThumbnail,
  commitGeneratedThumbnail,
  kickDocThumbnail,
  embeddedThumbnail,
  officeToPdf,
  DOC_THUMB_MIMES,
  OOXML_MIMES,
  ODF_MIMES,
};
