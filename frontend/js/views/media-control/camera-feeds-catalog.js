// camera-feeds-catalog.js — the curated Miami / Miami Beach live-camera catalog
// rendered by the "Camera Feeds" source tab. PURE DATA (no logic).
//
// Each group = a collapsible folder. Each feed:
//   title : short human label (shown on the tile + used as the broadcast label)
//   url   : the remote_url put into the player <iframe> (text/html). One of:
//             • youtube-nocookie.com/embed/<id>?…  (live YouTube — chosen over
//               youtube.com/embed ON PURPOSE: the send funnel's YouTube regex does
//               NOT match the nocookie domain, so it is NOT yt-dlp-transcoded, which
//               would otherwise break a 24/7 live stream)
//             • https://media.mbfdhub.com/player/oz.html?oid=<EMB_…>&label=… (Ozolio
//               cam — the bare relay embed is host-gated and renders black on our
//               origin, so oz.html resolves the .m3u8 via /player/oz-stream and
//               plays it with hls.js)
//             • https://media.mbfdhub.com/player/hls.html?station=<key>&label=… (live-news
//               HLS — resolved/proxied server-side by /player/news-stream, played via hls.js)
//   thumb : "ozolio:<OID>" | "youtube:<ID>" | a direct https image | omitted (→ folder icon)
//   kind  : "video" (default) | "snapshot" (refreshing still — labeled on the tile)
//
// Every feed here was embeddability- AND liveness-verified (adversarial validation
// passes, 2026-06-06 + 2026-06-08). Dead / frame-blocked / embedding-disabled /
// non-live sources are DROPPED, never added — a tile that won't play is worse than
// no tile. Dropped, with reasons:
//   • Local TV news on the station WEBSITES + YouTube: ad/consent/DRM-gated and not
//     embeddable. BUT each station's free 24/7 FAST/OTT HLS feed IS playable via the
//     hls.js wrapper (see the "news" group below) — that is how the news folder works.
//   • EarthCam (News Café / Brickell Key / resort pages): proprietary HLS players
//     behind ads + consent + click-to-play (and we have no hls.js).
//   • PTZtv PortMiami / South Beach YouTube ids that are embedding-disabled by the
//     owner (playableInEmbed:false) or whose recordings have ended — e.g. GgmD8xuOqMM,
//     DxZziUUr6CY (verified embedding-disabled 2026-06-08).
//   • Ozolio /explore/ pages (MacArthur, Biscayne North): frame-blocked host pages
//     whose CID_/raw OIDs 404 from the relay (only EMB_ OIDs resolve).
//   • FDOT / FL511 traffic cams: the only public artifact is a ~60s-refresh JPEG; the
//     real DIVAS live-video HLS is token-gated (HTTP 401, no CORS) and needs special
//     FDOT DIVAS authorization, so it CANNOT be embedded as direct live HLS. The old
//     JPEG-snapshot tiles (cam.html) are therefore replaced by embeddable YouTube live
//     causeway / skyline streams that show the same Biscayne Bay corridors as full
//     continuous video (see the "skyline" group below).

// ---- feed builders (keep the catalog DRY + scannable) ----
function yt(title, id) {
  return {
    title,
    url: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&mute=1&controls=0&rel=0&playsinline=1&loop=1&playlist=${id}`,
    thumb: `youtube:${id}`,
  };
}
function oz(title, oid) {
  return {
    title,
    url: `https://media.mbfdhub.com/player/oz.html?oid=${oid}&label=${encodeURIComponent(title)}`,
    thumb: `ozolio:${oid}`,
  };
}
// Live-news channel: a whitelisted station key the player resolves server-side to
// an HLS .m3u8 and plays via hls.js (see /player/hls.html + lib/news-streams.js).
// No per-feed thumbnail (no provider poster) → falls back to the broadcast-tower
// folder icon; the label identifies the channel.
function news(title, key) {
  return {
    title,
    url: `https://media.mbfdhub.com/player/hls.html?station=${key}&label=${encodeURIComponent(title)}`,
  };
}

