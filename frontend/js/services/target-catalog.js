// Pure projection of the authoritative room snapshot into operator-facing
// routing targets. Consumer views should use this catalog instead of combining
// /devices, /walls, and stale modal-local arrays independently.

export const LIVE_STREAM_DEVICE_PREFIX = 'live-stream-program-';

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function positiveNumber(value) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function normalizedStatus(value) {
  return text(value).toLowerCase() || 'offline';
}

function isOnlineStatus(value) {
  return ['online', 'connected', 'ready'].includes(normalizedStatus(value));
}

function dimensions(width, height) {
  const normalizedWidth = positiveNumber(width);
  const normalizedHeight = positiveNumber(height);
  return normalizedWidth && normalizedHeight
    ? { width: normalizedWidth, height: normalizedHeight }
    : null;
}

export function formatDimensions(value, height) {
  const normalized = value && typeof value === 'object'
    ? dimensions(value.width, value.height)
    : dimensions(value, height);
  if (!normalized) return 'dimensions unavailable';
  return `${Math.round(normalized.width)} × ${Math.round(normalized.height)}`;
}

function isVirtualDisplayId(id, liveProgramId = '') {
  return id.startsWith(LIVE_STREAM_DEVICE_PREFIX) || (!!liveProgramId && id === liveProgramId);
}

function memberLine(members) {
  return members.map((member) => `${member.name} (${member.status})`).join(' · ');
}

function normalizeDisplay(raw, confirmed = null, fallback = null) {
  const id = text(raw?.id || confirmed?.id || fallback?.deviceId);
  if (!id) return null;
  const status = normalizedStatus(raw?.status ?? confirmed?.status ?? fallback?.status);
  const physicalDimensions = dimensions(
    raw?.width ?? raw?.screenWidth ?? confirmed?.width
      ?? fallback?.displayWidth ?? fallback?.viewport?.width,
    raw?.height ?? raw?.screenHeight ?? confirmed?.height
      ?? fallback?.displayHeight ?? fallback?.viewport?.height,
  );
  const name = text(raw?.name || confirmed?.name || fallback?.name) || id;
  return {
    type: 'display',
    id,
    name,
    label: name,
    status,
    online: isOnlineStatus(status),
    dimensions: physicalDimensions,
    dimensionsLabel: formatDimensions(physicalDimensions),
    capabilities: raw?.capabilities ?? raw?.capabilities_json ?? null,
    raw: raw || confirmed || fallback || null,
    confirmedState: confirmed || null,
  };
}

function normalizeViewport(raw) {
  const x = finiteNumber(raw?.x);
  const y = finiteNumber(raw?.y);
  const viewportDimensions = dimensions(raw?.width ?? raw?.w, raw?.height ?? raw?.h);
  if (x === null || y === null || !viewportDimensions) return null;
  return { x, y, ...viewportDimensions };
}

function explicitCanvasDimensions(wall) {
  const candidates = [
    wall?.logicalCanvas,
    wall?.logical_canvas,
    wall?.layout?.logicalCanvas,
    wall?.layout?.logical_canvas,
    wall?.layout?.canvas,
  ];
  for (const candidate of candidates) {
    const normalized = dimensions(
      candidate?.width ?? candidate?.w,
      candidate?.height ?? candidate?.h,
    );
    if (normalized) return normalized;
  }
  return null;
}

function viewportBounds(members) {
  if (!members.length || members.some((member) => !member.viewport)) return null;
  const minX = Math.min(...members.map((member) => member.viewport.x));
  const minY = Math.min(...members.map((member) => member.viewport.y));
  const maxX = Math.max(...members.map((member) => member.viewport.x + member.viewport.width));
  const maxY = Math.max(...members.map((member) => member.viewport.y + member.viewport.height));
  return dimensions(maxX - minX, maxY - minY);
}

