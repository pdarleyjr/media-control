'use strict';

const crypto = require('crypto');
const config = require('../config');

function getBaseUrl() {
  return String(config.cameraControl?.baseUrl || process.env.CAMERA_CONTROL_BASE_URL || '').replace(/\/+$/, '');
}

function getToken() {
  return config.cameraControl?.token || process.env.CAMERA_CONTROL_TOKEN || '';
}

function headerValue(headers, name) {
  const match = Object.entries(headers || {}).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1] ?? '') : '';
}

function serviceHeaders(method, requestPath, body, operatorId, signedHeaders = {}) {
  const secret = config.cameraControl?.signingSecret || process.env.CAMERA_CONTROL_SIGNING_SECRET || '';
  if (!secret) return {};
  const timestamp = new Date().toISOString();
  const nonce = crypto.randomUUID();
  const signedOperatorId = String(operatorId || 'media-control-service');
  const ifMatch = headerValue(signedHeaders, 'if-match');
  const bodyHash = crypto.createHash('sha256')
    .update(JSON.stringify(body == null ? null : body))
    .digest('hex');
  const signature = crypto.createHmac('sha256', secret)
    .update(`${method}\n${requestPath}\n${timestamp}\n${bodyHash}\n${signedOperatorId}\n${nonce}\n${ifMatch}`)
    .digest('hex');
  return {
    'X-Service-Timestamp': timestamp,
    'X-Service-Nonce': nonce,
    'X-Service-Signature': signature,
    'X-Operator-Id': signedOperatorId,
  };
}

async function callCameraApi(method, path, body, timeoutMs = 15000, { headers: extraHeaders = {}, operatorId } = {}) {
  const base = getBaseUrl();
  if (!base) return { ok: false, message: 'Camera control base URL is not configured' };

  const token = getToken();
  if (!token) return { ok: false, message: 'Camera control token is not configured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'X-Api-Token': token,
      'Content-Type': 'application/json',
      ...extraHeaders,
      ...serviceHeaders(method, path, body, operatorId, extraHeaders),
    };

    const response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data.error || response.statusText)
        : (text || response.statusText);
      return { ok: false, status: response.status, message, data };
    }
    return { ok: true, status: response.status, data };
  } catch (e) {
    const message = e && e.name === 'AbortError'
      ? 'Camera API request timed out'
      : (e && e.message) || 'Camera API request failed';
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function getStatus() {
  return callCameraApi('GET', '/api/status');
}

async function startRecording() {
  return callCameraApi('POST', '/api/record/start');
}

async function stopRecording() {
  return callCameraApi('POST', '/api/record/stop');
}

async function startLivestream() {
  return callCameraApi('POST', '/api/stream/start');
}

async function stopLivestream() {
  return callCameraApi('POST', '/api/stream/stop');
}

async function emergencyStop() {
  return callCameraApi('POST', '/api/emergency-stop');
}

async function getRecordings() {
  return callCameraApi('GET', '/api/recordings');
}

async function getDeletionImpact(sessionId) {
  return callCameraApi('GET', `/api/recordings/${sessionId}/deletion-impact`);
}

async function archiveRecording(sessionId, { operatorId } = {}) {
  return callCameraApi('POST', `/api/recordings/${sessionId}/archive`, undefined, 15000, { operatorId });
}

async function restoreRecording(sessionId, { operatorId } = {}) {
  return callCameraApi('POST', `/api/recordings/${sessionId}/restore`, undefined, 15000, { operatorId });
}

async function deleteRecording(sessionId, { ifMatch, confirmTyped, operatorId } = {}) {
  const headers = {};
  if (ifMatch) headers['If-Match'] = ifMatch;
  return callCameraApi('DELETE', `/api/recordings/${sessionId}`, { confirm: confirmTyped }, 30000, { headers, operatorId });
}

async function deletePeerTubeVideo(sessionId, { confirmTyped, operatorId } = {}) {
  return callCameraApi('DELETE', `/api/recordings/${sessionId}/peertube`, { confirm: confirmTyped }, 30000, { operatorId });
}

module.exports = {
  callCameraApi,
  getStatus,
  startRecording,
  stopRecording,
  startLivestream,
  stopLivestream,
  emergencyStop,
  getRecordings,
  getDeletionImpact,
  archiveRecording,
  restoreRecording,
  deleteRecording,
  deletePeerTubeVideo,
  getBaseUrl,
  getToken,
  serviceHeaders,
};
