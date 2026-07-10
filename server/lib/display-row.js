// Pure: map one /api/displays/state DB row into its dashboard response object.
// Extracted from routes/displays.js so the mapping (notably playlist_id, which
// drives Mirror routing mode in the unified dashboard) is unit-testable without
// spinning up HTTP. Mirrors the existing inline null-handling exactly.
//
// `row` is one result of the /state SELECT (devices LEFT JOIN playlists and
// live state/telemetry lookups), with the now-playing summary already resolved
// out of band so this stays pure. The mapper only consumes the base display
// fields plus `shot_at`; extra joined columns are ignored here.
//   { id, name, status, last_heartbeat, screen_width, screen_height,
//     screen_on, playlist_id, layout_id, shot_at, ... }
// `nowPlaying` is the resolved now-playing summary (see lib/display-state.js).
// `now` is the current unix time (seconds) used for the online window.
function mapDisplayRow(row, nowPlaying, now, assetCache = null) {
  const online = row.status === 'online' && row.last_heartbeat && (now - row.last_heartbeat) < 60;
  return {
    id: row.id,
    name: row.name,
    online,
    screen_on: row.screen_on !== 0,
    width: row.screen_width || null,
    height: row.screen_height || null,
    layout_id: row.layout_id || null,
    playlist_id: row.playlist_id || null,
    now_playing: nowPlaying,
    // Token-less by design: the screenshot endpoint needs the JWT via ?token=
    // for browser <img> tags (no Authorization header). The client display-state
    // store appends &token= centrally; do NOT bake it in here.
    screenshot_url: row.shot_at ? `/api/devices/${row.id}/screenshot?t=${row.shot_at}` : null,
    screenshot_at: row.shot_at || null,
    asset_cache: assetCache || { mode: 'direct' },
  };
}

module.exports = { mapDisplayRow };
