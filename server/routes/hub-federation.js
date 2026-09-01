'use strict';

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');

const PROVIDER = 'mbfd_hub';
const REQUIRED_ROLE = 'platform_admin';

function ensureHubFederationSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hub_federated_identities (
      provider TEXT NOT NULL,
      subject TEXT NOT NULL,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (provider, subject),
      UNIQUE (user_id)
    );
    CREATE TABLE IF NOT EXISTS hub_auth_transactions (
      state_hash TEXT PRIMARY KEY,
      expires_at INTEGER NOT NULL
    );
  `);
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch (_) {
      return '';
    }
  }
  return '';
}

function stateHash(state) {
  return crypto.createHash('sha256').update(state).digest('hex');
}

function completeConfig(config) {
  const hub = config?.hubAuth || {};
  return Boolean(config?.jwtSecret && hub.authorizeUrl && hub.issuer && hub.audience
    && hub.callbackUrl && hub.serviceToken);
}

function sameValue(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function syntheticEmail(subject) {
  const digest = crypto.createHash('sha256').update(subject).digest('hex').slice(0, 24);
  return `hub-${digest}@federated.invalid`;
}

function createHubFederationRouter({ db, config, fetchImpl = fetch, ensureWorkspace }) {
  const router = express.Router();
  ensureHubFederationSchema(db);

  router.get('/start', (req, res) => {
    if (!completeConfig(config)) return res.status(503).json({ error: 'hub_auth_unavailable' });
    const hub = config.hubAuth;
    const state = crypto.randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    db.prepare('DELETE FROM hub_auth_transactions WHERE expires_at <= ?').run(now);
    db.prepare('INSERT INTO hub_auth_transactions (state_hash, expires_at) VALUES (?, ?)')
      .run(stateHash(state), now + Number(hub.stateTtlSeconds || 300));
    const secure = new URL(hub.callbackUrl).protocol === 'https:' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `mc_hub_state=${encodeURIComponent(state)}; Path=/api/auth/hub/callback; HttpOnly; SameSite=Lax; Max-Age=${Number(hub.stateTtlSeconds || 300)}${secure}`);
    const authorize = new URL(hub.authorizeUrl);
    authorize.searchParams.set('client_id', hub.audience);
    authorize.searchParams.set('redirect_uri', hub.callbackUrl);
    authorize.searchParams.set('state', state);
    return res.redirect(302, authorize.toString());
  });

  router.get('/callback', async (req, res) => {
    if (!completeConfig(config)) return res.status(503).json({ error: 'hub_auth_unavailable' });
    const { code, state } = req.query;
    const cookieState = readCookie(req.headers.cookie, 'mc_hub_state');
    if (typeof code !== 'string' || typeof state !== 'string' || !sameValue(state, cookieState)) {
      return res.status(400).json({ error: 'invalid_authorization_response' });
    }
    const now = Math.floor(Date.now() / 1000);
    const consume = db.transaction(() => {
      const key = stateHash(state);
      const record = db.prepare('SELECT expires_at FROM hub_auth_transactions WHERE state_hash = ?').get(key);
      db.prepare('DELETE FROM hub_auth_transactions WHERE state_hash = ?').run(key);
      return record && Number(record.expires_at) > now;
    });
    if (!consume()) return res.status(400).json({ error: 'invalid_authorization_response' });

    const hub = config.hubAuth;
    let exchange;
    try {
      exchange = await fetchImpl(`${hub.issuer.replace(/\/$/, '')}/api/v2/media-control/auth/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${hub.serviceToken}` },
        body: JSON.stringify({ code, client_id: hub.audience, redirect_uri: hub.callbackUrl }),
      });
    } catch (_) {
      return res.status(502).json({ error: 'hub_exchange_unavailable' });
    }
    if (!exchange.ok) return res.status(401).json({ error: 'hub_exchange_rejected' });
    let claims;
    try {
      claims = await exchange.json();
    } catch (_) {
      return res.status(502).json({ error: 'hub_exchange_invalid_response' });
    }
    const expectedSubject = `hub-user:${claims.user_id}`;
    if (claims.issuer !== hub.issuer || claims.audience !== hub.audience
      || claims.subject !== expectedSubject || claims.role !== REQUIRED_ROLE
      || !Number.isInteger(claims.user_id) || typeof claims.display_name !== 'string') {
      return res.status(401).json({ error: 'invalid_hub_claims' });
    }

    let identity = db.prepare(
      'SELECT user_id FROM hub_federated_identities WHERE provider = ? AND subject = ?',
    ).get(PROVIDER, claims.subject);
    let user;
    if (identity) {
      db.prepare(`UPDATE users SET name = ?, role = ?, provider_id = ?, updated_at = strftime('%s','now') WHERE id = ?`)
        .run(claims.display_name, REQUIRED_ROLE, claims.subject, identity.user_id);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(identity.user_id);
    } else {
      const id = uuidv4();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO users (id, email, name, password_hash, auth_provider, provider_id, role, plan_id)
          VALUES (?, ?, ?, NULL, ?, ?, ?, 'enterprise')
        `).run(id, syntheticEmail(claims.subject), claims.display_name, PROVIDER, claims.subject, REQUIRED_ROLE);
        db.prepare('INSERT INTO hub_federated_identities (provider, subject, user_id) VALUES (?, ?, ?)')
          .run(PROVIDER, claims.subject, id);
      })();
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    }

    const workspaceId = ensureWorkspace(user);
    try {
      db.prepare(`
        INSERT INTO activity_log (user_id, action, details, ip_address, workspace_id)
        VALUES (?, 'auth:hub_login', ?, ?, ?)
      `).run(
        user.id,
        JSON.stringify({ auth_source: PROVIDER, canonical_subject: claims.subject }),
        req.ip || null,
        workspaceId,
      );
      db.prepare("UPDATE users SET last_login = strftime('%s','now') WHERE id = ?").run(user.id);
    } catch (_) { /* login remains available when an older audit schema is still migrating */ }
    const token = jwt.sign({
      id: user.id,
      email: user.email,
      role: user.role,
      current_workspace_id: workspaceId,
      auth_source: PROVIDER,
      canonical_subject: claims.subject,
    }, config.jwtSecret, { algorithm: 'HS256', expiresIn: Number(hub.sessionTtlSeconds || 900) });
    const secure = new URL(hub.callbackUrl).protocol === 'https:' ? '; Secure' : '';
    res.setHeader('Set-Cookie', [
      `mc_hub_state=; Path=/api/auth/hub/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
      `mc_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Number(hub.sessionTtlSeconds || 900)}${secure}`,
    ]);
    res.setHeader('Cache-Control', 'no-store, private');
    return res.type('html').send('<!doctype html><html><head><meta charset="utf-8"><title>Signing in</title></head><body><p>Completing secure sign-in…</p><script type="module" src="/js/hub-auth-complete.js"></script></body></html>');
  });

  router.get('/session', (req, res) => {
    const token = readCookie(req.headers.cookie, 'mc_token');
    if (!token) return res.status(401).json({ error: 'authentication_required' });
    try {
      const claims = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      if (claims.auth_source !== PROVIDER || typeof claims.canonical_subject !== 'string') throw new Error('wrong source');
      const user = db.prepare(`
        SELECT id, email, username, name, role, auth_provider, provider_id, avatar_url, plan_id
        FROM users WHERE id = ? AND auth_provider = ? AND provider_id = ?
      `).get(claims.id, PROVIDER, claims.canonical_subject);
      if (!user) throw new Error('identity missing');
      return res.json({ token, user, current_workspace_id: claims.current_workspace_id || null });
    } catch (_) {
      return res.status(401).json({ error: 'invalid_session' });
    }
  });

  return router;
}

module.exports = { createHubFederationRouter, ensureHubFederationSchema };
