// Live Sources tab — one authoritative Anpviz/TONOR source plus the dynamically
// available ZowieBox Guest Computer. Both use the normal route/tap/drag contract.

import { esc } from '../../utils.js';
import { t } from '../../i18n.js';
import { api } from '../../api.js';
import { attachTileHandlers } from './toolbox.js';
import {
  LIVE_NEWS_CATALOG,
  LIVE_SOURCE_CATALOG,
  MIAMI_BEACH_FEED_GROUPS,
} from './camera-feeds-catalog.js';

const ICONS = {
  camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7h11a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"></path><path d="M15 10l6-3v10l-6-3"></path></svg>',
  computer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>',
  news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"></path><path d="M12 14v8"></path><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4"></path><path d="M5 5a9 9 0 0 0 0 14M19 5a9 9 0 0 1 0 14"></path></svg>',
};

function statusText(config, source) {
  const signal = source.signal || {};
  if (config.id === 'anpviz') {
    if (!signal.video_online) return t('mc.live_source.camera_offline');
    if (!signal.microphone_connected) return t('mc.live_source.mic_missing');
    if (!signal.audio_online) return t('mc.live_source.audio_missing');
    const inputState = signal.clipping
      ? t('mc.live_source.input_clipping')
      : signal.audio_detected
        ? t('mc.live_source.input_detected')
        : signal.silence_detected
          ? t('mc.live_source.input_quiet')
          : t('mc.live_source.input_pending');
    const level = Number.isFinite(signal.input_level_db)
      ? `${signal.input_level_db.toFixed(1)} dBFS`
      : t('mc.live_source.unknown');
    return t('mc.live_source.anpviz_ready', {
      sync: signal.synchronization_status || t('mc.live_source.unknown'),
      delay: signal.configured_delay_ms ?? 0,
      input: inputState,
      level,
    });
  }
  return t('mc.live_source.guest_ready', {
    resolution: signal.resolution || t('mc.live_source.unknown'),
    frameRate: signal.frame_rate ?? t('mc.live_source.unknown'),
    audio: signal.embedded_audio_detected
      ? t('mc.live_source.audio_yes')
      : t('mc.live_source.audio_no'),
  });
}

function tileHtml(config, source) {
  const available = source.available === true;
  const clipping = config.id === 'anpviz' && source.signal?.clipping === true;
  const label = t(config.nameKey);
  const payload = JSON.stringify({
    remote_url: config.url,
    live_source_id: config.id,
    audio_policy: config.audio_policy,
  });
  const routeAttributes = available
    ? `draggable="true" data-drag-source='${esc(payload)}'`
    : 'disabled aria-disabled="true"';
  const stateClass = `${available ? 'is-available' : 'is-unavailable'}${clipping ? ' has-clipping' : ''}`;
  const stateLabel = clipping
    ? t('mc.live_source.live_clipping')
    : available ? t('mc.live_source.live') : t('mc.live_source.unavailable');
  return `<button type="button" class="mc-tile mc-cf-tile mc-live-source-tile ${stateClass}"
    ${routeAttributes} data-label="${esc(label)}" title="${esc(label)}">
    <span class="mc-tile-icon mc-tile-icon-svg mc-cf-tile-ico" aria-hidden="true">${ICONS[config.icon]}</span>
    <span class="mc-tile-label">${esc(label)}</span>
    <span class="mc-live-source-state" data-state="${clipping ? 'clipping' : available ? 'live' : 'unavailable'}">
      <span class="mc-live-source-dot" aria-hidden="true"></span>${esc(stateLabel)}
    </span>
    <span class="mc-tile-sub">${esc(statusText(config, source))}</span>
  </button>`;
}

function newsTileHtml(source) {
  const payload = JSON.stringify({
    remote_url: source.url,
    live_source_id: source.id,
    audio_policy: source.audio_policy,
  });
  return `<button type="button" class="mc-tile mc-cf-tile mc-live-news-tile"
    draggable="true" data-drag-source='${esc(payload)}'
    data-label="${esc(source.title)}" title="${esc(source.title)}">
    <span class="mc-tile-icon mc-tile-icon-svg mc-cf-tile-ico" aria-hidden="true">${ICONS.news}</span>
    <span class="mc-tile-label">${esc(source.title)}</span>
  </button>`;
}

