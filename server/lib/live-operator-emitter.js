'use strict';

const crypto = require('crypto');

function generateCommandId() {
  return crypto.randomUUID();
}

function getTimestamp() {
  return new Date().toISOString();
}

function buildRoomName(workspaceId) {
  return `workspace:${workspaceId}`;
}

function safeEmit(io, room, eventName, payload) {
  try {
    const roomSockets = io.sockets.adapter.rooms.get(room);
    const clientCount = roomSockets ? roomSockets.size : 0;

    if (clientCount === 0) {
      console.log(`[LiveOperatorEmitter] No clients in room "${room}" for event "${eventName}"`);
    }

    io.to(room).emit(eventName, payload);

    console.log(`[LiveOperatorEmitter] Emitted "${eventName}" to room "${room}" (${clientCount} client(s))`);
    return { emitted: true, clientCount };
  } catch (err) {
    console.error(`[LiveOperatorEmitter] Failed to emit "${eventName}" to room "${room}":`, err.message);
    return { emitted: false, error: err.message };
  }
}

function buildBasePayload(options) {
  return {
    command_id: options.command_id || generateCommandId(),
    session_id: options.session_id || null,
    timestamp: options.timestamp || getTimestamp(),
    requested_state: options.requested_state || null,
    confirmed_state: options.confirmed_state || null,
    operator: options.operator || null,
    workspace_id: options.workspace_id || null,
    error: options.error || null,
    recording_id: options.recording_id || null,
    peertube_video_id: options.peertube_video_id || null
  };
}

function emitOperatorState(io, workspaceId, state) {
  const room = buildRoomName(workspaceId);
  const payload = buildBasePayload({
    command_id: state.command_id,
    session_id: state.session_id,
    operator: state.operator,
    workspace_id: workspaceId,
    requested_state: state.requested_state,
    confirmed_state: state.confirmed_state
  });

  payload.camera_online = state.camera_online || false;
  payload.preview_online = state.preview_online || false;
  payload.recording = state.recording || false;
  payload.livestreaming = state.livestreaming || false;
  payload.errors = state.errors || [];

  return safeEmit(io, room, 'camera_status', payload);
}

function emitFailureUpdate(io, workspaceId, failure) {
  const room = buildRoomName(workspaceId);
  const payload = buildBasePayload({
    command_id: failure.command_id,
    session_id: failure.session_id,
    operator: failure.operator,
    workspace_id: workspaceId,
    requested_state: failure.requested_state,
    confirmed_state: failure.confirmed_state,
    error: failure.error,
    recording_id: failure.recording_id,
    peertube_video_id: failure.peertube_video_id
  });

  payload.error_code = failure.error_code || null;
  payload.retry_count = failure.retry_count || 0;
  payload.retryable = failure.retryable !== undefined ? failure.retryable : true;

  return safeEmit(io, room, 'operation_failed', payload);
}

function emitCameraEvent(io, workspaceId, eventName, eventData) {
  const room = buildRoomName(workspaceId);
  const payload = buildBasePayload({
    command_id: eventData.command_id,
    session_id: eventData.session_id,
    operator: eventData.operator,
    workspace_id: workspaceId,
    requested_state: eventData.requested_state,
    confirmed_state: eventData.confirmed_state,
    error: eventData.error,
    recording_id: eventData.recording_id,
    peertube_video_id: eventData.peertube_video_id
  });

  Object.keys(eventData).forEach(key => {
    if (!(key in payload)) {
      payload[key] = eventData[key];
    }
  });

  return safeEmit(io, room, eventName, payload);
}

