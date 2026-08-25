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
const { presentationDependencyDecision } = require('../services/presentation-dependency-access');
const { buildBroadcastPreflight } = require('../lib/broadcast-preflight');
const cameraControl = require('../lib/camera-control-client');
const { ELEVATED_ROLES } = require('../middleware/auth');
const {
  buildAudioPolicy,
  findAudioPolicyParticipants,
  isClassroomRendererDevice,
  maxPersistedAudioPolicyRevision,
  nextAudioPolicyRevision,
  orderedRendererDeviceIds,
  resolveDeterministicAudioOwner,
  resolvePhysicalAudioOutputDeviceId,
} = require('../lib/audio-ownership');
const { fenceAudioOwnershipTargets } = require('../lib/audio-ownership-transaction');

function sourceIdentity({ contentId, playlistId, presentationId, remoteUrl }) {
  if (contentId) return { type: 'content', id: String(contentId) };
  if (playlistId) return { type: 'playlist', id: String(playlistId) };
  if (presentationId) return { type: 'presentation', id: String(presentationId) };
  const digest = crypto.createHash('sha256').update(String(remoteUrl || '')).digest('hex').slice(0, 32);
  return { type: 'remote_url', id: `sha256:${digest}` };
}

function loadPresentationForBroadcast(req) {
  const pres = db.prepare(`SELECT id, workspace_id, user_id, deck_json, status, published_snapshot, updated_at
    FROM presentations WHERE id = ?`).get(String(req.body.presentation_id));
  if (!pres) return { status: 404, error: `Presentation ${req.body.presentation_id} not found` };
  if (pres.workspace_id !== req.workspaceId) return { status: 403, error: `Presentation ${req.body.presentation_id} is not in this workspace` };
  if (!req.actingAs && !ELEVATED_ROLES.includes(req.user.role) && pres.user_id && pres.user_id !== req.user.id) {
    return { status: 403, error: 'You can only broadcast your own presentations' };
  }
  const dependencyIds = new Set(
    db.prepare('SELECT content_id FROM presentation_assets WHERE presentation_id=? AND content_id IS NOT NULL')
      .all(pres.id).map((row) => row.content_id)
  );
  try {
    const deck = JSON.parse(pres.deck_json || '{}');
    for (const asset of Array.isArray(deck.assets) ? deck.assets : []) if (asset.content_id) dependencyIds.add(String(asset.content_id));
    for (const slide of Array.isArray(deck.slides) ? deck.slides : []) {
      for (const value of Object.values(slide.slots || {})) if (value && typeof value === 'object' && value.content_id) dependencyIds.add(String(value.content_id));
    }
  } catch { return { status: 422, error: 'Presentation document is invalid' }; }
  const dependencies = [];
  for (const contentId of dependencyIds) {
    const decision = presentationDependencyDecision(
      db,
      pres,
      contentId,
      req.workspaceId,
      contextFromRequest(req),
    );
    if (!decision.content) return { status: 409, error: `Presentation dependency ${contentId} is missing` };
    if (!decision.allowed) return { status: 403, error: `Presentation dependency ${contentId} is not available in this workspace` };
    const readiness = contentBroadcastReadiness(db, decision.content);
    if (!readiness.ready) return { status: readiness.status, body: { ...readiness, presentation_id: pres.id, dependency_content_id: contentId } };
    dependencies.push(decision.content);
  }
  return { presentation: pres, dependencies };
}

