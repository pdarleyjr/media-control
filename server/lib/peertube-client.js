'use strict';

const config = require('../config');

const CREDENTIAL_REDACTED = '[redacted]';

function getBaseUrl() {
  return String(config.peertube?.baseUrl || process.env.PEERTUBE_BASE_URL || '').replace(/\/+$/, '');
}

function getAccessToken() {
  return config.peertube?.accessToken || process.env.PEERTUBE_ACCESS_TOKEN || '';
}

function redactCredential(value) {
  if (typeof value !== 'string') return value;
  const token = getAccessToken();
  if (!token) return value;
  return value.split(token).join(CREDENTIAL_REDACTED);
}

function redactError(error) {
  if (!error || typeof error !== 'object') return error;
  const redacted = { ...error };
  if (typeof redacted.message === 'string') {
    redacted.message = redactCredential(redacted.message);
  }
  if (typeof redacted.url === 'string') {
    redacted.url = redactCredential(redacted.url);
  }
  return redacted;
}

async function apiRequest(method, path, body, timeoutMs = 10000) {
  const base = getBaseUrl();
  if (!base) return { ok: false, message: 'PeerTube base URL not configured' };

  const token = getAccessToken();
  if (!token) return { ok: false, message: 'PeerTube access token not configured' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const headers = {
      'Authorization': `Bearer ${token}`,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

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
      return { ok: false, status: response.status, message: redactCredential(text || response.statusText), data };
    }
    return { ok: true, status: response.status, data };
  } catch (e) {
    const message = e && e.name === 'AbortError'
      ? 'PeerTube request timed out'
      : redactCredential((e && e.message) || 'PeerTube request failed');
    return { ok: false, message };
  } finally {
    clearTimeout(timeout);
  }
}

async function getVideo(videoId) {
  return apiRequest('GET', `/api/v1/videos/${videoId}`);
}

async function searchReplayForLive(liveVideoId) {
  const liveResult = await getVideo(liveVideoId);
  if (!liveResult.ok) return { ok: false, message: 'Could not fetch live video', detail: liveResult };

  const liveData = liveResult.data;
  if (!liveData) return { ok: false, message: 'No live data returned' };

  if (liveData.replayVideoId) {
    const replayResult = await getVideo(liveData.replayVideoId);
    if (replayResult.ok) {
      return {
        ok: true,
        replayFound: true,
        replayVideoId: liveData.replayVideoId,
        replayUuid: replayResult.data?.uuid,
        replayUrl: replayResult.data?.url,
        replayName: replayResult.data?.name,
        replayPrivacy: replayResult.data?.privacy,
      };
    }
  }

  return { ok: true, replayFound: false, liveVideoId };
}

async function uploadVideo({ filePath, name, description, channelId, privacy, tags, category, language }) {
  const base = getBaseUrl();
  const token = getAccessToken();
  if (!base || !token) return { ok: false, message: 'PeerTube not configured' };

  const fs = require('fs');
  const path = require('path');

  if (!filePath || !fs.existsSync(filePath)) {
    return { ok: false, message: 'Video file not found' };
  }

  const FormData = (await import('node:buffer')).Blob ? globalThis.FormData : null;
  if (!FormData) return { ok: false, message: 'FormData not available' };

  const formData = new FormData();
  const fileBuffer = fs.readFileSync(filePath);
  const blob = new Blob([fileBuffer]);
  formData.append('videofile', blob, path.basename(filePath));

  const fields = { name, channelId, privacy: privacy || 'private' };
  if (description) fields.description = description;
  if (tags && Array.isArray(tags)) fields.tags = tags.join(',');
  if (category) fields.category = String(category);
  if (language) fields.language = language;

  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, String(value));
  }

  try {
    const response = await fetch(`${base}/api/v1/videos/upload`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      body: formData,
      signal: AbortSignal.timeout(300000),
    });

    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }

    if (!response.ok) {
      return { ok: false, status: response.status, message: redactCredential(text || response.statusText) };
    }
    return { ok: true, status: response.status, data };
  } catch (e) {
    return { ok: false, message: redactCredential(e?.message || 'Upload failed') };
  }
}

function credentialIsConfigured() {
  return !!getBaseUrl() && !!getAccessToken();
}

module.exports = {
  getBaseUrl,
  credentialIsConfigured,
  redactCredential,
  redactError,
  apiRequest,
  getVideo,
  searchReplayForLive,
  uploadVideo,
  CREDENTIAL_REDACTED,
};
