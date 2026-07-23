/**
 * PeerTube replay → Media Control integration.
 *
 * Flow: recording session → PeerTube replay discovery → processing-state
 * tracking → replay UUID linkage → operator review → Add to Media Control →
 * privacy selection → content record → real-time library update.
 *
 * Properties:
 *  - Idempotent by (recording_session_id, peertube_video_uuid). Re-discovery
 *    of the same VOD never duplicates; the worker upserts a single row.
 *  - Bounded polling with exponential backoff (capped). A restart resumes.
 *  - No duplicate content: adding to Media Control is gated on content_id
 *    being NULL, then set atomically.
 *  - Default private visibility (privacy=1). PeerTube remains authoritative
 *    storage; the content row only references the PeerTube watch URL unless a
 *    local fallback download is explicitly requested.
 *  - Reuses existing Media Control authorization on the route layer. The
 *    worker itself authenticates to PeerTube with a server-side token from env
 *    (never logged, never returned to clients).
 *  - Stream keys and PeerTube secrets are never exposed in telemetry, audit,
 *    or API responses (only the public watch/embed URL + uuid).
 */
const { db } = require('../db/database');
const config = require('../config');
const { audit } = require('../lib/audit');

const STATE = Object.freeze({
  DISCOVERING: 'discovering',
  PROCESSING: 'processing',
  READY: 'ready',
  FAILED: 'failed',
  ADDED: 'added',
});

let _timer = null;
let _running = false;
let _backoff = 0;

function _cfg() {
  return config.peerTubeReplay || {};
}

function _enabled() {
  const c = _cfg();
  return c.enabled && (c.apiToken || (c.apiUsername && c.apiPassword));
}

function _apiBase() {
  return _cfg().apiBase || 'http://127.0.0.1:8098';
}

/** Authenticated PeerTube API call. Token from env; never echoed. */
async function _ptFetch(pathname, { method = 'GET', body } = {}) {
  const c = _cfg();
  let token = c.apiToken;
  if (!token && c.apiUsername && c.apiPassword) {
    token = await _resolveToken(c);
  }
  if (!token) throw new Error('PeerTube API token not configured');
  const url = `${_apiBase()}${pathname}`;
  const headers = { Authorization: `Bearer ${token}` };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PeerTube ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

let _cachedToken = null;
async function _resolveToken(c) {
  if (_cachedToken) return _cachedToken;
  const url = `${c.apiBase}/api/v1/users/token`;
  const params = new URLSearchParams({
    client_id: 'peertube',
    grant_type: 'password',
    username: c.apiUsername,
    password: c.apiPassword,
  });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`PeerTube token ${res.status}`);
  const data = await res.json();
  _cachedToken = data.access_token;
  return _cachedToken;
}

/** Discover recent local VODs (replays) from PeerTube. */
async function discoverReplays({ limit = 20 } = {}) {
  const data = await _ptFetch(`/api/v1/videos?start=0&count=${limit}&sort=-createdAt&filter=local&skipCount=false`);
  return Array.isArray(data.data) ? data.data : [];
}

/** Map a PeerTube video to a replay row. */
function _toReplay(v) {
  const uuid = v.uuid;
  const watchPath = v.path || `/w/${uuid}`;
  const publicBase = _cfg().publicWatchBase || _apiBase();
  const watchUrl = /^https?:\/\//i.test(watchPath) ? watchPath : `${publicBase}${watchPath}`;
  const embedUrl = `${publicBase}/videos/embed/${uuid}`;
  const state = _mapProcessingState(v);
  return {
    peertube_video_uuid: uuid,
    peertube_video_id: v.id,
    title: v.name || '',
    description: v.description || '',
    duration_sec: v.duration || null,
    thumbnail_url: Array.isArray(v.thumbnailPath) && v.thumbnailPath[0]
      ? `${publicBase}${v.thumbnailPath[0]}`
      : (v.thumbnailPath ? `${publicBase}${v.thumbnailPath}` : null),
    watch_url: watchUrl,
    embed_url: embedUrl,
    processing_state: state,
    privacy: v.privacy ?? 1,
    recording_session_id: _extractSessionId(v),
  };
}

