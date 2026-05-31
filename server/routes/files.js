const express = require('express');
const router = express.Router();
const config = require('../config');
const nc = require('../services/nextcloud');

// MBFD Media Control Studio — Files (Nextcloud WebDAV) API. Feature-flag gated
// and inert until the service account is configured in .env. The browser calls
// these authenticated endpoints; the WebDAV creds never leave the server.

router.get('/health', async (req, res) => {
  if (!config.features.nextcloudSync) return res.json({ enabled: false });
  res.json({ enabled: true, ...(await nc.ping()) });
});

router.get('/', async (req, res) => {
  if (!config.features.nextcloudSync) return res.status(503).json({ error: 'Files is disabled' });
  if (!nc.isConfigured()) return res.status(503).json({ error: 'Nextcloud not configured', configured: false });
  try { res.json(await nc.list(req.query.path || '')); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

router.get('/download', async (req, res) => {
  if (!config.features.nextcloudSync) return res.status(503).json({ error: 'Files is disabled' });
  const p = req.query.path;
  if (!p) return res.status(400).json({ error: 'path required' });
  try {
    const r = await nc.fetchFile(p);
    res.setHeader('Content-Type', r.headers.get('content-type') || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(String(p).split('/').pop())}"`);
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

module.exports = router;
