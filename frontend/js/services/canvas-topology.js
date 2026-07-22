function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positive(value, fallback = 1) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function rectBounds(rects) {
  if (!rects.length) return null;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x + rect.width));
  const maxY = Math.max(...rects.map((rect) => rect.y + rect.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function normalizeOutput(raw, index) {
  const id = String(raw?.id || raw?.device_id || raw?.deviceId || raw?.slug || `output-${index + 1}`);
  return {
    ...raw,
    id,
    deviceId: String(raw?.deviceId || raw?.device_id || raw?.id || ''),
    name: String(raw?.name || raw?.device_name || raw?.slug || id),
    x: number(raw?.x),
    y: number(raw?.y),
    width: positive(raw?.width),
    height: positive(raw?.height),
  };
}

function catalogMemberMap(catalog) {
  const result = new Map();
  for (const wall of (catalog?.walls || [])) {
    for (const member of (wall.members || [])) result.set(member.id, { wall, member });
  }
  return result;
}

function annotateExistingTopology(rawTopology, catalog) {
  const memberById = catalogMemberMap(catalog);
  const outputs = (rawTopology?.outputs || []).map(normalizeOutput).map((output) => {
    const match = memberById.get(output.deviceId) || memberById.get(output.id);
    return match ? { ...output, wallId: match.wall.id, wallName: match.wall.name } : output;
  });
  const walls = (catalog?.walls || []).map((wall) => {
    const members = outputs.filter((output) => output.wallId === wall.id);
    if (!members.length) return null;
    return {
      id: wall.id,
      name: wall.name,
      layoutMode: wall.layoutMode,
      layoutRevision: wall.layoutRevision,
      onlineCount: wall.onlineCount,
      memberCount: wall.memberCount,
      outputIds: members.map((member) => member.id),
      rect: rectBounds(members),
    };
  }).filter(Boolean);
  const bounds = rectBounds(outputs);
  return {
    ...rawTopology,
    origin_x: number(rawTopology?.origin_x, bounds?.x || 0),
    origin_y: number(rawTopology?.origin_y, bounds?.y || 0),
    width: positive(rawTopology?.width, bounds?.width || 1),
    height: positive(rawTopology?.height, bounds?.height || 1),
    outputs,
    walls,
  };
}

function deriveCatalogTopology(catalog) {
  const outputs = [];
  const walls = [];
  let offsetX = 0;
  let maxHeight = 1;
  for (const wall of (catalog?.walls || [])) {
    const viewports = (wall.members || []).filter((member) => member.viewport);
    const localBounds = rectBounds(viewports.map((member) => member.viewport));
    if (!localBounds) continue;
    const wallOutputs = viewports.map((member, index) => ({
      id: member.id,
      deviceId: member.id,
      name: member.name,
      wallId: wall.id,
      wallName: wall.name,
      x: offsetX + member.viewport.x - localBounds.x,
      y: member.viewport.y - localBounds.y,
      width: member.viewport.width,
      height: member.viewport.height,
      status: member.status,
      order: index,
    }));
    outputs.push(...wallOutputs);
    walls.push({
      id: wall.id,
      name: wall.name,
      layoutMode: wall.layoutMode,
      layoutRevision: wall.layoutRevision,
      onlineCount: wall.onlineCount,
      memberCount: wall.memberCount,
      outputIds: wallOutputs.map((output) => output.id),
      rect: { x: offsetX, y: 0, width: localBounds.width, height: localBounds.height },
    });
    offsetX += localBounds.width;
    maxHeight = Math.max(maxHeight, localBounds.height);
  }
  for (const display of (catalog?.standaloneDisplays || [])) {
    if (!display.dimensions) continue;
    outputs.push({
      id: display.id,
      deviceId: display.id,
      name: display.name,
      x: offsetX,
      y: 0,
      width: display.dimensions.width,
      height: display.dimensions.height,
      status: display.status,
    });
    offsetX += display.dimensions.width;
    maxHeight = Math.max(maxHeight, display.dimensions.height);
  }
  return { origin_x: 0, origin_y: 0, width: Math.max(1, offsetX), height: maxHeight, outputs, walls };
}

/** Use calibrated endpoint coordinates when available; otherwise derive a
 * deterministic real-pixel canvas from the authoritative room catalog. */
export function normalizeCanvasTopology(rawTopology, catalog) {
  return Array.isArray(rawTopology?.outputs) && rawTopology.outputs.length
    ? annotateExistingTopology(rawTopology, catalog)
    : deriveCatalogTopology(catalog);
}

