// audit.js — structured, append-only audit trail for state-changing
// display-control actions (commands to displays, scene/playlist changes,
// provisioning/pairing, kiosk actions).
//
// Writes to the dedicated `audit_log` table (see db/database.js migrateAuditLog).
// Distinct from services/activity.js (the user-facing activity feed): this is a
// security trail — who/what/when/where for control actions — and it REDACTS
// secrets before persisting so tokens/passwords/query strings never land on disk.
//
// Captures: actor (user or device id), action, target (display/workspace/scene),
// timestamp (DB default), source IP, and a redacted detail summary.

const { db } = require('../db/database');

// Keys whose values must never be stored. Matched case-insensitively against
// the leaf key name. Anything matching is replaced with '[redacted]'.
const SECRET_KEY_RE = /(token|secret|password|passwd|pwd|authorization|auth|api[_-]?key|apikey|cookie|session|jwt|bearer|credential|signature|pairing_code)/i;

// Best-effort scrub of token-shaped values that appear inside free-text strings
// (e.g. a URL with ?token=... or an Authorization: Bearer header captured by
// accident). Conservative: only strips obvious token query params and bearer
// prefixes — it does not try to be a general DLP engine.
function scrubString(s) {
  if (typeof s !== 'string') return s;
  return s
    // strip values of sensitive query params: ?token=xyz / &api_key=xyz
    .replace(/([?&](?:token|access_token|api[_-]?key|apikey|key|secret|sig|signature|password|pwd)=)[^&#\s]+/gi, '$1[redacted]')
    // strip bearer tokens embedded in text
    .replace(/\b(bearer\s+)[A-Za-z0-9._-]+/gi, '$1[redacted]');
}

// Recursively redact an object/array/string. Depth-bounded so a pathological
// nested payload can't blow the stack. Returns a NEW value (never mutates input).
function redact(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEY_RE.test(k)) { out[k] = '[redacted]'; continue; }
      out[k] = redact(v, depth + 1);
    }
    return out;
  }
  return undefined; // functions / symbols dropped
}

// Serialize a redacted detail object to a bounded JSON string for storage.
function serializeDetails(details) {
  if (details == null) return null;
  try {
    const safe = redact(details);
    let json = JSON.stringify(safe);
    if (json && json.length > 4000) json = json.slice(0, 4000) + '…';
    return json;
  } catch {
    return null;
  }
}

// Write one audit row. Never throws (audit failure must not break a control
// action). Fields:
//   actorType   'user' | 'device' | 'system'
//   actorId     user id / device id (nullable for system)
//   action      stable verb, e.g. 'display.command', 'scene.trigger', 'device.pair'
//   targetType  'device' | 'workspace' | 'scene' | 'kiosk' | ...
//   targetId    id of the target
//   workspaceId scope
//   sourceIp    request / socket client IP
//   details     any JSON-serializable summary (redacted before insert)
function audit({
  actorType = 'system',
  actorId = null,
  action,
  targetType = null,
  targetId = null,
  workspaceId = null,
  sourceIp = null,
  details = null,
} = {}) {
  if (!action) return;
  try {
    db.prepare(
      `INSERT INTO audit_log
        (actor_type, actor_id, action, target_type, target_id, workspace_id, source_ip, details)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      String(actorType),
      actorId != null ? String(actorId) : null,
      String(action),
      targetType != null ? String(targetType) : null,
      targetId != null ? String(targetId) : null,
      workspaceId != null ? String(workspaceId) : null,
      sourceIp != null ? String(sourceIp) : null,
      serializeDetails(details)
    );
  } catch (e) {
    // Best-effort: log to stderr, never propagate.
    console.error('[audit] write failed:', e.message);
  }
}

// Read helper (admin / security review). Newest first, bounded.
function getAuditLog({ workspaceId = null, targetId = null, limit = 100, offset = 0 } = {}) {
  let sql = 'SELECT * FROM audit_log WHERE 1=1';
  const params = [];
  if (workspaceId) { sql += ' AND workspace_id = ?'; params.push(workspaceId); }
  if (targetId) { sql += ' AND target_id = ?'; params.push(targetId); }
  sql += ' ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?';
  params.push(Math.min(Number(limit) || 100, 1000), Number(offset) || 0);
  return db.prepare(sql).all(...params);
}

module.exports = { audit, getAuditLog, redact, serializeDetails };
