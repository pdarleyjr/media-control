'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-downloads-route-'));
process.env.DB_PATH = path.join(tempDir, 'test.db');

const { db } = require('../db/database');

db.pragma('foreign_keys = OFF');
db.exec(`
  INSERT INTO users (id, email, password_hash, name, role)
  VALUES
    ('dl-owner', 'owner@example.test', 'x', 'Owner', 'user'),
    ('dl-peer', 'peer@example.test', 'x', 'Peer', 'user'),
    ('dl-other', 'other@example.test', 'x', 'Other', 'user');
  INSERT INTO organizations (id, name, owner_user_id)
  VALUES ('dl-org', 'Downloads Org', 'dl-owner');
  INSERT INTO workspaces (id, organization_id, name, created_by)
  VALUES
    ('dl-ws-a', 'dl-org', 'Room A', 'dl-owner'),
    ('dl-ws-b', 'dl-org', 'Room B', 'dl-other');
  INSERT INTO download_jobs
    (id, workspace_id, user_id, source_url, title, content_id, status, created_at)
  VALUES
    ('dl-owned', 'dl-ws-a', 'dl-owner', 'https://example.test/owned', 'Owned', 'content-owned', 'pending', 300),
    ('dl-peer-job', 'dl-ws-a', 'dl-peer', 'https://example.test/peer', 'Peer', 'content-peer', 'pending', 200),
    ('dl-other-job', 'dl-ws-b', 'dl-other', 'https://example.test/other', 'Other', 'content-other', 'pending', 100);
`);
db.pragma('foreign_keys = ON');

const router = require('../routes/downloads');

function handler(method, routePath) {
  const layer = router.stack.find((entry) => entry.route
    && entry.route.path === routePath
    && entry.route.methods[method.toLowerCase()]);
  if (!layer) throw new Error(`Missing ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function response() {
  const res = {
    statusCode: 200,
    body: undefined,
    status(code) { res.statusCode = code; return res; },
    json(body) { res.body = body; return res; },
  };
  return res;
}

test('download list uses owner scope compatible with the download_jobs schema', () => {
  const res = response();

  assert.doesNotThrow(() => handler('GET', '/')({
    user: { id: 'dl-owner', role: 'user' },
    workspaceId: 'dl-ws-a',
  }, res));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.map((job) => job.id), ['dl-owned']);
});

after(() => {
  try { db.close(); } catch {}
  fs.rmSync(tempDir, { recursive: true, force: true });
});
