'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { stat } = require('node:fs/promises');

const UPLOAD_TIMEOUT_MS = 600_000;
const METADATA_TIMEOUT_MS = 30_000;
const PRIVACY = Object.freeze({ PUBLIC: 1, UNLISTED: 2, PRIVATE: 3 });
const PRIVACY_LABELS = Object.freeze({ 1: 'Public', 2: 'Unlisted', 3: 'Private' });

function getConfig() {
  const baseUrl = process.env.PEERTUBE_BASE_URL;
  const token = process.env.PEERTUBE_ACCESS_TOKEN;
  if (!baseUrl || !token) {
    throw new Error('Missing required environment variables: PEERTUBE_BASE_URL and PEERTUBE_ACCESS_TOKEN');
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ''), token };
}

function redactToken(message, token) {
  if (!token) return String(message);
  let redacted = String(message);
  while (redacted.includes(token)) {
    redacted = redacted.replace(token, '[REDACTED]');
  }
  return redacted;
}

function sanitizeError(err, token) {
  const msg = redactToken(err.message || String(err), token);
  const sanitized = new Error(msg);
  sanitized.cause = err.cause || null;
  sanitized.statusCode = err.statusCode || null;
  return sanitized;
}

function buildAuthHeaders(token) {
  return { Authorization: `Bearer ${token}` };
}

function generateBoundary() {
  return `----KiloFormBoundary${crypto.randomBytes(16).toString('hex')}`;
}

