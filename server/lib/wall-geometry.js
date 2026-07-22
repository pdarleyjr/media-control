function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function dimensionForMember(member, axis) {
  const canvasKey = axis === 'x' ? 'canvas_width' : 'canvas_height';
  const screenKey = axis === 'x' ? 'screen_width' : 'screen_height';
  return positiveNumber(member?.[canvasKey]) || positiveNumber(member?.[screenKey]);
}

function mean(values) {
  const valid = values.filter((value) => Number.isFinite(value) && value > 0);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function membersAt(members, axis, coordinate) {
  const key = axis === 'x' ? 'grid_col' : 'grid_row';
  return members.filter((member) => Number(member[key]) === coordinate);
}

// The database stores bezel measurements in physical millimetres while the
// renderer consumes logical canvas pixels. At a seam between unlike panels,
// neither panel's pixel density alone is authoritative, so use the arithmetic
// mean of both adjoining edges. This makes the conversion deterministic and
// symmetric regardless of which member is building its payload.
function bezelPixelsBetween(wall, members, axis, before, after) {
  const bezelMm = positiveNumber(axis === 'x' ? wall?.bezel_h_mm : wall?.bezel_v_mm);
  if (!bezelMm) return 0;

  const physicalMm = positiveNumber(axis === 'x' ? wall?.screen_w_mm : wall?.screen_h_mm);
  if (!physicalMm) return Math.round(bezelMm);

  const densities = [];
  for (const coordinate of [before, after]) {
    const edgeDensity = mean(membersAt(members, axis, coordinate)
      .map((member) => dimensionForMember(member, axis))
      .filter(Boolean)
      .map((pixels) => pixels / physicalMm));
    if (edgeDensity) densities.push(edgeDensity);
  }
  const pixelsPerMm = mean(densities);
  return Math.round(bezelMm * (pixelsPerMm || 1));
}

function axisMetrics(wall, members, axis) {
  const gridKey = axis === 'x' ? 'grid_col' : 'grid_row';
  const physicalFallback = positiveNumber(axis === 'x' ? wall?.screen_w_mm : wall?.screen_h_mm) || 1;
  const coordinates = [...new Set(members.map((member) => Number(member[gridKey]) || 0))].sort((a, b) => a - b);
  const sizes = new Map();
  const starts = new Map();

  for (const coordinate of coordinates) {
    const trackSizes = membersAt(members, axis, coordinate)
      .map((member) => dimensionForMember(member, axis))
      .filter(Boolean);
    // A grid track must accommodate its largest panel. Averaging unlike
    // heights/widths would make the next row/column begin inside a larger TV.
    sizes.set(coordinate, trackSizes.length ? Math.max(...trackSizes) : physicalFallback);
  }

  let cursor = 0;
  coordinates.forEach((coordinate, index) => {
    if (index > 0) {
      const previous = coordinates[index - 1];
      cursor += sizes.get(previous);
      cursor += bezelPixelsBetween(wall, members, axis, previous, coordinate);
    }
    starts.set(coordinate, cursor);
  });

  return { sizes, starts };
}

function memberRect(member, xMetrics, yMetrics) {
  const col = Number(member.grid_col) || 0;
  const row = Number(member.grid_row) || 0;
  return {
    x: Math.round(finiteNumber(member.canvas_x) ?? xMetrics.starts.get(col) ?? 0),
    y: Math.round(finiteNumber(member.canvas_y) ?? yMetrics.starts.get(row) ?? 0),
    w: Math.round(dimensionForMember(member, 'x') || xMetrics.sizes.get(col) || 1),
    h: Math.round(dimensionForMember(member, 'y') || yMetrics.sizes.get(row) || 1),
  };
}

function boundingRect(rects) {
  if (!rects.length) return null;
  const x = Math.min(...rects.map((rect) => rect.x));
  const y = Math.min(...rects.map((rect) => rect.y));
  const x2 = Math.max(...rects.map((rect) => rect.x + rect.w));
  const y2 = Math.max(...rects.map((rect) => rect.y + rect.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

function explicitPlayerRect(wall) {
  const x = finiteNumber(wall?.player_x);
  const y = finiteNumber(wall?.player_y);
  const w = positiveNumber(wall?.player_width);
  const h = positiveNumber(wall?.player_height);
  if (x == null || y == null || w == null || h == null) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

function viewportFor(screenRect, playerRect) {
  const x = Math.max(screenRect.x, playerRect.x);
  const y = Math.max(screenRect.y, playerRect.y);
  const x2 = Math.min(screenRect.x + screenRect.w, playerRect.x + playerRect.w);
  const y2 = Math.min(screenRect.y + screenRect.h, playerRect.y + playerRect.h);
  return {
    x: Math.max(0, x - playerRect.x),
    y: Math.max(0, y - playerRect.y),
    w: Math.max(0, x2 - x),
    h: Math.max(0, y2 - y),
  };
}

function buildUniversalWallGeometry({ wall, members, memberIds, deviceId, useExplicitPlayerRect = true }) {
  const allMembers = Array.isArray(members) ? members : [];
  const current = allMembers.find((member) => member.device_id === deviceId);
  if (!wall || !current) return null;

  const selectedIds = new Set(Array.isArray(memberIds) && memberIds.length ? memberIds : [deviceId]);
  const selectedMembers = allMembers.filter((member) => selectedIds.has(member.device_id));
  if (!selectedMembers.length) return null;

  const xMetrics = axisMetrics(wall, allMembers, 'x');
  const yMetrics = axisMetrics(wall, allMembers, 'y');
  const rectById = new Map(allMembers.map((member) => [member.device_id, memberRect(member, xMetrics, yMetrics)]));
  const screenRect = rectById.get(deviceId);
  const groupBounds = boundingRect(selectedMembers.map((member) => rectById.get(member.device_id)).filter(Boolean));
  const playerRect = (useExplicitPlayerRect ? explicitPlayerRect(wall) : null) || groupBounds;
  if (!screenRect || !playerRect) return null;

  return {
    screenRect,
    playerRect,
    logicalCanvas: { width: playerRect.w, height: playerRect.h },
    viewport: viewportFor(screenRect, playerRect),
  };
}

function buildLayoutAssignment({
  layoutId,
  layoutRevision,
  contentId = null,
  geometry,
  fitMode = null,
  synchronizedStartAt = null,
}) {
  if (!geometry) return null;
  return {
    layout_id: layoutId || null,
    layout_revision: Number(layoutRevision) || 0,
    content_id: contentId || null,
    logical_canvas: geometry.logicalCanvas,
    viewport: geometry.viewport,
    fit_mode: fitMode || null,
    synchronized_start_at: synchronizedStartAt || null,
  };
}

module.exports = {
  buildUniversalWallGeometry,
  buildLayoutAssignment,
  bezelPixelsBetween,
};