function createEventEmitter(io, workspaceId, defaultOperator) {
  const room = buildRoomName(workspaceId);

  function emit(eventName, data) {
    const payload = buildBasePayload({
      command_id: data.command_id,
      session_id: data.session_id,
      operator: data.operator || defaultOperator,
      workspace_id: workspaceId,
      requested_state: data.requested_state,
      confirmed_state: data.confirmed_state,
      error: data.error,
      recording_id: data.recording_id,
      peertube_video_id: data.peertube_video_id
    });

    Object.keys(data).forEach(key => {
      if (!(key in payload)) {
        payload[key] = data[key];
      }
    });

    return safeEmit(io, room, eventName, payload);
  }

  return {
    cameraStatus(data = {}) {
      return emit('camera_status', {
        camera_online: data.camera_online || false,
        preview_online: data.preview_online || false,
        recording: data.recording || false,
        livestreaming: data.livestreaming || false,
        errors: data.errors || [],
        ...data
      });
    },

    recordingRequested(data = {}) {
      return emit('recording_requested', {
        requested_state: 'recording',
        ...data
      });
    },

    recordingStarted(data = {}) {
      return emit('recording_started', {
        confirmed_state: 'recording',
        started_at: data.started_at || getTimestamp(),
        ...data
      });
    },

    recordingProgress(data = {}) {
      return emit('recording_progress', {
        duration_seconds: data.duration_seconds || 0,
        file_size_bytes: data.file_size_bytes || 0,
        ...data
      });
    },

    recordingStopping(data = {}) {
      return emit('recording_stopping', {
        requested_state: 'idle',
        ...data
      });
    },

    recordingFinalizing(data = {}) {
      return emit('recording_finalizing', {
        confirmed_state: 'finalizing',
        ...data
      });
    },

    recordingCompleted(data = {}) {
      return emit('recording_completed', {
        confirmed_state: 'completed',
        file_path: data.file_path || null,
        duration: data.duration || null,
        size: data.size || null,
        sha256: data.sha256 || null,
        ...data
      });
    },

    recordingSyncing(data = {}) {
      return emit('recording_syncing', {
        confirmed_state: 'syncing',
        progress_percent: data.progress_percent || 0,
        ...data
      });
    },

    recordingSynced(data = {}) {
      return emit('recording_synced', {
        confirmed_state: 'synced',
        destination: data.destination || null,
        ...data
      });
    },

    recordingFailed(data = {}) {
      return emit('recording_failed', {
        confirmed_state: 'failed',
        error: data.error || 'Unknown recording error',
        retry_count: data.retry_count || 0,
        ...data
      });
    },

    livestreamRequested(data = {}) {
      return emit('livestream_requested', {
        requested_state: 'livestreaming',
        ...data
      });
    },

    livestreamStarted(data = {}) {
      return emit('livestream_started', {
        confirmed_state: 'livestreaming',
        started_at: data.started_at || getTimestamp(),
        peertube_watch_url: data.peertube_watch_url || null,
        ...data
      });
    },

    livestreamStopping(data = {}) {
      return emit('livestream_stopping', {
        requested_state: 'idle',
        ...data
      });
    },

    livestreamStopped(data = {}) {
      return emit('livestream_stopped', {
        confirmed_state: 'idle',
        stopped_at: data.stopped_at || getTimestamp(),
        ...data
      });
    },

    livestreamFailed(data = {}) {
      return emit('livestream_failed', {
        confirmed_state: 'failed',
        error: data.error || 'Unknown livestream error',
        ...data
      });
    },

    peertubeUploadStarted(data = {}) {
      return emit('peertube_upload_started', {
        confirmed_state: 'uploading',
        ...data
      });
    },

    peertubeUploadProgress(data = {}) {
      return emit('peertube_upload_progress', {
        progress_percent: data.progress_percent || 0,
        ...data
      });
    },

    peertubeUploadCompleted(data = {}) {
      return emit('peertube_upload_completed', {
        confirmed_state: 'uploaded',
        peertube_video_id: data.peertube_video_id || null,
        peertube_watch_url: data.peertube_watch_url || null,
        ...data
      });
    },

    peertubeUploadFailed(data = {}) {
      return emit('peertube_upload_failed', {
        confirmed_state: 'failed',
        error: data.error || 'Unknown upload error',
        ...data
      });
    },

    peertubePublished(data = {}) {
      return emit('peertube_published', {
        confirmed_state: 'published',
        peertube_video_id: data.peertube_video_id || null,
        privacy: data.privacy || 'private',
        published_at: data.published_at || getTimestamp(),
        ...data
      });
    },

    mediaEmergencyStop(data = {}) {
      return emit('media_emergency_stop', {
        requested_state: 'emergency_stop',
        confirmed_state: 'stopped',
        recording_stopped: data.recording_stopped || false,
        livestream_stopped: data.livestream_stopped || false,
        ...data
      });
    }
  };
}

module.exports = {
  emitOperatorState,
  emitFailureUpdate,
  emitCameraEvent,
  createEventEmitter
};
