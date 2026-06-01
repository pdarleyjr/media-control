const express = require('express');
const router = express.Router();
const config = require('../config');
const ncfs = require('../services/nextcloud-fs');

// MBFD Media Control Studio — Files (Nextcloud per-user raw-FS) API.
//
// SECURITY / TRUST BOUNDARY (HARD GUARDRAIL):
// The per-user email ALWAYS comes from req.user.email (set by requireAuth from
// the JWT). A client-supplied header is never used — media-control is the trust
// boundary; the microservices trust the email header blindly. Every ncfs call
// passes req.user.email explicitly so a mis-wired route throws
// NextcloudNotConnectedError instead of leaking another user's tree.
//
// The old WebDAV service (services/nextcloud.js) is kept in the tree but is NOT
// imported here. It serves as a disabled fallback during rollout.

// GET /health — connectivity probe for the per-user read path.
// Returns { enabled, connected, mode } (never throws; the frontend renders a banner).
router.get('/health', async (req, res) => {
  if (!config.features.nextcloudSync) return res.json({ enabled: false });
  const h = await ncfs.health(req.user.email);
  res.json({ enabled: true, connected: h.connected, mode: 'per-user', error: h.error });
});

// GET /?path= — list a directory in the caller's Nextcloud Files.
// Email always from JWT; path from query string ('' = root).
router.get('/', async (req, res) => {
  if (!config.features.nextcloudSync) return res.status(503).json({ error: 'Files is disabled' });
  try {
    const items = await ncfs.listDir(req.user.email, req.query.path || '');
    res.json(items);
  } catch (e) {
    if (e && e.code === 'NC_NOT_CONNECTED') return res.status(503).json({ error: e.message, connected: false });
    res.status(502).json({ error: e.message || String(e) });
  }
});

// GET /download?path= — stream a file from the caller's Nextcloud Files.
// Uses readFile which returns { buffer, mime, name, size } inferred from the
// extension (the read microservice is text-only; binary is re-encoded from
// the UTF-8 surface — see nextcloud-fs.js readFile() caveat for binary).
router.get('/download', async (req, res) => {
  if (!config.features.nextcloudSync) return res.status(503).json({ error: 'Files is disabled' });
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'path required' });
  try {
    const { buffer, mime, name } = await ncfs.readFile(req.user.email, p);
    res.setHeader('Content-Type', mime || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(name || String(p).split('/').pop())}"`);
    res.send(buffer);
  } catch (e) {
    if (e && e.code === 'NC_NOT_CONNECTED') return res.status(503).json({ error: e.message, connected: false });
    const status = e && e.status ? e.status : 502;
    res.status(status).json({ error: e.message || String(e) });
  }
});

module.exports = router;
