'use strict';

const express = require('express');
const config = require('../config');
const { db } = require('../db/database');
const { requirePlatformAdmin } = require('../lib/permissions');
const { buildOperationalDiagnostics } = require('../lib/operational-diagnostics');

const router = express.Router();

router.get('/', requirePlatformAdmin, (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  res.set('Cache-Control', 'no-store, private');
  return res.json(buildOperationalDiagnostics(db, {
    workspaceId: req.workspaceId,
    roomId: config.console.roomId,
    heartbeatTimeoutMs: config.heartbeatTimeout,
    audioAuthorityDeviceId: process.env.CLASSROOM_AUDIO_AUTHORITY_DEVICE_ID,
  }));
});

module.exports = router;
