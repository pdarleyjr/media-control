'use strict';

const fs = require('fs');
const path = require('path');

const ALLOWED_ACTIONS = new Set(['stream.start', 'stream.stop']);
const SESSION_PATTERN = /^ses_[A-Za-z0-9_-]{1,160}$/;
const CHMOD_PERMISSION_ERRORS = new Set([
  'EACCES',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
]);

function cleanText(value, fallback, maxLength = 160) {
  const text = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '?')
    .slice(0, maxLength);
  return text || fallback;
}

function authMethod(req) {
  const headers = req?.headers || {};
  if (headers['x-api-token']) return 'x-api-token';
  if (/^Bearer\s+\S+/i.test(String(headers.authorization || ''))) return 'bearer';
  return 'none';
}

function sessionId(responseBody, initialSessionId) {
  const candidate = responseBody?.session_id || initialSessionId || '';
  return SESSION_PATTERN.test(String(candidate)) ? String(candidate) : null;
}

function resultFor(responseBody, statusCode) {
  const status = Number(statusCode) || 0;
  if (status >= 200 && status < 400 && responseBody?.ok !== false) return 'accepted';
  if (status >= 400 && status < 500) return 'rejected';
  return 'failed';
}

function ensurePrivateAuditDescriptor(fd) {
  try {
    fs.fchmodSync(fd, 0o600);
    return;
  } catch (error) {
    if (!CHMOD_PERMISSION_ERRORS.has(error?.code)) {
      throw error;
    }
  }

  const stat = fs.fstatSync(fd);
  if (!stat.isFile() || (stat.mode & 0o007) !== 0) {
    const error = new Error('Livestream audit file permissions are unsafe');
    error.code = 'AUDIT_FILE_PERMISSIONS_UNSAFE';
    throw error;
  }
}

function buildLivestreamAuditRecord({
  action,
  req,
  responseBody,
  statusCode,
  initialSessionId,
  now = () => new Date(),
}) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error('Unsupported livestream audit action');
  }

  return {
    timestamp: now().toISOString(),
    action,
    source_ip: cleanText(req?.socket?.remoteAddress, 'unknown', 128),
    caller_identity: cleanText(req?.operatorId, 'unauthenticated', 128),
    auth_method: authMethod(req),
    session_id: sessionId(responseBody, initialSessionId),
    result: resultFor(responseBody, statusCode),
    status_code: Number(statusCode) || 0,
    request_id: cleanText(responseBody?.request_id, null, 128),
  };
}

function appendLivestreamAudit({
  recordingDir,
  action,
  req,
  responseBody,
  statusCode,
  initialSessionId,
  now,
}) {
  const record = buildLivestreamAuditRecord({
    action,
    req,
    responseBody,
    statusCode,
    initialSessionId,
    now,
  });
  const metadataDir = path.join(recordingDir, 'metadata');
  const auditPath = path.join(metadataDir, 'livestream-audit.jsonl');
  fs.mkdirSync(metadataDir, { recursive: true, mode: 0o770 });

  const fd = fs.openSync(auditPath, 'a', 0o600);
  try {
    ensurePrivateAuditDescriptor(fd);
    fs.writeSync(fd, `${JSON.stringify(record)}\n`, null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return record;
}

function createLivestreamAuditMiddleware({
  action,
  recordingDir,
  getSessionId = () => null,
  onError = () => {},
  now,
}) {
  if (!ALLOWED_ACTIONS.has(action)) {
    throw new Error('Unsupported livestream audit action');
  }

  return function livestreamAudit(req, res, next) {
    const initialSessionId = getSessionId();
    const originalJson = res.json;
    let logged = false;

    const persist = (responseBody) => {
      if (logged) return;
      logged = true;
      try {
        appendLivestreamAudit({
          recordingDir,
          action,
          req,
          responseBody,
          statusCode: res.statusCode,
          initialSessionId,
          now,
        });
      } catch (error) {
        onError(error);
      }
    };

    res.json = function auditedJson(responseBody) {
      persist(responseBody);
      return originalJson.call(this, responseBody);
    };
    res.once('finish', () => persist(null));
    next();
  };
}

module.exports = {
  appendLivestreamAudit,
  buildLivestreamAuditRecord,
  createLivestreamAuditMiddleware,
};

