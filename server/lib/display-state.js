// Pure: resolve a playlist published_snapshot (JSON string) into a compact
// "now playing" summary for the dashboard stage. Never throws — a display
// that can't be resolved is reported as Idle rather than crashing the grid.
//
// The REAL published_snapshot (written by playlists.js buildSnapshotItems /
// scene-engine pushSourceToDevice) is a TOP-LEVEL JSON ARRAY of item objects:
//   [{ content_id, widget_id, remote_url, zone_id, filename, mime_type,
//      filepath, duration_sec, widget_name, ... }]
// We also tolerate { items: [...] } / { assignments: [...] } wrappers defensively.
function nowPlayingFromSnapshot(snapshotJson) {
  const idle = { label: 'Idle', kind: 'idle', itemCount: 0 };
  if (!snapshotJson) return idle;
  let snap;
  try { snap = JSON.parse(snapshotJson); } catch { return idle; }
  let items = [];
  if (Array.isArray(snap)) items = snap;
  else if (snap && Array.isArray(snap.items)) items = snap.items;
  else if (snap && Array.isArray(snap.assignments)) items = snap.assignments;
  if (items.length === 0) return idle;
  if (items.length > 1) {
    return { label: `Playlist · ${items.length} items`, kind: 'playlist', itemCount: items.length };
  }
  const it = items[0] || {};
  const name = it.filename || it.name || it.widget_name || it.remote_url || 'Content';
  let kind = 'content';
  const mime = String(it.mime_type || '');
  if (mime === 'video/youtube') kind = 'youtube';
  else if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (it.widget_id) kind = 'widget';
  else if (it.remote_url) kind = 'web';
  return { label: name, kind, itemCount: 1 };
}

module.exports = { nowPlayingFromSnapshot };
