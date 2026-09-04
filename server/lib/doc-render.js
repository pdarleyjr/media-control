// Controllable document playback support.
//
// Uploaded PDFs and Office/ODF files are normalized to a PDF, then individual
// pages/slides are rasterized on demand with Poppler. The display player uses
// these cached page images in /player/doc/:id so Command Center transport can
// advance a PowerPoint/PDF without relying on the browser's native PDF plugin.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const config = require('../config');
const { getOfficePdf, isConvertibleOfficeMime } = require('./doc-pdf');

const PDF_MIME = 'application/pdf';
// 144 DPI renders a standard 4:3 PowerPoint page at 1440x1080: native
// 1080-line output without retaining oversized decoded PNG surfaces in every
// Chromium renderer on the five-display P3. Operators can still override this
// for a higher-resolution installation with DOC_RENDER_DPI.
const DEFAULT_DPI = Math.max(96, Math.min(360, parseInt(process.env.DOC_RENDER_DPI, 10) || 144));
const PDFINFO_TIMEOUT_MS = parseInt(process.env.DOC_PDFINFO_TIMEOUT_MS, 10) || 15000;
const RENDER_TIMEOUT_MS = parseInt(process.env.DOC_RENDER_TIMEOUT_MS, 10) || 60000;
const RENDER_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.DOC_RENDER_CONCURRENCY, 10) || 2));

const infoCache = new Map();
const renderInflight = new Map();

function createRenderScheduler(concurrency = RENDER_CONCURRENCY) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const queue = [];
  const records = new WeakMap();
  let active = 0;
  let sequence = 0;

  const rank = (priority) => priority === 'prefetch' ? 1 : 0;
  const sortQueue = () => queue.sort((a, b) => a.rank - b.rank || a.sequence - b.sequence);
  const drain = () => {
    sortQueue();
    while (active < limit && queue.length) {
      const item = queue.shift();
      item.started = true;
      active += 1;
      Promise.resolve()
        .then(item.task)
        .then(item.resolve, item.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  return {
    run(task, options = {}) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const item = {
        task,
        resolve,
        reject,
        rank: rank(options.priority),
        sequence: sequence++,
        started: false,
      };
      records.set(promise, item);
      queue.push(item);
      drain();
      return promise;
    },
    promote(promise) {
      const item = records.get(promise);
      if (!item || item.started || item.rank === 0) return false;
      item.rank = 0;
      sortQueue();
      return true;
    },
    activeCount: () => active,
    pendingCount: () => queue.length,
  };
}

const renderScheduler = createRenderScheduler();

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (error, stdout, stderr) => {
      if (error) {
        error.stderr = stderr;
        reject(error);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function isDocumentMime(mimeType) {
  return mimeType === PDF_MIME || isConvertibleOfficeMime(mimeType);
}

function parsePdfInfo(text) {
  const match = String(text || '').match(/^Pages:\s*(\d+)\s*$/mi);
  const pages = match ? parseInt(match[1], 10) : 1;
  return Number.isFinite(pages) && pages > 0 ? pages : 1;
}

function clampPage(page, pages) {
  const max = Math.max(1, parseInt(pages, 10) || 1);
  const n = parseInt(page, 10) || 1;
  return Math.max(1, Math.min(max, n));
}

function safeContentId(id) {
  return String(id || 'doc').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function pageCacheBasename(contentId, mtimeMs, page, dpi) {
  return `docpage_${safeContentId(contentId)}_${Math.round(mtimeMs || 0)}_${dpi}_${page}.png`;
}

function safeContentPath(filepath) {
  if (!filepath) throw new Error('document has no file path');
  const baseDir = path.resolve(config.contentDir);
  const safePath = path.resolve(baseDir, path.basename(filepath));
  if (safePath !== baseDir && safePath.startsWith(baseDir + path.sep)) return safePath;
  throw new Error('invalid document path');
}

async function getRenderablePdf(content) {
  if (!content || !isDocumentMime(content.mime_type)) throw new Error('not a document');
  const srcPath = safeContentPath(content.filepath);
  if (content.mime_type === PDF_MIME) return srcPath;
  return getOfficePdf(content.id, srcPath, content.mime_type);
}

async function getPdfPageCount(pdfPath) {
  const stat = fs.statSync(pdfPath);
  const key = `${pdfPath}:${Math.round(stat.mtimeMs)}`;
  if (infoCache.has(key)) return infoCache.get(key).pages;
  const { stdout } = await execFileAsync('pdfinfo', [pdfPath], { timeout: PDFINFO_TIMEOUT_MS, maxBuffer: 256 * 1024 });
  const pages = parsePdfInfo(stdout);
  infoCache.set(key, { pages });
  return pages;
}

async function renderPdfPageImage(contentId, pdfPath, page, opts = {}) {
  const dpi = Math.max(96, Math.min(360, parseInt(opts.dpi, 10) || DEFAULT_DPI));
  const pages = await getPdfPageCount(pdfPath);
  const pageNum = clampPage(page, pages);
  const stat = fs.statSync(pdfPath);
  const outPath = path.join(config.contentDir, pageCacheBasename(contentId, stat.mtimeMs, pageNum, dpi));
  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return { path: outPath, page: pageNum, pages, dpi };

  if (renderInflight.has(outPath)) {
    const existing = renderInflight.get(outPath);
    if (opts.priority !== 'prefetch') renderScheduler.promote(existing);
    return existing;
  }

  const job = renderScheduler.run(async () => {
    // A queued request may have become a cache hit while another renderer was
    // active. Recheck at execution time before spawning Poppler.
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
      return { path: outPath, page: pageNum, pages, dpi };
    }
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcdocpage-'));
    try {
      const prefix = path.join(workDir, 'page');
      await execFileAsync('pdftoppm', [
        '-png', '-singlefile', '-r', String(dpi),
        '-f', String(pageNum), '-l', String(pageNum),
        pdfPath, prefix,
      ], { timeout: RENDER_TIMEOUT_MS, maxBuffer: 1024 * 1024 });
      const rendered = `${prefix}.png`;
      if (!fs.existsSync(rendered) || fs.statSync(rendered).size === 0) throw new Error('page render produced no image');
      const tmpOut = `${outPath}.${process.pid}.tmp`;
      fs.copyFileSync(rendered, tmpOut);
      fs.renameSync(tmpOut, outPath);
      return { path: outPath, page: pageNum, pages, dpi };
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }, { priority: opts.priority });

  renderInflight.set(outPath, job);
  try {
    return await job;
  } finally {
    renderInflight.delete(outPath);
  }
}

module.exports = {
  DEFAULT_DPI,
  RENDER_CONCURRENCY,
  clampPage,
  createRenderScheduler,
  getPdfPageCount,
  getRenderablePdf,
  isDocumentMime,
  pageCacheBasename,
  parsePdfInfo,
  renderPdfPageImage,
  safeContentPath,
};
