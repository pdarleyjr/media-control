'use strict';

const peertubeClient = require('./peertube-client');
const peertubeTracking = require('./peertube-tracking');

async function attemptFallbackUpload(sessionId, mp4Path, metadata = {}) {
  const tracking = peertubeTracking.getPeerTubeTracking(sessionId);
  if (!tracking) {
    return { ok: false, message: 'No PeerTube tracking found for session' };
  }

  if (tracking.peertube_replay_status === 'available') {
    return { ok: false, message: 'Native replay already available, skipping fallback' };
  }

  if (tracking.peertube_replay_status === 'fallback_available') {
    return { ok: false, message: 'Fallback upload already completed' };
  }

  peertubeTracking.markFallbackUploading(sessionId);

  try {
    const result = await peertubeClient.uploadVideo({
      filePath: mp4Path,
      name: metadata.name || `Recording ${new Date().toISOString()}`,
      description: metadata.description || 'Live session recording',
      channelId: metadata.channelId || 1,
      privacy: metadata.privacy || 'private',
      tags: metadata.tags || [],
      category: metadata.category,
      language: metadata.language,
    });

    if (!result.ok) {
      peertubeTracking.markFallbackFailed(sessionId, result.message || 'Upload failed');
      return { ok: false, message: result.message, detail: result };
    }

    const videoData = result.data?.video;
    if (videoData) {
      peertubeTracking.markFallbackAvailable(sessionId, videoData.uuid, videoData.url || videoData.shortUrl);
      return { ok: true, videoId: videoData.uuid, videoUrl: videoData.url || videoData.shortUrl };
    }

    peertubeTracking.markFallbackFailed(sessionId, 'No video data in response');
    return { ok: false, message: 'No video data in PeerTube response' };
  } catch (err) {
    peertubeTracking.markFallbackFailed(sessionId, err.message);
    return { ok: false, message: err.message };
  }
}

module.exports = {
  attemptFallbackUpload,
};
