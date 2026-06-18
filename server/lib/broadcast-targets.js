'use strict';

function resolveBroadcastTargets({ db, requestedIds, workspaceId }) {
  const requested = [...new Set((requestedIds || []).map(String))];
  const targets = [];
  const missing = [];

  for (const id of requested) {
    const device = db.prepare('SELECT id, workspace_id FROM devices WHERE id = ?').get(id);
    if (!device) {
      missing.push(id);
      continue;
    }
    if (device.workspace_id !== workspaceId) {
      return {
        ok: false,
        status: 403,
        body: { error: `Device ${id} is not in this workspace` },
      };
    }
    targets.push(id);
  }

  if (targets.length === 0) {
    return {
      ok: false,
      status: 404,
      body: { error: 'No valid target devices found', missing },
    };
  }

  return { ok: true, requested, targets, missing };
}

module.exports = { resolveBroadcastTargets };
