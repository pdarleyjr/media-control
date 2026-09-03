'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
const { installIsolatedTestDatabase } = require('./live-stream-test-db');

installIsolatedTestDatabase('operational-diagnostics-auth');

const config = require('../config');
const { db } = require('../db/database');
const { generateToken, requireAuth } = require('../middleware/auth');
const { resolveTenancy } = require('../lib/tenancy');
const diagnosticsRouter = require('../routes/operational-diagnostics');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

test('real diagnostics route enforces the canonical persisted platform-admin boundary', async (t) => {
  const users = [
    ['diag-platform', 'platform_admin'],
    ['diag-acting-platform', 'platform_admin'],
    ['diag-workspace-admin', 'user'],
    ['diag-org-admin', 'user'],
    ['diag-member', 'user'],
  ];
  for (const [id, role] of users) {
    db.prepare('INSERT INTO users (id, email, name, role, auth_provider) VALUES (?, ?, ?, ?, ?)')
      .run(id, `${id}@example.test`, id, role, 'local');
  }
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('diag-org-a', 'Diagnostics A', 'diag-platform')").run();
  db.prepare("INSERT INTO organizations (id, name, owner_user_id) VALUES ('diag-org-b', 'Diagnostics B', 'diag-platform')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('diag-ws-a', 'diag-org-a', 'Diagnostics A', 'diag-platform')").run();
  db.prepare("INSERT INTO workspaces (id, organization_id, name, created_by) VALUES ('diag-ws-b', 'diag-org-b', 'Diagnostics B', 'diag-platform')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('diag-ws-a', 'diag-platform', 'workspace_admin')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('diag-ws-a', 'diag-workspace-admin', 'workspace_admin')").run();
  db.prepare("INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ('diag-ws-a', 'diag-member', 'workspace_viewer')").run();
  db.prepare("INSERT INTO organization_members (organization_id, user_id, role) VALUES ('diag-org-a', 'diag-org-admin', 'org_admin')").run();

  const app = express();
  app.use('/api/operational-diagnostics', requireAuth, resolveTenancy, diagnosticsRouter);
  const server = await listen(app);
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/operational-diagnostics`;

  const persistedToken = (id, role, workspaceId = null) => generateToken({
    id, email: `${id}@example.test`, username: id, role,
  }, workspaceId);
  const recoveryToken = jwt.sign({
    id: 'recovery-admin', role: 'platform_admin', recovery: true,
  }, config.jwtSecret, { algorithm: 'HS256', expiresIn: '5m' });
  async function request(token, workspaceId) {
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(workspaceId ? { 'x-workspace-id': workspaceId } : {}),
      },
    });
    return { response, body: await response.json() };
  }

  await t.test('normal persisted platform admin returns diagnostics', async () => {
    const { response, body } = await request(persistedToken('diag-platform', 'platform_admin', 'diag-ws-a'));
    assert.equal(response.status, 200);
    assert.equal(body.workspace_id, 'diag-ws-a');
  });

  await t.test('recovery identity claiming platform_admin is denied', async () => {
    const { response } = await request(recoveryToken);
    assert.equal(response.status, 403);
  });

  await t.test('recovery platform_admin cannot select or read a second workspace', async () => {
    const { response, body } = await request(recoveryToken, 'diag-ws-b');
    assert.equal(response.status, 403);
    assert.equal(body.workspace_id, undefined);
    assert.doesNotMatch(JSON.stringify(body), /diag-ws-b/);
  });

  await t.test('workspace admin is denied', async () => {
    const { response } = await request(persistedToken('diag-workspace-admin', 'user', 'diag-ws-a'));
    assert.equal(response.status, 403);
  });

  await t.test('organization admin is denied', async () => {
    const { response } = await request(persistedToken('diag-org-admin', 'user'), 'diag-ws-a');
    assert.equal(response.status, 403);
  });

  await t.test('ordinary workspace member is denied', async () => {
    const { response } = await request(persistedToken('diag-member', 'user', 'diag-ws-a'));
    assert.equal(response.status, 403);
  });

  await t.test('persisted acting-as platform admin remains authorized', async () => {
    const { response, body } = await request(persistedToken('diag-acting-platform', 'platform_admin'), 'diag-ws-b');
    assert.equal(response.status, 200);
    assert.equal(body.workspace_id, 'diag-ws-b');
  });
});
