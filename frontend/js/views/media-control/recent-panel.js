// recent-panel.js — the right-rail "Recent" panel for the unified Media Control
// dashboard. Folds the two Studio Home recent panels into one stacked card:
//
//   (A) Recent presentations — the 4 newest decks, each a link to #/presentations,
//       with a "View all" link in the section head and a composed empty state
//       that points at #/ai-deck.
//   (B) Recent activity — up to 6 read-only lines from the workspace activity
//       trail, each with the action text and a relative timestamp.
//
// Read-only by design: this panel never broadcasts or mutates, so it imports no
// send funnel. Both sections load via Promise.allSettled so one failing endpoint
// can't blank the whole panel — each section renders its own empty/error state.

import { esc } from '../../utils.js';
import { t, tn } from '../../i18n.js';
import { api } from '../../api.js';

// ---- composed state blocks (icon + message — never a bare sentence) ----
// Mirrors toolbox.js's loadingState/emptyState/errorState shape.
const ICON_DECK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"></rect><path d="M8 21h8M12 17v4"></path></svg>';
const ICON_ACTIVITY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12h4l2 6 4-14 2 8h6"></path></svg>';
const ICON_ERROR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5M12 16h.01"></path></svg>';

function loadingState(msg) {
  return `<div class="mc-recent-state mc-recent-loading"><span class="mc-recent-spin" aria-hidden="true"></span><span>${esc(msg)}</span></div>`;
}
function emptyState(icon, msg, ctaHtml = '') {
  return `<div class="mc-recent-state mc-recent-empty"><span class="mc-recent-state-ico" aria-hidden="true">${icon}</span><span>${esc(msg)}</span>${ctaHtml}</div>`;
}
function errorState(msg) {
  return `<div class="mc-recent-state mc-recent-error" role="alert"><span class="mc-recent-state-ico" aria-hidden="true">${ICON_ERROR}</span><span>${esc(msg)}</span></div>`;
}

/**
 * Render a unix-seconds OR ISO-8601 timestamp as a short relative label.
 * Defensive about the input type: a finite number is treated as unix seconds
 * (the activity trail's native format), anything else is parsed as a date
 * string. Returns '' when the value can't be understood so callers can omit it.
 *
 * @param {number|string} value  unix seconds or an ISO/date string
 * @returns {string}             localized relative time, or '' if unparseable
 */
function relativeTime(value) {
  if (value == null || value === '') return '';
  let ms;
  if (typeof value === 'number' && Number.isFinite(value)) {
    ms = value * 1000;
  } else {
    const parsed = Date.parse(String(value));
    if (Number.isNaN(parsed)) return '';
    ms = parsed;
  }
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return t('mc.recent.just_now');
  if (seconds < 60) return t('mc.recent.just_now');
  if (seconds < 3600) return tn('mc.recent.mins_ago', Math.floor(seconds / 60), { n: Math.floor(seconds / 60) });
  if (seconds < 86400) return tn('mc.recent.hours_ago', Math.floor(seconds / 3600), { n: Math.floor(seconds / 3600) });
  return tn('mc.recent.days_ago', Math.floor(seconds / 86400), { n: Math.floor(seconds / 86400) });
}

// Pull a timestamp off an activity row regardless of which field name the
// server used (created_at / timestamp / ts), preserving its original type.
function rowTimestamp(row) {
  if (!row || typeof row !== 'object') return null;
  if (row.created_at != null) return row.created_at;
  if (row.timestamp != null) return row.timestamp;
  if (row.ts != null) return row.ts;
  return null;
}

// Best-effort human action text for an activity row. The trail stores a raw
// `action` (e.g. "POST /api/content"); we surface whatever readable field the
// server provides, falling back to a generic label so a row is never blank.
function rowAction(row) {
  if (!row || typeof row !== 'object') return t('mc.recent.activity_action_fallback');
  return row.action || row.action_type || row.description || row.message || t('mc.recent.activity_action_fallback');
}

