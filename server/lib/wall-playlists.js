'use strict';

const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

function buildPlaylistSnapshot(playlistId) {
  return db.prepare(`
    SELECT pi.content_id, pi.widget_id, pi.zone_id, pi.sort_order, pi.duration_sec,
           COALESCE(pi.fit_mode, c.default_fit_mode) AS fit_mode,
           COALESCE(c.filename, w.name) as filename, c.mime_type, c.filepath, c.file_size,
           c.duration_sec as content_duration, c.remote_url,
           w.name as widget_name, w.widget_type, w.config as widget_config
    FROM playlist_items pi
    LEFT JOIN content c ON pi.content_id = c.id
    LEFT JOIN widgets w ON pi.widget_id = w.id
    WHERE pi.playlist_id = ?
    ORDER BY pi.sort_order ASC
  `).all(playlistId);
}

function wallContextForDevice(deviceId) {
  return db.prepare(`
    SELECT vw.id AS wall_id, vw.playlist_id AS wall_playlist_id,
           COALESCE(vw.layout_mode, 'span') AS layout_mode
    FROM video_wall_devices vwd
    JOIN video_walls vw ON vw.id = vwd.wall_id
    WHERE vwd.device_id = ?
    LIMIT 1
  `).get(deviceId) || null;
}

function clonePlaylistForDevice(deviceId, userId, sourcePlaylistId) {
  const device = db.prepare('SELECT playlist_id, workspace_id, name, user_id FROM devices WHERE id = ?').get(deviceId);
  if (!device) return null;

  const playlistId = uuidv4();
  const sourceId = sourcePlaylistId !== undefined ? sourcePlaylistId : device.playlist_id;
  const snapshot = sourceId ? buildPlaylistSnapshot(sourceId) : [];

  const tx = db.transaction(() => {
    db.prepare('INSERT INTO playlists (id, user_id, workspace_id, name, is_auto_generated) VALUES (?, ?, ?, ?, 1)')
      .run(playlistId, userId || device.user_id || null, device.workspace_id || null, `${device.name || 'Display'} playlist`);

    if (snapshot.length) {
      const insert = db.prepare(`
        INSERT INTO playlist_items (playlist_id, content_id, widget_id, zone_id, sort_order, duration_sec, fit_mode)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of snapshot) {
        insert.run(
          playlistId,
          item.content_id || null,
          item.widget_id || null,
          item.zone_id || null,
          item.sort_order || 0,
          item.duration_sec || 10,
          item.fit_mode ?? null,
        );
      }
    }

    db.prepare("UPDATE playlists SET status = 'published', published_snapshot = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(JSON.stringify(snapshot), playlistId);
    db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?').run(playlistId, deviceId);
  });
  tx();

  return playlistId;
}

function ensureDevicePlaylist(deviceId, userId) {
  const device = db.prepare('SELECT playlist_id, workspace_id, name, user_id FROM devices WHERE id = ?').get(deviceId);
  if (!device) return null;

  if (device.playlist_id) {
    const existing = db.prepare('SELECT id, is_auto_generated FROM playlists WHERE id = ?').get(device.playlist_id);
    if (existing) {
      const wall = wallContextForDevice(deviceId);
      const isSharedSplitWallPlaylist = !!(wall && wall.layout_mode === 'split' && wall.wall_playlist_id === existing.id);
      const isSharedSpanWallPlaylist = !!(wall && wall.layout_mode !== 'split' && wall.wall_playlist_id === existing.id);
      if (!isSharedSplitWallPlaylist && (existing.is_auto_generated || isSharedSpanWallPlaylist)) {
        return existing.id;
      }
    }
  }

  return clonePlaylistForDevice(deviceId, userId, device.playlist_id || null);
}

module.exports = {
  buildPlaylistSnapshot,
  clonePlaylistForDevice,
  ensureDevicePlaylist,
  wallContextForDevice,
};
