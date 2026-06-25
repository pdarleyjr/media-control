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
  const remote = String(it.remote_url || '');
  if (mime === 'video/youtube') kind = 'youtube';
  else if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (mime === 'application/pdf') kind = 'pdf';
  else if (/msword|ms-excel|ms-powerpoint|officedocument\.(?:wordprocessing|spreadsheet|presentation)ml|oasis\.opendocument/.test(mime)) kind = 'document';
  else if (it.widget_id) kind = 'widget';
  else if (remote) {
    // Multiview grid → 'grid' so live-preview renders a CSS mosaic thumbnail
    if (/\/player\/grid\.html/i.test(remote)) kind = 'grid';
    // Live streams and camera pages → 'web' so live-preview shows a LIVE badge.
    // These are never rendered as site.html/Chromium screenshots.
    else if (/\/player\/(?:hls|oz|cam|classroom-camera)\.html/i.test(remote)) kind = 'web';
    else kind = 'web';
  }
  // contentId lets the stage attach the content's poster thumbnail for content
  // whose live screenshot is useless (un-capturable video / deck / web iframes).
  // remoteUrl is passed through so live-preview.js can embed our own /player/*
  // pages directly as live iframes without going through site.html/site-shot.
  const result = { label: name, kind, itemCount: 1, contentId: it.content_id || null };
  if (remote) result.remoteUrl = remote;
  return result;
}

module.exports = { nowPlayingFromSnapshot };
