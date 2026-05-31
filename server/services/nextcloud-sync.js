// MBFD Media Control Studio — per-user Nextcloud deck sync (server-side).
// When a user saves a presentation, we render it to .pptx and PUT it into THAT
// user's OWN Nextcloud Files over the internal origin (no Cloudflare Access).
//
// Auth model (per the deployment): every NC user logs in with their work email
// and a shared password; the NC user id (uid) is the email's local-part. So a
// Media Control user with email <uid>@miamibeachfl.gov maps to NC uid <uid>, and
// we authenticate to WebDAV as <uid>:<shared-password>. Only @miamibeachfl.gov
// accounts are synced; everyone else is skipped silently. The shared password
// lives in the box .env (NEXTCLOUD_SHARED_PASSWORD), never in the repo.
//
// All failures are best-effort + recorded in nextcloud_sync_jobs; a Nextcloud
// hiccup must never break saving a presentation.

const config = require('../config');
const { db } = require('../db/database');
const { renderDeckToPptxBuffer } = require('./pptx');

const USER_DOMAIN = 'miamibeachfl.gov';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

function nc() { return config.nextcloud || {}; }
function enabled() { const c = nc(); return !!(config.features && config.features.nextcloudSync && c.url && c.sharedPassword); }

// Local-part restricted to safe identifier chars (no '/', ':', whitespace) so a
// crafted email can never inject a WebDAV path segment or a Basic-auth separator.
const UID_RE = new RegExp('^([a-z0-9._-]+)@' + USER_DOMAIN.replace(/\./g, '\\.') + '$', 'i');
function uidFromEmail(email) {
  const m = UID_RE.exec(String(email || '').trim());
  return m ? m[1].toLowerCase() : null;
}
function authHeader(uid) { return 'Basic ' + Buffer.from(`${uid}:${nc().sharedPassword}`).toString('base64'); }
function davBase(uid) { return nc().url.replace(/\/+$/, '') + '/remote.php/dav/files/' + encodeURIComponent(uid); }

// Filesystem-safe Nextcloud filename (preserve unicode; strip path/illegal chars).
function safeFileBase(title) {
  let s = String(title || 'Presentation').normalize('NFC').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
  s = s.replace(/^\.+/, '').slice(0, 120).trim();
  return s || 'Presentation';
}

async function mkcolChain(uid, segments) {
  // Create each folder level idempotently (405 = already exists).
  let rel = '';
  for (const seg of segments) {
    rel += '/' + seg;
    const url = davBase(uid) + rel.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(url, { method: 'MKCOL', headers: { Authorization: authHeader(uid) }, signal: AbortSignal.timeout(15000) });
    if (!res.ok && res.status !== 405 && res.status !== 301) {
      throw new Error(`MKCOL ${seg} -> ${res.status}`);
    }
  }
}

async function putFile(uid, relPath, buffer, contentType) {
  const url = davBase(uid) + '/' + relPath.split('/').map(encodeURIComponent).join('/');
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: authHeader(uid), 'Content-Type': contentType || 'application/octet-stream' },
    body: buffer,
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error(`PUT ${res.status}`);
  return true;
}

async function deleteFile(uid, relPath) {
  try {
    const url = davBase(uid) + '/' + relPath.split('/').map(encodeURIComponent).join('/');
    await fetch(url, { method: 'DELETE', headers: { Authorization: authHeader(uid) }, signal: AbortSignal.timeout(15000) });
  } catch { /* best-effort */ }
}

// Upsert the single tracking row per presentation. Column names are allowlisted
// (never interpolate caller-supplied keys into SQL, even though all callers here
// pass literals — defense against a future caller passing a user-controlled key).
const JOB_COLS = new Set(['nextcloud_path', 'status', 'error_msg', 'last_synced_at']);
function recordJob(pres, uid, fields) {
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

  const owner = db.prepare('SELECT email FROM users WHERE id = ?').get(pres.user_id);
  const uid = owner && uidFromEmail(owner.email);
  if (!uid) return { skipped: 'owner has no @' + USER_DOMAIN + ' Nextcloud account' };

  let deck;
  try { deck = JSON.parse(pres.deck_json || '{}'); } catch { deck = { slides: [] }; }

  const folder = [nc().baseDir || 'MBFD Media Control', 'Presentations'];
  const relDir = folder.map((s) => s).join('/');
  const fileBase = safeFileBase(pres.title);
  const relPath = `${relDir}/${fileBase}.pptx`;

  try {
    const buffer = await renderDeckToPptxBuffer(deck);
    await mkcolChain(uid, folder);

    // If the title changed since last sync, remove the stale file.
    const prior = db.prepare('SELECT nextcloud_path FROM nextcloud_sync_jobs WHERE presentation_id = ?').get(pres.id);
    if (prior && prior.nextcloud_path && prior.nextcloud_path !== relPath) {
      await deleteFile(uid, prior.nextcloud_path);
    }

    await putFile(uid, relPath, buffer, PPTX_MIME);
    recordJob(pres, uid, { nextcloud_path: relPath, status: 'done', error_msg: null, last_synced_at: Math.floor(Date.now() / 1000) });
    console.log(`[nc-sync] ${pres.id} -> ${uid}:/${relPath} (${buffer.length} bytes)`);
    return { ok: true, uid, path: relPath, bytes: buffer.length };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 300);
    try { recordJob(pres, uid, { status: 'error', error_msg: msg }); } catch { /* */ }
    console.warn(`[nc-sync] ${pres.id} -> ${uid} FAILED: ${msg}`);
    return { error: msg };
  }
}

// Fire-and-forget wrapper for route handlers (never rejects).
function syncSoon(presId) {
  if (!enabled()) return;
  setImmediate(() => { syncPresentation(presId).catch(() => {}); });
}

module.exports = { syncPresentation, syncSoon, enabled, uidFromEmail };
