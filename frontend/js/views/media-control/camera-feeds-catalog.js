// Canonical live-source identities. Availability and signal state come from
// /api/live-sources; this file contains no independently managed camera feed.
export const LIVE_SOURCE_CATALOG = Object.freeze([
  Object.freeze({
    id: 'anpviz',
    nameKey: 'mc.live_source.anpviz',
    url: `/player/live-source.html?source=anpviz`,
    icon: 'camera',
    audio_policy: 'tonor_microphone',
    alwaysVisible: true,
  }),
  Object.freeze({
    id: 'podium-computer',
    nameKey: 'mc.live_source.podium',
    url: `/player/live-source.html?source=podium-computer`,
    icon: 'computer',
    audio_policy: 'embedded_hdmi',
    alwaysVisible: true,
  }),
  Object.freeze({
    id: 'guest-computer',
    nameKey: 'mc.live_source.guest',
    url: `/player/live-source.html?source=guest-computer`,
    icon: 'computer',
    audio_policy: 'embedded_hdmi',
    alwaysVisible: true,
  }),
]);

// Existing municipal and local-news streams are retained as media sources.
// They are deliberately separate from the managed camera inventory.
export const LIVE_NEWS_CATALOG = Object.freeze([
  ['mbtv', 'MBTV · Miami Beach'],
  ['cbs', 'CBS News Miami'],
  ['nbc6', 'NBC6 South Florida'],
  ['local10', 'Local 10 · WPLG'],
  ['wsvn', 'WSVN 7News'],
  ['univision23', 'Univisión 23'],
  ['telemundo51', 'Telemundo 51'],
].map(([station, title]) => Object.freeze({
  id: `news-${station}`,
  title,
  url: `/player/hls.html?station=${station}&label=${encodeURIComponent(title)}`,
  audio_policy: 'embedded',
})));

const newsById = new Map(LIVE_NEWS_CATALOG.map((source) => [source.id, source]));
export const LIVE_NEWS_GROUPS = Object.freeze([
  Object.freeze({
    id: 'city',
    title: 'City of Miami Beach',
    feeds: Object.freeze(['news-mbtv'].map((id) => newsById.get(id))),
  }),
  Object.freeze({
    id: 'english',
    title: 'English Local News',
    feeds: Object.freeze(['news-cbs', 'news-nbc6', 'news-local10', 'news-wsvn'].map((id) => newsById.get(id))),
  }),
  Object.freeze({
    id: 'spanish',
    title: 'Spanish Local News',
    feeds: Object.freeze(['news-univision23', 'news-telemundo51'].map((id) => newsById.get(id))),
  }),
]);

function publicWebcam(id, title) {
  return Object.freeze({
    id,
    title,
    url: `/player/external-feed.html?feed=${encodeURIComponent(id)}`,
    audio_policy: 'embedded',
  });
}

// Curated public Internet webcams are media sources, not managed classroom
// cameras. Keeping them in a separate catalog preserves the single physical
// camera invariant (Anpviz) while restoring the Miami Beach situational views.
export const MIAMI_BEACH_FEED_GROUPS = Object.freeze([
  Object.freeze({
    id: 'city-beaches',
    title: 'City Beach Conditions',
    feeds: Object.freeze([
      publicWebcam('mb-1st-street', '1st Street Beach · Ocean Rescue'),
      publicWebcam('mb-21st-street', '21st Street Beach · Ocean Rescue'),
    ]),
  }),
  Object.freeze({
    id: 'ocean-drive',
    title: 'Ocean Drive',
    feeds: Object.freeze([
      publicWebcam('mb-ocean-drive-south', 'Ocean Drive · South Beach'),
      publicWebcam('mb-ocean-drive-avalon', 'Ocean Drive · Avalon'),
    ]),
  }),
  Object.freeze({
    id: 'bay-port',
    title: 'Bay & Port',
    feeds: Object.freeze([
      publicWebcam('mb-biscayne-port', 'Biscayne Bay & PortMiami'),
    ]),
  }),
]);

export const CAMERA_FEED_GROUPS = Object.freeze([
  Object.freeze({
    id: 'live-sources',
    nameKey: 'mc.live_source.group',
    feeds: LIVE_SOURCE_CATALOG,
  }),
  Object.freeze({
    id: 'news',
    nameKey: 'mc.cf.group.news',
    feeds: LIVE_NEWS_CATALOG,
    groups: LIVE_NEWS_GROUPS,
  }),
  Object.freeze({
    id: 'miami-beach-public',
    name: 'Miami Beach Public Webcams',
    groups: MIAMI_BEACH_FEED_GROUPS,
  }),
]);