function encodeFieldPart(boundary, name, value) {
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n`;
  const body = `${value}\r\n`;
  return Buffer.from(header + body, 'utf8');
}

function encodeFilePart(boundary, name, filename, contentType, fileBuffer) {
  const header = `--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`;
  const headerBuf = Buffer.from(header, 'utf8');
  const footerBuf = Buffer.from('\r\n', 'utf8');
  return Buffer.concat([headerBuf, fileBuffer, footerBuf]);
}

function buildMultipartBody(fields, fileFieldName, fileBuffer, filename, fileContentType) {
  const boundary = generateBoundary();
  const parts = [];

  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        parts.push(encodeFieldPart(boundary, key, String(item)));
      }
    } else {
      parts.push(encodeFieldPart(boundary, key, String(value)));
    }
  }

  parts.push(encodeFilePart(boundary, fileFieldName, filename, fileContentType, fileBuffer));
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));

  const body = Buffer.concat(parts);
  const contentType = `multipart/form-data; boundary=${boundary}`;
  return { body, contentType };
}

function detectContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = {
    '.mp4': 'video/mp4',
    '.mkv': 'video/x-matroska',
    '.webm': 'video/webm',
    '.avi': 'video/x-msvideo',
    '.mov': 'video/quicktime',
    '.flv': 'video/x-flv',
    '.ts': 'video/mp2t',
    '.m4v': 'video/x-m4v',
    '.ogv': 'video/ogg',
  };
  return types[ext] || 'video/mp4';
}

async function readWithProgress(filePath, onProgress) {
  const fileStat = await stat(filePath);
  const totalSize = fileStat.size;
  const fileBuffer = Buffer.alloc(totalSize);
  const readStream = fs.createReadStream(filePath, { highWaterMark: 1024 * 1024 });

  let bytesRead = 0;
  return new Promise((resolve, reject) => {
    readStream.on('data', (chunk) => {
      chunk.copy(fileBuffer, bytesRead);
      bytesRead += chunk.length;
      if (typeof onProgress === 'function') {
        onProgress(bytesRead, totalSize);
      }
    });
    readStream.on('end', () => resolve(fileBuffer));
    readStream.on('error', (err) => reject(err));
  });
}

async function fetchWithTimeout(url, options, timeoutMs, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } catch (err) {
    if (err.name === 'AbortError') {
      const timeoutErr = new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
      timeoutErr.statusCode = 408;
      throw sanitizeError(timeoutErr, token);
    }
    throw sanitizeError(err, token);
  } finally {
    clearTimeout(timer);
  }
}

async function parseResponse(response, token) {
  let body;
  const contentType = response.headers.get('content-type') || '';

  if (contentType.includes('application/json')) {
    body = await response.json();
  } else {
    body = await response.text();
  }

  if (!response.ok) {
    const errMsg = typeof body === 'object' && body !== null
      ? (body.error || body.message || JSON.stringify(body))
      : String(body);
    const err = new Error(`PeerTube API error ${response.status}: ${errMsg}`);
    err.statusCode = response.status;
    err.responseBody = body;
    throw sanitizeError(err, token);
  }

  return body;
}

/**
 * Uploads a video file to PeerTube.
 * @param {string} filePath - Absolute path to the video file
 * @param {object} metadata - Video metadata
 * @param {string} metadata.name - Video title (required)
 * @param {string} [metadata.description] - Video description
 * @param {number} [metadata.channelId=1] - Channel ID
 * @param {number} [metadata.privacy=3] - Privacy: 1=Public, 2=Unlisted, 3=Private
 * @param {string[]} [metadata.tags] - Array of tags
 * @param {string} [metadata.language] - ISO 639-1 language code
 * @param {string} [metadata.recordingDate] - ISO 8601 recording date
 * @param {string} [metadata.sessionId] - Recording session identifier
 * @param {string} [metadata.operator] - Operator who made the recording
 * @param {function} [metadata.onProgress] - Progress callback (bytesSent, totalBytes)
 * @returns {Promise<{ok: boolean, videoId: number, videoUuid: string, watchUrl: string, privacy: number, processingState: string}>}
 */
async function uploadRecording(filePath, metadata = {}) {
  const config = getConfig();
  const { token, baseUrl } = config;

  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath is required and must be a non-empty string');
  }

  const resolvedPath = path.resolve(filePath);

  let fileStat;
  try {
    fileStat = await stat(resolvedPath);
  } catch {
    throw new Error(`File not found: ${resolvedPath}`);
  }

  if (!fileStat.isFile()) {
    throw new Error(`Path is not a file: ${resolvedPath}`);
  }

  if (!metadata.name || typeof metadata.name !== 'string') {
    throw new Error('metadata.name (video title) is required');
  }

  const {
    name,
    description = '',
    channelId = 1,
    privacy = PRIVACY.PRIVATE,
    tags = [],
    language = '',
    recordingDate = '',
    sessionId = '',
    operator = '',
    onProgress = null,
  } = metadata;

  if (![PRIVACY.PUBLIC, PRIVACY.UNLISTED, PRIVACY.PRIVATE].includes(privacy)) {
    throw new Error(`Invalid privacy value: ${privacy}. Must be 1 (Public), 2 (Unlisted), or 3 (Private)`);
  }

  const fileBuffer = await readWithProgress(resolvedPath, onProgress);
  const filename = path.basename(resolvedPath);
  const contentType = detectContentType(resolvedPath);

  const fields = {
    name,
    channelId: String(channelId),
    privacy: String(privacy),
  };

  if (description) fields.description = description;
  if (language) fields.language = language;
  if (recordingDate) fields.recordingDate = recordingDate;
  if (sessionId) fields['pluginMetadata[sessionRecording].sessionId'] = sessionId;
  if (operator) fields['pluginMetadata[sessionRecording].operator'] = operator;
  if (tags.length > 0) {
    tags.slice(0, 5).forEach((tag, i) => {
      fields[`tags[${i}]`] = tag;
    });
  }

  const { body, contentType: multipartContentType } = buildMultipartBody(
    fields,
    'videofile',
    fileBuffer,
    filename,
    contentType,
  );

  const uploadUrl = `${baseUrl}/api/v1/videos/upload`;

  const response = await fetchWithTimeout(
    uploadUrl,
    {
      method: 'POST',
      headers: {
        ...buildAuthHeaders(token),
        'Content-Type': multipartContentType,
        'Content-Length': String(body.length),
      },
      body,
    },
    UPLOAD_TIMEOUT_MS,
    token,
  );

  const result = await parseResponse(response, token);

  const video = result.video || result;
  const videoId = video.id || null;
  const videoUuid = video.uuid || null;

  return {
    ok: true,
    videoId,
    videoUuid,
    watchUrl: videoUuid ? `${baseUrl}/w/${videoUuid}` : null,
    privacy,
    processingState: video.state?.label || video.state || 'pending',
  };
}

/**
 * Updates the privacy setting of a PeerTube video.
 * @param {number|string} videoId - Video ID or UUID
 * @param {number} newPrivacy - New privacy: 1=Public, 2=Unlisted, 3=Private
 * @param {object} [options]
 * @param {boolean} [options.confirmPublic=false] - Must be true when setting privacy to Public
 * @returns {Promise<{ok: boolean, videoId: number|string, privacy: number, previousPrivacy: number}>}
 */
async function updatePrivacy(videoId, newPrivacy, options = {}) {
  const config = getConfig();
  const { token, baseUrl } = config;

  if (!videoId) {
    throw new Error('videoId is required');
  }

  if (![PRIVACY.PUBLIC, PRIVACY.UNLISTED, PRIVACY.PRIVATE].includes(newPrivacy)) {
    throw new Error(`Invalid privacy value: ${newPrivacy}. Must be 1 (Public), 2 (Unlisted), or 3 (Private)`);
  }

  if (newPrivacy === PRIVACY.PUBLIC && options.confirmPublic !== true) {
    throw new Error(
      'Setting video to Public requires explicit confirmation. Pass { confirmPublic: true } in options.',
    );
  }

  const infoUrl = `${baseUrl}/api/v1/videos/${videoId}`;

  const infoResponse = await fetchWithTimeout(
    infoUrl,
    { method: 'GET', headers: buildAuthHeaders(token) },
    METADATA_TIMEOUT_MS,
    token,
  );

  const currentVideo = await parseResponse(infoResponse, token);
  const previousPrivacy = currentVideo.privacy?.id ?? currentVideo.privacy;

  const updateUrl = `${baseUrl}/api/v1/videos/${videoId}`;

  const updateResponse = await fetchWithTimeout(
    updateUrl,
    {
      method: 'PUT',
      headers: {
        ...buildAuthHeaders(token),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ privacy: newPrivacy }),
    },
    METADATA_TIMEOUT_MS,
    token,
  );

  await parseResponse(updateResponse, token);

  return {
    ok: true,
    videoId,
    privacy: newPrivacy,
    previousPrivacy,
  };
}

/**
 * Retrieves information about a PeerTube video.
 * @param {number|string} videoIdOrUuid - Video ID or UUID
 * @returns {Promise<{ok: boolean, uuid: string, id: number, name: string, privacy: number, state: string, transcodingState: string|null, watchUrl: string, duration: number}>}
 */
async function getVideoInfo(videoIdOrUuid) {
  const config = getConfig();
  const { token, baseUrl } = config;

  if (!videoIdOrUuid) {
    throw new Error('videoIdOrUuid is required');
  }

  const url = `${baseUrl}/api/v1/videos/${videoIdOrUuid}`;

  const response = await fetchWithTimeout(
    url,
    { method: 'GET', headers: buildAuthHeaders(token) },
    METADATA_TIMEOUT_MS,
    token,
  );

  const video = await parseResponse(response, token);

  const privacyValue = typeof video.privacy === 'object' ? video.privacy.id : video.privacy;
  const stateValue = typeof video.state === 'object' ? video.state.id : video.state;
  const stateLabel = typeof video.state === 'object' ? video.state.label : String(stateValue);

  let transcodingState = null;
  if (video.waitingTranscoding) {
    transcodingState = 'waiting';
  } else if (video.transcodingProgress !== undefined && video.transcodingProgress !== null) {
    transcodingState = video.transcodingProgress < 100 ? 'in_progress' : 'complete';
  }

  return {
    ok: true,
    uuid: video.uuid || null,
    id: video.id || null,
    name: video.name || '',
    privacy: privacyValue,
    state: stateLabel,
    transcodingState,
    watchUrl: video.uuid ? `${baseUrl}/w/${video.uuid}` : null,
    duration: video.duration || 0,
  };
}

/**
 * Checks whether a video has finished transcoding/processing.
 * @param {number|string} videoIdOrUuid - Video ID or UUID
 * @returns {Promise<{ok: boolean, processing: boolean, state: string, transcodingState: string|null}>}
 */
async function checkProcessingStatus(videoIdOrUuid) {
  const info = await getVideoInfo(videoIdOrUuid);

  const stateId = info.state;
  const isPublished = stateId === 'published' || stateId === 'Published' || stateId === 1;
  const transcodingDone = info.transcodingState === 'complete' || info.transcodingState === null;
  const processing = !isPublished || !transcodingDone;

  return {
    ok: true,
    processing,
    state: info.state,
    transcodingState: info.transcodingState,
  };
}

module.exports = {
  uploadRecording,
  updatePrivacy,
  getVideoInfo,
  checkProcessingStatus,
  PRIVACY,
  PRIVACY_LABELS,
};