function gridBounds(wall, members) {
  if (!members.length || members.some((member) => !member.dimensions)) return null;
  const columns = new Map();
  const rows = new Map();
  for (const member of members) {
    const column = finiteNumber(member.gridColumn) ?? 0;
    const row = finiteNumber(member.gridRow) ?? 0;
    columns.set(column, Math.max(columns.get(column) || 0, member.dimensions.width));
    rows.set(row, Math.max(rows.get(row) || 0, member.dimensions.height));
  }
  const width = [...columns.values()].reduce((sum, value) => sum + value, 0);
  const height = [...rows.values()].reduce((sum, value) => sum + value, 0);
  return dimensions(width, height);
}

function wallDimensions(wall, members) {
  return dimensions(wall?.playerRect?.width, wall?.playerRect?.height)
    || explicitCanvasDimensions(wall)
    || viewportBounds(members)
    || gridBounds(wall, members);
}

function groupDimensionsLabel(members) {
  const labels = [...new Set(
    members
      .filter((member) => member.dimensions)
      .map((member) => member.dimensionsLabel),
  )];
  if (!labels.length) return 'dimensions unavailable';
  return labels.length === 1 ? labels[0] : 'mixed dimensions';
}

function targetCountLabel(count) {
  return `${count} ${count === 1 ? 'display' : 'displays'}`;
}

function createLiveProgram(raw) {
  if (!raw || typeof raw !== 'object' || raw.configured === false) return null;
  const id = text(raw.displayId || raw.id);
  if (!id) return null;
  const name = text(raw.displayName || raw.name) || 'Live Stream Program';
  const status = normalizedStatus(raw.status);
  const physicalDimensions = dimensions(raw.width, raw.height);
  return {
    type: 'live-program',
    id,
    name,
    label: name,
    status,
    online: isOnlineStatus(status),
    dimensions: physicalDimensions,
    dimensionsLabel: formatDimensions(physicalDimensions),
    contentId: raw.contentId ?? null,
    raw,
  };
}

/**
 * Build a stable routing catalog from socket.roomState.getSnapshot(). This is
 * intentionally pure so reconnects and modal openings cannot trigger separate,
 * racing topology fetches.
 */
