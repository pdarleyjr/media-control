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

async function writeAssetManifest(db, contentId, absolutePath) {
  if (!db || !contentId || !absolutePath || !fs.existsSync(absolutePath)) return null;
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size <= 0) return null;
  const sha256 = await sha256File(absolutePath);
  const row = db.prepare('SELECT duration_sec, width, height, thumbnail_path FROM content WHERE id = ?').get(contentId) || {};
  db.prepare(`
    INSERT INTO asset_checksums
      (asset_id, content_id, sha256, size_bytes, canonical_path, canonical_url,
       poster_path, duration_sec, width, height, computed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(content_id) DO UPDATE SET
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
    contentId,
    contentId,
    sha256,
    stat.size,
    path.basename(absolutePath),
    canonicalAssetPath(contentId),
    row.thumbnail_path || null,
    row.duration_sec ?? null,
    row.width ?? null,
    row.height ?? null,
    Math.floor(Date.now() / 1000)
  );
  return { asset_id: contentId, content_id: contentId, sha256, size_bytes: stat.size, canonical_url: canonicalAssetPath(contentId) };
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

module.exports = { canonicalAssetPath, queueAssetManifest, sha256File, writeAssetManifest };
