'use strict';

const crypto = require('crypto');
const { db } = require('../db/database');

const LIVE_STREAM_DEVICE_PREFIX = 'live-stream-program-';
const DEFAULT_LIVE_STREAM_DISPLAY_NAME = 'Content for live stream';
const DEFAULT_LIVE_STREAM_NOTES = 'Managed by Media Control for OBS/PeerTube live-stream program output.';

// In-memory last-content-change timestamps per live-stream display id (epoch
// seconds). Used by the AI Director to briefly favor slides right after a
// change. Lives only in this process; that is fine because the director polls
// continuously and only needs recency, not history.
const liveContentChangeAt = new Map();

function markLiveContentChanged(deviceId) {
  if (!deviceId) return;
  liveContentChangeAt.set(String(deviceId), Date.now() / 1000);
}

function liveStreamDeviceId(workspaceId) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const hash = crypto.createHash('sha256').update(String(workspaceId)).digest('hex').slice(0, 24);
  return `${LIVE_STREAM_DEVICE_PREFIX}${hash}`;
}

function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

function rowById(deviceId) {
  return db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) || null;
}

function ensureLiveStreamDisplay({ workspaceId, userId }) {
  if (!workspaceId) throw new Error('workspaceId is required');
  const id = liveStreamDeviceId(workspaceId);
  const existing = rowById(id);
  if (existing) {
    const token = existing.device_token || generateDeviceToken();
    db.prepare(`
      UPDATE devices
      SET name = ?,
          user_id = COALESCE(user_id, ?),
          workspace_id = ?,
          device_token = ?,
          screen_width = COALESCE(screen_width, 1920),
          screen_height = COALESCE(screen_height, 1080),
          android_version = COALESCE(android_version, 'Web/OBS Browser Source'),
          app_version = COALESCE(app_version, '1.1.0-live-stream'),
          notes = COALESCE(notes, ?),
          updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(DEFAULT_LIVE_STREAM_DISPLAY_NAME, userId || null, workspaceId, token, DEFAULT_LIVE_STREAM_NOTES, id);
    return rowById(id);
  }

  const token = generateDeviceToken();
  db.prepare(`
    INSERT INTO devices (
      id, user_id, workspace_id, name, pairing_code, status, device_token,
      screen_width, screen_height, android_version, app_version, notes
    ) VALUES (?, ?, ?, ?, NULL, 'offline', ?, 1920, 1080, 'Web/OBS Browser Source', '1.1.0-live-stream', ?)
  `).run(id, userId || null, workspaceId, DEFAULT_LIVE_STREAM_DISPLAY_NAME, token, DEFAULT_LIVE_STREAM_NOTES);
  return rowById(id);
}

function loadLiveStreamDisplay(deviceId, token) {
  if (!deviceId || !token) return null;
  if (!String(deviceId).startsWith(LIVE_STREAM_DEVICE_PREFIX)) return null;
  const row = rowById(String(deviceId));
  if (!row || !row.device_token) return null;
  try {
    const expected = Buffer.from(String(row.device_token));
    const actual = Buffer.from(String(token));
    if (expected.length !== actual.length) return null;
    if (!crypto.timingSafeEqual(expected, actual)) return null;
    return row;
  } catch {
    return null;
  }
}

function buildLiveStreamPlayerUrl({ baseUrl, display }) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!display || !display.id || !display.device_token) throw new Error('display with device_token is required');
  const base = String(baseUrl).replace(/\/+$/, '');
  const qs = new URLSearchParams({ device_id: display.id, token: display.device_token });
  return `${base}/player/live-stream?${qs.toString()}`;
}

function liveStreamProgramState(workspaceId) {
  if (!workspaceId) return { configured: false, content_active: false };
  const id = liveStreamDeviceId(workspaceId);
  const row = db.prepare(`
    SELECT d.id, d.name, d.workspace_id, d.playlist_id,
           p.id AS playlist_id, p.status AS playlist_status, p.published_snapshot
    FROM devices d
    LEFT JOIN playlists p ON p.id = d.playlist_id
    WHERE d.id = ?
  `).get(id);
  if (!row) return { configured: false, content_active: false, display_id: id };
  let items = [];
  try { items = row.published_snapshot ? JSON.parse(row.published_snapshot) : []; } catch { items = []; }
  const contentActive = row.playlist_status === 'published'
    && Array.isArray(items)
    && items.some(item => item && (item.content_id || item.widget_id || item.remote_url || item.filepath));
  return {
    configured: true,
    content_active: contentActive,
    display_id: row.id,
    display_name: row.name,
    playlist_id: row.playlist_id || null,
    playlist_status: row.playlist_status || null,
    item_count: Array.isArray(items) ? items.length : 0,
    last_content_change_at: liveContentChangeAt.get(String(row.id)) || null,
  };
}

function liveStreamProgramStateAnyWorkspace() {
  const row = db.prepare(`
    SELECT workspace_id
    FROM devices
    WHERE id LIKE ?
    ORDER BY updated_at DESC
    LIMIT 1
  `).get(`${LIVE_STREAM_DEVICE_PREFIX}%`);
  if (!row || !row.workspace_id) return { configured: false, content_active: false };
  return liveStreamProgramState(row.workspace_id);
}

module.exports = {
  DEFAULT_LIVE_STREAM_DISPLAY_NAME,
  LIVE_STREAM_DEVICE_PREFIX,
  buildLiveStreamPlayerUrl,
  ensureLiveStreamDisplay,
  liveStreamDeviceId,
  liveStreamProgramState,
  liveStreamProgramStateAnyWorkspace,
  loadLiveStreamDisplay,
  markLiveContentChanged,
};
