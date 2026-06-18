'use strict';

const crypto = require('crypto');
const { db } = require('../db/database');

function safeEqual(a, b) {
  try {
    const expected = Buffer.from(String(a || ''));
    const actual = Buffer.from(String(b || ''));
    if (expected.length === 0 || actual.length === 0) return false;
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function loadManagedDisplay(deviceId, token) {
  if (!deviceId || !token) return null;
  const row = db.prepare('SELECT * FROM devices WHERE id = ?').get(String(deviceId));
  if (!row || !row.workspace_id || !row.device_token) return null;
  if (!safeEqual(row.device_token, token)) return null;
  return row;
}

function buildManagedPlayerUrl({ baseUrl, display }) {
  if (!baseUrl) throw new Error('baseUrl is required');
  if (!display || !display.id || !display.device_token) {
    throw new Error('display with device_token is required');
  }

  const base = String(baseUrl).replace(/\/+$/, '');
  const qs = new URLSearchParams({ device_id: display.id, token: display.device_token });
  return `${base}/player/managed?${qs.toString()}`;
}

module.exports = {
  buildManagedPlayerUrl,
  loadManagedDisplay,
};
