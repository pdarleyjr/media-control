'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const config = require('../config');

const queued = new Set();

function canonicalAssetPath(contentId) {
  return `/api/content/${encodeURIComponent(String(contentId || ''))}/file`;
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

function manifestItem(contentId, values = {}) {
  const size = Number(values.size_bytes ?? values.size) || 0;
  return {
    asset_id: values.asset_id || contentId,
    content_id: contentId,
    generation: Math.max(1, Number(values.generation) || 1),
    sha256: String(values.sha256 || '').toLowerCase(),
    size,
    size_bytes: size,
    canonical_path: values.canonical_path || null,
    canonical_url: values.canonical_url || canonicalAssetPath(contentId),
  };
}

function upsertAssetManifest(db, contentId, values = {}) {
  const item = manifestItem(contentId, values);
  if (!db || !contentId || !/^[0-9a-f]{64}$/i.test(item.sha256) || item.size_bytes <= 0) return null;
  db.prepare(`
    INSERT INTO asset_checksums
      (asset_id, content_id, generation, sha256, size_bytes, canonical_path, canonical_url,
       poster_path, duration_sec, width, height, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
      asset_id=excluded.asset_id,
      generation=excluded.generation,
      sha256=excluded.sha256,
      size_bytes=excluded.size_bytes,
      canonical_path=excluded.canonical_path,
      canonical_url=excluded.canonical_url,
      poster_path=excluded.poster_path,
      duration_sec=excluded.duration_sec,
      width=excluded.width,
      height=excluded.height,
      computed_at=excluded.computed_at
  `).run(
    item.asset_id,
    contentId,
    item.generation,
    item.sha256,
    item.size_bytes,
    item.canonical_path,
    item.canonical_url,
    values.poster_path || null,
    values.duration_sec ?? null,
    values.width ?? null,
    values.height ?? null,
    Number(values.computed_at) || Math.floor(Date.now() / 1000),
  );
  return item;
}

async function writeAssetManifest(db, contentId, absolutePath) {
  if (!db || !contentId || !absolutePath || !fs.existsSync(absolutePath)) return null;
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size <= 0) return null;
  const sha256 = await sha256File(absolutePath);
  const row = db.prepare(
    'SELECT version, duration_sec, width, height, thumbnail_path FROM content WHERE id = ?',
  ).get(contentId) || {};
  return upsertAssetManifest(db, contentId, {
    generation: row.version,
    sha256,
    size_bytes: stat.size,
    canonical_path: path.basename(absolutePath),
    poster_path: row.thumbnail_path,
    duration_sec: row.duration_sec,
    width: row.width,
    height: row.height,
  });
}

function queueAssetManifest(db, contentId, absolutePath) {
  const key = String(contentId || '');
  if (!key || queued.has(key)) return false;
  queued.add(key);
  setImmediate(async () => {
    try {
      let resolvedPath = absolutePath;
      if (!resolvedPath) {
        const row = db.prepare('SELECT filepath FROM content WHERE id = ?').get(contentId);
        if (row && row.filepath) resolvedPath = path.join(config.contentDir, path.basename(row.filepath));
      }
      await writeAssetManifest(db, contentId, resolvedPath);
    } catch (error) {
      console.warn(`[asset-manifest] ${contentId} failed: ${error.message}`);
    } finally {
      queued.delete(key);
    }
  });
  return true;
}

module.exports = {
  canonicalAssetPath,
  manifestItem,
  queueAssetManifest,
  sha256File,
  upsertAssetManifest,
  writeAssetManifest,
};