function publicWebcamGroupsHtml() {
  return MIAMI_BEACH_FEED_GROUPS.map((group) => `
    <section class="mc-public-feed-section" aria-labelledby="mc-public-feed-${esc(group.id)}">
      <h4 id="mc-public-feed-${esc(group.id)}">${esc(group.title)}</h4>
      <div class="mc-tile-grid mc-live-source-grid">
        ${group.feeds.map(newsTileHtml).join('')}
      </div>
    </section>`).join('');
}

function captureDisclosureState(container) {
  const state = container._feedDisclosureState instanceof Map
    ? container._feedDisclosureState
    : new Map();
  container.querySelectorAll('details[data-feed-group-id]').forEach((group) => {
    state.set(group.dataset.feedGroupId, group.open === true);
  });
  container._feedDisclosureState = state;
  return state;
}

function restoreDisclosureState(container, state) {
  container.querySelectorAll('details[data-feed-group-id]').forEach((group) => {
    const id = group.dataset.feedGroupId;
    if (state.has(id)) group.open = state.get(id) === true;
    group.addEventListener('toggle', () => {
      state.set(id, group.open === true);
    });
  });
}

/**
 * @param {HTMLElement} container
 * @param {object} opts
 */
export async function renderCameraFeedsTab(container, { selectedIds, onAfterSend, onRouteSource } = {}) {
  if (container._liveSourcesTimer) clearTimeout(container._liveSourcesTimer);
  const disclosureState = captureDisclosureState(container);
  try {
    const response = await api.liveSources.list();
    const byId = new Map((response.sources || []).map((source) => [source.id, source]));
    const visible = LIVE_SOURCE_CATALOG
      .map((config) => ({ config, source: byId.get(config.id) || { id: config.id, available: false, signal: {} } }))
      .filter(({ config, source }) => config.alwaysVisible || source.available === true);

    container.innerHTML = `
      <div class="mc-live-source-heading">
        <strong>${esc(t('mc.live_source.group'))}</strong>
        <span>${esc(t('mc.live_source.hint'))}</span>
      </div>
      <div class="mc-tile-grid mc-live-source-grid">
        ${visible.map(({ config, source }) => tileHtml(config, source)).join('')}
      </div>
      <details class="mc-live-news-group" data-feed-group-id="news">
        <summary>
          <span class="mc-live-news-icon" aria-hidden="true">${ICONS.news}</span>
          <strong>${esc(t('mc.cf.group.news'))}</strong>
          <span>${LIVE_NEWS_CATALOG.length}</span>
        </summary>
        <div class="mc-tile-grid mc-live-source-grid">
          ${LIVE_NEWS_CATALOG.map(newsTileHtml).join('')}
        </div>
      </details>
      <details class="mc-live-news-group mc-public-webcams-group" data-feed-group-id="miami-beach">
        <summary>
          <span class="mc-live-news-icon" aria-hidden="true">${ICONS.camera}</span>
          <strong>Miami Beach Public Webcams</strong>
          <span>${MIAMI_BEACH_FEED_GROUPS.reduce((count, group) => count + group.feeds.length, 0)}</span>
        </summary>
        <div class="mc-public-feed-groups">
          ${publicWebcamGroupsHtml()}
        </div>
      </details>
      ${response.edge_available ? '' : `<div class="mc-tb-state mc-tb-error" role="status">${esc(t('mc.live_source.edge_unavailable'))}</div>`}`;
    restoreDisclosureState(container, disclosureState);
    attachTileHandlers(container, selectedIds, onAfterSend, onRouteSource);
  } catch (_error) {
    container.innerHTML = `<div class="mc-tb-state mc-tb-error" role="alert">${esc(t('mc.live_source.load_failed'))}</div>`;
  }

  container._liveSourcesTimer = setTimeout(() => {
    if (container.isConnected) {
      renderCameraFeedsTab(container, { selectedIds, onAfterSend, onRouteSource });
    }
  }, 5_000);
}