export const CAMERA_FEED_GROUPS = [
  {
    id: 'news',
    nameKey: 'mc.cf.group.news',
    // Each station's free 24/7 FAST/OTT HLS feed, resolved server-side and played
    // via hls.js. MBTV (the City of Miami Beach's own gov channel) leads; then
    // English, then Spanish. Commercial feeds are for internal department-display
    // situational awareness. WSVN is AES-128 + CORS-locked → resolve+proxy.
    feeds: [
      news('MBTV · Miami Beach', 'mbtv'),
      news('CBS News Miami', 'cbs'),
      news('NBC6 South Florida', 'nbc6'),
      news('Local 10 · WPLG', 'local10'),
      news('WSVN 7News', 'wsvn'),
      news('Univisión 23', 'univision23'),
      news('Telemundo 51', 'telemundo51'),
    ],
  },
  {
    id: 'skyline',
    nameKey: 'mc.cf.group.skyline',
    // Traffic / skyline / causeway corridors as continuous YouTube live video.
    // REPLACES the former FDOT/FL511 JPEG-snapshot "Traffic Cams" group: the FDOT
    // DIVAS live-video HLS is token-gated (401, no CORS) and not embeddable, so
    // these embeddable 24/7 streams of the same Biscayne Bay / causeway corridors
    // stand in (full motion, not a refreshing still).
    feeds: [
      oz('Biscayne Bay & PortMiami', 'EMB_FDVN00000417'),
      yt('MacArthur Causeway & Skyline', '4UzQd1dVPlo'),
      yt('Miami River Cam', '7wHgYc_kN98'),
    ],
  },
  {
    id: 'street',
    nameKey: 'mc.cf.group.street',
    feeds: [
      oz('Ocean Drive · South Beach', 'EMB_RANL0000044E'),
      oz('Ocean Drive · Avalon', 'EMB_DRHL00000E71'),
      oz('1st Street Beach · Ocean Rescue', 'EMB_ZUKF00000B65'),
      oz('W South Beach · 21st St', 'EMB_QHQT0000039A'),
    ],
  },
  {
    id: 'beach',
    nameKey: 'mc.cf.group.beach',
    feeds: [
      yt('ZeroEight · South Beach / Collins Ave', 'g5BS95j2rmM'),
      yt('Ocean Drive · Miami Beach', 'lVkJlng3nSs'),
      yt('Acqualina Beach Cam', 'sI7oCUe1dmo'),
      yt('Sunny Isles Beach', 'T5U_EzpjCJk'),
      yt('Sunny Isles Beach · Cam 2', 'qDQ97Gw83Xs'),
      yt('Hollywood Beach Broadwalk', 'cmkAbDUEoyA'),
      yt('Coral City Camera · Reef', '7i8ARjIeM2k'),
      oz('Newport Pier · North', 'EMB_DCCO00000F84'),
      oz('Newport Fishing Pier', 'EMB_BKDD00000F89'),
    ],
  },
  {
    id: 'marine',
    nameKey: 'mc.cf.group.marine',
    feeds: [
      yt('PortMiami Cruise Ships', 'PeYZZinH1wI'),
      yt('PortMiami Terminals', '9iV-D-KAtao'),
      yt('Biscayne Bay North Waterfront', '5YCajRjvWCg'),
    ],
  },
  {
    id: 'miami',
    nameKey: 'mc.cf.group.miami',
    // Ozolio EMB_ live cams around greater Miami / Miami Beach.
    feeds: [
      oz('Grand Hyatt · Convention Center', 'EMB_VKAD00001371'),
      oz('Little Havana · Calle Ocho', 'EMB_KQOD00000D77'),
      oz('Wynwood Walls', 'EMB_GYHT00000D7C'),
      oz('Coconut Grove', 'EMB_ZJKB000009E9'),
    ],
  },
];
