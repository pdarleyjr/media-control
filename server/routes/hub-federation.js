'use strict';

const crypto = require('node:crypto');
const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { createLoginFailureRateLimit } = require('../lib/login-rate-limit');

const PROVIDER = 'mbfd_hub';
const REQUIRED_ROLE = 'platform_admin';
const LINK_COOKIE = 'mc_hub_link';
const DUMMY_PASSWORD_HASH = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 10);

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
    CREATE TABLE IF NOT EXISTS hub_account_link_transactions (
      link_hash TEXT PRIMARY KEY,
      subject TEXT NOT NULL UNIQUE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_hub_account_link_transactions_expiry
      ON hub_account_link_transactions(expires_at);
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

function cookieSecurity(config) {
  return new URL(config.hubAuth.callbackUrl).protocol === 'https:' ? '; Secure' : '';
}

function clearCookie(name, path, secure) {
  return `${name}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

function completePage() {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Signing in</title></head><body><p>Completing secure sign-in…</p><script type="module" src="/js/hub-auth-complete.js"></script></body></html>';
}

function accountLinkPage() {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Link Media Control account</title><link rel="stylesheet" href="/css/variables.css"><link rel="stylesheet" href="/css/reset.css"><link rel="stylesheet" href="/css/main.css"></head><body><main style="min-height:100vh;display:grid;place-items:center;padding:16px"><section style="width:420px;max-width:100%;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg);padding:24px"><h1 style="font-size:22px;margin-bottom:8px">Link your Media Control account</h1><p style="color:var(--text-secondary);font-size:13px;margin-bottom:20px">For this one-time step, enter your existing Media Control username or email and current password. Future sign-ins will use MBFD Hub.</p><form id="hubAccountLinkForm"><div class="form-group"><label for="hubLinkIdentifier">Username or email</label><input class="input" id="hubLinkIdentifier" name="identifier" autocomplete="username" required></div><div class="form-group"><label for="hubLinkPassword">Current Media Control password</label><input class="input" id="hubLinkPassword" name="password" type="password" autocomplete="current-password" required></div><button class="btn btn-primary" id="hubLinkSubmit" type="submit" style="width:100%;justify-content:center">Link account</button><p id="hubLinkError" role="alert" style="display:none;color:var(--danger);font-size:12px;margin-top:12px">Account linking failed. Check your existing Media Control credentials or contact an administrator.</p></form></section></main><script type="module" src="/js/hub-account-link.js"></script></body></html>`;
}

function loginIdentifier(body) {
  return String(body?.identifier || body?.username || body?.email || '').trim().toLowerCase().slice(0, 320);
}

function createHubFederationRouter({ db, config, fetchImpl = fetch, ensureWorkspace, getClientIp = (req) => req.ip }) {
  const router = express.Router();
  ensureHubFederationSchema(db);

  function issueSession(req, res, user, subject, extraCookies = []) {
    const workspaceId = ensureWorkspace(user);
    try {
      db.prepare(`
        INSERT INTO activity_log (user_id, action, details, ip_address, workspace_id)
        VALUES (?, 'auth:hub_login', ?, ?, ?)
      `).run(
        user.id,
        JSON.stringify({ auth_source: PROVIDER, canonical_subject: subject }),
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
      canonical_subject: subject,
    }, config.jwtSecret, { algorithm: 'HS256', expiresIn: Number(config.hubAuth.sessionTtlSeconds || 900) });
    const secure = cookieSecurity(config);
    res.setHeader('Set-Cookie', [
      ...extraCookies,
      `mc_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Number(config.hubAuth.sessionTtlSeconds || 900)}${secure}`,
    ]);
    res.setHeader('Cache-Control', 'no-store, private');
    return { token, workspaceId };
  }

  router.get('/start', (req, res) => {
    if (!completeConfig(config)) return res.status(503).json({ error: 'hub_auth_unavailable' });
    const hub = config.hubAuth;
    const state = crypto.randomBytes(32).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    db.prepare('DELETE FROM hub_auth_transactions WHERE expires_at <= ?').run(now);
    db.prepare('INSERT INTO hub_auth_transactions (state_hash, expires_at) VALUES (?, ?)')
      .run(stateHash(state), now + Number(hub.stateTtlSeconds || 300));
    const secure = cookieSecurity(config);
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

    const identity = db.prepare(
      'SELECT user_id FROM hub_federated_identities WHERE provider = ? AND subject = ?',
    ).get(PROVIDER, claims.subject);
    if (identity) {
      const user = db.prepare('SELECT * FROM users WHERE id = ? AND auth_provider = ? AND provider_id = ?')
        .get(identity.user_id, PROVIDER, claims.subject);
      if (!user) return res.status(401).json({ error: 'invalid_hub_identity' });
      issueSession(req, res, user, claims.subject, [
        clearCookie('mc_hub_state', '/api/auth/hub/callback', cookieSecurity(config)),
        clearCookie(LINK_COOKIE, '/api/auth/hub', cookieSecurity(config)),
      ]);
      return res.type('html').send(completePage());
    }

    const linkToken = crypto.randomBytes(32).toString('base64url');
    const linkTtl = Number(hub.linkTtlSeconds || 300);
    db.transaction(() => {
      db.prepare('DELETE FROM hub_account_link_transactions WHERE expires_at <= ?').run(now);
      db.prepare('DELETE FROM hub_account_link_transactions WHERE subject = ?').run(claims.subject);
      db.prepare('INSERT INTO hub_account_link_transactions (link_hash, subject, expires_at) VALUES (?, ?, ?)')
        .run(stateHash(linkToken), claims.subject, now + linkTtl);
    })();
    const secure = cookieSecurity(config);
    res.setHeader('Set-Cookie', [
      `mc_hub_state=; Path=/api/auth/hub/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,
      `${LINK_COOKIE}=${encodeURIComponent(linkToken)}; Path=/api/auth/hub; HttpOnly; SameSite=Strict; Max-Age=${linkTtl}${secure}`,
    ]);
    res.setHeader('Cache-Control', 'no-store, private');
    return res.type('html').send(accountLinkPage());
  });

  const linkRateLimit = createLoginFailureRateLimit({
    getClientIp,
    maxAccountFailures: 5,
    maxIpFailures: 20,
  });

  router.post('/link', linkRateLimit, (req, res) => {
    const linkToken = readCookie(req.headers.cookie, LINK_COOKIE);
    const identifier = loginIdentifier(req.body);
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const now = Math.floor(Date.now() / 1000);
    const linkHash = linkToken ? stateHash(linkToken) : '';
    const pending = linkHash
      ? db.prepare('SELECT subject, expires_at FROM hub_account_link_transactions WHERE link_hash = ?').get(linkHash)
      : null;
    if (!pending || Number(pending.expires_at) <= now || !identifier || !password || password.length > 1024) {
      if (pending && Number(pending.expires_at) <= now) {
        db.prepare('DELETE FROM hub_account_link_transactions WHERE link_hash = ?').run(linkHash);
      }
      return res.status(401).json({ error: 'account_link_failed' });
    }

    const candidates = db.prepare(`
      SELECT * FROM users
      WHERE lower(email) = ? OR lower(username) = ?
      LIMIT 2
    `).all(identifier, identifier);
    const candidate = candidates.length === 1 ? candidates[0] : null;
    const passwordHash = candidate?.password_hash || DUMMY_PASSWORD_HASH;
    const passwordValid = bcrypt.compareSync(password, passwordHash);
    const linkable = candidate
      && candidate.auth_provider === 'local'
      && String(candidate.username || '').toLowerCase() !== 'guest'
      && typeof candidate.password_hash === 'string'
      && candidate.password_hash.length > 0;
    if (!passwordValid || !linkable) {
      return res.status(401).json({ error: 'account_link_failed' });
    }

    const consume = db.transaction(() => {
      const fresh = db.prepare('SELECT subject, expires_at FROM hub_account_link_transactions WHERE link_hash = ?')
        .get(linkHash);
      if (!fresh || Number(fresh.expires_at) <= now || fresh.subject !== pending.subject) return null;
      if (db.prepare('SELECT 1 FROM hub_federated_identities WHERE provider = ? AND subject = ?')
        .get(PROVIDER, fresh.subject)) return null;
      if (db.prepare('SELECT 1 FROM hub_federated_identities WHERE user_id = ?').get(candidate.id)) return null;
      const updated = db.prepare(`
        UPDATE users
        SET auth_provider = ?, provider_id = ?, updated_at = strftime('%s','now')
        WHERE id = ? AND auth_provider = 'local' AND password_hash = ?
          AND lower(COALESCE(username, '')) <> 'guest'
      `).run(PROVIDER, fresh.subject, candidate.id, candidate.password_hash);
      if (updated.changes !== 1) return null;
      db.prepare('INSERT INTO hub_federated_identities (provider, subject, user_id) VALUES (?, ?, ?)')
        .run(PROVIDER, fresh.subject, candidate.id);
      const deleted = db.prepare('DELETE FROM hub_account_link_transactions WHERE link_hash = ?').run(linkHash);
      if (deleted.changes !== 1) throw new Error('link transaction consumption failed');
      return db.prepare('SELECT * FROM users WHERE id = ?').get(candidate.id);
    });

    let user;
    try {
      user = consume();
    } catch (_) {
      return res.status(401).json({ error: 'account_link_failed' });
    }
    if (!user) return res.status(401).json({ error: 'account_link_failed' });

    issueSession(req, res, user, pending.subject, [
      clearCookie(LINK_COOKIE, '/api/auth/hub', cookieSecurity(config)),
    ]);
    return res.json({ success: true, complete_url: '/api/auth/hub/complete' });
  });

  router.get('/complete', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    return res.type('html').send(completePage());
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