// ---- section (A): Recent presentations ----

function renderDecksSection(result) {
  let items = Array.isArray(result)
    ? result
    : (result && Array.isArray(result.presentations) ? result.presentations : []);

  const head = `
    <div class="mc-recent-head">
      <span class="mc-recent-title">${esc(t('mc.recent.decks_title'))}</span>
      <a class="mc-recent-link" href="#/presentations">${esc(t('mc.recent.view_all'))}</a>
    </div>`;

  if (items.length === 0) {
    const cta = `<a class="mc-recent-link" href="#/ai-deck">${esc(t('mc.recent.decks_cta'))}</a>`;
    return `<section class="mc-recent-section">${head}${emptyState(ICON_DECK, t('mc.recent.decks_empty'), cta)}</section>`;
  }

  const rows = items.slice(0, 4).map((deck) => {
    const title = deck && deck.title ? deck.title : t('mc.recent.deck_fallback');
    return `<a class="mc-recent-row" href="#/presentations">
      <span class="mc-recent-action">${esc(title)}</span>
    </a>`;
  }).join('');

  return `<section class="mc-recent-section">${head}<div class="mc-recent-list">${rows}</div></section>`;
}

// ---- section (B): Recent activity ----

function renderActivitySection(result) {
  let items = Array.isArray(result)
    ? result
    : (result && Array.isArray(result.activity) ? result.activity : []);

  const head = `
    <div class="mc-recent-head">
      <span class="mc-recent-title">${esc(t('mc.recent.activity_title'))}</span>
    </div>`;

  if (items.length === 0) {
    return `<section class="mc-recent-section">${head}${emptyState(ICON_ACTIVITY, t('mc.recent.activity_empty'))}</section>`;
  }

  const rows = items.slice(0, 6).map((row) => {
    const rel = relativeTime(rowTimestamp(row));
    const time = rel ? `<span class="mc-recent-time">${esc(rel)}</span>` : '';
    return `<div class="mc-recent-row">
      <span class="mc-recent-action">${esc(rowAction(row))}</span>
      ${time}
    </div>`;
  }).join('');

  return `<section class="mc-recent-section">${head}<div class="mc-recent-list">${rows}</div></section>`;
}

/**
 * Render the right-rail "Recent" panel into `container`. Safe to call
 * repeatedly — each call replaces container.innerHTML. Fetches decks and
 * activity in parallel via Promise.allSettled so a single failing endpoint
 * degrades only its own section instead of blanking the panel.
 *
 * @param {HTMLElement} container
 * @returns {Promise<void>}
 */
export async function renderRecentPanel(container) {
  if (!container) return;

  // Composed loading state first (never a bare spinner or blank).
  container.innerHTML = `<div class="mc-recent">${loadingState(t('mc.recent.loading'))}</div>`;

  const [decksOutcome, activityOutcome] = await Promise.allSettled([
    api.presentations.list(),
    api.getActivity(8),
  ]);

  const decksHtml = decksOutcome.status === 'fulfilled'
    ? renderDecksSection(decksOutcome.value)
    : `<section class="mc-recent-section">
        <div class="mc-recent-head">
          <span class="mc-recent-title">${esc(t('mc.recent.decks_title'))}</span>
          <a class="mc-recent-link" href="#/presentations">${esc(t('mc.recent.view_all'))}</a>
        </div>
        ${errorState(t('mc.recent.decks_error'))}
      </section>`;

  const activityHtml = activityOutcome.status === 'fulfilled'
    ? renderActivitySection(activityOutcome.value)
    : `<section class="mc-recent-section">
        <div class="mc-recent-head">
          <span class="mc-recent-title">${esc(t('mc.recent.activity_title'))}</span>
        </div>
        ${errorState(t('mc.recent.activity_error'))}
      </section>`;

  container.innerHTML = `<div class="mc-recent">${decksHtml}${activityHtml}</div>`;
}