function _mapProcessingState(v) {
  // PeerTube state: { id, label }. 1=TO_TRANSCODE,2=TO_IMPORT,3=TO_MOVE...,
  // 5=PUBLISHED. isLive marks an ongoing live, not a replay VOD.
  if (v.isLive) return STATE.PROCESSING;
  const id = v.state && typeof v.state.id === 'number' ? v.state.id : null;
  if (id === 5 || id === 1 && v.transcodingFinished) return STATE.READY;
  if (id != null && id !== 5) return STATE.PROCESSING;
  // Published with no pending transcode.
  if (v.state && /publish/i.test(String(v.state.label || ''))) return STATE.READY;
  return STATE.PROCESSING;
}

function _extractSessionId(v) {
  // Prefer an explicit tag set by the director at stream time; fall back to
  // the PeerTube uuid so discovery is always idempotent per VOD.
  const tags = Array.isArray(v.tags) ? v.tags : [];
  const session = tags.find((t) => typeof t === 'string' && /^rec:[^:]+/.test(t));
  if (session) return session.slice(4);
  const support = v.support || '';
  const m = /rec-session:([a-zA-Z0-9_-]+)/.exec(support);
  if (m) return m[1];
  return v.uuid;
}

/** Upsert a discovered replay (idempotent). Returns the row id. */
function upsertReplay(v) {
  const r = _toReplay(v);
  const existing = db.prepare(
    'SELECT id, processing_state, content_id FROM peertube_replays WHERE recording_session_id = ? AND peertube_video_uuid = ?'
  ).get(r.recording_session_id, r.peertube_video_uuid);
  if (existing) {
    // Update mutable state, but never clear a content_id or revert to a
    // pre-discovery state once added.
    const next = r.processing_state === STATE.READY && existing.content_id ? STATE.ADDED : r.processing_state;
    db.prepare(`
      UPDATE peertube_replays
      SET title=?, description=?, duration_sec=?, thumbnail_url=?, watch_url=?, embed_url=?,
          processing_state=?, privacy=?, peertube_video_id=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(r.title, r.description, r.duration_sec, r.thumbnail_url, r.watch_url, r.embed_url,
      next, r.privacy, r.peertube_video_id, existing.id);
    return existing.id;
  }
  const id = require('uuid').v4();
  db.prepare(`
    INSERT INTO peertube_replays
      (id, recording_session_id, peertube_video_uuid, peertube_video_id, title, description,
       duration_sec, thumbnail_url, watch_url, embed_url, processing_state, privacy, workspace_id)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, r.recording_session_id, r.peertube_video_uuid, r.peertube_video_id, r.title,
    r.description, r.duration_sec, r.thumbnail_url, r.watch_url, r.embed_url,
    r.processing_state, r.privacy, null);
  return id;
}

/** List replays pending operator review (ready, not yet added). */
function listPending({ limit = 50, offset = 0 } = {}) {
  return db.prepare(`
    SELECT * FROM peertube_replays
    WHERE processing_state = 'ready' AND content_id IS NULL
    ORDER BY discovered_at DESC LIMIT ? OFFSET ?
  `).all(Math.min(Number(limit) || 50, 200), Number(offset) || 0);
}

function listAll({ limit = 100, offset = 0 } = {}) {
  return db.prepare('SELECT * FROM peertube_replays ORDER BY discovered_at DESC LIMIT ? OFFSET ?')
    .all(Math.min(Number(limit) || 100, 500), Number(offset) || 0);
}

function getById(id) {
  return db.prepare('SELECT * FROM peertube_replays WHERE id = ?').get(id);
}

/**
 * Operator-approve: add a Media Control content row referencing the PeerTube
 * replay (default private). Idempotent — a second approval returns the existing
 * content_id without creating a duplicate.
 */
function addToMediaControl({ replayId, userId, workspaceId, privacy = 1, title }) {
  const replay = getById(replayId);
  if (!replay) throw Object.assign(new Error('Replay not found'), { code: 404 });
  // Idempotent: a repeat approval returns the existing content row without
  // creating a duplicate (operator double-click safe).
  if (replay.content_id) {
    return { content_id: replay.content_id, replay, created: false };
  }
  if (replay.processing_state !== STATE.READY) {
    throw Object.assign(new Error(`Replay not ready (state=${replay.processing_state})`), { code: 409 });
  }
  const { v4: uuidv4 } = require('uuid');
  const contentId = uuidv4();
  const safeTitle = (title || replay.title || `Replay ${replay.peertube_video_uuid || ''}`).slice(0, 255);
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO content (id, user_id, workspace_id, filename, filepath, mime_type, file_size, remote_url,
                           access_level, content_type, processing_status, original_sha256)
      VALUES (?, ?, ?, ?, '', ?, 0, ?, ?, 'peertube-replay', 'remote', ?)
    `).run(contentId, userId, workspaceId, safeTitle, 'video/mp4', replay.watch_url,
      privacy === 3 ? 'public' : 'private', replay.peertube_video_uuid);
    db.prepare(`
      UPDATE peertube_replays
      SET content_id=?, processing_state='added', privacy=?, added_at=strftime('%s','now'),
          added_by=?, updated_at=strftime('%s','now')
      WHERE id=?
    `).run(contentId, privacy, userId, replayId);
  });
  tx();
  audit({
    actorType: 'user', actorId: userId, action: 'peertube.replay.add',
    targetType: 'content', targetId: contentId, workspaceId,
    details: { replayId, peertubeUuid: replay.peertube_video_uuid, privacy },
  });
  return { content_id: contentId, replay: getById(replayId), created: true };
}

/** Reject/discard a replay without adding it. */
function discard({ replayId, userId }) {
  const replay = getById(replayId);
  if (!replay) throw Object.assign(new Error('Replay not found'), { code: 404 });
  if (replay.content_id) throw Object.assign(new Error('Replay already linked to content'), { code: 409 });
  db.prepare(`UPDATE peertube_replays SET processing_state='failed', error_message='discarded_by_operator', updated_at=strftime('%s','now') WHERE id=?`).run(replayId);
  audit({ actorType: 'user', actorId: userId, action: 'peertube.replay.discard', targetType: 'peertube_replay', targetId: replayId, details: { peertubeUuid: replay.peertube_video_uuid } });
  return { ok: true };
}

async function _tick() {
  if (_running || !_enabled()) return;
  _running = true;
  try {
    const videos = await discoverReplays({});
    let newCount = 0;
    for (const v of videos) {
      if (v.isLive) continue; // only VOD replays
      const before = listPending({ limit: 1, offset: 0 }).length;
      upsertReplay(v);
      newCount++;
      void before;
    }
    // Re-evaluate processing rows whose PeerTube state may have advanced.
    const processing = db.prepare("SELECT peertube_video_uuid FROM peertube_replays WHERE processing_state IN ('discovering','processing') AND peertube_video_uuid IS NOT NULL").all();
    for (const row of processing) {
      try {
        const v = await _ptFetch(`/api/v1/videos/${row.peertube_video_uuid}`);
        upsertReplay(v);
      } catch (e) { /* per-video fetch best-effort */ }
    }
    _backoff = 0;
    if (newCount) console.log(`[peertube-replay] discovered ${newCount} video(s)`);
  } catch (e) {
    _backoff = Math.min((_backoff || _cfg().pollIntervalMs) * 2, _cfg().pollBackoffMaxMs);
    console.warn(`[peertube-replay] poll failed; backing off ${_backoff}ms: ${e.message}`);
  } finally {
    _running = false;
  }
}

function start() {
  if (!_enabled() || _timer) return;
  const interval = _cfg().pollIntervalMs;
  _timer = setInterval(() => {
    const delay = _backoff || interval;
    setTimeout(_tick, Math.min(delay, _cfg().pollBackoffMaxMs)).unref?.();
  }, interval);
  _timer.unref?.();
  // Kick once shortly after boot.
  setTimeout(_tick, 5000).unref?.();
  console.log(`[peertube-replay] worker started (poll ${interval}ms)`);
}

function stop() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  STATE,
  start, stop,
  discoverReplays, upsertReplay,
  listPending, listAll, getById,
  addToMediaControl, discard,
  // exported for tests
  _toReplay, _mapProcessingState, _extractSessionId,
};
