// Phase 3: Fast Broadcast.
//
// POST /api/broadcast — send one content / remote URL / playlist to a selection
// of displays in ~2 taps, reusing the existing device-content-push path
// (services/scene-engine.pushSourceToDevice -> commandQueue device:playlist-update).
//
// Confirmation gate: if the target set equals ALL devices in the caller's
// workspace AND confirm_all !== true, respond 409 { code:'CONFIRM_ALL_REQUIRED',
// count } so the UI can show a "you're about to take over every display"
// confirmation before re-submitting with confirm_all:true.
//
// Mounted with requireAuth + resolveTenancy (server.js). Writes deny
// workspace_viewer (mirrors playlists.js / scenes.js).

const express = require('express');
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../db/database');
const { getBroadcastDeliveryStore } = require('../lib/broadcast-delivery');
const broadcastDelivery = getBroadcastDeliveryStore(db);
const sceneEngine = require('../services/scene-engine');
const { logActivity, getClientIp } = require('../services/activity');
const { deckPlayerUrl } = require('../lib/deck-player-url');
const { assertRemoteUrlSafe, isAppOwnedRelativeUrl } = require('../lib/ssrf-policy');
const { audit } = require('../lib/audit');
const { ensureLiveStreamDisplay, liveStreamProgramState, markLiveContentChanged } = require('../lib/live-stream-display');
const {
  LIVE_STREAM_DEVICE_PREFIX,
  isManagedLiveStreamTarget,
  resolveBroadcastTargets,
  resolveTypedBroadcastTargets,
} = require('../lib/broadcast-targets');
const nodeRegistry = require('../lib/node-registry');
const { contentUseDecision, contextFromRequest } = require('../lib/content-visibility');
const { contentBroadcastReadiness } = require('../lib/content-readiness');
const { buildBroadcastPreflight } = require('../lib/broadcast-preflight');
const cameraControl = require('../lib/camera-control-client');

function sourceIdentity({ contentId, playlistId, presentationId, remoteUrl }) {
  if (contentId) return { type: 'content', id: String(contentId) };
  if (playlistId) return { type: 'playlist', id: String(playlistId) };
  if (presentationId) return { type: 'presentation', id: String(presentationId) };
  const digest = crypto.createHash('sha256').update(String(remoteUrl || '')).digest('hex').slice(0, 32);
  return { type: 'remote_url', id: `sha256:${digest}` };
}

router.get('/:requestId', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  broadcastDelivery.sweepExpired();
  const request = broadcastDelivery.getRequest(String(req.params.requestId || ''), req.workspaceId);
  if (!request) return res.status(404).json({ error: 'Broadcast request not found' });
  res.set('Cache-Control', 'no-store');
  return res.json(request);
});

// Read-only release gate for Media Library sends. This resolves the same typed
// topology contract used by POST /api/broadcast, but performs no command,
// prewarm, audit, or display-state mutation.
router.post('/preflight', (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  const {
    device_ids: deviceIds,
    targets: targetRefs,
    content_id: contentId,
  } = req.body || {};
  if (!contentId) return res.status(400).json({ error: 'content_id is required' });
  if (deviceIds !== undefined && !Array.isArray(deviceIds)) {
    return res.status(400).json({ error: 'device_ids must be an array' });
  }
  if (targetRefs !== undefined && !Array.isArray(targetRefs)) {
    return res.status(400).json({ error: 'targets must be an array' });
  }
  const legacyIds = Array.isArray(deviceIds) ? deviceIds.map(String) : [];
  const typedRefs = Array.isArray(targetRefs) ? targetRefs : [];
  if (legacyIds.length === 0 && typedRefs.length === 0) {
    return res.status(400).json({ error: 'device_ids or targets must select at least one display' });
  }

  const decision = contentUseDecision(db, String(contentId), req.workspaceId, contextFromRequest(req));
  if (!decision.content) return res.status(404).json({ error: 'Content not found' });
  if (!decision.allowed) return res.status(403).json({ error: decision.reason });
  const readiness = contentBroadcastReadiness(db, decision.content);

  const typedResolution = resolveTypedBroadcastTargets({
    db,
    refs: typedRefs,
    workspaceId: req.workspaceId,
  });
  if (!typedResolution.ok) {
    return res.status(typedResolution.status).json(typedResolution.body);
  }
  const requested = [...new Set(
    typedRefs.length > 0 ? typedResolution.targets : legacyIds,
  )].filter((id) => !isManagedLiveStreamTarget(id));
  let resolved = resolveBroadcastTargets({
    db,
    requestedIds: requested,
    workspaceId: req.workspaceId,
    allowLiveStream: false,
  });
  if (!resolved.ok && resolved.status === 404) {
    resolved = {
      ok: true,
      targets: [],
      missing: resolved.body?.missing || requested,
    };
  } else if (!resolved.ok) {
    return res.status(resolved.status).json(resolved.body);
  }
  const routes = typedRefs.length > 0
    ? typedResolution.routes.filter((route) => resolved.targets.includes(route.device_id))
    : resolved.targets.map((deviceId) => ({ type: 'display', device_id: deviceId }));

  res.set('Cache-Control', 'no-store');
  return res.json(buildBroadcastPreflight(db, {
    workspaceId: req.workspaceId,
    content: decision.content,
    readiness,
    routes,
    missingDeviceIds: resolved.missing || [],
  }));
});

