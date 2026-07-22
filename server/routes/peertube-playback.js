'use strict';

const { Readable } = require('node:stream');
const { db } = require('../db/database');
const { canServePublicContent } = require('../lib/public-content-access');
const { verifyPlaybackGrant } = require('../lib/peertube-playback-grant');
const svc = require('../services/peertube-replay');

const FORWARDED_HEADERS = Object.freeze([
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
]);

function safeDownloadName(value) {
  return String(value || 'classroom-replay.mp4')
    .replace(/[\r\n"\\/]/g, '_')
    .slice(0, 180) || 'classroom-replay.mp4';
}

async function pipePlayback(req, res, next, { disposition = null } = {}) {
  try {
    const upstream = await svc.fetchPlaybackResponse(req.params.id, {
      range: req.headers.range || null,
      signal: req.signal,
    });
    res.status(upstream.status);
    for (const name of FORWARDED_HEADERS) {
      const value = upstream.headers.get(name);
      if (value != null) res.setHeader(name, value);
    }
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (disposition) {
      const binding = svc.getPlaybackBinding(req.params.id);
      res.setHeader('Content-Disposition', `${disposition}; filename="${safeDownloadName(binding && binding.filename)}"`);
    }
    if (req.method === 'HEAD' || !upstream.body) return res.end();
    const stream = Readable.fromWeb(upstream.body);
    stream.on('error', next);
    stream.pipe(res);
  } catch (caught) {
    if (res.headersSent) return next(caught);
    const status = caught.code && Number(caught.code) >= 400 ? Number(caught.code)
      : caught.status && Number(caught.status) >= 400 ? Number(caught.status)
        : 502;
    return res.status(status).json({ error: caught.message });
  }
}

function publicPlayback(req, res, next) {
  const binding = svc.getPlaybackBinding(req.params.id);
  if (!binding) return res.status(404).json({ error: 'Replay playback not found' });
  const content = db.prepare('SELECT * FROM content WHERE id=?').get(binding.content_id);
  let grantAuthorized = false;
  if (req.query && req.query.grant) {
    try {
      const claims = verifyPlaybackGrant(req.query.grant, { replayId: req.params.id });
      grantAuthorized = claims.workspace_id === binding.workspace_id;
    } catch (_) { /* fail closed */ }
  }
  if (!grantAuthorized && (!content || !canServePublicContent(db, content))) {
    return res.status(403).json({ error: 'Replay is not assigned to a published display payload' });
  }
  return pipePlayback(req, res, next, {
    disposition: grantAuthorized && req.query.download === '1' ? 'attachment' : null,
  });
}

module.exports = {
  publicPlayback,
  pipePlayback,
  safeDownloadName,
};
