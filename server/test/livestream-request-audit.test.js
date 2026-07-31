'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const edgeRoot = path.join(__dirname, '..', '..', 'kamrui-media-edge');

const {
  appendLivestreamAudit,
  buildLivestreamAuditRecord,
} = require('../../kamrui-media-edge/camera-api/livestream-audit');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-livestream-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function permissionError(code) {
  const error = new Error(`simulated ${code}`);
  error.code = code;
  return error;
}

test('livestream audit records only attributable, allowlisted request metadata', () => {
  const secretToken = 'camera-token-must-never-be-logged';
  const secretStreamKey = 'rtmp-stream-key-must-never-be-logged';
  const record = buildLivestreamAuditRecord({
    action: 'stream.start',
    req: {
      operatorId: 'api-client',
      headers: {
        'x-api-token': secretToken,
        authorization: `Bearer ${secretToken}`,
      },
      socket: { remoteAddress: '::ffff:192.168.1.116' },
      body: { stream_key: secretStreamKey },
    },
    responseBody: {
      ok: true,
      session_id: 'ses_audit_fixture',
      peertube_watch_url: `https://example.invalid/watch?key=${secretStreamKey}`,
    },
    statusCode: 200,
    initialSessionId: null,
    now: () => new Date('2026-07-27T15:00:56.000Z'),
  });

  assert.deepEqual(Object.keys(record).sort(), [
    'action',
    'auth_method',
    'caller_identity',
    'request_id',
    'result',
    'session_id',
    'source_ip',
    'status_code',
    'timestamp',
  ]);
  assert.equal(record.action, 'stream.start');
  assert.equal(record.source_ip, '::ffff:192.168.1.116');
  assert.equal(record.caller_identity, 'api-client');
  assert.equal(record.auth_method, 'x-api-token');
  assert.equal(record.session_id, 'ses_audit_fixture');
  assert.equal(record.result, 'accepted');
  assert.equal(record.status_code, 200);

  const serialized = JSON.stringify(record);
  assert.doesNotMatch(serialized, new RegExp(secretToken));
  assert.doesNotMatch(serialized, new RegExp(secretStreamKey));
  assert.doesNotMatch(serialized, /authorization|stream_key|peertube_watch_url/i);
});

test('livestream audit appends durable JSON lines without exposing response errors', (t) => {
  const recordingDir = tempDir(t);
  const req = {
    headers: { authorization: 'Bearer hidden-bearer' },
    socket: { remoteAddress: '127.0.0.1' },
  };

  const first = appendLivestreamAudit({
    recordingDir,
    action: 'stream.stop',
    req,
    responseBody: { ok: false, error: 'failure containing hidden-stream-key' },
    statusCode: 409,
    initialSessionId: 'ses_existing',
    now: () => new Date('2026-07-27T15:01:00.000Z'),
  });
  const second = appendLivestreamAudit({
    recordingDir,
    action: 'stream.start',
    req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    responseBody: { ok: false },
    statusCode: 401,
    initialSessionId: null,
    now: () => new Date('2026-07-27T15:01:01.000Z'),
  });

  const auditPath = path.join(recordingDir, 'metadata', 'livestream-audit.jsonl');
  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines, [first, second]);
  assert.equal(first.result, 'rejected');
  assert.equal(first.session_id, 'ses_existing');
  assert.equal(second.caller_identity, 'unauthenticated');
  assert.equal(second.auth_method, 'none');
  assert.doesNotMatch(fs.readFileSync(auditPath, 'utf8'), /hidden-bearer|hidden-stream-key/);
});

test('livestream audit appends to an existing secure group-owned file when chmod is not permitted', (t) => {
  const recordingDir = tempDir(t);
  const metadataDir = path.join(recordingDir, 'metadata');
  const auditPath = path.join(metadataDir, 'livestream-audit.jsonl');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(auditPath, '{"existing":true}\n', 'utf8');

  const originalFchmodSync = fs.fchmodSync;
  const originalFstatSync = fs.fstatSync;
  fs.fchmodSync = () => {
    throw permissionError('EPERM');
  };
  fs.fstatSync = (fd) => {
    const stat = originalFstatSync(fd);
    return {
      ...stat,
      mode: (stat.mode & ~0o777) | 0o660,
      isFile: () => true,
    };
  };
  t.after(() => {
    fs.fchmodSync = originalFchmodSync;
    fs.fstatSync = originalFstatSync;
  });

  const record = appendLivestreamAudit({
    recordingDir,
    action: 'stream.start',
    req: {
      operatorId: 'api-client',
      headers: { 'x-api-token': 'hidden' },
      socket: { remoteAddress: '127.0.0.1' },
    },
    responseBody: { ok: true, session_id: 'ses_secure_group_file' },
    statusCode: 200,
    now: () => new Date('2026-07-31T04:00:00.000Z'),
  });

  const lines = fs.readFileSync(auditPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [{ existing: true }, record]);
});

test('livestream audit rejects a shared file that is accessible to other users', (t) => {
  const recordingDir = tempDir(t);
  const metadataDir = path.join(recordingDir, 'metadata');
  const auditPath = path.join(metadataDir, 'livestream-audit.jsonl');
  fs.mkdirSync(metadataDir, { recursive: true });
  fs.writeFileSync(auditPath, '{"existing":true}\n', 'utf8');

  const originalFchmodSync = fs.fchmodSync;
  const originalFstatSync = fs.fstatSync;
  fs.fchmodSync = () => {
    throw permissionError('EPERM');
  };
  fs.fstatSync = (fd) => {
    const stat = originalFstatSync(fd);
    return {
      ...stat,
      mode: (stat.mode & ~0o777) | 0o666,
      isFile: () => true,
    };
  };
  t.after(() => {
    fs.fchmodSync = originalFchmodSync;
    fs.fstatSync = originalFstatSync;
  });

  assert.throws(
    () => appendLivestreamAudit({
      recordingDir,
      action: 'stream.stop',
      req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      responseBody: { ok: true },
      statusCode: 200,
    }),
    (error) => error?.code === 'AUDIT_FILE_PERMISSIONS_UNSAFE',
  );
  assert.equal(fs.readFileSync(auditPath, 'utf8'), '{"existing":true}\n');
});

test('livestream audit does not suppress non-permission chmod failures', (t) => {
  const recordingDir = tempDir(t);
  const originalFchmodSync = fs.fchmodSync;
  fs.fchmodSync = () => {
    throw permissionError('EIO');
  };
  t.after(() => {
    fs.fchmodSync = originalFchmodSync;
  });

  assert.throws(
    () => appendLivestreamAudit({
      recordingDir,
      action: 'stream.start',
      req: { headers: {}, socket: { remoteAddress: '127.0.0.1' } },
      responseBody: { ok: true },
      statusCode: 200,
    }),
    (error) => error?.code === 'EIO',
  );
});

test('camera API installs audit middleware before authentication on both livestream actions', () => {
  const server = fs.readFileSync(
    path.join(edgeRoot, 'camera-api', 'server.js'),
    'utf8',
  );
  const install = readScript('install.sh');
  const upgrade = readScript('upgrade.sh');

  assert.match(
    server,
    /app\.post\('\/api\/stream\/start', livestreamStartAudit, authMiddleware,/,
  );
  assert.match(
    server,
    /app\.post\('\/api\/stream\/stop', livestreamStopAudit, authMiddleware,/,
  );
  assert.match(install, /camera-api\/livestream-audit\.js/);
  assert.match(upgrade, /camera-api\/livestream-audit\.js/);
});

function readScript(name) {
  return fs.readFileSync(path.join(edgeRoot, 'scripts', name), 'utf8');
}
