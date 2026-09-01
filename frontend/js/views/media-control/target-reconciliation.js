function targetRef(target) {
  if (!target?.id) return null;
  return `${target.type || 'display'}:${target.id}`;
}

// An established operator choice is safety-critical state. A transient catalog
// miss may make it unavailable, but it must never redirect controls to another
// wall. Callers retain the reference and expose no command targets until the
// selected topology is authoritative again.
export function reconcileControlTarget({ activeTarget, validateTarget, chooseDefaultTarget }) {
  const ref = targetRef(activeTarget);
  if (ref) {
    const validated = typeof validateTarget === 'function' ? validateTarget(ref) : null;
    return {
      target: validated || activeTarget,
      available: !!validated,
      usedDefault: false,
    };
  }

  const fallback = typeof chooseDefaultTarget === 'function' ? chooseDefaultTarget() : null;
  return {
    target: fallback || null,
    available: !!fallback,
    usedDefault: !!fallback,
  };
}

function stableLayout(layout) {
  if (layout === null || layout === undefined) return null;
  if (typeof layout !== 'object') return layout;
  if (Array.isArray(layout)) return layout.map(stableLayout);
  return Object.fromEntries(
    Object.keys(layout).sort().map((key) => [key, stableLayout(layout[key])]),
  );
}

function deviceTopology(device) {
  return {
    id: device?.device_id || null,
    gridCol: device?.grid_col ?? null,
    gridRow: device?.grid_row ?? null,
    rotation: device?.rotation ?? 0,
    canvasX: device?.canvas_x ?? null,
    canvasY: device?.canvas_y ?? null,
    canvasWidth: device?.canvas_width ?? null,
    canvasHeight: device?.canvas_height ?? null,
    screenWidth: device?.screen_width ?? null,
    screenHeight: device?.screen_height ?? null,
  };
}

// Content, timestamps, online telemetry, and playback state do not change which
// devices a control targets. Excluding them prevents each room heartbeat from
// tearing down and rebuilding the live canvas.
export function wallTopologySignature(walls) {
  const topology = (Array.isArray(walls) ? walls : [])
    .map((wall) => ({
      id: wall?.id || null,
      name: wall?.name || '',
      gridCols: wall?.grid_cols ?? null,
      gridRows: wall?.grid_rows ?? null,
      syncMode: wall?.sync_mode ?? null,
      layoutMode: wall?.layout_mode || 'span',
      locked: Number(wall?.is_locked) || 0,
      leaderId: wall?.leader_device_id || null,
      playerX: wall?.player_x ?? null,
      playerY: wall?.player_y ?? null,
      playerWidth: wall?.player_width ?? null,
      playerHeight: wall?.player_height ?? null,
      layoutRevision: Number(wall?.layout_revision) || 0,
      layout: stableLayout(wall?.layout),
      devices: (Array.isArray(wall?.devices) ? wall.devices : [])
        .map(deviceTopology)
        .sort((a, b) => String(a.id).localeCompare(String(b.id))),
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return JSON.stringify(topology);
}
