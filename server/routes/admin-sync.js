// MBFD admin user mirror endpoint.
// Bearer-auth'd upsert for keeping Media Control user table in sync with the
// MBFD Hub Laravel admin user table. Called by app/Listeners/SyncToScreentinker.php
// in the MBFD Hub on User saved+password-dirty events. Bypasses canRegister().
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db/database');
const { ensurePrimaryWorkspaceMembership } = require('../lib/primary-workspace');

const ADMIN_SYNC_TOKEN = process.env.MBFD_SYNC_TOKEN;

// Valid global roles (mirrors middleware/auth.js). Any synced role MUST be one of
// these; anything omitted or unrecognized falls back to the LEAST-privileged
// 'user'. Previously this defaulted to 'platform_admin', which silently granted
// full platform access to any synced user whose payload omitted a role — a
// privilege-escalation footgun. The real caller (MBFD Hub's SyncToScreentinker
// observer) always sends an explicit 'platform_admin' for admins it mirrors, so
// this safe default changes nothing for the legitimate flow.
const ALLOWED_SYNC_ROLES = new Set(['user', 'admin', 'superadmin', 'platform_admin']);

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

// Synced MBFD Hub users join the SAME shared room as everyone else. Delegates to
// the shared resolver (lib/primary-workspace.js) so the Hub-sync path and the
// local auth path are consistent: a synced user lands in the primary workspace
// (shared displays) instead of a private one. Additive — never deletes anything.
function ensureWorkspace(user) {
  return ensurePrimaryWorkspaceMembership(db, user);
}

router.post('/users/sync', requireBearer, (req, res) => {
  const { email, password, name, role } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 4) return res.status(400).json({ error: 'password too short (min 4)' });

  const normalizedEmail = String(email).toLowerCase().trim();
  const normalizedRole = ALLOWED_SYNC_ROLES.has(role) ? role : 'user';
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
