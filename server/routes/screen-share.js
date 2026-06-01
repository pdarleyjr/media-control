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
      // Operator-tunable per-receiver bitrate CEILING (kbps). The broadcaster
      // computes an adaptive target from the captured resolution/fps client-side;
      // this is only the upper bound. Default 50 Mbps. Lower it via the
      // SCREEN_SHARE_MAX_BITRATE_KBPS env var on the box when a broadcaster is on
      // a constrained uplink (e.g. remote Starlink ~10-40 Mbps upstream) shared
      // across N receivers.
      maxBitrateKbps: parseInt(process.env.SCREEN_SHARE_MAX_BITRATE_KBPS, 10) || 50000,
    });
  } catch (e) {
    console.error('[screen-share] turn-credentials error:', e);
    res.status(500).json({ error: 'Failed to provision ICE servers' });
  }
});

module.exports = router;
