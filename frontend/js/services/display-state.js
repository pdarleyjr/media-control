// Client store for "what is live where". Fetches GET /api/displays/state once,
// then merges live dashboard:* socket events (status / screenshot / playback)
// on top, and notifies subscribers. Re-fetches on socket reconnect so the stage
// is correct after navigation, reload, or a second operator's change.
import { api } from '../api.js';
import { on as onSocket } from '../socket.js';

let displays = new Map();          // id -> display state
const subs = new Set();
let wired = false;

function notify() { const list = [...displays.values()]; subs.forEach(cb => cb(list)); }

// The screenshot endpoint accepts the JWT via Authorization header OR ?token=.
// Browser <img src> sends neither header, so it needs ?token= in the URL
// (same convention as dashboard.js). We append it HERE, centrally, so every
// consumer (stage, inspector) can use display.screenshot_url verbatim and the
// SERVER never has to bake the token into its response.
function withToken(url) {
  if (!url) return url;
  const tok = localStorage.getItem('token') || '';
  return url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok);
}

export async function refresh() {
  const { displays: list } = await api.getDisplaysState();   // added in Task 4.1 api.js
  displays = new Map(list.map(d => [d.id, { ...d, screenshot_url: withToken(d.screenshot_url) }]));
  notify();
}

export function getAll() { return [...displays.values()]; }
export function get(id) { return displays.get(id) || null; }

export function subscribe(cb) {
  subs.add(cb);
  ensureWired();
  return () => subs.delete(cb);
}

function ensureWired() {
  if (wired) return;
  wired = true;
  onSocket('connected', () => { refresh().catch(() => {}); });
  onSocket('device-status', (d) => {
    // Only patch fields actually present — never clobber screen_on with undefined
    // when a status event doesn't carry it.
    const patch = { online: d.status === 'online' };
    if (d.screen_on !== undefined) patch.screen_on = !!d.screen_on;
    merge(d.device_id || d.id, patch);
  });
  onSocket('screenshot-ready', (d) => {
    const id = d.device_id || d.id;
    merge(id, {
      screenshot_url: withToken(`/api/devices/${id}/screenshot?t=${Date.now()}`),
      screenshot_at: Math.floor(Date.now() / 1000),
    });
  });
  onSocket('playback-progress', (d) => { merge(d.device_id || d.id, { progress: d }); });
  onSocket('wall-changed', () => { refresh().catch(() => {}); });
}

function merge(id, patch) {
  const cur = displays.get(id);
  if (!cur) return;
  displays.set(id, { ...cur, ...patch });
  notify();
}
