const jwt = require('jsonwebtoken');
const config = require('../config');
const { db } = require('../db/database');

// Phase 2.1: JWT now optionally carries the user's current workspace_id so
// the tenancy middleware can resolve scope without an extra DB lookup on
// every request. Callers that don't know the workspace yet (legacy paths,
// recovery tokens) pass null and the tenancy resolver falls back to the
// user's first accessible workspace.
function generateToken(user, currentWorkspaceId) {
  return jwt.sign(
    { id: user.id, email: user.email, username: user.username || null, role: user.role, current_workspace_id: currentWorkspaceId || null },
    config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.jwtExpiry }
  );
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
}

// Synthetic user record for recovery tokens (scripts/reset-admin.js). Not
// persisted; only exists for the lifetime of the request.
function recoveryUser(decoded) {
  return {
    id: decoded.id,
    email: decoded.email || 'admin@localhost',
    username: decoded.username || null,
    name: 'Recovery Admin',
    role: decoded.role || 'admin',
    auth_provider: 'recovery',
    avatar_url: null,
    plan_id: 'enterprise'
  };
}

// Express middleware - requires valid JWT
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const token = authHeader.split(' ')[1];
    const decoded = verifyToken(token);
    if (decoded.recovery) {
      req.user = recoveryUser(decoded);
      req.jwtWorkspaceId = null;
      return next();
    }
    const user = db.prepare('SELECT id, email, username, name, role, auth_provider, avatar_url, plan_id, email_alerts FROM users WHERE id = ?').get(decoded.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    req.user = user;
    // Tenancy middleware reads this on the resolver step.
    req.jwtWorkspaceId = decoded.current_workspace_id || null;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Optional auth - sets req.user if token present, continues either way
function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    try {
      const token = authHeader.split(' ')[1];
      const decoded = verifyToken(token);
      req.user = decoded.recovery
        ? recoveryUser(decoded)
        : db.prepare('SELECT id, email, username, name, role, auth_provider, avatar_url, plan_id FROM users WHERE id = ?').get(decoded.id);
      req.jwtWorkspaceId = decoded.current_workspace_id || null;
    } catch (err) {
      // Token invalid, continue without user
    }
  }
  next();
}

// Phase 2.1: role rename. Phase 1 renamed 'superadmin' to 'platform_admin' and
// dropped the in-between 'admin' role. These two guards are widened to accept
// either spelling so existing callers keep working without per-route edits.
// New code should prefer requirePlatformAdmin / requireOrgAdmin / workspace
// role guards from server/lib/permissions.js.

const PLATFORM_ROLES = ['superadmin', 'platform_admin'];
const ELEVATED_ROLES = ['admin', 'superadmin', 'platform_admin'];

function requireAdmin(req, res, next) {
  if (!req.user || !ELEVATED_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

function requireSuperAdmin(req, res, next) {
  if (!req.user || !PLATFORM_ROLES.includes(req.user.role)) {
    return res.status(403).json({ error: 'Platform admin access required' });
  }
  next();
}

// Preferred alias for new code.
const requirePlatformAdmin = requireSuperAdmin;

module.exports = { generateToken, verifyToken, requireAuth, optionalAuth, requireAdmin, requireSuperAdmin, requirePlatformAdmin, PLATFORM_ROLES, ELEVATED_ROLES };
