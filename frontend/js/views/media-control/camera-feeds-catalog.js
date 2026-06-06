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
//             • https://media.mbfdhub.com/player/cam.html?id=<fl511 id>&label=… (FDOT snapshot)
//   thumb : "ozolio:<OID>" | "youtube:<ID>" | a direct https image | omitted (→ folder icon)
//   kind  : "video" (default) | "snapshot" (refreshing still — labeled on the tile)
//
// Every feed here was embeddability- AND liveness-verified (adversarial validation
// pass, 2026-06-06). Dead / frame-blocked / embedding-disabled / non-live sources
// from the original list were DROPPED, never added — a tile that won't play is
// worse than no tile. Dropped, with reasons:
//   • Local TV news (CBS4/NBC6/Local10/WSVN/Univision23/Telemundo51): no station
//     runs a stable, embeddable, 24/7 YouTube LIVE id; their web players are
//     ad/cookie-consent/DRM-gated and don't muted-autoplay in a bare iframe.
//   • EarthCam (News Café / Brickell Key / resort pages): proprietary HLS players
//     behind ads + consent + click-to-play (and we have no hls.js).
//   • PTZtv PortMiami / South Beach YouTube ids: embedding disabled by the owner
//     (playableInEmbed:false) or the recordings have ended.
//   • Ozolio /explore/ pages (MacArthur, Biscayne North): frame-blocked host pages
//     whose CID_/raw OIDs 404 from the relay (only EMB_ OIDs resolve).

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
function fdot(title, id) {
  return {
    title,
    url: `https://media.mbfdhub.com/player/cam.html?id=${id}&label=${encodeURIComponent(title)}`,
    thumb: `https://fl511.com/map/Cctv/${id}`,
    kind: 'snapshot',
  };
}

export const CAMERA_FEED_GROUPS = [
  {
    id: 'news',
    nameKey: 'mc.cf.group.news',
    // Intentionally empty: no Miami station exposes a stable embeddable 24/7 live
    // stream (see header). Folder is hidden while empty. Left here so the category
    // is documented if a station ever publishes a persistent YouTube-Live id.
    feeds: [],
  },
  {
    id: 'causeway',
    nameKey: 'mc.cf.group.causeway',
    feeds: [
      oz('Biscayne Bay & PortMiami', 'EMB_FDVN00000417'),
      yt('MacArthur Causeway & Skyline', '4UzQd1dVPlo'),
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
      yt('Acqualina Beach Cam', 'sI7oCUe1dmo'),
      yt('Sunny Isles Beach', 'T5U_EzpjCJk'),
      oz('Newport Pier · North', 'EMB_DCCO00000F84'),
      oz('Newport Fishing Pier', 'EMB_BKDD00000F89'),
    ],
  },
  {
    id: 'traffic',
    nameKey: 'mc.cf.group.traffic',
    feeds: [
      // FDOT District 6 / FL511 publishes these causeway + Port cameras only as a
      // ~60s-refresh JPEG (the DIVAS video stream is auth-walled). cam.html reloads
      // the still so the display shows a live-updating image, not a frozen frame.
      fdot('MacArthur Cswy · Alton Rd', 470),
      fdot('MacArthur Cswy · Watson Is.', 604),
      fdot('MacArthur Cswy · Bridge Rd', 409),
      fdot('Julia Tuttle Cswy · Alton Rd', 408),
      fdot('Julia Tuttle Cswy · I-95', 566),
      fdot('Port of Miami · Port Blvd', 425),
    ],
  },
  {
    id: 'earthcam',
    nameKey: 'mc.cf.group.earthcam',
    // Intentionally empty: every EarthCam page is HLS + ad/consent-gated (see
    // header). The one resolvable Sunny Isles view lives in "Beaches" instead.
    feeds: [],
  },
];
