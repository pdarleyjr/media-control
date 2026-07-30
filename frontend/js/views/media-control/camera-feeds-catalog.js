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
    id: 'guest-computer',
    nameKey: 'mc.live_source.guest',
    url: `/player/live-source.html?source=guest-computer`,
    icon: 'computer',
    audio_policy: 'embedded_hdmi',
    alwaysVisible: false,
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
  }),
]);
