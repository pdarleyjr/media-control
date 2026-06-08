// On-demand Office/ODF -> PDF conversion for the player.
//
// Why this exists: the player's isOffice branch used to point an iframe at
// ONLYOFFICE's `…/api/documents/api.js?fileUrl=…`. That URL is the ONLYOFFICE
// JavaScript LIBRARY, not a viewer — an iframe pointed at it just shows the raw
// .js source as text (the "PowerPoint loaded a bunch of weird text, not the PDF"
// bug). ONLYOFFICE has to be embedded via a host page that <script>-loads api.js
// then calls `new DocsAPI.DocEditor(...)` with a config + JWT, which we don't do.
//
// The robust fix the original author's own TODO called for: convert the document
// to a PDF server-side (LibreOffice is already in the image for thumbnails) and
// render it through the browser's native PDF viewer — the same proven path the
// isPdf branch already uses on the kiosk displays.
//
// Conversion reuses officeToPdf() from doc-thumbnail.js (headless LibreOffice).
// Results are cached on disk in contentDir, keyed by content id + source mtime
// (so a /replace re-converts), and a single-flight map coalesces the concurrent
// requests a wall of displays fires when the same doc goes live.

const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('../config');
const { officeToPdf, OOXML_MIMES, ODF_MIMES } = require('./doc-thumbnail');

// Office/ODF mimes that must be converted before a browser can display them.
// (A native application/pdf is served directly and never reaches here.)
const OFFICE_DOC_MIMES = new Set([...OOXML_MIMES, ...ODF_MIMES]);

function isConvertibleOfficeMime(mt) {
  return OFFICE_DOC_MIMES.has(mt);
}

// Cache filename keyed by id + source mtime. The mtime busts the cache when a
// document is replaced in place; the basename has no caller-controlled input
// (id is a DB UUID, mtime a number) so it is safe to join into contentDir.
function cacheName(contentId, srcStat) {
  return `docpdf_${contentId}_${Math.round(srcStat.mtimeMs)}.pdf`;
}

const inflight = new Map();

/**
 * Convert an Office/ODF document to PDF, returning the cached PDF path. Reuses a
 * prior conversion when present; coalesces concurrent conversions of the same
 * output via a single-flight map.
 * @param {string} [outDir] cache directory (defaults to config.contentDir; a param for tests)
 * @returns {Promise<string>} absolute path to the converted PDF
 * @throws if the mime is not convertible, the source is missing, or LibreOffice fails
 */
async function getOfficePdf(contentId, srcPath, mimeType, { outDir } = {}) {
  if (!isConvertibleOfficeMime(mimeType)) throw new Error('not a convertible office mime');
  if (!srcPath || !fs.existsSync(srcPath)) throw new Error('source file missing');

  const dir = outDir || config.contentDir;
  const stat = fs.statSync(srcPath);
  const outPath = path.join(dir, cacheName(contentId, stat));

  // Cache hit (non-empty file from a previous conversion).
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return outPath;

  // Single-flight: a live wall hits this route once per device simultaneously.
  if (inflight.has(outPath)) return inflight.get(outPath);

  const job = (async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdocpdf-'));
    try {
      const pdf = await officeToPdf(srcPath, workDir);
      // Materialize into the persistent content dir. Write to a temp name in the
      // same dir then rename so a reader never sees a half-written file.
      const tmpOut = `${outPath}.${process.pid}.tmp`;
      fs.copyFileSync(pdf, tmpOut);
      fs.renameSync(tmpOut, outPath);
      return outPath;
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  })();

  inflight.set(outPath, job);
  try {
    return await job;
  } finally {
    inflight.delete(outPath);
  }
}

module.exports = {
  isConvertibleOfficeMime,
  getOfficePdf,
  OFFICE_DOC_MIMES,
};
