const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
// Phase 2.2l: workspace-aware access. Drops the previous listVisibleWalls /
// userCanAccessWall helpers - the admin/team_members branches there were
// dead code after the Phase 2.1 role rename (no users carry role='admin'
// anymore; team_members is a vestigial table from the pre-workspace model).
const { accessContext } = require('../lib/tenancy');
const { ensureDevicePlaylist } = require('../lib/wall-playlists');
const {
  parseStoredLayout,
  presetGroups,
  validateLayout,
} = require('../lib/wall-layout');

// Load a wall + access context. Returns the wall row or null after sending
// 403/404. requireWrite=true also denies workspace_viewer.
function loadWallAccess(req, res, requireWrite) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(req.params.id);
  if (!wall) { res.status(404).json({ error: 'Wall not found' }); return null; }
  if (!wall.workspace_id) { res.status(403).json({ error: 'Wall not assigned to a workspace' }); return null; }
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(wall.workspace_id);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) { res.status(403).json({ error: 'Access denied' }); return null; }
  if (requireWrite && !ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return null;
  }
  req.wall = wall;
  req.wallCtx = ctx;
  return wall;
}

function requireWallRead(req, res, next) {
  if (!loadWallAccess(req, res, false)) return;
  next();
}

function requireWallWrite(req, res, next) {
  if (!loadWallAccess(req, res, true)) return;
  next();
}

// List walls (with attached devices). Phase 2.2l: scoped to caller's
// current workspace.
router.get('/', (req, res) => {
  if (!req.workspaceId) return res.json([]);
  const walls = db.prepare('SELECT * FROM video_walls WHERE workspace_id = ? ORDER BY created_at DESC').all(req.workspaceId);

  const devStmt = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status, d.playlist_id
    FROM video_wall_devices vwd
    JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `);
  walls.forEach(w => {
    w.devices = devStmt.all(w.id);
    w.layout = parseStoredLayout(w, w.devices);
  });

  res.json(walls);
});

// Notify dashboard clients to re-fetch walls/devices. Phase 2.3: scoped to
// the wall's workspace room so other tenants don't get a stray refresh ping.
function notifyDashboards(req, workspaceId) {
  try {
    const io = req.app.get('io');
    if (!io || !workspaceId) return;
    const { workspaceRoom, emitToWorkspace } = require('../lib/socket-rooms');
    emitToWorkspace(io.of('/dashboard'), workspaceRoom(workspaceId), 'dashboard:wall-changed', null);
  } catch (e) { /* silent */ }
}

function loadWallWithDevices(id) {
  const wall = db.prepare('SELECT * FROM video_walls WHERE id = ?').get(id);
  if (!wall) return null;
  wall.devices = db.prepare(`
    SELECT vwd.*, d.name as device_name, d.status as device_status, d.playlist_id
    FROM video_wall_devices vwd JOIN devices d ON vwd.device_id = d.id
    WHERE vwd.wall_id = ? ORDER BY vwd.grid_row, vwd.grid_col
  `).all(id);
  wall.layout = parseStoredLayout(wall, wall.devices);
  return wall;
}

// Push a fresh wall-aware playlist payload to one device.
function pushWallPayloadToDevice(req, deviceId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const { buildPlaylistPayload } = require('../ws/deviceSocket');
    const commandQueue = require('../lib/command-queue');
    commandQueue.queueOrEmitPlaylistUpdate(io.of('/device'), deviceId, buildPlaylistPayload);
  } catch (e) { /* silent */ }
}

function pushToWallMembers(req, wallId) {
  const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(wallId);
  for (const m of members) pushWallPayloadToDevice(req, m.device_id);
}

// Get wall with devices
router.get('/:id', requireWallRead, (req, res) => {
  res.json(loadWallWithDevices(req.wall.id));
});

// Create wall. Phase 2.2l: stamps workspace_id; closes pre-existing leak
// where playlist_id was accepted with NO cross-tenant check (caller could
// embed a foreign workspace's playlist into a wall they create).
router.post('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const ws = db.prepare('SELECT * FROM workspaces WHERE id = ?').get(req.workspaceId);
  const ctx = ws && accessContext(req.user.id, req.user.role, ws);
  if (!ctx) return res.status(403).json({ error: 'Access denied' });
  if (!ctx.actingAs && ctx.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const { name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, playlist_id, is_locked } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  if (playlist_id) {
    const pl = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(playlist_id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: 'Playlist is not in this workspace' });
    }
  }

  const id = uuidv4();
  db.prepare(`
    INSERT INTO video_walls (id, user_id, workspace_id, name, grid_cols, grid_rows, bezel_h_mm, bezel_v_mm, playlist_id, is_locked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, req.user.id, req.workspaceId, name, grid_cols || 2, grid_rows || 1,
    bezel_h_mm || 0, bezel_v_mm || 0, playlist_id || null, is_locked ? 1 : 0);

  const wall = loadWallWithDevices(id);
  notifyDashboards(req, req.workspaceId);
  res.status(201).json(wall);
});

