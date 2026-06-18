const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const config = require('../config');
const { generateToken } = require('../middleware/auth');
const { ensurePrimaryWorkspaceMembership } = require('../lib/primary-workspace');
const { logActivity, getClientIp } = require('../services/activity');

const router = express.Router();

function presentedDeviceToken(req) {
  return String(req.headers['x-mbfd-device-token'] || req.query.device_token || '').trim();
}

function requireConsoleDevice(req, res, next) {
  const expected = config.console.deviceToken;
  if (expected && presentedDeviceToken(req) !== expected) {
    return res.status(403).json({ error: 'Console device token rejected' });
  }
  next();
}

function safeRoomId(value) {
  const roomId = String(value || config.console.roomId || 'classroom-1').toLowerCase();
  return roomId.replace(/[^a-z0-9_-]/g, '').slice(0, 64) || 'classroom-1';
}

function safeDeviceId(value) {
  const deviceId = String(value || config.console.deviceId || 'classroom-1-podium-console').toLowerCase();
  return deviceId.replace(/[^a-z0-9_-]/g, '').slice(0, 96) || 'classroom-1-podium-console';
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    auth_provider: row.auth_provider,
    avatar_url: row.avatar_url,
    plan_id: row.plan_id,
    workspace_id: row.workspace_id || null,
    workspace_role: row.workspace_role || null,
  };
}

function primaryWorkspaceId() {
  const row = db.prepare('SELECT id FROM workspaces ORDER BY created_at ASC, rowid ASC LIMIT 1').get();
  return row?.id || null;
}

function loadUserByProfileId(profileId) {
  const id = String(profileId || '').trim();
  if (!id) return null;
  if (id.toLowerCase() === 'guest') {
    return db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ? OR lower(email) = lower(?) LIMIT 1')
      .get(config.console.guestUserId, config.console.guestEmail);
  }
  return db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ? OR lower(email) = lower(?) LIMIT 1')
    .get(id, id);
}

function ensureGuestProfile() {
  const existing = loadUserByProfileId('guest');
  if (existing) {
    const workspaceId = ensurePrimaryWorkspaceMembership(db, existing);
    return { ...existing, workspace_id: workspaceId };
  }

  const id = config.console.guestUserId || uuidv4();
  db.prepare(`
    INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id)
    VALUES (?, ?, 'Guest', NULL, 'console_guest', 'instructor', 'enterprise')
  `).run(id, config.console.guestEmail.toLowerCase());
  const guest = db.prepare('SELECT id, email, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(id);
  const workspaceId = ensurePrimaryWorkspaceMembership(db, guest);
  return { ...guest, workspace_id: workspaceId };
}

function profileRows() {
  const workspaceId = primaryWorkspaceId();
  const rows = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.auth_provider, u.avatar_url, u.plan_id,
           wm.workspace_id, wm.role AS workspace_role
    FROM users u
    LEFT JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ?
    ORDER BY
      CASE WHEN u.id = ? THEN 0 WHEN lower(u.email) = lower(?) THEN 0 ELSE 1 END,
      lower(COALESCE(NULLIF(u.name, ''), u.email))
    LIMIT 500
  `).all(workspaceId, config.console.guestUserId, config.console.guestEmail);
  return rows.map(publicUser);
}

function contentCounts(workspaceId, userId) {
  const content = db.prepare('SELECT COUNT(*) AS n FROM content WHERE ((workspace_id = ? AND user_id = ?) OR workspace_id IS NULL)').get(workspaceId, userId)?.n || 0;
  const playlists = db.prepare('SELECT COUNT(*) AS n FROM playlists WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId)?.n || 0;
  const presentations = db.prepare('SELECT COUNT(*) AS n FROM presentations WHERE workspace_id = ? AND user_id = ?').get(workspaceId, userId)?.n || 0;
  return { content, playlists, presentations };
}

function buildSession(req, profileId) {
  ensureGuestProfile();
  const selected = loadUserByProfileId(profileId || config.console.defaultProfile) || loadUserByProfileId('guest');
  if (!selected) throw Object.assign(new Error('Profile not found'), { status: 404 });
  const workspaceId = ensurePrimaryWorkspaceMembership(db, selected);
  const token = generateToken(selected, workspaceId);
  const workspace = db.prepare('SELECT id, name, organization_id FROM workspaces WHERE id = ?').get(workspaceId);
  const membership = db.prepare('SELECT role FROM workspace_members WHERE workspace_id = ? AND user_id = ?').get(workspaceId, selected.id);
  const user = publicUser({ ...selected, workspace_id: workspaceId, workspace_role: membership?.role || null });
  return {
    token,
    user,
    current_workspace_id: workspaceId,
    current_workspace: workspace || null,
    profiles: profileRows(),
    context: contentCounts(workspaceId, selected.id),
    room_id: safeRoomId(req.body?.room_id || req.query.room_id || req.headers['x-mbfd-room-id']),
    device_id: safeDeviceId(req.body?.device_id || req.query.device_id || req.headers['x-mbfd-device-id']),
    default_profile: config.console.defaultProfile,
    device_token_required: !!config.console.deviceToken,
  };
}

function auditProfileSwitch(req, session, previousProfileId) {
  const details = {
    timestamp: new Date().toISOString(),
    device_id: session.device_id,
    room_id: session.room_id,
    previous_profile: previousProfileId || null,
    selected_profile: session.user.id,
  };
  logActivity(session.user.id, 'console:profile_switch', JSON.stringify(details), null, getClientIp(req), session.current_workspace_id);
}

router.use(requireConsoleDevice);

router.get('/profiles', (_req, res) => {
  ensureGuestProfile();
  res.json({ profiles: profileRows(), default_profile: config.console.defaultProfile });
});

router.post('/session', (req, res) => {
  try {
    const previousProfileId = req.body?.previous_profile_id || null;
    const profileId = req.body?.profile_id || req.query.profile_id || config.console.defaultProfile;
    const session = buildSession(req, profileId);
    auditProfileSwitch(req, session, previousProfileId);
    res.json(session);
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Console session failed' });
  }
});

module.exports = router;
