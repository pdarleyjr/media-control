'use strict';

const crypto = require('node:crypto');

const PAIRING_CODE_TTL_SECONDS = 600;

function normalizedText(value, maxLength) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) return '';
  return text;
}

function generatePairingCode() {
  return String(crypto.randomInt(100000, 1000000));
}

function pairingCodeExpiresAt(now = Math.floor(Date.now() / 1000)) {
  return Number(now) + PAIRING_CODE_TTL_SECONDS;
}

function isPairingCodeActive(device, now = Math.floor(Date.now() / 1000)) {
  return /^\d{6}$/.test(String(device?.pairing_code || ''))
    && Number.isFinite(Number(device?.pairing_expires_at))
    && Number(device.pairing_expires_at) > Number(now);
}

function findReusablePendingEnrollment(db, pairingCode) {
  const code = normalizedText(pairingCode, 64);
  if (!db || !code) return null;
  try {
    return db.prepare(`
      SELECT *
      FROM devices
      WHERE pairing_code = ?
        AND user_id IS NULL
        AND workspace_id IS NULL
        AND COALESCE(retired, 0) = 0
      LIMIT 1
    `).get(code) || null;
  } catch (_) {
    return null;
  }
}

// A browser fingerprint is only a reconnect hint. Identical TVs can report the
// same browser characteristics, so this helper repairs an unbound/same-device
// row but never steals a fingerprint already owned by another display.
function bindEnrollmentFingerprint(db, fingerprint, deviceId) {
  const value = normalizedText(fingerprint, 512);
  const id = normalizedText(deviceId, 128);
  if (!db || !value || !id) return false;
  try {
    const existing = db.prepare(
      'SELECT device_id FROM device_fingerprints WHERE fingerprint = ?',
    ).get(value);
    if (existing?.device_id && String(existing.device_id) !== id) return false;
    if (existing) {
      db.prepare(`
        UPDATE device_fingerprints
        SET device_id = ?, last_seen = strftime('%s','now')
        WHERE fingerprint = ?
      `).run(id, value);
    } else {
      db.prepare(`
        INSERT INTO device_fingerprints (fingerprint, device_id)
        VALUES (?, ?)
      `).run(value, id);
    }
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  bindEnrollmentFingerprint,
  findReusablePendingEnrollment,
  generatePairingCode,
  pairingCodeExpiresAt,
  isPairingCodeActive,
};