// Update wall (name, grid, bezels, playlist, leader, sync_mode). Phase 2.2l:
// closes pre-existing leaks where playlist_id / content_id / leader_device_id
// were accepted without any cross-tenant check.
router.put('/:id', requireWallWrite, (req, res) => {
  const wall = req.wall;

  if (req.body.playlist_id) {
    const pl = db.prepare('SELECT workspace_id FROM playlists WHERE id = ?').get(req.body.playlist_id);
    if (!pl) return res.status(404).json({ error: 'Playlist not found' });
    if (pl.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Playlist is not in this workspace' });
    }
  }
  if (req.body.content_id) {
    const c = db.prepare('SELECT workspace_id FROM content WHERE id = ?').get(req.body.content_id);
    if (!c) return res.status(404).json({ error: 'Content not found' });
    if (c.workspace_id && c.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Content is not in this workspace' });
    }
  }
  if (req.body.leader_device_id) {
    const d = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(req.body.leader_device_id);
    if (!d) return res.status(404).json({ error: 'Leader device not found' });
    if (d.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Leader device is not in this workspace' });
    }
  }

  const fields = ['name', 'grid_cols', 'grid_rows', 'bezel_h_mm', 'bezel_v_mm',
    'screen_w_mm', 'screen_h_mm', 'sync_mode', 'leader_device_id', 'content_id', 'playlist_id',
    'player_x', 'player_y', 'player_width', 'player_height',
    // 2026-06-04: Span/Split template. 'span' = one source stretched across all
    // screens (wall_config); 'split' = each member screen plays independently.
    'layout_mode',
    'is_locked',
    // 2026-05-28: wall-level refresh_rate_hz override (informational on the player,
    // surfaced in payload.wall_config.refresh_rate_hz so future native players can pick
    // an exact display mode on Fire TV / Android).
    'refresh_rate_hz'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }

  if (updates.length > 0) {
    updates.push("updated_at = strftime('%s','now')");
    values.push(req.params.id);
    db.prepare(`UPDATE video_walls SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  // The legacy Span/Split control intentionally replaces any custom subgroup
  // layout. This keeps old clients deterministic and makes the migration fully
  // reversible without deleting playlists or memberships.
  if (req.body.layout_mode === 'span' || req.body.layout_mode === 'split') {
    db.prepare(`
      UPDATE video_walls
      SET layout_json = NULL, layout_revision = layout_revision + 1,
          updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(req.params.id);
  }

  const nextLayoutMode = req.body.layout_mode !== undefined
    ? String(req.body.layout_mode)
    : String(wall.layout_mode || 'span');

  // If playlist changed while the wall is still spanning, propagate to every
  // member device's playlist_id so the existing buildPlaylistPayload picks up
  // the right items. Split mode keeps per-device playlists independent.
  if (req.body.playlist_id !== undefined && nextLayoutMode !== 'split') {
    const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
    const stmt = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');
    for (const m of members) stmt.run(req.body.playlist_id || null, m.device_id);
  }

  // When a wall enters split mode, decouple any member still sharing the wall
  // playlist so future per-screen changes stay local to that screen.
  if (nextLayoutMode === 'split') {
    const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
    for (const m of members) ensureDevicePlaylist(m.device_id, req.user.id);
  }

  // Switching a wall back to Span means every physical screen should again play
  // the wall-level playlist. Split mode may have given members private
  // per-device playlists for per-cell drops; leave those alone while split, but
  // rejoin the shared wall playlist when returning to span.
  if (req.body.layout_mode === 'span') {
    const playlistId = req.body.playlist_id !== undefined ? req.body.playlist_id : wall.playlist_id;
    const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
    const stmt = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');
    for (const m of members) stmt.run(playlistId || null, m.device_id);
  }

  pushToWallMembers(req, req.params.id);
  notifyDashboards(req, req.wall.workspace_id);
  res.json(loadWallWithDevices(req.params.id));
});

// Atomically apply a versioned contiguous-group layout. `expected_revision`
// prevents two dashboards from silently replacing one another's edit.
router.put('/:id/layout', requireWallWrite, (req, res) => {
  const wall = req.wall;
  const members = db.prepare(`
    SELECT vwd.*, d.name AS device_name, d.status AS device_status, d.playlist_id
    FROM video_wall_devices vwd
    JOIN devices d ON d.id = vwd.device_id
    WHERE vwd.wall_id = ?
    ORDER BY vwd.grid_row, vwd.grid_col
  `).all(wall.id);
  const currentRevision = Number(wall.layout_revision) || 0;
  if (req.body.expected_revision != null && Number(req.body.expected_revision) !== currentRevision) {
    return res.status(409).json({
      error: 'Wall layout changed in another session',
      code: 'LAYOUT_REVISION_CONFLICT',
      current: parseStoredLayout(wall, members),
    });
  }

  let groups;
  try {
    groups = req.body.preset
      ? presetGroups(wall, members, String(req.body.preset))
      : req.body.groups;
    const validated = validateLayout(wall, members, { groups }, { revision: currentRevision + 1 });
    groups = validated.groups;
  } catch (error) {
    return res.status(400).json({ error: error.message, code: 'INVALID_WALL_LAYOUT' });
  }

  const memberById = new Map(members.map((member) => [member.device_id, member]));
  const nextRevision = currentRevision + 1;
  const tx = db.transaction(() => {
    const updatePlaylist = db.prepare('UPDATE devices SET playlist_id = ? WHERE id = ?');
    for (const group of groups) {
      if (group.layout === 'span' && group.member_ids.length > 1) {
        const leader = memberById.get(group.leader_device_id) || memberById.get(group.member_ids[0]);
        const playlistId = group.playlist_id || leader?.playlist_id || wall.playlist_id
          || ensureDevicePlaylist(group.leader_device_id, req.user.id);
        group.playlist_id = playlistId;
        for (const deviceId of group.member_ids) updatePlaylist.run(playlistId, deviceId);
      } else {
        const deviceId = group.member_ids[0];
        group.playlist_id = ensureDevicePlaylist(deviceId, req.user.id);
      }
    }

    const allIds = members.map((member) => member.device_id);
    const allSpan = groups.length === 1 && groups[0].layout === 'span'
      && groups[0].member_ids.length === allIds.length;
    const allSolo = groups.length === allIds.length && groups.every((group) => group.layout === 'solo');
    const mode = allSpan ? 'span' : (allSolo ? 'split' : 'groups');
    const layout = {
      version: 1,
      id: `${wall.id}:layout:${nextRevision}`,
      wall_id: wall.id,
      mode: 'groups',
      revision: nextRevision,
      preset: validateLayout(wall, members, { groups }, { revision: nextRevision }).preset,
      groups,
    };
    db.prepare(`
      UPDATE video_walls
      SET layout_mode = ?, layout_json = ?, layout_revision = ?,
          leader_device_id = ?, updated_at = strftime('%s','now')
      WHERE id = ?
    `).run(mode, JSON.stringify(layout), nextRevision, groups[0]?.leader_device_id || null, wall.id);
  });
  tx();

  pushToWallMembers(req, wall.id);
  notifyDashboards(req, wall.workspace_id);
  res.json(loadWallWithDevices(wall.id));
});

// Delete wall — clear playlists + wall_id on every former member (matches
// group-dissolve semantics: leaving the wall returns devices to ungrouped).
router.delete('/:id', requireWallWrite, (req, res) => {
  if (req.wall.is_locked) {
    return res.status(423).json({ error: 'Wall is locked' });
  }
  const wallWorkspaceId = req.wall.workspace_id; // capture before the DELETE
  const members = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
  const tx = db.transaction(() => {
    db.prepare("UPDATE devices SET wall_id = NULL, playlist_id = NULL WHERE wall_id = ?").run(req.params.id);
    db.prepare('DELETE FROM video_walls WHERE id = ?').run(req.params.id);
  });
  tx();

  // Push fresh (now wall-less, playlist-less) payloads to ex-members so they
  // exit wall mode and clear content immediately.
  for (const m of members) pushWallPayloadToDevice(req, m.device_id);
  notifyDashboards(req, wallWorkspaceId);

  res.json({ success: true });
});

// Set device grid positions. Replaces the entire member set.
// Devices removed lose their playlist (returned to ungrouped); devices added
// inherit the wall's playlist.
// Phase 2.2l: closes pre-existing leak. Old per-device check ran through
// team_members (legacy table) and role==='admin' (dead since Phase 2.1) -
// effectively only the device.user_id direct-ownership branch was active,
// missing the workspace dimension. Now: every device must be in the wall's
// workspace.
router.put('/:id/devices', requireWallWrite, (req, res) => {
  const { devices } = req.body;
  if (!Array.isArray(devices)) return res.status(400).json({ error: 'devices array required' });

  const wall = req.wall;
  for (const d of devices) {
    const dev = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(d.device_id);
    if (!dev) return res.status(404).json({ error: `Device ${d.device_id} not found` });
    if (dev.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: `Device ${d.device_id} is not in this workspace` });
    }
  }

  const previous = db.prepare('SELECT device_id FROM video_wall_devices WHERE wall_id = ?').all(req.params.id);
  const previousIds = new Set(previous.map(p => p.device_id));
  const incomingIds = new Set(devices.map(d => d.device_id));
  const removedIds = [...previousIds].filter(id => !incomingIds.has(id));
  if (wall.is_locked && (previousIds.size !== incomingIds.size || removedIds.length > 0)) {
    return res.status(423).json({ error: 'Wall is locked' });
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM video_wall_devices WHERE wall_id = ?').run(req.params.id);
    db.prepare("UPDATE devices SET wall_id = NULL WHERE wall_id = ?").run(req.params.id);

    // Removed devices: clear playlist (they're returning to ungrouped state).
    for (const id of removedIds) {
      db.prepare("UPDATE devices SET playlist_id = NULL WHERE id = ?").run(id);
    }

    const insertPos = db.prepare(`
      INSERT INTO video_wall_devices
        (wall_id, device_id, grid_col, grid_row, rotation, canvas_x, canvas_y, canvas_width, canvas_height)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const updateDevice = db.prepare("UPDATE devices SET wall_id = ?, playlist_id = ? WHERE id = ?");
    const splitMode = String(wall.layout_mode || 'span') === 'split';

    for (const d of devices) {
      insertPos.run(
        req.params.id, d.device_id,
        d.grid_col, d.grid_row, d.rotation || 0,
        d.canvas_x ?? null, d.canvas_y ?? null,
        d.canvas_width ?? null, d.canvas_height ?? null,
      );
      const playlistId = splitMode ? ensureDevicePlaylist(d.device_id, req.user.id) : (wall.playlist_id || null);
      updateDevice.run(req.params.id, playlistId, d.device_id);
      // A device joining a wall leaves all of its groups (walls and groups
      // are mutually exclusive concepts in this UX).
      db.prepare('DELETE FROM device_group_members WHERE device_id = ?').run(d.device_id);
    }

    if (devices.length > 0) {
      // Prefer the device whose canvas rect is closest to the wall's top-left
      // (smallest canvas_x + canvas_y), falling back to grid 0,0, then first.
      const leader =
        [...devices].sort((a, b) => ((a.canvas_x ?? 0) + (a.canvas_y ?? 0)) - ((b.canvas_x ?? 0) + (b.canvas_y ?? 0)))[0]
        || devices.find(d => d.grid_col === 0 && d.grid_row === 0)
        || devices[0];
      db.prepare('UPDATE video_walls SET leader_device_id = ? WHERE id = ?').run(leader.device_id, req.params.id);
    } else {
      db.prepare('UPDATE video_walls SET leader_device_id = NULL WHERE id = ?').run(req.params.id);
    }
  });
  tx();

  // Push wall-aware payload to current members, and a wall-less payload to
  // ex-members so they exit wall mode.
  for (const id of removedIds) pushWallPayloadToDevice(req, id);
  pushToWallMembers(req, req.params.id);
  notifyDashboards(req, req.wall.workspace_id);

  res.json(loadWallWithDevices(req.params.id));
});

// Set wall content (legacy single-video path — kept for back-compat).
// Phase 2.2l: closes pre-existing leak where content_id was accepted with
// NO cross-tenant check.
router.put('/:id/content', requireWallWrite, (req, res) => {
  const wall = req.wall;
  const { content_id } = req.body;
  if (content_id) {
    const c = db.prepare('SELECT workspace_id FROM content WHERE id = ?').get(content_id);
    if (!c) return res.status(404).json({ error: 'Content not found' });
    if (c.workspace_id && c.workspace_id !== wall.workspace_id) {
      return res.status(403).json({ error: 'Content is not in this workspace' });
    }
  }
  db.prepare("UPDATE video_walls SET content_id = ?, updated_at = strftime('%s','now') WHERE id = ?")
    .run(content_id || null, req.params.id);
  res.json({ success: true });
});

// Get wall config for a specific device (legacy fetch path)
router.get('/:id/device-config/:deviceId', requireWallRead, (req, res) => {
  const wall = req.wall;

  const position = db.prepare('SELECT * FROM video_wall_devices WHERE wall_id = ? AND device_id = ?')
    .get(req.params.id, req.params.deviceId);
  if (!position) return res.status(404).json({ error: 'Device not in this wall' });

  res.json({
    wall_id: wall.id,
    grid_cols: wall.grid_cols,
    grid_rows: wall.grid_rows,
    grid_col: position.grid_col,
    grid_row: position.grid_row,
    rotation: position.rotation,
    bezel_h_px: wall.bezel_h_mm,
    bezel_v_px: wall.bezel_v_mm,
    sync_mode: wall.sync_mode,
    is_leader: wall.leader_device_id === req.params.deviceId,
  });
});

module.exports = router;