// A workspace viewer is normally read-only. Classroom operation is the narrow
// exception requested by policy: every selected physical display must currently
// belong to a protected wall in the same workspace. The authoritative join keeps
// this fail-closed for removed members, custom walls, mixed selections, and
// cross-workspace ids.
function allTargetsBelongToProtectedWalls(database, workspaceId, deviceIds) {
  const ids = [...new Set((deviceIds || []).map(String).filter(Boolean))];
  if (!workspaceId || ids.length === 0) return false;
  const placeholders = ids.map(() => '?').join(', ');
  const row = database.prepare(`
    SELECT COUNT(DISTINCT d.id) AS count
    FROM devices d
    JOIN video_wall_devices vwd ON vwd.device_id = d.id
    JOIN video_walls w ON w.id = vwd.wall_id
    WHERE d.workspace_id = ?
      AND w.workspace_id = ?
      AND w.is_locked = 1
      AND d.id IN (${placeholders})
  `).get(workspaceId, workspaceId, ...ids);
  return Number(row?.count || 0) === ids.length;
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

  // A broadcast is one authoritative source mutation. Reject ambiguous bodies
  // instead of relying on precedence between fields; accepting both a camera
  // URL and Guest Computer URL/content would let the UI label, audit identity,
  // and playlist mutation disagree.
  const sourceFields = Object.entries({ content_id, remote_url, playlist_id, presentation_id })
    .filter(([, value]) => value !== undefined && value !== null && value !== '');
  if (sourceFields.length !== 1) {
    return res.status(400).json({ error: 'exactly one of content_id, remote_url, playlist_id, or presentation_id is required' });
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
  let presentationDependencies = [];
  let presentationForBroadcast = null;
  if (presentation_id) {
    const decision = loadPresentationForBroadcast(req);
    if (!decision.presentation) return res.status(decision.status).json(decision.body || { error: decision.error });
    const pres = decision.presentation;
    presentationForBroadcast = pres;
    presentationDependencies = decision.dependencies;
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
  const viewerProtectedWallOperation = include_live_stream !== true
    && allTargetsBelongToProtectedWalls(db, req.workspaceId, physicalTargets);
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer' && !viewerProtectedWallOperation) {
    return res.status(403).json({ error: 'Read-only access' });
  }
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
  const classroomRenderers = db.prepare(`
    SELECT id, name
    FROM devices
    WHERE workspace_id = ?
      AND id NOT LIKE ?
  `).all(req.workspaceId, `${LIVE_STREAM_DEVICE_PREFIX}%`).filter(isClassroomRendererDevice);
  const rendererIds = new Set(classroomRenderers.map((device) => String(device.id)));
  const audioTargetDeviceIds = physicalTargets.filter((deviceId) => rendererIds.has(String(deviceId)));
  const audioOutputDeviceId = resolvePhysicalAudioOutputDeviceId(classroomRenderers);
  const deviceNamespace = io.of('/device');
  const onlineAudioTargetIds = audioTargetDeviceIds.filter((deviceId) => {
    const room = deviceNamespace.adapter.rooms.get(deviceId);
    return Boolean(room && room.size > 0);
  });
  const audioOwnerDeviceId = audioOutputDeviceId && audioTargetDeviceIds.length > 0
    ? resolveDeterministicAudioOwner({
        targetDeviceIds: audioTargetDeviceIds,
        preferredDeviceId: audioOutputDeviceId,
        orderedDeviceIds: orderedRendererDeviceIds(classroomRenderers),
        onlineDeviceIds: onlineAudioTargetIds,
      })
    : null;
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
    presentation_snapshot_sha256: presentationForBroadcast
      ? crypto.createHash('sha256').update(presentationForBroadcast.deck_json).digest('hex')
      : null,
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
  // A presentation broadcast is also its publication boundary. Complete this
  // last abortable consistency check before muting any renderer for a new
  // ownership epoch; a concurrent edit must not strand the current owner
  // behind a fence that will never receive its matching committed policy.
  if (presentationForBroadcast
      && (presentationForBroadcast.status !== 'published'
        || presentationForBroadcast.published_snapshot !== presentationForBroadcast.deck_json)) {
    const published = db.prepare(`UPDATE presentations
      SET status='published', published_snapshot=deck_json,
          published_at=strftime('%s','now'), updated_at=strftime('%s','now')
      WHERE id=? AND deck_json=?`).run(
      presentationForBroadcast.id,
      presentationForBroadcast.deck_json,
    );
    if (published.changes !== 1) {
      return res.status(409).json({
        code: 'PRESENTATION_CHANGED',
        error: 'Presentation changed before broadcast; review and send again.',
      });
    }
  }
  // Every whole-display source, including an existing playlist, receives one
  // durable request-scoped policy. Before any owner grant is published, all
  // online windows participating in this same logical source must acknowledge
  // the exact mute fence. Any timeout or stale acknowledgement commits a null
  // owner so the content still routes but every renderer stays fail-muted.
  const hasRegionRoute = dispatchRoutes.some((route) => route.region_id || route.zone_id);
  let audioFenceResult = null;
  let committedAudioOwnerDeviceId = audioOwnerDeviceId;
  let audioParticipantDeviceIds = audioTargetDeviceIds.slice();
  if (!hasRegionRoute && audioOutputDeviceId && audioTargetDeviceIds.length > 0) {
    let audioGeneration = 1;
    if (content_id) {
      audioGeneration = Number(db.prepare('SELECT version FROM content WHERE id = ?').get(content_id)?.version) || 1;
    } else if (effectiveRemoteUrl) {
      audioGeneration = Number(db.prepare(`
        SELECT version FROM content
        WHERE remote_url = ? AND (workspace_id = ? OR workspace_id IS NULL)
        ORDER BY CASE WHEN workspace_id = ? THEN 0 ELSE 1 END
        LIMIT 1
      `).get(effectiveRemoteUrl, req.workspaceId, req.workspaceId)?.version) || 1;
    } else if (playlist_id) {
      audioGeneration = Number(db.prepare(`
        SELECT MAX(COALESCE(c.version, 1)) AS version
        FROM playlist_items pi
        LEFT JOIN content c ON c.id = pi.content_id
        WHERE pi.playlist_id = ?
      `).get(playlist_id)?.version) || 1;
    }
    source.content_instance_id = deliveryRequest.id;
    const audioSourceKey = `${sourceRef.type}:${sourceRef.id}`;
    audioParticipantDeviceIds = [...new Set([
      ...audioTargetDeviceIds,
      ...findAudioPolicyParticipants(db, {
        workspaceId: req.workspaceId,
        sourceKey: audioSourceKey,
        playlistId: playlist_id || null,
      }),
    ])];
    const onlineAudioParticipantIds = audioParticipantDeviceIds.filter((deviceId) => {
      const room = deviceNamespace.adapter.rooms.get(deviceId);
      return Boolean(room && room.size > 0);
    });
    const audioPolicyRevision = nextAudioPolicyRevision({
      persistedRevision: maxPersistedAudioPolicyRevision(db),
    });
    const proposedAudioPolicy = buildAudioPolicy({
      outputDeviceId: audioOutputDeviceId,
      ownerDeviceId: audioOwnerDeviceId,
      contentInstanceId: deliveryRequest.id,
      transactionId: deliveryRequest.id,
      generation: audioGeneration,
      revision: audioPolicyRevision,
      sourceKey: audioSourceKey,
    });
    audioFenceResult = audioOwnerDeviceId
      ? await fenceAudioOwnershipTargets(deviceNamespace, {
          deviceIds: onlineAudioParticipantIds,
          policy: proposedAudioPolicy,
        })
      : {
          ok: false,
          acknowledged_device_ids: [],
          failed_device_ids: [],
          offline_device_ids: audioParticipantDeviceIds,
          committed_policy: buildAudioPolicy({
            ...{
              outputDeviceId: audioOutputDeviceId,
              ownerDeviceId: null,
              contentInstanceId: deliveryRequest.id,
              transactionId: deliveryRequest.id,
              generation: audioGeneration,
              revision: audioPolicyRevision,
              sourceKey: audioSourceKey,
            },
          }),
        };
    source.audio_policy = audioFenceResult.committed_policy;
    committedAudioOwnerDeviceId = source.audio_policy.owner_device_id;
  }
  const deliveryByTarget = new Map(
    deliveryRequest.devices.map((entry) => [entry.target_key, entry])
  );
  let sent = 0;
  const failed = resolvedTargets.missing.slice();
  // Send mute decisions before the owner grant so a same-content ownership
  // change cannot briefly leave both renderer windows audible.
  const audioOrderedDispatchRoutes = [...dispatchRoutes].sort((left, right) => (
    Number(left.device_id === committedAudioOwnerDeviceId) - Number(right.device_id === committedAudioOwnerDeviceId)
  ));
  const regionRoutesByDevice = new Map();
  for (const route of audioOrderedDispatchRoutes) {
    if (route.type !== 'wall-region') continue;
    const entries = regionRoutesByDevice.get(route.device_id) || [];
    entries.push(route);
    regionRoutesByDevice.set(route.device_id, entries);
  }
  const batchProcessedDevices = new Set();
  for (const route of audioOrderedDispatchRoutes) {
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
  if (source.audio_policy) {
    const passiveParticipants = audioParticipantDeviceIds.filter((deviceId) => (
      !audioTargetDeviceIds.includes(deviceId)
    ));
    sceneEngine.applyAudioPolicyToDevices(io, passiveParticipants, source.audio_policy);
  }
  // Reinforce the upload/finalization prewarm after routing. Node delivery stays
  // workspace-scoped, and this event makes the selected asset priority.
  const prewarmContentIds = content_id
    ? [String(content_id)]
    : presentationDependencies.map((content) => String(content.id));
  const prewarmResults = prewarmContentIds.map((contentId) => ({
    content_id: contentId,
    ...nodeRegistry.requestContentPrewarm(io, db, { deviceIds: targets, contentId }),
  }));
  const cachePrewarm = prewarmResults.length
    ? {
      requested: prewarmResults.some((result) => result.requested === true),
      dependencies: prewarmResults,
      dependency_count: prewarmResults.length,
    }
    : { requested: false, reason: 'not_local_content', dependency_count: 0 };

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
      audio_barrier_acknowledged: audioFenceResult?.ok === true,
      audio_owner_device_id: source.audio_policy?.owner_device_id || null,
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
    audio_ownership: source.audio_policy ? {
      transaction_id: source.audio_policy.transaction_id,
      revision: source.audio_policy.revision,
      owner_device_id: source.audio_policy.owner_device_id,
      output_device_id: source.audio_policy.output_device_id,
      barrier_acknowledged: audioFenceResult?.ok === true,
      acknowledged_device_ids: audioFenceResult?.acknowledged_device_ids || [],
      failed_device_ids: audioFenceResult?.failed_device_ids || [],
    } : null,
    live_stream: liveProgram,
  });
});

module.exports = router;
module.exports.loadPresentationForBroadcast = loadPresentationForBroadcast;
