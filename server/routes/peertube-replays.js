/**
 * PeerTube replay → Media Control operator-review API.
 *
 * Auth/tenancy middleware is applied at the server.js mount point
 * (requireAuth + resolveTenancy). These handlers reuse that authorization:
 * only an authenticated user of the active workspace may review/add replays.
 */
const express = require('express');
const svc = require('../services/peertube-replay');

const router = express.Router();

// List replays pending operator review (ready, not yet added).
router.get('/pending', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json({ replays: svc.listPending({ limit, offset }) });
});

// List all discovered replays (any state).
router.get('/', (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 100;
  const offset = parseInt(req.query.offset, 10) || 0;
  res.json({ replays: svc.listAll({ limit, offset }) });
});

router.get('/:id', (req, res) => {
  const replay = svc.getById(req.params.id);
  if (!replay) return res.status(404).json({ error: 'Replay not found' });
  res.json(replay);
});

// Approve a replay: create a (default-private) Media Control content row
// referencing PeerTube as authoritative storage. Idempotent.
router.post('/:id/add', (req, res) => {
  if (!req.workspaceId) return res.status(403).json({ error: 'No workspace context' });
  const privacy = _parsePrivacy(req.body.privacy);
  const title = req.body.title ? String(req.body.title).slice(0, 255) : null;
  try {
    const result = svc.addToMediaControl({
      replayId: req.params.id,
      userId: req.user.id,
      workspaceId: req.workspaceId,
      privacy,
      title,
    });
    // Real-time library update: notify connected dashboards a new content
    // row exists so the library refreshes without a manual reload.
    const io = req.app.get('io');
    if (io) io.to(`workspace:${req.workspaceId}`).emit('content:created', { contentId: result.content_id });
    res.status(result.created ? 201 : 200).json(result);
  } catch (e) {
    const status = e.code || 500;
    res.status(status).json({ error: e.message });
  }
});

// Discard a replay without adding it.
router.post('/:id/discard', (req, res) => {
  try {
    svc.discard({ replayId: req.params.id, userId: req.user.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(e.code || 500).json({ error: e.message });
  }
});

function _parsePrivacy(raw) {
  // PeerTube privacy: 1=private, 2=unlisted, 3=public, 4=internal.
  const n = parseInt(raw, 10);
  if ([1, 2, 3, 4].includes(n)) return n;
  return 1; // default private
}

module.exports = router;
