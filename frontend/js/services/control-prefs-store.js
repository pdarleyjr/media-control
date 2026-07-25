// control-prefs-store.js — Serialized per-user operator navigation preferences.
//
// ONE controller for all preference mutations (last focused target + pinned
// quick-tab refs). Queues mutations in order, merges them into one local
// canonical object, sends writes serially, resolves 412 conflicts by
// refetching + merging + retrying once, and surfaces save status.
//
// The server is authoritative. A scoped local cache (keyed by user+workspace+
// room+schema-version) drives fast first paint; the server reconciles. When
// the server returns null/empty, stale cache values are cleared — an
// unrelated cached target does NOT remain active indefinitely.
//
// Preference operations NEVER call player-command, broadcast, transport,
// blank, volume, or screensaver APIs. Selecting/restoring a target emits zero
// physical commands.

import { api } from '../api.js';

const SCHEMA_VERSION = 'v2';
const MAX_RETRIES = 1;

function scopedCacheKey(userId, workspaceId, roomId) {
  return `mc:control-prefs:${SCHEMA_VERSION}:${userId || 'anon'}:${workspaceId || 'none'}:${roomId || 'none'}`;
}

export function createControlPrefsStore({ userId, workspaceId, roomId, onPinsChange } = {}) {
  let canonical = { room_id: roomId, last_focused_target_ref: null, pinned_target_refs: [], revision: 0 };
  let pending = null; // { last_focused_target_ref?, pinned_target_refs? }
  let writing = false;
  let aborted = false;
  let saveStatus = 'idle'; // 'idle' | 'saving' | 'saved' | 'error'

  const cacheKey = scopedCacheKey(userId, workspaceId, roomId);

  function readCache() {
    try {
      const raw = localStorage.getItem(cacheKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch { return null; }
  }

  function writeCache(value) {
    try { localStorage.setItem(cacheKey, JSON.stringify(value)); } catch { /* ignore */ }
  }

  function clearCache() {
    try { localStorage.removeItem(cacheKey); } catch { /* ignore */ }
  }

  function setSaveStatus(status) {
    saveStatus = status;
  }

  function getSaveStatus() { return saveStatus; }

  // Queue a mutation. Only fields PRESENT in the patch are updated (PATCH
  // semantics — an omitted field is never erased).
  function mutate(patch) {
    if (aborted) return;
    pending = { ...pending, ...patch };
    flush();
  }

  // Merge the pending patch into canonical and send the write serially.
  async function flush() {
    if (writing || aborted || !pending) return;
    writing = true;
    setSaveStatus('saving');

    const patch = pending;
    pending = null;

    // Merge into canonical locally for optimistic UI.
    const optimistic = { ...canonical };
    if (patch.last_focused_target_ref !== undefined) {
      optimistic.last_focused_target_ref = patch.last_focused_target_ref;
    }
    if (patch.pinned_target_refs !== undefined) {
      optimistic.pinned_target_refs = patch.pinned_target_refs;
    }
    writeCache(optimistic);

    try {
      const saved = await api.patchControlPreferences(patch, canonical.revision);
      if (aborted) return; // unmounted during request
      canonical = { ...saved };
      writeCache(canonical);
      if (Array.isArray(canonical.pinned_target_refs) && typeof onPinsChange === 'function') {
        onPinsChange(canonical.pinned_target_refs);
      }
      setSaveStatus('saved');
    } catch (err) {
      if (aborted) return;
      if (err.status === 412) {
        // Conflict: fetch the current server representation, merge the
        // still-pending mutation, and retry once with the new revision.
        try {
          const serverPrefs = await api.getControlPreferences();
          if (aborted) return;
          canonical = { ...serverPrefs };
          // Re-apply the user's still-pending mutation on top of the server state.
          const retryPatch = {};
          if (patch.last_focused_target_ref !== undefined) {
            retryPatch.last_focused_target_ref = patch.last_focused_target_ref;
          }
          if (patch.pinned_target_refs !== undefined) {
            retryPatch.pinned_target_refs = patch.pinned_target_refs;
          }
          const retrySaved = await api.patchControlPreferences(retryPatch, canonical.revision);
          if (aborted) return;
          canonical = { ...retrySaved };
          writeCache(canonical);
          if (Array.isArray(canonical.pinned_target_refs) && typeof onPinsChange === 'function') {
            onPinsChange(canonical.pinned_target_refs);
          }
          setSaveStatus('saved');
        } catch (retryErr) {
          if (aborted) return;
          setSaveStatus('error');
          // Re-queue the pending patch so a future flush can retry.
          pending = { ...pending, ...patch };
        }
      } else {
        setSaveStatus('error');
        // Re-queue the pending patch so a future flush can retry.
        pending = { ...pending, ...patch };
      }
    } finally {
      writing = false;
      // If more mutations arrived during the write, flush again.
      if (pending && !aborted) flush();
    }
  }

  // Load preferences from the server (authoritative). Uses the scoped local
  // cache for fast first paint. Reconciles or clears stale cache values.
  async function load() {
    // 1. Read scoped local cache for fast paint.
    const cached = readCache();
    // 2. Request server preferences (authoritative).
    try {
      const serverPrefs = await api.getControlPreferences();
      if (aborted) return cached || canonical;
      canonical = { ...serverPrefs };
      // 5. Reconcile: if the server returns null/empty, clear stale cache.
      if (!serverPrefs.last_focused_target_ref && (!serverPrefs.pinned_target_refs || serverPrefs.pinned_target_refs.length === 0)) {
        clearCache();
      } else {
        writeCache(canonical);
      }
      if (Array.isArray(canonical.pinned_target_refs) && typeof onPinsChange === 'function') {
        onPinsChange(canonical.pinned_target_refs);
      }
      return canonical;
    } catch {
      // Offline or unauthenticated: fall back to cache.
      if (cached) canonical = { ...canonical, ...cached };
      return canonical;
    }
  }

  function getCanonical() { return { ...canonical }; }
  function getRevision() { return canonical.revision; }
  function getCached() { return readCache(); }

  function abort() {
    aborted = true;
    pending = null;
  }

  return {
    load,
    mutate,
    getCanonical,
    getRevision,
    getCached,
    getSaveStatus,
    abort,
  };
}
