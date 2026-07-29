'use strict';

const express = require('express');
const { db } = require('../db/database');
const { mediaObservabilitySnapshot } = require('../lib/media-observability');

const router = express.Router();

function canViewOperations(req) {
  return req.isPlatformAdmin === true
    || req.workspaceRole === 'workspace_admin'
    || req.orgRole === 'org_admin'
    || req.actingAs === true;
}

router.get('/', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!canViewOperations(req)) {
    return res.status(403).json({ error: 'Workspace administrator access is required.' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json(mediaObservabilitySnapshot(db, {
    workspaceId: req.workspaceId,
  }));
});

module.exports = router;
