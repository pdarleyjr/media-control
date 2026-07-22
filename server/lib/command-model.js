// Phase 2 reliable command/state model. Additive to the existing fire-and-forget
// device:command emits (see lib/command-queue.js for the offline replay buffer,
// which is untouched here). Every relayed command is ingested into command_logs
// for audit; rows with requires_ack=1 get an ack_deadline and are swept by
// startAckSweep. requires_ack defaults to 0 today so existing behaviour (log
// only, never time out) is preserved; ack-per-type is enabled gradually.
//
// See planning/command-center/COMMAND_EVENT_MODEL.md and HEARTBEATS_AND_ACKS.md.

const crypto = require('crypto');
const config = require('../config');
const { db } = require('../db/database');
const deviceContract = require('../player/device-contract');

// ── prepared statements (memoized per-process) ────────────────────────────
function p(sql) {
  return db.prepare(sql);
}
const stmts = {
  maxRevision:     p('SELECT COALESCE(MAX(revision), 0) AS r FROM command_logs WHERE target_id = ?'),
  insertLog:       p(`INSERT INTO command_logs
    (command_id, target_type, target_id, command_type, payload, revision,
     parent_command_id, issued_by, created_at, requires_ack, ack_deadline, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'sent')`),
  wallMembers:     p('SELECT device_id FROM video_wall_devices WHERE wall_id = ?'),
  groupMembers:    p('SELECT device_id FROM device_group_members WHERE group_id = ?'),
  ackedOrFailed:   p(`SELECT status FROM command_logs WHERE parent_command_id = ?`),
  parentRow:       p('SELECT command_id FROM command_logs WHERE command_id = ?'),
  updateAck:       p(`UPDATE command_logs
    SET status = ?, ack_at = ?, ack_error = ?, requires_ack = requires_ack
    WHERE command_id = ? AND status = 'sent'`),
  updateParent:    p(`UPDATE command_logs
    SET status = ?, ack_at = ?, ack_error = ?, requires_ack = requires_ack
    WHERE command_id = ?`),
  timedOut:        p(`SELECT command_id, target_type, target_id, command_type, payload,
    revision, requires_ack, parent_command_id
    FROM command_logs
    WHERE status = 'sent' AND requires_ack = 1 AND ack_deadline IS NOT NULL
      AND ack_deadline < ?`),
  // Resolve the workspace room for a target so the ack-sweep can broadcast a
  // timed-out command to dashboards tracking that target (non-silent failure).
  wsForDevice: p('SELECT workspace_id FROM devices WHERE id = ?'),
  wsForWall:   p('SELECT workspace_id FROM video_walls WHERE id = ?'),
  wsForGroup:  p('SELECT workspace_id FROM device_groups WHERE id = ?'),
  countRetries:    p(`SELECT COUNT(*) AS n FROM command_logs
    WHERE parent_command_id IS NULL AND target_id = ? AND command_type = ?
      AND status IN ('timeout','failed')`),
  markTimeout:      p(`UPDATE command_logs
    SET status = 'timeout', ack_at = ? WHERE command_id = ? AND status = 'sent'`),
  displayStateExists: p('SELECT state_revision FROM display_states WHERE target_type = ? AND target_id = ?'),
  insertDisplayState: p(`INSERT INTO display_states
    (target_type, target_id, workspace_id, current_content_id, current_asset_id,
     content_type, layout_mode, slide_index, slide_count, current_time, duration, paused, muted,
     volume, local_asset_ready, last_ack_at, render_state,
     error_state, idle_screensaver_id, default_screensaver_id, wall_id, layout_id,
     group_id, member_id, playback_revision, command_revision, last_heartbeat_at,
     state_revision, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
  updateDisplayState: p(`UPDATE display_states SET
     workspace_id = COALESCE(?, workspace_id),
     current_content_id = COALESCE(?, current_content_id),
     current_asset_id = COALESCE(?, current_asset_id),
     content_type = COALESCE(?, content_type),
     layout_mode = COALESCE(?, layout_mode),
     slide_index = COALESCE(?, slide_index),
     slide_count = COALESCE(?, slide_count),
     current_time = COALESCE(?, current_time),
     duration = COALESCE(?, duration),
     paused = COALESCE(?, paused),
     muted = COALESCE(?, muted),
     volume = COALESCE(?, volume),
     local_asset_ready = COALESCE(?, local_asset_ready),
     last_ack_at = COALESCE(?, last_ack_at),
     render_state = COALESCE(?, render_state),
     error_state = COALESCE(?, error_state),
     idle_screensaver_id = COALESCE(?, idle_screensaver_id),
     default_screensaver_id = COALESCE(?, default_screensaver_id),
     wall_id = COALESCE(?, wall_id),
     layout_id = COALESCE(?, layout_id),
     group_id = COALESCE(?, group_id),
     member_id = COALESCE(?, member_id),
     playback_revision = COALESCE(?, playback_revision),
     command_revision = COALESCE(?, command_revision),
     state_revision = ?,
     updated_at = ?
     WHERE target_type = ? AND target_id = ?`),
  updateHeartbeat: p(`UPDATE display_states
    SET last_heartbeat_at = ?, updated_at = ? WHERE target_type = ? AND target_id = ?`),

  upsertHeartbeatState: p(`INSERT INTO display_states (target_type, target_id, last_heartbeat_at, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(target_type, target_id) DO UPDATE SET
      last_heartbeat_at = excluded.last_heartbeat_at, updated_at = excluded.updated_at`),
  nodeHeartbeat: p('UPDATE managed_nodes SET last_heartbeat = ?, updated_at = ? WHERE node_id = ?'),
};

// Canonical ordered list of updatable display_states columns (everything
// except the PK target_type/target_id, last_heartbeat_at, and updated_at,
// which are handled separately below). The INSERT/UPDATE prepared statements
// MUST list these in the same order.
const STATE_COLS = [
  'workspace_id', 'current_content_id', 'current_asset_id', 'content_type',
  'layout_mode', 'slide_index', 'slide_count', 'current_time', 'duration', 'paused', 'muted',
  'volume', 'local_asset_ready', 'last_ack_at', 'render_state', 'error_state',
  'idle_screensaver_id', 'default_screensaver_id', 'wall_id', 'layout_id',
  'group_id', 'member_id', 'playback_revision', 'command_revision',
];
const STATE_NUMERIC_COLS = new Set([
  'slide_index', 'slide_count', 'current_time', 'duration', 'volume',
  'last_ack_at', 'playback_revision',
]);
const STATE_BOOLEAN_COLS = new Set(['paused', 'muted', 'local_asset_ready']);

// Compute the next per-target revision (monotonic optimistic-lock counter).
function nextRevision(targetId) {
  const row = stmts.maxRevision.get(targetId);
  return (row && row.r ? row.r : 0) + 1;
}

// Resolve member device_ids for a wall/group target. Returns [] for single
// targets (display/node/live-program).
function fanOutTargets(target_type, target_id) {
  if (target_type === 'wall') {
    return stmts.wallMembers.all(target_id).map((r) => r.device_id);
  }
  if (target_type === 'group') {
    return stmts.groupMembers.all(target_id).map((r) => r.device_id);
  }
  return [];
}

/**
 * Ingest a command row. For wall/group targets, fans out N member child rows
 * (target_type='display', one per member device) carrying parent_command_id.
 * Returns the parent row (or the single row for non-aggregate targets).
 *
 * @param {object} args
 * @param {string} args.target_type   display|wall|group|node|live-program
 * @param {string} args.target_id
 * @param {string} args.command_type
 * @param {object} [args.payload]
 * @param {string} [args.issued_by]
 * @param {number} [args.requires_ack]  0/1, default 0 (fire-and-forget logging)
 * @param {string} [args.workspace_id] cached on display_STATES; not stored here.
 */
function ingestCommand(args) {
  const {
    target_type, target_id, command_type,
    payload, issued_by, requires_ack = 0, workspace_id,
    command_id: suppliedCommandId, created_at: suppliedCreatedAt,
  } = args || {};
  if (!target_type || !target_id || !command_type) return null;

  const command_id = suppliedCommandId || crypto.randomUUID();
  const created_at = Number.isFinite(Number(suppliedCreatedAt)) ? Number(suppliedCreatedAt) : Date.now();
  const ack_deadline = requires_ack ? created_at + config.commandAckTimeoutMs : null;
  const payloadStr = payload == null ? null
    : (typeof payload === 'string' ? payload : JSON.stringify(payload));

  const members = fanOutTargets(target_type, target_id);

  const tx = db.transaction(() => {
    const revision = nextRevision(target_id);
    stmts.insertLog.run(
      command_id, target_type, target_id, command_type, payloadStr, revision,
      null, issued_by || null, created_at, requires_ack ? 1 : 0, ack_deadline
    );
    for (const deviceId of members) {
      const childId = crypto.randomUUID();
      const childRevision = nextRevision(deviceId);
      stmts.insertLog.run(
        childId, 'display', deviceId, command_type, payloadStr, childRevision,
        command_id, issued_by || null, created_at, requires_ack ? 1 : 0, ack_deadline
      );
    }
  });
  tx();

  return {
    command_id, target_type, target_id, command_type,
    payload: payloadStr, revision: nextRevision(target_id) - 1,
    parent_command_id: null, issued_by: issued_by || null,
    created_at, requires_ack: requires_ack ? 1 : 0, ack_deadline, status: 'sent',
  };
}

// Merge a partial state object into display_states. Only known columns are
// carried; everything else is ignored so a chatty device can't poison the row.
// A null/missing value means "don't change" on UPDATE (COALESCE), and a literal
// NULL on INSERT — except last_ack_at which recordAck stamps explicitly.
function toSqlScalar(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' || typeof value === 'bigint') return value;
  if (value instanceof Date) return value.getTime();
  return null;
}
function toStateScalar(key, value) {
  if (value === undefined || value === null) return null;
  if (STATE_BOOLEAN_COLS.has(key)) {
    if (value === true || value === 1 || value === '1') return 1;
    if (value === false || value === 0 || value === '0') return 0;
    return null;
  }
  if (STATE_NUMERIC_COLS.has(key)) {
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }
  return toSqlScalar(value);
}
function mergeDisplayState(target_type, target_id, state) {
  if (!state || typeof state !== 'object') return { applied: false, reason: 'invalid_state' };
  if (!target_type || !target_id) return { applied: false, reason: 'invalid_target' };
  const tx = db.transaction(() => {
    const now = Date.now();
    const vals = STATE_COLS.map((key) => toStateScalar(key, state[key]));
    const exists = stmts.displayStateExists.get(target_type, target_id);
    const currentRevision = Number(exists?.state_revision) || 0;
    const suppliedRevision = state.state_revision == null ? Number.NaN : Number(state.state_revision);
    const hasSuppliedRevision = Number.isInteger(suppliedRevision) && suppliedRevision >= 0;
    if (hasSuppliedRevision && suppliedRevision < currentRevision) {
      return { applied: false, reason: 'stale_revision', state_revision: currentRevision };
    }
    const stateRevision = hasSuppliedRevision ? suppliedRevision : currentRevision + 1;
    if (!exists) {
      stmts.insertDisplayState.run(target_type, target_id, ...vals, null, stateRevision, now);
    } else {
      stmts.updateDisplayState.run(...vals, stateRevision, now, target_type, target_id);
    }
    return { applied: true, state_revision: stateRevision };
  });
  try {
    return tx();
  } catch (cause) {
    const wrapped = new Error(`display state persistence failed for ${target_type}:${target_id}: ${cause.message}`);
    wrapped.cause = cause;
    throw wrapped;
  }
}

// Recompute a parent (wall/group) row's status from its children's ack results.
// acked if every child is acked; failed if any child failed; otherwise leave
// as 'sent' so the sweep continues to track it.
function bubbleParent(parentId) {
  const kids = stmts.ackedOrFailed.all(parentId);
  if (!kids.length) return null;
  const statuses = kids.map((k) => k.status);
  if (statuses.every((s) => s === 'acked')) {
    const now = Date.now();
    stmts.updateParent.run('acked', now, null, parentId);
    return 'acked';
  }
  if (statuses.some((s) => s === 'failed')) {
    const now = Date.now();
    const firstFail = kids.find((k) => k.status === 'failed');
    stmts.updateParent.run('failed', now, firstFail?.ack_error || null, parentId);
    return 'failed';
  }
  return null;
}

/**
 * Record a device ack for a command_id. Child rows bubble up to their parent.
 * @param {object} args
 * @param {string} args.command_id
 * @param {boolean} args.ok
 * @param {string} [args.error]
 * @param {object} [args.state]      optional display state to upsert.
 * @param {string} [args.target_type] display|node — required when state is set.
 * @param {string} [args.target_id]   required when state is set.
 */
function recordAck(args) {
  const { command_id, ok, error, state, target_type, target_id } = args || {};
  if (!command_id) return null;
  const now = Date.now();
  const status = ok ? 'acked' : 'failed';

  const updated = stmts.updateAck.run(status, now, ok ? null : (error || null), command_id);
  if (updated.changes > 0) {
    // Bubble to parent if this is a child row.
    const child = db.prepare('SELECT parent_command_id, target_type, target_id FROM command_logs WHERE command_id = ?').get(command_id);
    if (child && child.parent_command_id) {
      bubbleParent(child.parent_command_id);
    }
  }

  if (state && target_type && target_id) {
    const stateResult = mergeDisplayState(target_type, target_id, { ...state, last_ack_at: now });
    if (stateResult && stateResult.applied === false && stateResult.reason !== 'stale_revision') {
      throw new Error(`recordAck state was not persisted: ${stateResult.reason}`);
    }
  }
  return { status, changes: updated.changes };
}

// Sweep one pass: mark timed-out sent rows and optionally re-emit retries.
// Returns { retries, timedOut } for observability. `retryies` are parent rows
// eligible for re-emit; `timedOut` is EVERY row marked timeout this pass (parent
// + child) so startAckSweep can broadcast a non-silent command:ack ok:false to
// dashboards tracking the target — the owner's "toast at 8s" requirement.
function tickAckTimeouts() {
  const now = Date.now();
  const rows = stmts.timedOut.all(now);
  const retries = [];
  const timedOut = [];
  const tx = db.transaction(() => {
    for (const r of rows) {
      stmts.markTimeout.run(now, r.command_id);
      timedOut.push({
        command_id: r.command_id,
        target_type: r.target_type,
        target_id: r.target_id,
        command_type: r.command_type,
        parent_command_id: r.parent_command_id,
      });
      // Retry budget is per (target_id, command_type) across the aggregate
      // command's history. Only the parent (no parent_command_id) is eligible
      // — children's deadlines mirror the parent, so re-issuing the parent
      // fans new children out via ingestCommand.
      if (!r.parent_command_id) {
        const prior = stmts.countRetries.get(r.target_id, r.command_type);
        const attempts = prior ? prior.n : 0;
        if (attempts < config.commandMaxRetries) {
          retries.push({
            command_id: r.command_id,
            target_id: r.target_id,
            command_type: r.command_type,
            payload: r.payload,
            revision: r.revision,
            attempt: attempts,
          });
        }
      }
    }
  });
  tx();
  return { retries, timedOut };
}

// Resolve the workspace room name for a target so the ack-sweep can broadcast
// a timed-out command to dashboards tracking that target. Returns null when
// the target / its workspace can't be resolved (best-effort, non-fatal).
function workspaceRoomForTarget(target_type, target_id) {
  if (!target_type || !target_id) return null;
  let wsId = null;
  try {
    if (target_type === 'wall') {
      wsId = (stmts.wsForWall.get(target_id) || {}).workspace_id || null;
    } else if (target_type === 'group') {
      wsId = (stmts.wsForGroup.get(target_id) || {}).workspace_id || null;
    } else {
      // display / node / live-program / anything device-like → devices.workspace_id
      wsId = (stmts.wsForDevice.get(target_id) || {}).workspace_id || null;
      if (!wsId && target_type === 'display') {
        // child of a wall/group: parent's wall/group workspace is the same, so
        // falling back to device lookup is sufficient.
      }
    }
  } catch (_) { /* table missing during early boot is non-fatal */ }
  return wsId ? ('workspace:' + wsId) : null;
}

let _sweepTimer = null;

/**
 * Start the ack-sweep interval. Mutates no existing state; safe to call from
 * server.js after io is constructed. The timer is unref()'d so it never keeps
 * the event loop alive on its own (matches command-queue.startSweep).
 */
function startAckSweep(io) {
  if (_sweepTimer) return _sweepTimer;
  _sweepTimer = setInterval(() => {
    try {
      const dashNs = io && io.of ? io.of('/dashboard') : null;
      const { retries, timedOut } = tickAckTimeouts();
      // Non-silent timeout: for every row that just expired, broadcast
      // command:ack {ok:false, status:'timeout'} to the target's workspace room
      // so any dashboard (Command Center) tracking it flips the chip to
      // Stale/Failed AND surfaces a toast — the "command not acknowledged
      // within 8s" requirement. We emit for parent rows (what the operator
      // sees) to avoid per-child spam on walls/groups.
      if (dashNs && timedOut && timedOut.length) {
        for (const t of timedOut) {
          if (t.parent_command_id) continue; // children mirror parent
          const room = workspaceRoomForTarget(t.target_type, t.target_id);
          if (!room) continue;
          try {
            dashNs.to(room).emit('command:ack', {
              command_id: t.command_id,
              target_type: t.target_type,
              target_id: t.target_id,
              ok: false,
              status: 'timeout',
              error: 'Command not acknowledged within ' +
                Math.round(config.commandAckTimeoutMs / 1000) + 's',
            });
          } catch (_) { /* broadcast is best-effort */ }
        }
      }
      if (retries && retries.length && io) {
        // Re-emit by ingesting a fresh command for the timed-out target. This
        // is the minimal, additive retry path; we don't bypass re-ingest so the
        // new row gets its own revision + ack_deadline.
        for (const r of retries) {
          try {
            const row = ingestCommand({
              target_type: 'display', target_id: r.target_id,
              command_type: r.command_type,
              payload: r.payload ? JSON.parse(r.payload) : {},
              requires_ack: 1,
            });
            const deviceNs = io.of && io.of('/device');
            if (row && deviceNs) {
              deviceNs.to(r.target_id).emit('device:command', deviceContract.createCommand({
                command_id: row.command_id,
                device_id: r.target_id,
                target_scope: 'display',
                payload: {
                  ...(r.payload ? JSON.parse(r.payload) : {}),
                  action: r.command_type,
                },
              }));
            }
          } catch (e) {
            console.warn(`ackSweep re-emit failed for ${r.target_id}/${r.command_type}: ${e.message}`);
          }
        }
      }
    } catch (e) {
      console.warn(`ackSweep tick failed: ${e.message}`);
    }
  }, config.ackSweepIntervalMs);
  if (_sweepTimer.unref) _sweepTimer.unref();
  return _sweepTimer;
}

function stopAckSweep() {
  if (_sweepTimer) { clearInterval(_sweepTimer); _sweepTimer = null; }
}

/**
 * Record a display/node heartbeat. Always bumps display_states.last_heartbeat_at
 * (upserting a minimal row if none exists). For node targets the managed_nodes
 * row's last_heartbeat is bumped too. Intended to be called from the device
 * socket's device:heartbeat handler alongside heartbeat.updateHeartbeat.
 */
function recordHeartbeat(args) {
  const { target_type = 'display', target_id, ts } = args || {};
  if (!target_id) return;
  const now = ts ? Math.floor(ts) : Date.now();
  try {
    stmts.upsertHeartbeatState.run(target_type, target_id, now, now);
  } catch (e) { /* table missing during early boot is non-fatal */ }
  if (target_type === 'node') {
    try { stmts.nodeHeartbeat.run(now, now, target_id); } catch (_) { /* no managed_nodes row yet */ }
  }
}

// Command types whose success the operator must SEE: these opt into
// requires_ack=1 so the dashboard status chip flips to "Applied ✓" on ack
// and the ack-sweep emits a non-silent timeout chip/toast at ack deadline.
// Fire-and-forget command types (volume/muted/seek/setcontent/identify/…)
// stay ack=0 (logged but never time out). List mirrors the operator-facing
// transport + display-control verbs in COMMAND_EVENT_MODEL.md / TEST_PLAN.
const ACK_ELIGIBLE_TYPES = new Set([
  'play', 'pause', 'prev', 'next', 'restart',
  'play_pause', 'transport',
  'blank', 'screensaver', 'grid',
]);
function ackRequiredForType(type) {
  return ACK_ELIGIBLE_TYPES.has(String(type || '').toLowerCase()) ? 1 : 0;
}

// Classroom single-audio-authority model.
// Only Front Center feeds the eARC/Ultimea path. Follower TVs must stay muted.
const AUDIO_AUTHORITY_ROLE_NAMES = {
  authority: [
    'front center',
    'classroom 1 - front center',
    'classroom1 - front center',
    'fc',
  ],
  followers: [
    'front left',
    'front right',
    'side left',
    'side right',
  ],
};

function _normName(name) {
  return String(name || '').trim().toLowerCase();
}

function resolveClassroomAudioAuthority(devices) {
  const list = Array.isArray(devices) ? devices : [];
  const authority = list.find((d) => {
    const n = _normName(d && d.name);
    return AUDIO_AUTHORITY_ROLE_NAMES.authority.some((alias) => n === alias || n.endsWith(alias));
  }) || null;
  const followers = list.filter((d) => {
    if (!d || (authority && d.id === authority.id)) return false;
    const n = _normName(d.name);
    return AUDIO_AUTHORITY_ROLE_NAMES.followers.some((alias) => n.includes(alias));
  });
  return {
    configured_authority_name: 'Front Center',
    authority_device_id: authority ? authority.id : null,
    authority_device_name: authority ? authority.name : null,
    followers: followers.map((d) => ({ id: d.id, name: d.name })),
    valid: Boolean(authority),
    error: authority ? null : 'audio_authority_offline_or_unconfigured',
  };
}

/**
 * Desired mute map after authority reconciliation.
 * Authority unmuted; every follower muted. Invalid/offline authority → all muted.
 */
function classroomAudioMutePlan(devices, options = {}) {
  const resolved = resolveClassroomAudioAuthority(devices);
  const onlineIds = new Set(
    (Array.isArray(options.onlineDeviceIds) ? options.onlineDeviceIds : [])
      .map(String),
  );
  const hasOnlineFilter = Array.isArray(options.onlineDeviceIds);
  const authorityOnline = resolved.authority_device_id
    && (!hasOnlineFilter || onlineIds.has(String(resolved.authority_device_id)));
  const plan = [];
  for (const d of (Array.isArray(devices) ? devices : [])) {
    if (!d || !d.id) continue;
    const isAuth = resolved.authority_device_id && d.id === resolved.authority_device_id;
    const isFollower = resolved.followers.some((f) => f.id === d.id);
    if (!isAuth && !isFollower) continue;
    let muted = true;
    let reason = 'follower_must_mute';
    if (isAuth) {
      if (!resolved.valid || !authorityOnline) {
        muted = true;
        reason = authorityOnline ? 'authority_invalid' : 'authority_offline';
      } else {
        muted = false;
        reason = 'single_audio_authority';
      }
    }
    plan.push({
      device_id: d.id,
      name: d.name,
      role: isAuth ? 'authority' : 'follower',
      muted,
      reason,
    });
  }
  return {
    ...resolved,
    authority_online: Boolean(authorityOnline),
    plan,
  };
}

module.exports = {
  ingestCommand,
  recordAck,
  tickAckTimeouts,
  startAckSweep,
  stopAckSweep,
  recordHeartbeat,
  bubbleParent,
  mergeDisplayState,
  fanOutTargets,
  nextRevision,
  ackRequiredForType,
  workspaceRoomForTarget,
  ACK_ELIGIBLE_TYPES,
  resolveClassroomAudioAuthority,
  classroomAudioMutePlan,
  AUDIO_AUTHORITY_ROLE_NAMES,
};
