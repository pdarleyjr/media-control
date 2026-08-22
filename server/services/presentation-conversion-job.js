'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { randomUUID } = require('node:crypto');
const { execFile: execFileCallback } = require('node:child_process');
const { promisify } = require('node:util');

const config = require('../config');
const { extractPptxToSlideIr, extractAssetBuffer } = require('./pptx-slide-ir');
const { convertDeckIr, MODES } = require('./presentation-converter');
const ai = require('./ai');
const { PROFILE_IDS } = require('../lib/presentation-template-registry');
const { resolveStoredContentFile } = require('../lib/trusted-content-file');
const defaultExecFile = promisify(execFileCallback);

const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const SAFE_EMBEDDED = Object.freeze({
  '.png': { mime: 'image/png', kind: 'image' },
  '.jpg': { mime: 'image/jpeg', kind: 'image' },
  '.jpeg': { mime: 'image/jpeg', kind: 'image' },
  '.gif': { mime: 'image/gif', kind: 'image' },
  '.webp': { mime: 'image/webp', kind: 'image' },
  '.bmp': { mime: 'image/bmp', kind: 'image' },
  '.mp4': { mime: 'video/mp4', kind: 'video' },
  '.m4v': { mime: 'video/mp4', kind: 'video' },
  '.mov': { mime: 'video/quicktime', kind: 'video' },
  '.webm': { mime: 'video/webm', kind: 'video' },
  '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
  '.m4a': { mime: 'audio/mp4', kind: 'audio' },
  '.wav': { mime: 'audio/wav', kind: 'audio' },
});

function isRecognizedBytes(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return false;
  const start = buffer.subarray(0, 12);
  if (ext === '.png') return start.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (['.jpg', '.jpeg'].includes(ext)) return start[0] === 0xff && start[1] === 0xd8 && start[2] === 0xff;
  if (ext === '.gif') return start.subarray(0, 4).toString('ascii') === 'GIF8';
  if (ext === '.webp') return start.subarray(0, 4).toString('ascii') === 'RIFF' && start.subarray(8, 12).toString('ascii') === 'WEBP';
  if (ext === '.bmp') return start.subarray(0, 2).toString('ascii') === 'BM';
  if (['.mp4', '.m4v', '.mov', '.m4a'].includes(ext)) return start.subarray(4, 8).toString('ascii') === 'ftyp';
  if (ext === '.webm') return start.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'));
  if (ext === '.mp3') return start.subarray(0, 3).toString('ascii') === 'ID3' || (start[0] === 0xff && (start[1] & 0xe0) === 0xe0);
  if (ext === '.wav') return start.subarray(0, 4).toString('ascii') === 'RIFF' && start.subarray(8, 12).toString('ascii') === 'WAVE';
  return false;
}

function safeContentPath(contentDir, storedName) {
  const root = path.resolve(contentDir);
  const resolved = path.resolve(root, path.basename(storedName));
  if (path.dirname(resolved) !== root) throw new Error('Content path escaped storage root');
  return resolved;
}

async function extractSafeAssets(sourcePath, slideIr, contentDir, options = {}) {
  const extracted = [];
  try {
    for (const asset of slideIr.assets || []) {
      const ext = path.extname(asset.filename || asset.package_path || '').toLowerCase();
      const policy = SAFE_EMBEDDED[ext];
      if (!policy) {
        asset.review_flag = `Unsupported embedded ${ext || 'asset'} preserved in source package; review required`;
        continue;
      }
      const { buffer, sha256 } = await extractAssetBuffer(sourcePath, asset.package_path);
      if (!isRecognizedBytes(buffer, ext)) {
        asset.review_flag = 'Embedded asset signature did not match its safe declared type; it was not served';
        continue;
      }
      const contentId = randomUUID();
      const storedName = `presentation_${contentId}${ext}`;
      const finalPath = safeContentPath(contentDir, storedName);
      const temporaryPath = `${finalPath}.partial-${process.pid}`;
      try {
        options.registerArtifact?.(temporaryPath);
        options.registerArtifact?.(finalPath);
        await fs.promises.writeFile(temporaryPath, buffer, { flag: 'wx' });
        await fs.promises.rename(temporaryPath, finalPath);
      } catch (error) {
        await fs.promises.unlink(temporaryPath).catch(() => {});
        throw error;
      }
      asset.content_id = contentId;
      asset.sha256 = sha256;
      asset.mime_type = policy.mime;
      extracted.push({
        contentId,
        storedName,
        finalPath,
        filename: path.basename(asset.filename || storedName),
        mime: policy.mime,
        kind: policy.kind,
        size: buffer.length,
        sha256,
        assetId: asset.id,
      });
    }
    return extracted;
  } catch (error) {
    await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
    throw error;
  }
}

