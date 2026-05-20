/**
 * Screen-share REST endpoints.
 *
 * Currently exposes:
 *   GET /api/screen-share/turn-credentials
 *     Returns per-request ICE servers (STUN always, TURN when configured).
 *     Auth: JWT (requireAuth middleware mounted at /api/screen-share).
 *
 * Signaling itself happens over the authenticated /dashboard Socket.IO
 * namespace (see server/ws/screen-share-signaling.js). All session lifecycle
 * is event-driven; this route is purely for fetching ICE config.
 */
const express = require('express');
const router = express.Router();
const { getIceServers } = require('../lib/turn-credentials');

router.get('/turn-credentials', async (req, res) => {
  try {
    const config = await getIceServers();
    // req.user is set by requireAuth; we don't return identifying info to the
    // client beyond the JWT it already holds.
    res.json({
      iceServers: config.iceServers,
      turnEnabled: config.turnEnabled,
      // RTCConfiguration.iceTransportPolicy hint. Default 'all' (try direct
      // P2P first, fall back to TURN). 'relay' forces TURN-only - useful
      // for diagnosing whether TURN works in isolation.
      iceTransportPolicy: 'all',
    });
  } catch (e) {
    console.error('[screen-share] turn-credentials error:', e);
    res.status(500).json({ error: 'Failed to provision ICE servers' });
  }
});

module.exports = router;
