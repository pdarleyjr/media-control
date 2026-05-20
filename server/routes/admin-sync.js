// MBFD admin user mirror endpoint.
// Bearer-auth'd upsert for keeping ScreenTinker user table in sync with the
// MBFD Hub Laravel admin user table. Called by app/Listeners/SyncToScreentinker.php
// in the MBFD Hub on User saved+password-dirty events. Bypasses canRegister().
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');

const ADMIN_SYNC_TOKEN = process.env.MBFD_SYNC_TOKEN;

function requireBearer(req, res, next) {
  if (!ADMIN_SYNC_TOKEN) {
    return res.status(503).json({ error: 'Sync endpoint not configured: MBFD_SYNC_TOKEN env var not set' });
  }
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m || m[1] !== ADMIN_SYNC_TOKEN) {
    return res.status(401).json({ error: 'Invalid bearer token' });
  }
  next();
}

// Same logic as auth.js ensureDefaultOrgForUser - kept local to minimize the
// upstream diff (no need to refactor that helper into a shared module).
function ensureWorkspace(user) {
  const existing = db.prepare(`
    SELECT w.id FROM workspaces w
    JOIN workspace_members wm ON wm.workspace_id = w.id
    WHERE wm.user_id = ?
    ORDER BY wm.joined_at ASC LIMIT 1
  `).get(user.id);
  if (existing) return existing.id;

  const orgId = uuidv4();
  const wsId = uuidv4();
  const orgName = (user.name && user.name.trim())
    ? `${user.name}'s organization`
    : `${user.email}'s organization`;
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO organizations (id, name, owner_user_id, plan_id, subscription_status)
                VALUES (?, ?, ?, 'enterprise', 'active')`).run(orgId, orgName, user.id);
    db.prepare(`INSERT INTO organization_members (organization_id, user_id, role) VALUES (?, ?, 'org_owner')`).run(orgId, user.id);
    db.prepare(`INSERT INTO workspaces (id, organization_id, name, created_by) VALUES (?, ?, 'Default', ?)`).run(wsId, orgId, user.id);
    db.prepare(`INSERT INTO workspace_members (workspace_id, user_id, role) VALUES (?, ?, 'workspace_admin')`).run(wsId, user.id);
  });
  tx();
  return wsId;
}

router.post('/users/sync', requireBearer, (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'password too short (min 4)' });

  const normalizedEmail = String(email).toLowerCase().trim();
  const normalizedRole = role || 'platform_admin';
  const displayName = (name && String(name).trim()) || normalizedEmail.split('@')[0];
  const passwordHash = bcrypt.hashSync(password, 10);

  const existing = db.prepare('SELECT id, name FROM users WHERE email = ?').get(normalizedEmail);
  if (existing) {
    db.prepare(`UPDATE users
                SET password_hash = ?,
                    name = COALESCE(NULLIF(name, ''), ?),
                    role = ?,
                    auth_provider = 'local',
                    updated_at = strftime('%s','now')
                WHERE id = ?`)
      .run(passwordHash, displayName, normalizedRole, existing.id);
    return res.json({ user_id: existing.id, action: 'updated' });
  }

  const id = uuidv4();
  db.prepare(`INSERT INTO users (id, email, name, password_hash, auth_provider, role, plan_id)
              VALUES (?, ?, ?, ?, 'local', ?, 'enterprise')`)
    .run(id, normalizedEmail, displayName, passwordHash, normalizedRole);
  const workspaceId = ensureWorkspace({ id, email: normalizedEmail, name: displayName });
  return res.json({ user_id: id, workspace_id: workspaceId, action: 'created' });
});

module.exports = router;