router.post('/', async (req, res) => {
  if (!req.workspaceId) return res.status(400).json({ error: 'No active workspace' });
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    return res.status(403).json({ error: 'Read-only access' });
  }

  const {
    device_ids, targets: target_refs, content_id, remote_url, playlist_id, presentation_id,
    fit_mode, confirm_all, confirm_wall_replace, include_live_stream,
  } = req.body || {};

  // Validate the target selection.
  if (device_ids !== undefined && !Array.isArray(device_ids)) {
    return res.status(400).json({ error: 'device_ids must be an array' });
  }
  if (target_refs !== undefined && !Array.isArray(target_refs)) {
    return res.status(400).json({ error: 'targets must be an array' });
  }
  const legacyIds = Array.isArray(device_ids) ? device_ids : [];
  const typedRefs = Array.isArray(target_refs) ? target_refs : [];
  if (legacyIds.length === 0 && typedRefs.length === 0 && include_live_stream !== true) {
    return res.status(400).json({ error: 'device_ids or targets must select at least one display unless Live Program is explicitly selected' });
  }

  // Validate at least one source (presentation_id counts as a valid source).
  if (!content_id && !remote_url && !playlist_id && !presentation_id) {
    return res.status(400).json({ error: 'one of content_id, remote_url, playlist_id, or presentation_id is required' });
  }
  if (content_id) {
    const decision = contentUseDecision(db, String(content_id), req.workspaceId, contextFromRequest(req));
    if (!decision.content) return res.status(404).json({ error: 'Content not found' });
    if (!decision.allowed) return res.status(403).json({ error: decision.reason });
    const readiness = contentBroadcastReadiness(db, decision.content);
    if (!readiness.ready) return res.status(readiness.status).json(readiness);
  }

  // SSRF gate: app-owned root-relative player/content paths are rendered by the
  // display from its current Media Control origin and never trigger a server-side
  // fetch. Every other hand-typed remote_url still receives the full public-host
  // shape + DNS policy so it cannot target internal infrastructure or metadata.
  // A presentation_id-derived URL is generated by us below and is also exempt.
  if (remote_url && !isAppOwnedRelativeUrl(remote_url)) {
    const safe = await assertRemoteUrlSafe(remote_url);
    if (!safe.ok) return res.status(400).json({ error: safe.error });
  }

  // Resolve a presentation_id to its public deck-player remote_url, so a deck
  // flows through the SAME source/push path as a hand-typed remote_url (exactly
  // what the "Present this deck" buttons already broadcast). The presentation
  // must exist and live in the caller's workspace.
  let effectiveRemoteUrl = remote_url;
  if (presentation_id) {
    const pres = db.prepare('SELECT id, workspace_id FROM presentations WHERE id = ?').get(String(presentation_id));
    if (!pres) return res.status(404).json({ error: `Presentation ${presentation_id} not found` });
    if (pres.workspace_id !== req.workspaceId) {
      return res.status(403).json({ error: `Presentation ${presentation_id} is not in this workspace` });
    }
    const publicBase = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
    effectiveRemoteUrl = deckPlayerUrl(publicBase, pres.id);
  }

  // Resolve logical targets from authoritative, current topology before any
  // display mutation. Wall targets carry an optimistic layout revision: stale
  // popup/card selections fail atomically instead of broadcasting to an old
  // physical membership list supplied by the browser.
  const typedResolution = resolveTypedBroadcastTargets({
    db,
    refs: typedRefs,
    workspaceId: req.workspaceId,
  });
  if (!typedResolution.ok) return res.status(typedResolution.status).json(typedResolution.body);

  // Merge the revision-safe logical selection with legacy physical ids. The
  // legacy contract remains compatible while new clients can use typed refs.
  const requested = [...new Set(
    typedRefs.length > 0 ? typedResolution.targets : legacyIds.map(String)
  )];
  // Live Program is represented only by its explicit boolean gate. Ignore any
  // legacy managed id here and recreate/append the workspace's canonical live
  // target only after validation and confirm-all have completed.
  const requestedPhysical = requested.filter((id) => !isManagedLiveStreamTarget(id));
  let resolvedTargets = resolveBroadcastTargets({
    db,
    requestedIds: requestedPhysical,
    workspaceId: req.workspaceId,
    allowLiveStream: false,
  });
  if (!resolvedTargets.ok) {
    if (include_live_stream === true && resolvedTargets.status === 404) {
      resolvedTargets = {
        ok: true,
        requested: requestedPhysical,
        targets: [],
        missing: resolvedTargets.body?.missing || requestedPhysical,
      };
    } else {
      return res.status(resolvedTargets.status).json(resolvedTargets.body);
    }
  }
  const physicalTargets = resolvedTargets.targets;
  const typedRoutes = typedRefs.length > 0
    ? typedResolution.routes.filter((route) => physicalTargets.includes(route.device_id))
    : physicalTargets.map((deviceId) => ({ type: 'display', device_id: deviceId }));
  const wallReplacementRoutes = typedRoutes.filter((route) => route.wall_replace === true);
  if (wallReplacementRoutes.length > 0 && confirm_wall_replace !== true) {
    return res.status(409).json({
      error: 'Replacing every Mosaic region requires explicit confirmation',
      code: 'CONFIRM_WALL_REPLACE_REQUIRED',
      wall_id: wallReplacementRoutes[0].wall_id,
      region_count: wallReplacementRoutes.length,
    });
  }

  // Confirmation gate when targeting ALL displays in the workspace.
  const totalInWorkspace = db.prepare(
    `SELECT COUNT(*) AS c FROM devices
     WHERE workspace_id = ?
       AND id NOT LIKE ?`
  ).get(req.workspaceId, `${LIVE_STREAM_DEVICE_PREFIX}%`).c;
  const targetingAll = totalInWorkspace > 0 && physicalTargets.length === totalInWorkspace;
  if (targetingAll && confirm_all !== true) {
    return res.status(409).json({ code: 'CONFIRM_ALL_REQUIRED', count: totalInWorkspace });
  }

  // All read-only validation and the operator confirmation gate have passed.
  // Only now may the request create/mark the managed Live Program display.
  const targets = [...physicalTargets];
  if (include_live_stream === true) {
    const liveStreamDisplay = ensureLiveStreamDisplay({ workspaceId: req.workspaceId, userId: req.user.id });
    if (liveStreamDisplay && !targets.includes(liveStreamDisplay.id)) targets.push(liveStreamDisplay.id);
    if (liveStreamDisplay) markLiveContentChanged(liveStreamDisplay.id);
  }
  const dispatchRoutes = [...typedRoutes];
  for (const deviceId of targets) {
    if (!dispatchRoutes.some((route) => route.device_id === deviceId)) {
      dispatchRoutes.push({ type: 'display', device_id: deviceId });
    }
  }

  const source = { content_id, remote_url: effectiveRemoteUrl, playlist_id, fit_mode };
  const io = req.app.get('io');
  const totalRequested = dispatchRoutes.length + resolvedTargets.missing.length;
  const sourceRef = sourceIdentity({
    contentId: content_id,
    playlistId: playlist_id,
    presentationId: presentation_id,
    remoteUrl: effectiveRemoteUrl,
  });
  const idempotencyKey = String(
    req.get('X-Idempotency-Key') || req.body?.idempotency_key || ''
  ).trim();
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
    workspace_id: req.workspaceId,
    source: sourceRef,
    remote_url: effectiveRemoteUrl || null,
    fit_mode: fit_mode || null,
    routes: dispatchRoutes.map((route) => ({
      type: route.type,
      device_id: route.device_id,
      wall_id: route.wall_id || null,
      region_id: route.region_id || null,
      zone_id: route.zone_id || null,
      layout_revision: route.layout_revision ?? null,
    })),
  })).digest('hex');
  let deliveryRequest;
  try {
    deliveryRequest = broadcastDelivery.createRequest({
      workspaceId: req.workspaceId,
      userId: req.user.id,
      sourceType: sourceRef.type,
      sourceId: sourceRef.id,
      typedTargets: typedRefs,
      expectedTargetCount: totalRequested,
      idempotencyKey: idempotencyKey || null,
      requestFingerprint: fingerprint,
      targets: [
        ...dispatchRoutes.map((route) => ({
          deviceId: route.device_id,
          regionId: route.region_id || null,
          zoneId: route.zone_id || null,
          expectedSourceId: content_id ? String(content_id) : null,
        })),
        ...resolvedTargets.missing.map((deviceId) => ({
          deviceId,
          resolved: false,
          initialState: 'failed',
          failureReason: 'Display was not found in the active workspace',
        })),
      ],
    });
  } catch (error) {
    if (error?.code === 'IDEMPOTENCY_KEY_REUSED') {
      return res.status(409).json({
        error: error.message,
        code: error.code,
      });
    }
    throw error;
  }
  if (deliveryRequest.idempotent_replay === true) {
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
      accepted: true,
      success: true,
      idempotent_replay: true,
      request_id: deliveryRequest.id,
      status_url: `/api/broadcast/${encodeURIComponent(deliveryRequest.id)}`,
      delivery: deliveryRequest,
    });
  }
  const deliveryByTarget = new Map(
    deliveryRequest.devices.map((entry) => [entry.target_key, entry])
  );
  let sent = 0;
  const failed = resolvedTargets.missing.slice();
  const regionRoutesByDevice = new Map();
  for (const route of dispatchRoutes) {
    if (route.type !== 'wall-region') continue;
    const entries = regionRoutesByDevice.get(route.device_id) || [];
    entries.push(route);
    regionRoutesByDevice.set(route.device_id, entries);
  }
  const batchProcessedDevices = new Set();
  for (const route of dispatchRoutes) {
    const deviceId = route.device_id;
    const regionBatch = regionRoutesByDevice.get(deviceId) || [];
    if (regionBatch.length > 1) {
      if (batchProcessedDevices.has(deviceId)) continue;
      batchProcessedDevices.add(deviceId);
      const batchDeliveries = regionBatch.map((batchRoute) => {
        const key = `${deviceId}:region:${batchRoute.region_id}`;
        const entry = deliveryByTarget.get(key);
        return {
          requestId: deliveryRequest.id,
          commandId: entry.command_id,
          sourceId: sourceRef.id,
          sourceType: sourceRef.type,
          expectedSourceId: content_id ? String(content_id) : null,
          regionId: batchRoute.region_id,
          zoneId: batchRoute.zone_id,
        };
      });
      const batchResult = sceneEngine.pushSourceToRegions(io, deviceId, source, regionBatch, {
        workspaceId: req.workspaceId,
        userId: req.user.id,
        contentContext: contextFromRequest(req),
        targetDeviceIds: targets,
        deliveries: batchDeliveries,
      });
      for (const [index, batchRoute] of regionBatch.entries()) {
        const delivery = deliveryByTarget.get(`${deviceId}:region:${batchRoute.region_id}`);
        broadcastDelivery.markDispatched({
          requestId: deliveryRequest.id,
          deviceId,
          commandId: delivery.command_id,
          delivered: batchResult.delivered,
          queued: batchResult.queued,
          playlistRevision: batchResult.playlistRevision,
          expectedSourceId: batchResult.expectedSourceId,
          regionId: batchRoute.region_id,
          failureReason: batchResult.failureReason,
        });
        if (batchResult.ok) sent++; else failed.push(`${deviceId}:region:${batchRoute.region_id}`);
      }
      continue;
    }
    const targetKey = route.region_id
      ? `${deviceId}:region:${route.region_id}`
      : deviceId;
    const delivery = deliveryByTarget.get(targetKey);
    const result = sceneEngine.pushSourceToDevice(io, deviceId, source, {
      workspaceId: req.workspaceId,
      userId: req.user.id,
      contentContext: contextFromRequest(req),
      targetDeviceIds: targets,
      regionId: route.region_id || null,
      zoneId: route.zone_id || null,
      target: route,
      delivery: {
        requestId: deliveryRequest.id,
        commandId: delivery.command_id,
        sourceId: sourceRef.id,
        sourceType: sourceRef.type,
        expectedSourceId: content_id ? String(content_id) : null,
        regionId: route.region_id || null,
        zoneId: route.zone_id || null,
      },
      returnDetails: true,
    });
    broadcastDelivery.markDispatched({
      requestId: deliveryRequest.id,
      deviceId,
      commandId: delivery.command_id,
      delivered: result.delivered,
      queued: result.queued,
      playlistRevision: result.playlistRevision,
      expectedSourceId: result.expectedSourceId,
      regionId: route.region_id || null,
      failureReason: result.failureReason,
    });
    if (result.ok) sent++; else failed.push(targetKey);
  }
  // Reinforce the upload/finalization prewarm after routing. Node delivery stays
  // workspace-scoped, and this event makes the selected asset priority.
  const cachePrewarm = content_id
    ? nodeRegistry.requestContentPrewarm(io, db, { deviceIds: targets, contentId: content_id })
    : { requested: false, reason: 'not_local_content' };

  // Log the broadcast (activityLogger middleware only captures a single
  // device_id; broadcasts touch many, so log an explicit summary here).
  try {
    const sourceLabel = presentation_id ? `presentation:${presentation_id}`
      : playlist_id ? `playlist:${playlist_id}`
      : content_id ? `content:${content_id}`
      : `url:${effectiveRemoteUrl}`;
    logActivity(
      req.user.id,
      'POST /api/broadcast',
      `broadcast ${sourceLabel} to ${sent}/${totalRequested} display(s)${targetingAll ? ' (ALL)' : ''}`,
      null,
      getClientIp(req),
      req.workspaceId
    );
  } catch (e) { /* logging best-effort */ }

  // Security audit trail (redacted; never stores token-bearing query strings).
  audit({
    actorType: 'user',
    actorId: req.user.id,
    action: 'display.broadcast',
    targetType: 'workspace',
    targetId: req.workspaceId,
    workspaceId: req.workspaceId,
    sourceIp: getClientIp(req),
    details: {
      source: presentation_id ? 'presentation' : playlist_id ? 'playlist' : content_id ? 'content' : 'remote_url',
      content_id: content_id || null,
      playlist_id: playlist_id || null,
      presentation_id: presentation_id || null,
      remote_url: effectiveRemoteUrl || null,
      device_ids: targets,
      target_routes: dispatchRoutes.map((route) => ({
        type: route.type,
        device_id: route.device_id,
        wall_id: route.wall_id || null,
        region_id: route.region_id || null,
      })),
      target_count: totalRequested,
      missing_device_count: resolvedTargets.missing.length,
      sent,
      targeting_all: targetingAll,
      cache_prewarm_requested: cachePrewarm.requested === true,
    },
  });

  let liveProgram = null;
  if (include_live_stream === true) {
    liveProgram = liveStreamProgramState(req.workspaceId);
    // AI Director retired: the program source is the canonical Anpviz/TONOR edge. Surface
    // its live status instead of an OBS media-control refresh.
    const cameraStatus = await cameraControl.getStatus();
    liveProgram.program_refresh = cameraStatus.ok
      ? { ok: true, data: { camera_online: !!(cameraStatus.data && cameraStatus.data.camera_online), message: 'Anpviz/TONOR program source live' } }
      : { ok: false, message: cameraStatus.message || 'Camera control edge is unreachable' };
  }
  const deliveryStatus = broadcastDelivery.getRequest(deliveryRequest.id, req.workspaceId);
  res.status(202).json({
    accepted: true,
    success: true,
    request_id: deliveryRequest.id,
    status_url: `/api/broadcast/${encodeURIComponent(deliveryRequest.id)}`,
    delivery: deliveryStatus,
    sent,
    failed,
    total: totalRequested,
    cache_prewarm: cachePrewarm,
    live_stream: liveProgram,
  });
});

module.exports = router;
