'use strict';

const { test, expect } = require('@playwright/test');
const express = require('express');
const http = require('node:http');
const path = require('node:path');
const Database = require('../../node_modules/better-sqlite3');
const { createHubFederationRouter, ensureHubFederationSchema } = require('../../routes/hub-federation');

function listen(app) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function origin(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

test('browser completes Hub federation without a second password and enforces denial, logout, and expiry', async ({ page }) => {
  const serviceToken = 'browser-federation-service-token';
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, username TEXT, name TEXT NOT NULL DEFAULT '',
      password_hash TEXT, auth_provider TEXT NOT NULL DEFAULT 'local', provider_id TEXT,
      avatar_url TEXT, role TEXT NOT NULL DEFAULT 'user', plan_id TEXT DEFAULT 'enterprise',
      last_login INTEGER,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
  `);
  ensureHubFederationSchema(db);

  let deny = false;
  let exchangedBody = '';
  const hubApp = express();
  hubApp.use(express.json());
  hubApp.get('/auth/media-control/authorize', (req, res) => {
    const callback = new URL(String(req.query.redirect_uri));
    callback.searchParams.set('state', String(req.query.state));
    if (deny) callback.searchParams.set('error', 'access_denied');
    else callback.searchParams.set('code', 'opaque-hub-code');
    res.redirect(callback.toString());
  });
  hubApp.post('/api/v2/media-control/auth/exchange', (req, res) => {
    exchangedBody = JSON.stringify(req.body);
    if (req.headers.authorization !== `Bearer ${serviceToken}`) return res.sendStatus(401);
    return res.json({
      issuer: origin(hubServer), audience: 'media-control', subject: 'hub-user:42',
      user_id: 42, display_name: 'Browser Operator', role: 'platform_admin',
    });
  });
  const hubServer = await listen(hubApp);

  const config = {
    jwtSecret: 'browser-test-jwt-secret-at-least-32-characters',
    hubAuth: {
      authorizeUrl: `${origin(hubServer)}/auth/media-control/authorize`,
      issuer: origin(hubServer),
      audience: 'media-control',
      callbackUrl: '',
      serviceToken,
      stateTtlSeconds: 300,
      sessionTtlSeconds: 2,
    },
  };
  const mediaApp = express();
  mediaApp.use(express.json());
  mediaApp.use('/js', express.static(path.join(__dirname, '..', '..', '..', 'frontend', 'js')));
  mediaApp.use('/api/auth/hub', createHubFederationRouter({
    db,
    config,
    ensureWorkspace: () => 'workspace-primary',
  }));
  mediaApp.post('/api/auth/logout', (_req, res) => {
    res.setHeader('Set-Cookie', 'mc_token=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
    res.json({ success: true });
  });
  mediaApp.get('/app', (_req, res) => res.type('html').send('<!doctype html><title>Media Control</title>'));
  const mediaServer = await listen(mediaApp);
  config.hubAuth.callbackUrl = `${origin(mediaServer)}/api/auth/hub/callback`;

  try {
    await page.goto(`${origin(mediaServer)}/api/auth/hub/start`);
    await expect(page).toHaveURL(`${origin(mediaServer)}/app#/control`);
    const session = await page.evaluate(() => ({
      token: localStorage.getItem('token'),
      user: JSON.parse(localStorage.getItem('user')),
    }));
    expect(session.token).toBeTruthy();
    expect(session.user.auth_provider).toBe('mbfd_hub');
    expect(exchangedBody).not.toMatch(/password|session|cookie/i);

    await page.request.post(`${origin(mediaServer)}/api/auth/logout`);
    expect((await page.request.get(`${origin(mediaServer)}/api/auth/hub/session`)).status()).toBe(401);

    deny = true;
    const denied = await page.goto(`${origin(mediaServer)}/api/auth/hub/start`);
    expect(denied.status()).toBe(400);
    expect(await denied.text()).toContain('invalid_authorization_response');

    deny = false;
    await page.goto(`${origin(mediaServer)}/api/auth/hub/start`);
    await expect(page).toHaveURL(`${origin(mediaServer)}/app#/control`);
    await page.waitForTimeout(2100);
    expect((await page.request.get(`${origin(mediaServer)}/api/auth/hub/session`)).status()).toBe(401);
  } finally {
    await new Promise((resolve) => mediaServer.close(resolve));
    await new Promise((resolve) => hubServer.close(resolve));
    db.close();
  }
});
