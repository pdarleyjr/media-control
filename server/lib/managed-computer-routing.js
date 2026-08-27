'use strict';

// Canonical managed-computer URL recognition and the shared routing fence.
// This is deliberately independent of UI visibility: every sender and every
// device-payload reconstruction uses this same gate.

const { db } = require('../db/database');
const { isAppOwnedRelativeUrl } = require('./ssrf-policy');
const { managedLiveSourceHealth } = require('./managed-live-source-health');

const MANAGED_COMPUTER_SOURCE_IDS = new Set(['podium-computer', 'guest-computer']);
const MANAGED_COMPUTER_HEALTH_MAX_AGE_SECONDS = 60;
const CANONICAL_MANAGED_PLAYER_ORIGINS = new Set([
  'https://media.mbfdhub.com',
  'https://media-control.mbfdhub.com',
]);

function canonicalManagedPlayerUrl(remoteUrl) {
  if (isAppOwnedRelativeUrl(remoteUrl)) {
    try { return new URL(String(remoteUrl), 'http://media-control.local'); } catch { return null; }
  }
  if (typeof remoteUrl !== 'string' || !/^https:\/\//i.test(remoteUrl)) return null;
  try {
    const parsed = new URL(remoteUrl);
    return !parsed.username
      && !parsed.password
      && CANONICAL_MANAGED_PLAYER_ORIGINS.has(parsed.origin)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function decodeMultiviewGridCells(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const cells = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return cells && typeof cells === 'object' && !Array.isArray(cells) ? cells : null;
  } catch {
    return null;
  }
}

function managedComputerSourceIds(remoteUrl, allowGrid = true) {
  const parsed = canonicalManagedPlayerUrl(remoteUrl);
  if (!parsed) return [];
  try {
    const sourceId = parsed.searchParams.get('source');
    if (parsed.pathname === '/player/live-source.html') {
      return MANAGED_COMPUTER_SOURCE_IDS.has(sourceId) ? [sourceId] : [];
    }
    if (!allowGrid || parsed.pathname !== '/player/grid.html') return [];
    const cells = decodeMultiviewGridCells(parsed.searchParams.get('cells'));
    if (!cells) return [];
    const ids = new Set();
    for (const cell of Object.values(cells)) {
      if (!cell || typeof cell !== 'object' || Array.isArray(cell)) continue;
      for (const nestedSourceId of managedComputerSourceIds(cell.u, false)) ids.add(nestedSourceId);
    }
    return [...ids];
  } catch {
    return [];
  }
}

function potentialManagedPlayerUrl(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl) return null;
  if (!remoteUrl.startsWith('/') && !/^https?:\/\//i.test(remoteUrl)) return null;
  try { return new URL(remoteUrl, 'http://media-control.local'); } catch { return null; }
}

// This recognizes a managed URL shape without granting it canonical status.
// A foreign host must not impersonate an app-owned computer player.
function potentialManagedComputerSourceIds(remoteUrl, allowGrid = true) {
  const parsed = potentialManagedPlayerUrl(remoteUrl);
  if (!parsed) return [];
  const sourceId = parsed.searchParams.get('source');
  if (parsed.pathname === '/player/live-source.html') {
    return MANAGED_COMPUTER_SOURCE_IDS.has(sourceId) ? [sourceId] : [];
  }
  if (!allowGrid || parsed.pathname !== '/player/grid.html') return [];
  const cells = decodeMultiviewGridCells(parsed.searchParams.get('cells'));
  if (!cells) return [];
  const ids = new Set();
  for (const cell of Object.values(cells)) {
    if (!cell || typeof cell !== 'object' || Array.isArray(cell)) continue;
    for (const nestedSourceId of potentialManagedComputerSourceIds(cell.u, false)) ids.add(nestedSourceId);
  }
  return [...ids];
}

function nonCanonicalManagedComputerSourceId(remoteUrl) {
  const canonical = new Set(managedComputerSourceIds(remoteUrl));
  return potentialManagedComputerSourceIds(remoteUrl)
    .find((sourceId) => !canonical.has(sourceId)) || null;
}

function unavailableManagedComputerSourceId(remoteUrl, {
  database = db,
  healthProvider = managedLiveSourceHealth,
  nowSeconds = Math.floor(Date.now() / 1000),
} = {}) {
  const snapshot = healthProvider && typeof healthProvider.getSnapshot === 'function'
    ? healthProvider.getSnapshot()
    : null;
  const useSnapshot = snapshot
    && ((typeof healthProvider.hasAuthoritativeSnapshot === 'function' && healthProvider.hasAuthoritativeSnapshot())
      || snapshot.observedAt);
  const failClosedBeforeInitialPoll = healthProvider
    && typeof healthProvider.isRunning === 'function'
    && healthProvider.isRunning()
    && !useSnapshot;

  for (const sourceId of managedComputerSourceIds(remoteUrl)) {
    if (failClosedBeforeInitialPoll) return sourceId;
    const source = database.prepare(`
      SELECT enabled, availability, last_seen_at
      FROM live_sources
      WHERE id = ?
    `).get(sourceId);
    const freshEnough = Number.isFinite(Number(source?.last_seen_at))
      && Number(source.last_seen_at) >= nowSeconds - MANAGED_COMPUTER_HEALTH_MAX_AGE_SECONDS;
    if (useSnapshot) {
      if (!(source?.enabled === 1 && source.availability === 'available' && freshEnough
        && snapshot.sources?.[sourceId]?.available === true)) return sourceId;
      continue;
    }
    if (!(source?.enabled === 1 && source.availability === 'available' && freshEnough)) return sourceId;
  }
  return null;
}

function routeFailure(code, sourceId) {
  if (code === 'MANAGED_COMPUTER_SOURCE_NONCANONICAL') {
    return {
      code,
      sourceId,
      message: `Managed computer player URL is not a canonical app URL: ${sourceId}`,
    };
  }
  return {
    code: 'MANAGED_COMPUTER_SOURCE_UNAVAILABLE',
    sourceId,
    message: `Managed computer source is unavailable: ${sourceId}`,
  };
}

function managedComputerRouteFailureDetail(remoteUrl, options = {}) {
  const nonCanonicalSource = nonCanonicalManagedComputerSourceId(remoteUrl);
  if (nonCanonicalSource) return routeFailure('MANAGED_COMPUTER_SOURCE_NONCANONICAL', nonCanonicalSource);
  const unavailableSource = unavailableManagedComputerSourceId(remoteUrl, options);
  return unavailableSource ? routeFailure('MANAGED_COMPUTER_SOURCE_UNAVAILABLE', unavailableSource) : null;
}

function managedComputerRouteFailure(remoteUrl, options = {}) {
  return managedComputerRouteFailureDetail(remoteUrl, options)?.message || null;
}

function managedComputerRouteFailureInContentIds(contentIds, options = {}) {
  const database = options.database || db;
  const findContent = database.prepare('SELECT remote_url FROM content WHERE id = ?');
  for (const contentId of contentIds || []) {
    const failure = managedComputerRouteFailure(findContent.get(contentId)?.remote_url, { ...options, database });
    if (failure) return failure;
  }
  return null;
}

function managedComputerRouteFailureInPlaylistItems(items, options = {}) {
  return managedComputerRouteFailureDetailInPlaylistItems(items, options)?.message || null;
}

function managedComputerRouteFailureDetailInPlaylistItems(items, options = {}) {
  for (const item of items || []) {
    const failure = managedComputerRouteFailureDetail(item?.remote_url, options);
    if (failure) return failure;
  }
  return null;
}

function managedComputerPlaylistDeliveryFailure(playlistId, options = {}) {
  return managedComputerPlaylistDeliveryFailureDetail(playlistId, options)?.message || null;
}

function managedComputerPlaylistDeliveryFailureDetail(playlistId, options = {}) {
  const database = options.database || db;
  const row = database.prepare('SELECT published_snapshot FROM playlists WHERE id = ?').get(playlistId);
  if (!row?.published_snapshot) return null;
  try {
    const items = JSON.parse(row.published_snapshot);
    return managedComputerRouteFailureDetailInPlaylistItems(Array.isArray(items) ? items : [], { ...options, database });
  } catch {
    return null;
  }
}

function isManagedComputerPlayerUrl(remoteUrl) {
  return managedComputerSourceIds(remoteUrl, false).length > 0;
}

module.exports = {
  MANAGED_COMPUTER_HEALTH_MAX_AGE_SECONDS,
  canonicalManagedPlayerUrl,
  decodeMultiviewGridCells,
  managedComputerSourceIds,
  potentialManagedComputerSourceIds,
  nonCanonicalManagedComputerSourceId,
  unavailableManagedComputerSourceId,
  managedComputerRouteFailureDetail,
  managedComputerRouteFailure,
  managedComputerRouteFailureInContentIds,
  managedComputerRouteFailureInPlaylistItems,
  managedComputerRouteFailureDetailInPlaylistItems,
  managedComputerPlaylistDeliveryFailure,
  managedComputerPlaylistDeliveryFailureDetail,
  isManagedComputerPlayerUrl,
};
