// Pure: resolve a playlist published_snapshot (JSON string) into a compact
// "now playing" summary for the dashboard stage. Never throws — a display
// that can't be resolved is reported as Idle rather than crashing the grid.
function nowPlayingFromSnapshot(snapshotJson) {
  const idle = { label: 'Idle', kind: 'idle', itemCount: 0 };
  if (!snapshotJson) return idle;
  let snap;
  try { snap = JSON.parse(snapshotJson); } catch { return idle; }
  const items = Array.isArray(snap && snap.items) ? snap.items : [];
  if (items.length === 0) return idle;
  if (items.length > 1) {
    return { label: `Playlist · ${items.length} items`, kind: 'playlist', itemCount: items.length };
  }
  const it = items[0];
  const name = it.filename || it.name || it.remote_url || 'Content';
  let kind = 'content';
  const mime = String(it.mime_type || '');
  if (mime === 'video/youtube') kind = 'youtube';
  else if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (it.remote_url) kind = 'web';
  return { label: name, kind, itemCount: 1 };
}

module.exports = { nowPlayingFromSnapshot };