async function renderComplexSlideFallbacks(sourcePath, slideIr, contentDir, options = {}) {
  const execFile = options.execFile || defaultExecFile;
  const assetsById = new Map((slideIr.assets || []).map((asset) => [asset.id, asset]));
  const requiresFallback = (element) => ['chart', 'smartart', 'group', 'ole', 'graphic'].includes(element.kind)
    || Boolean(element.asset_ref && assetsById.get(element.asset_ref)?.review_flag);
  const complexSlides = (slideIr.slides || []).filter((slide) => (slide.elements || []).some(requiresFallback));
  if (!complexSlides.length) return [];
  const jobToken = crypto.createHash('sha256').update(String(options.jobId || '')).digest('hex').slice(0, 24);
  const temporaryBase = safeContentPath(contentDir, `presentation_job_${jobToken}_fallback`);
  const workingSource = `${temporaryBase}.pptx`;
  const pdfPath = `${temporaryBase}.pdf`;
  const temporaryPaths = [workingSource, pdfPath];
  for (const temporaryPath of temporaryPaths) options.registerArtifact?.(temporaryPath);
  await fs.promises.copyFile(sourcePath, workingSource, fs.constants.COPYFILE_EXCL);
  const rendered = [];
  try {
    let converted = false; let lastError = null;
    for (const command of process.platform === 'win32' ? ['soffice.exe', 'libreoffice.exe'] : ['libreoffice', 'soffice']) {
      try {
        await execFile(command, ['--headless', '--convert-to', 'pdf', '--outdir', contentDir, workingSource], { timeout: 240000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
        converted = true; break;
      } catch (error) { lastError = error; }
    }
    if (!converted) throw lastError || new Error('LibreOffice unavailable');
    await fs.promises.access(pdfPath, fs.constants.R_OK);
    for (const slide of complexSlides) {
      const number = Number(slide.source_slide_number);
      const prefix = `${temporaryBase}_slide_${number}`;
      const pngPath = `${prefix}.png`;
      temporaryPaths.push(pngPath);
      options.registerArtifact?.(pngPath);
      await execFile('pdftoppm', ['-png', '-r', '192', '-f', String(number), '-l', String(number), '-singlefile', pdfPath, prefix], { timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      const buffer = await fs.promises.readFile(pngPath);
      if (!isRecognizedBytes(buffer, '.png')) throw new Error(`Rendered fallback for slide ${number} is not a safe PNG`);
      const contentId = randomUUID();
      const storedName = `presentation_${contentId}.png`;
      const finalPath = safeContentPath(contentDir, storedName);
      options.registerArtifact?.(finalPath);
      await fs.promises.copyFile(pngPath, finalPath, fs.constants.COPYFILE_EXCL);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const assetId = `asset:rendered-fallback:slide-${number}`;
      for (const element of slide.elements || []) {
        if (!['video', 'audio', 'youtube'].includes(element.kind)) element.rendered_fallback_covered = true;
      }
      slideIr.assets.push({
        id: assetId, kind: 'image', filename: `slide-${number}-rendered-fallback.png`,
        content_id: contentId, sha256, mime_type: 'image/png', rendered_fallback: true,
      });
      slide.elements.push({
        id: `s${number}-rendered-fallback`, kind: 'image', asset_ref: assetId,
        content_id: contentId, caption: 'Rendered source visual fallback', rendered_fallback: true,
      });
      rendered.push({
        contentId, storedName, finalPath, filename: `slide-${number}-rendered-fallback.png`,
        mime: 'image/png', kind: 'image', size: buffer.length, sha256, assetId,
      });
    }
    return rendered;
  } catch (error) {
    await Promise.allSettled(rendered.map((asset) => fs.promises.unlink(asset.finalPath)));
    const failure = new Error(`Rendered fallback unavailable: ${String(error.message || error).slice(0, 180)}`);
    failure.code = 'presentation_complex_fallback_unavailable';
    failure.retryable = true;
    throw failure;
  } finally {
    await Promise.allSettled(temporaryPaths.map((temporaryPath) => fs.promises.unlink(temporaryPath)));
  }
}

function resolveDeckAssetContent(deck) {
  const byAsset = new Map((deck.assets || []).filter((asset) => asset.id && asset.content_id).map((asset) => [asset.id, asset.content_id]));
  for (const slide of deck.slides || []) {
    for (const value of Object.values(slide.slots || {})) {
      if (value && typeof value === 'object' && value.asset_ref && byAsset.has(value.asset_ref)) value.content_id = byAsset.get(value.asset_ref);
    }
  }
}

function conciseReview(slideIr, deck) {
  return (slideIr.slides || []).map((sourceSlide) => {
    const mapping = deck.conversion.source_slide_mappings.find((item) => item.source_slide_number === sourceSlide.source_slide_number);
    const outputSlideNumbers = (mapping ? mapping.output_slide_ids : []).map((id) => deck.slides.findIndex((slide) => slide.id === id) + 1).filter((number) => number > 0);
    const accountingById = new Map((deck.conversion.accounting || []).map((item) => [item.source_element_id, item]));
    return {
      source_slide_number: sourceSlide.source_slide_number,
      title: sourceSlide.title,
      source_elements: sourceSlide.elements.map((element) => {
        const accounting = accountingById.get(element.id);
        return {
          id: element.id,
          kind: element.kind,
          text: element.text || element.caption || element.description || null,
          items: element.items || null,
          rows: element.rows || null,
          external: element.external === true,
          disposition: accounting?.disposition || 'requires_review',
          output_slide_ids: accounting?.output_slide_ids || [],
        };
      }),
      output_slide_ids: mapping ? mapping.output_slide_ids : [],
      output_slide_numbers: outputSlideNumbers,
      template_id: mapping ? mapping.template_id : null,
      warnings: [...(sourceSlide.warnings || []), ...(mapping ? mapping.warnings : [])],
      speaker_notes_preserved: Boolean(sourceSlide.speaker_notes),
    };
  });
}

function createPresentationConversionHandler({ db, contentDir = config.contentDir, enqueueVideo, execFile } = {}) {
  if (!db) throw new Error('presentation conversion handler requires database');
  return async function handlePresentationConversion(job, context) {
    const prior = db.prepare(`
      SELECT p.id, p.title, p.deck_json, r.source_content_id
      FROM presentation_conversion_runs r
      JOIN presentations p ON p.id=r.presentation_id
      WHERE r.job_id=? AND r.workspace_id=? AND r.user_id=?
    `).get(job.id, job.workspace_id, job.user_id);
    if (prior) {
      const deck = JSON.parse(prior.deck_json);
      const recoveredSlides = (deck.conversion?.source_slide_mappings || []).map((mapping) => mapping.source_snapshot).filter(Boolean);
      const videoAssets = reconcileRecoveredPresentationVideos({
        db,
        contentDir,
        presentationId: prior.id,
        enqueueVideo,
        job,
      });
      return {
        presentation_id: prior.id,
        source_content_id: prior.source_content_id,
        title: prior.title,
        wall_profile: deck.wall_profile,
        mode: deck.conversion?.mode,
        slide_count: Array.isArray(deck.slides) ? deck.slides.length : 0,
        source_slide_count: recoveredSlides.length,
        source_accounting_percent: deck.conversion?.source_accounting_percent,
        optimization_status: deck.conversion?.optimization_status,
        media_preparing: videoAssets.some((asset) => asset.processing_status !== 'ready'),
        broadcast_ready: videoAssets.every((asset) => asset.processing_status === 'ready'),
        quality: deck.conversion?.quality,
        review: conciseReview({ slides: recoveredSlides }, deck),
        extracted_assets: videoAssets.map((asset) => ({
          content_id: asset.contentId,
          kind: 'video',
          filename: asset.filename,
        })),
        warnings: deck.conversion?.deck_plan_warning ? [deck.conversion.deck_plan_warning] : [],
        recovered: true,
      };
    }
    const payload = job.payload || {};
    const wallProfile = Object.values(PROFILE_IDS).includes(payload.wall_profile) ? payload.wall_profile : PROFILE_IDS.THREE_DISPLAY;
    const mode = payload.mode === MODES.OPTIMIZED ? MODES.OPTIMIZED : MODES.FAITHFUL;
    const source = db.prepare('SELECT * FROM content WHERE id=? AND workspace_id=?').get(job.content_id, job.workspace_id);
    if (!source) { const error = new Error('Source presentation is unavailable in this workspace'); error.code = 'presentation_source_missing'; error.retryable = false; throw error; }
    if (source.mime_type !== PPTX_MIME && path.extname(source.filename || '').toLowerCase() !== '.pptx') {
      const error = new Error('Presentation Converter currently accepts PPTX source files');
      error.code = 'presentation_source_type_unsupported'; error.retryable = false; throw error;
    }
    const sourcePath = resolveStoredContentFile(contentDir, source.filepath);
    if (!sourcePath) {
      const error = new Error('Source presentation bytes are unavailable or outside the media store');
      error.code = 'presentation_source_missing';
      error.retryable = false;
      throw error;
    }
    context.progress('validating', 10, { step: 'package-security', mode, wall_profile: wallProfile });
    const slideIr = await extractPptxToSlideIr(sourcePath);
    if (context.isCancellationRequested()) return null;
    context.progress('preparing', 25, { step: 'extracting-media', slides: slideIr.slides.length, mode, wall_profile: wallProfile });
    const extracted = [];
    try {
      extracted.push(...await extractSafeAssets(sourcePath, slideIr, contentDir, {
        registerArtifact: context.registerArtifact,
      }));
      context.progress('preparing', 35, { step: 'rendering-fallbacks', slides: slideIr.slides.length, mode, wall_profile: wallProfile });
      extracted.push(...await renderComplexSlideFallbacks(sourcePath, slideIr, contentDir, {
        execFile,
        jobId: job.id,
        registerArtifact: context.registerArtifact,
      }));
    } catch (error) {
      await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
      throw error;
    }
    if (context.isCancellationRequested()) {
      await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
      return null;
    }
    context.progress('optimizing', 55, { step: 'semantic-mapping', ai_requested: payload.use_ai !== false });
    const aiAdapter = payload.use_ai === false ? null : { planDeck: ai.planDeckToV2, mapSlide: ai.mapSlideToV2 };
    let deck;
    try {
      deck = await convertDeckIr(slideIr, {
        wallProfile,
        mode,
        ai: aiAdapter,
        title: String(payload.title || source.filename.replace(/\.pptx$/i, '')),
        onProgress(detail) {
          const current = Math.max(0, Number(detail?.slide_current) || 0);
          const total = Math.max(1, Number(detail?.slide_total) || slideIr.slides.length || 1);
          const percent = detail?.step === 'validating-fit' ? 86
            : detail?.step === 'compiling-layouts' ? 82
              : Math.min(80, 52 + Math.round((current / total) * 28));
          context.progress('optimizing', percent, { ...detail, mode, wall_profile: wallProfile });
        },
      });
    } catch (error) {
      await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
      throw error;
    }
    if (context.isCancellationRequested()) {
      await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
      return null;
    }
    deck.conversion.job_id = job.id;
    deck.conversion.source_content_id = source.id;
    resolveDeckAssetContent(deck);
    const presentationId = deck.deck_id;
    context.progress('preparing', 88, { step: 'saving', mode, wall_profile: wallProfile });
    const transaction = db.transaction(() => {
      let currentJob = { cancel_requested: 0 };
      try { currentJob = db.prepare('SELECT cancel_requested FROM media_jobs WHERE id=?').get(job.id); }
      catch (error) { if (!/no such table/i.test(error.message)) throw error; }
      const sourceStillExists = db.prepare('SELECT 1 FROM content WHERE id=?').get(source.id);
      let erasing = null;
      try {
        erasing = db.prepare(`SELECT 1 FROM content_erase_operations
          WHERE content_id=? AND state IN ('prepared','staged','catalog_committed','cleanup_pending','recovery_failed')
          LIMIT 1`).get(source.id);
      } catch (error) {
        if (!/no such table/i.test(error.message)) throw error;
      }
      if (!currentJob || Number(currentJob.cancel_requested) === 1 || !sourceStillExists || erasing) {
        const error = new Error('Presentation conversion was cancelled before publication');
        error.code = 'media_job_cancelled';
        error.retryable = false;
        throw error;
      }
      for (const asset of extracted) {
        db.prepare(`
          INSERT INTO content
            (id, user_id, workspace_id, filename, filepath, mime_type, file_size,
             content_type, access_level, original_sha256, processing_status)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'presentation_asset', 'private', ?, ?)
        `).run(asset.contentId, job.user_id, job.workspace_id, asset.filename, asset.storedName, asset.mime, asset.size,
          asset.sha256, asset.kind === 'video' ? 'uploaded' : 'ready');
        db.prepare("UPDATE content SET library_scope='internal' WHERE id=?").run(asset.contentId);
      }
      db.prepare(`
        INSERT INTO presentations
          (id, workspace_id, user_id, created_by, title, description, theme, canvas_profile, deck_json, status)
        VALUES (?, ?, ?, ?, ?, ?, 'mbfd-videowall-v2', ?, ?, 'draft')
      `).run(presentationId, job.workspace_id, job.user_id, job.user_id, deck.title,
        `Converted from ${source.filename} (${mode === MODES.FAITHFUL ? 'Faithful Transfer' : 'Instructor Optimized'})`,
        wallProfile, JSON.stringify(deck));
      for (const asset of extracted) {
        db.prepare(`INSERT INTO presentation_assets (id, presentation_id, content_id, position_json, fit_mode)
                    VALUES (?, ?, ?, '{}', 'contain')`).run(randomUUID(), presentationId, asset.contentId);
      }
      db.prepare(`INSERT INTO presentation_conversion_runs
        (job_id, presentation_id, source_content_id, workspace_id, user_id) VALUES (?, ?, ?, ?, ?)`)
        .run(job.id, presentationId, source.id, job.workspace_id, job.user_id);
    });
    try { transaction(); }
    catch (error) {
      await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
      throw error;
    }
    if (context.isCancellationRequested()) {
      const rollback = db.transaction(() => {
        db.prepare('DELETE FROM presentations WHERE id=?').run(presentationId);
        for (const asset of extracted) db.prepare('DELETE FROM content WHERE id=? AND workspace_id=? AND user_id=?').run(asset.contentId, job.workspace_id, job.user_id);
      });
      rollback();
      await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
      return null;
    }
    const videoAssets = extracted.filter((item) => item.kind === 'video');
    try {
      enqueuePresentationVideoAssets(videoAssets, enqueueVideo, job);
    } catch (error) {
      const rollback = db.transaction(() => {
        db.prepare('DELETE FROM presentations WHERE id=?').run(presentationId);
        for (const asset of extracted) {
          db.prepare('DELETE FROM content WHERE id=? AND workspace_id=? AND user_id=?')
            .run(asset.contentId, job.workspace_id, job.user_id);
        }
      });
      try {
        rollback();
      } finally {
        await Promise.allSettled(extracted.map((asset) => fs.promises.unlink(asset.finalPath)));
      }
      error.code = error.code || 'presentation_video_enqueue_failed';
      error.retryable = true;
      throw error;
    }
    for (const asset of extracted) context.releaseArtifact?.(asset.finalPath);
    context.progress('preparing', videoAssets.length ? 94 : 99, {
      step: videoAssets.length ? 'preparing-embedded-media' : 'ready',
      presentation_id: presentationId,
      mode,
      wall_profile: wallProfile,
    });
    return {
      presentation_id: presentationId,
      source_content_id: source.id,
      title: deck.title,
      wall_profile: wallProfile,
      mode,
      slide_count: deck.slides.length,
      source_slide_count: slideIr.slides.length,
      source_accounting_percent: deck.conversion.source_accounting_percent,
      optimization_status: deck.conversion.optimization_status,
      media_preparing: videoAssets.length > 0,
      broadcast_ready: videoAssets.length === 0,
      quality: deck.conversion.quality,
      review: conciseReview(slideIr, deck),
      extracted_assets: extracted.map((asset) => ({ content_id: asset.contentId, kind: asset.kind, filename: asset.filename })),
      warnings: [
        ...(slideIr.assets || []).filter((asset) => asset.review_flag).map((asset) => asset.review_flag),
        ...(deck.conversion.deck_plan_warning ? [deck.conversion.deck_plan_warning] : []),
      ],
    };
  };
}

function reconcileRecoveredPresentationVideos({ db, contentDir, presentationId, enqueueVideo, job }) {
  const videos = db.prepare(`
    SELECT c.id, c.filename, c.filepath, c.version, c.processing_status
    FROM presentation_assets pa
    JOIN presentations p ON p.id=pa.presentation_id
    JOIN content c ON c.id=pa.content_id
    WHERE pa.presentation_id=? AND p.workspace_id=? AND p.user_id=?
      AND LOWER(c.mime_type) LIKE 'video/%'
  `).all(presentationId, job.workspace_id, job.user_id).map((content) => {
    const finalPath = resolveStoredContentFile(contentDir, content.filepath);
    if (!finalPath) {
      const error = new Error(`Embedded video ${content.id} is unavailable or outside the media store`);
      error.code = 'presentation_video_source_missing';
      error.retryable = false;
      throw error;
    }
    return {
      contentId: content.id,
      filename: content.filename,
      storedName: content.filepath,
      finalPath,
      version: Math.max(1, Number(content.version) || 1),
      processing_status: content.processing_status,
    };
  });
  enqueuePresentationVideoAssets(
    videos.filter((asset) => asset.processing_status !== 'ready'),
    enqueueVideo,
    job,
  );
  return videos;
}

function enqueuePresentationVideoAssets(videoAssets, enqueueVideo, job) {
  if (videoAssets.length && typeof enqueueVideo !== 'function') {
    const error = new Error('Embedded video preparation queue is unavailable');
    error.code = 'presentation_video_enqueue_failed';
    error.retryable = true;
    throw error;
  }
  for (const asset of videoAssets) {
    try {
      enqueueVideo({
        contentId: asset.contentId,
        workspaceId: job.workspace_id,
        userId: job.user_id,
        absolutePath: asset.finalPath,
        expectedVersion: asset.version || 1,
        expectedFilepath: asset.storedName,
        sourceType: 'presentation_conversion',
        idempotencyKey: `presentation-video:${asset.contentId}:v${asset.version || 1}`,
      });
    } catch (cause) {
      const error = new Error(`Could not queue embedded video ${asset.contentId} for classroom preparation`);
      error.code = 'presentation_video_enqueue_failed';
      error.retryable = true;
      error.cause = cause;
      throw error;
    }
  }
}

module.exports = {
  PPTX_MIME,
  SAFE_EMBEDDED,
  isRecognizedBytes,
  safeContentPath,
  createPresentationConversionHandler,
  enqueuePresentationVideoAssets,
  reconcileRecoveredPresentationVideos,
  extractSafeAssets,
  renderComplexSlideFallbacks,
};