export function buildTargetCatalog(snapshot, options = {}) {
  const state = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const confirmedRows = Array.isArray(state.confirmedState?.displays)
    ? state.confirmedState.displays
    : [];
  const deviceRows = Array.isArray(state.deviceStates?.displays)
    ? state.deviceStates.displays
    : [];
  const wallRows = Array.isArray(state.layoutState?.walls) ? state.layoutState.walls : [];
  const groupRows = Array.isArray(state.layoutState?.groups) ? state.layoutState.groups : [];
  const liveProgram = createLiveProgram(state.livestreamProgram);
  const liveProgramId = liveProgram?.id || '';
  const includeVirtualDisplays = options.includeVirtualDisplays === true;

  const confirmedById = new Map(
    confirmedRows
      .filter((row) => text(row?.id))
      .map((row) => [text(row.id), row]),
  );
  const displayById = new Map();
  const displays = [];

  function addDisplay(raw, fallback = null) {
    const id = text(raw?.id || fallback?.deviceId);
    if (!id || displayById.has(id)) return displayById.get(id) || null;
    if (!includeVirtualDisplays && isVirtualDisplayId(id, liveProgramId)) return null;
    const normalized = normalizeDisplay(raw, confirmedById.get(id), fallback);
    if (!normalized) return null;
    displayById.set(id, normalized);
    displays.push(normalized);
    return normalized;
  }

  for (const row of deviceRows) addDisplay(row);
  for (const row of confirmedRows) addDisplay(row);

  const wallMemberIds = new Set();
  const walls = wallRows.map((rawWall) => {
    const id = text(rawWall?.id);
    const name = text(rawWall?.name) || id || 'Unnamed wall';
    const seenMembers = new Set();
    const members = [];
    for (const rawMember of Array.isArray(rawWall?.members) ? rawWall.members : []) {
      const memberId = text(rawMember?.deviceId || rawMember?.device_id);
      if (!memberId || seenMembers.has(memberId)) continue;
      if (!includeVirtualDisplays && isVirtualDisplayId(memberId, liveProgramId)) continue;
      seenMembers.add(memberId);
      wallMemberIds.add(memberId);
      const display = displayById.get(memberId)
        || addDisplay({ id: memberId, status: 'offline' }, rawMember);
      if (!display) continue;
      const viewport = normalizeViewport(rawMember.viewport || {
        x: rawMember.canvasX ?? rawMember.canvas_x,
        y: rawMember.canvasY ?? rawMember.canvas_y,
        width: rawMember.canvasWidth ?? rawMember.canvas_width,
        height: rawMember.canvasHeight ?? rawMember.canvas_height,
      });
      members.push({
        ...display,
        wallId: id,
        gridColumn: finiteNumber(rawMember.gridColumn ?? rawMember.grid_col),
        gridRow: finiteNumber(rawMember.gridRow ?? rawMember.grid_row),
        viewport,
        rawMember,
      });
    }
    const onlineCount = members.filter((member) => member.online).length;
    const layoutMode = text(rawWall?.layoutMode || rawWall?.layout_mode) || 'single';
    const logicalDimensions = wallDimensions(rawWall, members);
    const topologyParts = [
      targetCountLabel(members.length),
      layoutMode,
      `${onlineCount}/${members.length} online`,
      formatDimensions(logicalDimensions),
    ];
    return {
      type: 'wall',
      id,
      name,
      label: name,
      layoutMode,
      layoutRevision: Number(rawWall?.layoutRevision ?? rawWall?.layout_revision) || 0,
      memberCount: members.length,
      onlineCount,
      memberIds: members.map((member) => member.id),
      members,
      dimensions: logicalDimensions,
      dimensionsLabel: formatDimensions(logicalDimensions),
      playerRect: rawWall?.playerRect || null,
      topologySummary: topologyParts.join(' · '),
      topologyLabel: [name, ...topologyParts].join(' · '),
      memberLine: memberLine(members),
      raw: rawWall,
    };
  }).filter((wall) => wall.id);

  // Current wall layouts can expose independently routable regions (for
  // example span-left plus solo-right). They are revision-bound wall children,
  // not generic device groups.
  const wallGroups = walls.flatMap((wall) => {
    const rawGroups = Array.isArray(wall.raw?.layout?.groups) ? wall.raw.layout.groups : [];
    return rawGroups.map((rawGroup) => {
      const groupId = text(rawGroup?.id);
      if (!groupId) return null;
      const rawMemberIds = Array.isArray(rawGroup.member_ids)
        ? rawGroup.member_ids
        : (Array.isArray(rawGroup.memberIds) ? rawGroup.memberIds : []);
      const requested = new Set(rawMemberIds.map(text).filter(Boolean));
      const members = wall.members.filter((member) => requested.has(member.id));
      if (!members.length) return null;
      const name = `${wall.name} · ${text(rawGroup.name) || groupId}`;
      const onlineCount = members.filter((member) => member.online).length;
      const groupLayout = text(rawGroup.layout) || 'custom';
      const groupDimensions = viewportBounds(members) || gridBounds(rawGroup, members);
      const topologyParts = [
        targetCountLabel(members.length), groupLayout,
        `${onlineCount}/${members.length} online`, formatDimensions(groupDimensions),
        `wall revision ${wall.layoutRevision}`,
      ];
      return {
        type: 'wall-group',
        id: `${wall.id}:${groupId}`,
        groupId,
        wallId: wall.id,
        name,
        label: name,
        layoutMode: groupLayout,
        layoutRevision: wall.layoutRevision,
        preset: text(wall.raw?.layout?.preset) || null,
        memberCount: members.length,
        onlineCount,
        memberIds: members.map((member) => member.id),
        members,
        dimensions: groupDimensions,
        dimensionsLabel: formatDimensions(groupDimensions),
        topologySummary: topologyParts.join(' · '),
        topologyLabel: [name, ...topologyParts].join(' · '),
        memberLine: memberLine(members),
        raw: rawGroup,
      };
    }).filter(Boolean);
  });

  const groups = groupRows.map((rawGroup) => {
    const id = text(rawGroup?.id);
    const name = text(rawGroup?.name) || id || 'Unnamed group';
    const memberIds = [...new Set(
      (Array.isArray(rawGroup?.memberIds) ? rawGroup.memberIds : rawGroup?.member_ids || [])
        .map(text)
        .filter((memberId) => memberId
          && (includeVirtualDisplays || !isVirtualDisplayId(memberId, liveProgramId))),
    )];
    const members = memberIds.map((memberId) => (
      displayById.get(memberId)
      || addDisplay({ id: memberId, status: 'offline' })
    )).filter(Boolean);
    const onlineCount = members.filter((member) => member.online).length;
    const dimensionsLabel = groupDimensionsLabel(members);
    const topologyParts = [
      targetCountLabel(members.length),
      `${onlineCount}/${members.length} online`,
      dimensionsLabel,
    ];
    return {
      type: 'group',
      id,
      name,
      label: name,
      memberCount: members.length,
      onlineCount,
      memberIds: members.map((member) => member.id),
      members,
      dimensions: null,
      dimensionsLabel,
      topologySummary: topologyParts.join(' · '),
      topologyLabel: [name, ...topologyParts].join(' · '),
      memberLine: memberLine(members),
      raw: rawGroup,
    };
  }).filter((group) => group.id);

  const standaloneDisplays = displays
    .filter((display) => !wallMemberIds.has(display.id))
    .map((display) => ({
      ...display,
      standalone: true,
      memberIds: [display.id],
      memberLine: memberLine([display]),
      topologySummary: [
        'standalone display',
        display.status,
        display.dimensionsLabel,
      ].join(' · '),
      topologyLabel: [
        display.name,
        'standalone display',
        display.status,
        display.dimensionsLabel,
      ].join(' · '),
    }));

  const physicalMembers = [];
  const seenPhysicalMembers = new Set();
  for (const wall of walls) {
    for (const member of wall.members) {
      if (seenPhysicalMembers.has(member.id)) continue;
      seenPhysicalMembers.add(member.id);
      physicalMembers.push(member);
    }
  }

  return {
    schemaVersion: Number(state.schemaVersion) || 0,
    workspaceId: text(state.workspaceId) || null,
    roomId: text(state.roomId) || null,
    revision: Number(state.revision) || 0,
    serverTimestamp: Number(state.serverTimestamp) || null,
    walls,
    wallGroups,
    groups,
    displays,
    standaloneDisplays,
    targets: [...walls, ...wallGroups, ...groups, ...standaloneDisplays],
    physicalMembers,
    physicalMemberLine: memberLine(physicalMembers),
    liveProgram,
  };
}

