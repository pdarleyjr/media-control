'use strict';

const CAMERA_HOST = 'http://host.docker.internal:8766/camera-hls';

function normalizeCamera(camera) {
  const value = String(camera || '');
  if (value !== '1' && value !== '2') throw new Error('Unknown classroom camera');
  return value;
}

function normalizeAsset(asset) {
  const value = String(asset || 'index.m3u8').replace(/^\/+/, '');
  if (!value || value.includes('..') || value.includes('\\') || !/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(value)) {
    throw new Error('Invalid camera asset');
  }
  return value;
}

function cameraUpstreamUrl(camera, asset) {
  const id = normalizeCamera(camera);
  return `${CAMERA_HOST}/${id}/${normalizeAsset(asset)}`;
}

function proxyCameraUri(uri, camera) {
  const id = normalizeCamera(camera);
  let value = String(uri || '').trim();
  if (!value) return value;
  try {
    const parsed = new URL(value, `${CAMERA_HOST}/kamrui-camera-${id}/`);
    const marker = `/kamrui-camera-${id}/`;
    const markerIndex = parsed.pathname.indexOf(marker);
    const asset = markerIndex >= 0
      ? parsed.pathname.slice(markerIndex + marker.length)
      : parsed.pathname.replace(/^\/+/, '');
    return `/player/classroom-camera/${id}/${normalizeAsset(asset)}${parsed.search}`;
  } catch {
    return value;
  }
}

function rewriteCameraManifest(manifest, camera) {
  return String(manifest || '')
    .split(/\r?\n/)
    .map((line) => {
      if (!line) return line;
      if (line.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uri) => `URI="${proxyCameraUri(uri, camera)}"`);
      }
      return proxyCameraUri(line, camera);
    })
    .join('\n');
}

async function handleClassroomCamera(req, res) {
  const camera = normalizeCamera(req.params.camera);
  const asset = normalizeAsset(req.params[0] || 'index.m3u8');
  const target = new URL(cameraUpstreamUrl(camera, asset));
  const queryIndex = req.originalUrl.indexOf('?');
  if (queryIndex >= 0) target.search = req.originalUrl.slice(queryIndex);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const upstream = await fetch(target, {
      signal: controller.signal,
      headers: req.headers.range ? { Range: req.headers.range } : undefined,
      cache: 'no-store',
    });
    if (!upstream.ok) return res.status(upstream.status).type('text/plain').send('camera unavailable');
    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    res.status(upstream.status);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Cache-Control', asset.endsWith('.m3u8') ? 'no-store' : 'public, max-age=5');
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (asset.endsWith('.m3u8') || contentType.includes('mpegurl')) {
      return res.send(rewriteCameraManifest(bytes.toString('utf8'), camera));
    }
    res.send(bytes);
  } catch (error) {
    res.status(502).type('text/plain').send(error.name === 'AbortError' ? 'camera timeout' : 'camera unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = {
  cameraUpstreamUrl,
  handleClassroomCamera,
  rewriteCameraManifest,
};
