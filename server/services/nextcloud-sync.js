// MBFD Media Control Studio — per-user Nextcloud deck sync (server-side).
// When a user saves a presentation, we render it to .pptx and write it into THAT
// user's OWN Nextcloud Files via the box's `nextcloud-write` raw-FS microservice
// (services/nextcloud-fs.js), scoped by the owner's email header. No WebDAV, no
// shared password.
//
// TRUST BOUNDARY: the scoping email is the presentation OWNER's address, loaded
// server-side from the `users` row (`users.email` for `presentations.user_id`) —
// NEVER a client-supplied header. This is a server-initiated push to the owner's
// own tree; media-control is the trust boundary the microservice trusts.
//
// Only @miamibeachfl.gov accounts are synced (everyone else is skipped silently),
// matching the deployment's NC-account population. uidFromEmail() is used ONLY as
// that skip-guard now — the microservice does its own per-user path scoping.
//
// All failures are best-effort + recorded in nextcloud_sync_jobs; a Nextcloud
// hiccup must never break saving a presentation (syncSoon is fire-and-forget).

const config = require('../config');
const { db } = require('../db/database');
const { renderDeckToPptxBuffer } = require('./pptx');
const ncfs = require('./nextcloud-fs');

const USER_DOMAIN = 'miamibeachfl.gov';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function nc() { return config.nextcloud || {}; }
// Gate on the feature flag + the write microservice URL (the per-user transport).
// The old sharedPassword requirement is gone — WebDAV is no longer the transport.
function enabled() { const c = nc(); return !!(config.features && config.features.nextcloudSync && c.writeUrl); }

// Skip-guard ONLY: confirm the owner has an @miamibeachfl.gov address (= a NC
// account). The local-part is restricted to safe identifier chars so a crafted
// email can never smuggle anything; we no longer build WebDAV paths from it.
const UID_RE = new RegExp('^([a-z0-9._-]+)@' + USER_DOMAIN.replace(/\./g, '\\.') + '$', 'i');
function uidFromEmail(email) {
  const m = UID_RE.exec(String(email || '').trim());
  return m ? m[1].toLowerCase() : null;
}

// Filesystem-safe Nextcloud filename (preserve unicode; strip path/illegal chars).
function safeFileBase(title) {
  let s = String(title || 'Presentation').normalize('NFC').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').slice(0, 120).trim();
  return s || 'Presentation';
}

// Upsert the single tracking row per presentation. Column names are allowlisted
// (never interpolate caller-supplied keys into SQL, even though all callers here
// pass literals — defense against a future caller passing a user-controlled key).
const JOB_COLS = new Set(['nextcloud_path', 'status', 'error_msg', 'last_synced_at']);
function recordJob(pres, fields) {
  const keys = Object.keys(fields).filter((k) => JOB_COLS.has(k));
  const existing = db.prepare('SELECT id FROM nextcloud_sync_jobs WHERE presentation_id = ?').get(pres.id);
  if (existing) {
    if (!keys.length) return existing.id;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.prepare(`UPDATE nextcloud_sync_jobs SET ${sets} WHERE id = ?`).run(...keys.map((k) => fields[k]), existing.id);
    return existing.id;
  }
  const { v4: uuidv4 } = require('uuid');
  const id = uuidv4();
  db.prepare(`INSERT INTO nextcloud_sync_jobs (id, workspace_id, user_id, presentation_id, nextcloud_path, sync_direction, status, error_msg, last_synced_at)
              VALUES (?, ?, ?, ?, ?, 'push', ?, ?, ?)`)
    .run(id, pres.workspace_id, pres.user_id, pres.id, fields.nextcloud_path || '', fields.status || 'pending', fields.error_msg || null, fields.last_synced_at || null);
  return id;
}

// Sync one presentation into its OWNER's Nextcloud. Best-effort; resolves to a
// small status object and never throws (safe to call fire-and-forget).
async function syncPresentation(presId) {
  if (!enabled()) return { skipped: 'nextcloud sync disabled/unconfigured' };
  let pres;
  try {
    pres = db.prepare('SELECT id, workspace_id, user_id, title, deck_json FROM presentations WHERE id = ?').get(presId);
  } catch (e) { return { error: 'load failed: ' + e.message }; }
  if (!pres) return { error: 'presentation not found' };

  // OWNER email — loaded server-side from the users row, NEVER a client header.
  const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(pres.user_id);
  const email = owner && owner.email;
  // Skip-guard: only @miamibeachfl.gov owners have a Nextcloud account.
  if (!uidFromEmail(email)) return { skipped: 'owner has no @' + USER_DOMAIN + ' Nextcloud account' };

  let deck;
  try { deck = JSON.parse(pres.deck_json || '{}'); } catch { deck = { slides: [] }; }

  const folder = [nc().baseDir || 'MBFD Media Control', 'Presentations'];
  const relDir = folder.join('/');
  const fileBase = safeFileBase(pres.title);
  const relPath = `${relDir}/${fileBase}.pptx`;

  try {
    const buffer = await renderDeckToPptxBuffer(deck);
    await ncfs.createFolder(email, relDir);

    // If the title changed since last sync, remove the stale file.
    const prior = db.prepare('SELECT nextcloud_path FROM nextcloud_sync_jobs WHERE presentation_id = ?').get(pres.id);
    if (prior && prior.nextcloud_path && prior.nextcloud_path !== relPath) {
      try { await ncfs.deleteFile(email, prior.nextcloud_path); } catch { /* best-effort */ }
    }

    await ncfs.writeBase64(email, relPath, buffer.toString('base64'), PPTX_MIME);
    recordJob(pres, { nextcloud_path: relPath, status: 'done', error_msg: null, last_synced_at: Math.floor(Date.now() / 1000) });
    console.log(`[nc-sync] ${pres.id} -> ${email}:/${relPath} (${buffer.length} bytes)`);
    return { ok: true, email, path: relPath, bytes: buffer.length };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    try { recordJob(pres, { status: 'error', error_msg: msg }); } catch { /* */ }
    console.warn(`[nc-sync] ${pres.id} -> ${email} FAILED: ${msg}`);
    return { error: msg };
  }
}

// Fire-and-forget wrapper for route handlers (never rejects).
function syncSoon(presId) {
  if (!enabled()) return;
  setImmediate(() => { syncPresentation(presId).catch(() => {}); });
}

module.exports = { syncPresentation, syncSoon, enabled, uidFromEmail, safeFileBase };