function parseTargetReference(target) {
  if (typeof target === 'string') {
    const separator = target.indexOf(':');
    if (separator > 0) {
      return { type: target.slice(0, separator), id: target.slice(separator + 1) };
    }
    return { type: 'display', id: target };
  }
  if (!target || typeof target !== 'object') return null;
  return {
    type: text(target.type || target.targetType || target.target_type),
    id: text(target.id || target.targetId || target.target_id),
  };
}

export function findCatalogTarget(catalog, target) {
  const reference = parseTargetReference(target);
  if (!reference?.id) return null;
  if (reference.type === 'wall') {
    return catalog?.walls?.find((candidate) => candidate.id === reference.id) || null;
  }
  if (reference.type === 'wall-group') {
    return catalog?.wallGroups?.find((candidate) => candidate.id === reference.id) || null;
  }
  if (reference.type === 'group') {
    return catalog?.groups?.find((candidate) => candidate.id === reference.id) || null;
  }
  if (reference.type === 'live-program') {
    return catalog?.liveProgram?.id === reference.id ? catalog.liveProgram : null;
  }
  return catalog?.displays?.find((candidate) => candidate.id === reference.id) || null;
}

export function expandTargetToDeviceIds(target, catalog) {
  const resolved = findCatalogTarget(catalog, target);
  if (!resolved || resolved.type === 'live-program') return [];
  if (resolved.type === 'display') return [resolved.id];
  return [...new Set(Array.isArray(resolved.memberIds) ? resolved.memberIds : [])];
}

export function expandTargetsToDeviceIds(targets, catalog) {
  const references = Array.isArray(targets) ? targets : [targets];
  const ids = [];
  const seen = new Set();
  for (const target of references) {
    for (const id of expandTargetToDeviceIds(target, catalog)) {
      if (seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}
