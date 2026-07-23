// Client projection for "what is live where". The authoritative room snapshot
// owns full-state reconciliation; high-frequency device events remain additive
// optimizations between monotonic room revisions.
import { api } from '../api.js';
import { on as onSocket, roomState } from '../socket.js';
import { projectRoomDisplays } from './room-display-projection.js';

let displays = new Map();          // id -> display state
const subs = new Set();
let wired = false;
let notifyScheduled = false;

function notify() {
  if (notifyScheduled) return;
  notifyScheduled = true;
  const run = () => {
    notifyScheduled = false;
    const list = [...displays.values()];
    subs.forEach(cb => cb(list));
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, 0);
}

// Screenshots must be loaded via authenticated fetch (Authorization header),
// NOT via ?token= in the URL which exposes the JWT in browser history, access
// logs, and Referer headers. We fetch the blob and create a blob: URL that the
// <img> can use safely.
const blobUrlCache = new Map();

export async function secureScreenshotUrl(baseUrl) {
  if (!baseUrl) return null;
  if (baseUrl.startsWith('blob:') || baseUrl.startsWith('data:')) return baseUrl;
  if (blobUrlCache.has(baseUrl)) return blobUrlCache.get(baseUrl);
  const token = localStorage.getItem('token');
  try {
    const res = await fetch(baseUrl, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'same-origin',
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const prev = blobUrlCache.get(baseUrl);
    if (prev) URL.revokeObjectURL(prev);
    blobUrlCache.set(baseUrl, url);
    return url;
  } catch {
    return null;
  }
}

// Keep withToken for backward-compat but it no longer puts JWT in URL.
// Instead it strips any existing token param and relies on the secure fetch.
function withToken(url) {
  if (!url) return url;
  // Strip any existing token= param — never expose JWT in URL.
  return url.replace(/[?&]token=[^&]*/g, '').replace(/[?&]$/, '');
}

export async function refresh() {
  const { displays: list } = await api.getDisplaysState();   // added in Task 4.1 api.js
  displays = new Map(list.map(d => [d.id, { ...d, screenshot_url: withToken(d.screenshot_url) }]));
  notify();
}

export function getAll() { return [...displays.values()]; }
export function get(id) { return displays.get(id) || null; }

function hydrateRoomSnapshot(snapshot) {
  const projected = projectRoomDisplays(snapshot, displays, {
    screenshotUrlForId: (id) => withToken(`/api/devices/${encodeURIComponent(id)}/screenshot`),
  });
  if (!projected) return;
  displays = projected;
  notify();
}

export function subscribe(cb) {
  subs.add(cb);
  ensureWired();
  return () => subs.delete(cb);
}

function ensureWired() {
  if (wired) return;
  wired = true;
  onSocket('room-snapshot', hydrateRoomSnapshot);
  roomState.subscribe(hydrateRoomSnapshot);
  if (roomState.getSnapshot()) hydrateRoomSnapshot(roomState.getSnapshot());
  onSocket('device-status', (d) => {
    // Only patch fields actually present — never clobber screen_on with undefined
    // when a status event doesn't carry it.
    const patch = { online: d.status === 'online' };
    if (d.screen_on !== undefined) patch.screen_on = !!d.screen_on;
    if (d.telemetry && typeof d.telemetry === 'object') {
      patch.telemetry = { ...d.telemetry };
    }
    merge(d.device_id || d.id, patch);
  });
  onSocket('screenshot-ready', (d) => {
    const id = d.device_id || d.id;
    merge(id, {
      screenshot_url: withToken(`/api/devices/${id}/screenshot?t=${Date.now()}`),
      screenshot_at: Math.floor(Date.now() / 1000),
    });
  });
  // playback-progress: fired when a new item begins playing (play_start event).
  // Contains content_name and content_id — use to update the now_playing label
  // live so stage cards reflect the current item after a Next/Prev/Restart
  // transport command without waiting for the next full REST refresh.
  // IMPORTANT: do NOT override `kind` here. kind is derived from the playlist
  // snapshot (mime_type → kind mapping in display-state.js server lib) and must
  // not be reset to 'content' by a live event — that erases 'grid'/'web' and
  // triggers a stageSignature change → paintStage → no liveEmbed → blank card.
  onSocket('playback-progress', (d) => {
    const id = d.device_id || d.id;
    const cur = displays.get(id);
    if (!cur) return;
    const npPatch = { ...(cur.now_playing || {}) };
    if (d.content_name) npPatch.label = d.content_name;
    if (d.content_id) {
      npPatch.contentId = d.content_id;
      npPatch.content_id = d.content_id;
    }
    // Preserve existing kind — never override it with a generic fallback.
    // Do not force paused=false when the operator just paused (now_playing.paused
    // already true) and this progress event is only a content-label refresh.
    if (cur.now_playing && cur.now_playing.paused === true && d.paused !== false && !d.force_playing) {
      npPatch.paused = true;
    } else {
      npPatch.paused = false;
    }
    merge(id, { progress: d, now_playing: npPatch }, true);
    scheduleProgressNotify();
  });
  // playback-state: fired by the player on HTML5 video play/pause events.
  // Use to reflect real-time pause state in the transport bar so the operator
  // can tell whether the display is currently playing or paused, and the
  // Play/Pause button label stays correct ("Play" when paused, "Pause" when
  // playing).
  onSocket('playback-state', (d) => {
    const id = d.device_id || d.id;
    const cur = displays.get(id);
    if (!cur) return;
    const npPatch = { ...(cur.now_playing || {}), paused: !!d.paused };
    if (d.content_id) {
      npPatch.contentId = d.content_id;
      npPatch.content_id = d.content_id;
    }
    merge(id, { now_playing: npPatch });
  });
  onSocket('state-sync', (d) => {
    const id = d && (d.target_id || d.device_id || d.id);
    if (!id) return;
    const cur = displays.get(id);
    if (!cur) return;
    const state = d.state && typeof d.state === 'object' ? d.state : d;
    const npPatch = { ...(cur.now_playing || {}) };
    if (state.current_content_id) {
      npPatch.contentId = state.current_content_id;
      npPatch.content_id = state.current_content_id;
    }
    if (state.media_title) npPatch.label = state.media_title;
    if (state.content_type) npPatch.kind = state.content_type;
    if (state.paused !== undefined) npPatch.paused = !!state.paused;
    if (state.slide_index != null) npPatch.slideIndex = state.slide_index;
    if (state.slide_count != null) npPatch.slideCount = state.slide_count;
    else if (state.slide_total != null) npPatch.slideCount = state.slide_total;
    merge(id, { ...state, now_playing: npPatch });
  });
  // Pairing can happen from either the legacy Displays page or Command Center.
  // The server emits this after /api/provision/pair; refresh immediately so the
  // newly claimed display appears without relying on a manual reload.
}

function merge(id, patch, silent) {
  const cur = displays.get(id);
  if (!cur) return;
  displays.set(id, { ...cur, ...patch });
  if (!silent) notify();
}

// High-frequency playback-progress events can fire many times per second per
// display (every video timeupdate that crosses a reporting boundary). Each one
// used to call notify() synchronously, which re-renders every stage subscriber
// and starves the main thread on a busy wall. Coalesce them: patch the store
// silently, then notify at most once per second.
let _progressNotifyTimer = null;
function scheduleProgressNotify() {
  if (_progressNotifyTimer) clearTimeout(_progressNotifyTimer);
  _progressNotifyTimer = setTimeout(() => { _progressNotifyTimer = null; notify(); }, 1000);
}
