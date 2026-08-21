'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { sha256File, upsertAssetManifest } = require('../lib/asset-manifest');

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function resolveExistingContentFile(contentDir, storedPath) {
  if (!storedPath || /^https?:\/\//i.test(String(storedPath))) {
    throw fail('PRESENTATION_ASSET_NOT_LOCAL', 'This presentation asset does not have local bytes to copy.');
  }
  const root = fs.realpathSync(path.resolve(contentDir));
  const candidate = path.isAbsolute(String(storedPath))
    ? path.resolve(String(storedPath))
    : path.resolve(root, String(storedPath));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw fail('PRESENTATION_ASSET_PATH_INVALID', 'The presentation asset path is outside the media store.');
  }
  const real = fs.realpathSync(candidate);
  const realRelative = path.relative(root, real);
  if (!realRelative || realRelative.startsWith('..') || path.isAbsolute(realRelative) || !fs.statSync(real).isFile()) {
    throw fail('PRESENTATION_ASSET_PATH_INVALID', 'The presentation asset path is outside the media store.');
  }
  return { root, path: real };
}

function safeExtension(...values) {
  for (const value of values) {
    const extension = path.extname(String(value || '')).toLowerCase();
    if (/^\.[a-z0-9]{1,10}$/.test(extension)) return extension;
  }
  return '';
}

function libraryContentType(mimeType) {
  const family = String(mimeType || '').split('/')[0].toLowerCase();
  return ['image', 'video', 'audio'].includes(family) ? family : 'document';
}

function copiedFilename(filename) {
  const parsed = path.parse(String(filename || 'Presentation asset'));
  return `${parsed.name || 'Presentation asset'} (copy)${parsed.ext}`;
}

function relatedInternalAsset(db, { presentationId, contentId, workspaceId }) {
  return db.prepare(`SELECT c.* FROM content c
    WHERE c.id=? AND c.workspace_id=? AND c.library_scope='internal'
      AND (
        EXISTS (SELECT 1 FROM presentation_assets pa
          WHERE pa.presentation_id=? AND pa.content_id=c.id)
        OR EXISTS (SELECT 1 FROM presentation_conversion_runs pcr
          WHERE pcr.presentation_id=? AND pcr.source_content_id=c.id)
      )`).get(contentId, workspaceId, presentationId, presentationId);
}

function publishExclusiveCopy(sourcePath, finalPath, partialPath, createdFiles) {
  fs.copyFileSync(sourcePath, partialPath, fs.constants.COPYFILE_EXCL);
  try {
    fs.linkSync(partialPath, finalPath);
    createdFiles.add(finalPath);
  } finally {
    try { fs.unlinkSync(partialPath); } catch { /* caller retries cleanup */ }
  }
}

async function copyPresentationAssetToLibrary(db, options) {
  const {
    presentationId,
    contentId,
    workspaceId,
    userId,
    contentDir,
    createId = randomUUID,
    now = Math.floor(Date.now() / 1000),
  } = options;
  const source = relatedInternalAsset(db, { presentationId, contentId, workspaceId });
  if (!source) {
    throw fail('PRESENTATION_ASSET_NOT_FOUND', 'Presentation asset not found.');
  }
  if (String(source.mime_type || '').startsWith('video/') && source.processing_status !== 'ready') {
    throw fail('PRESENTATION_ASSET_NOT_READY', 'Wait for this presentation video to finish preparing before saving a copy.');
  }

  const id = String(createId());
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    throw fail('PRESENTATION_ASSET_COPY_ID_INVALID', 'Could not allocate a safe Media Library identity.');
  }
  const primary = resolveExistingContentFile(contentDir, source.filepath);
  const primaryExtension = safeExtension(source.filepath, source.filename);
  const storedName = `presentation_asset_copy_${id}${primaryExtension}`;
  const finalPath = path.join(primary.root, storedName);
  const partialPath = `${finalPath}.partial-${process.pid}-${randomUUID()}`;
  const cleanup = new Set([partialPath]);
  const createdFiles = new Set();
  let thumbnailName = null;

  try {
    publishExclusiveCopy(primary.path, finalPath, partialPath, createdFiles);

    if (source.thumbnail_path) {
      const thumbnail = resolveExistingContentFile(contentDir, source.thumbnail_path);
      if (thumbnail.path === primary.path) {
        thumbnailName = storedName;
      } else {
        const thumbnailExtension = safeExtension(source.thumbnail_path, source.filename) || '.jpg';
        thumbnailName = `presentation_asset_copy_${id}_thumb${thumbnailExtension}`;
        const thumbnailFinal = path.join(primary.root, thumbnailName);
        const thumbnailPartial = `${thumbnailFinal}.partial-${process.pid}-${randomUUID()}`;
        cleanup.add(thumbnailPartial);
        publishExclusiveCopy(thumbnail.path, thumbnailFinal, thumbnailPartial, createdFiles);
      }
    }

    let sourceMetadata = {};
    try { sourceMetadata = JSON.parse(source.metadata_json || '{}'); } catch { sourceMetadata = {}; }
    const metadata = JSON.stringify({
      ...sourceMetadata,
      saved_from_presentation_id: presentationId,
      saved_from_content_id: contentId,
    });
    const size = fs.statSync(finalPath).size;
    const sha256 = await sha256File(finalPath);
    const commit = db.transaction(() => {
      db.prepare(`INSERT INTO content (
      id,user_id,workspace_id,filename,filepath,mime_type,file_size,duration_sec,thumbnail_path,
      width,height,processing_status,processing_error,media_probe_json,access_level,
      source_content_id,version,archived_at,updated_at,created_at,content_type,metadata_json,library_scope
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'ready',NULL,?,'private',?,1,NULL,?,?,?,?, 'library')`).run(
      id, userId, workspaceId, copiedFilename(source.filename), storedName, source.mime_type,
      size, source.duration_sec, thumbnailName, source.width, source.height,
      source.media_probe_json, source.id, now, now, libraryContentType(source.mime_type), metadata,
      );
      upsertAssetManifest(db, id, {
        generation: 1,
        sha256,
        size_bytes: size,
        canonical_path: storedName,
        poster_path: thumbnailName,
        duration_sec: source.duration_sec,
        width: source.width,
        height: source.height,
        computed_at: now,
      });
    });
    commit();
    return {
      content_id: id,
      filename: copiedFilename(source.filename),
      filepath: storedName,
      thumbnail_path: thumbnailName,
      mime_type: source.mime_type,
      file_size: size,
      library_scope: 'library',
      source_content_id: source.id,
    };
  } catch (error) {
    for (const file of cleanup) {
      try { fs.unlinkSync(file); } catch { /* absent or retained source file */ }
    }
    for (const file of createdFiles) {
      try { fs.unlinkSync(file); } catch { /* recovery evidence remains in the media store */ }
    }
    throw error;
  }
}

module.exports = {
  copyPresentationAssetToLibrary,
  libraryContentType,
  relatedInternalAsset,
  resolveExistingContentFile,
};
