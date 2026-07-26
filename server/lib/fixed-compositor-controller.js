'use strict';

const crypto = require('node:crypto');

const FIXED_SCENES = Object.freeze({
  CAMERA_ONLY: 'MBFD_CAMERA_ONLY',
  CONTENT_MAIN_CAMERA_PIP: 'MBFD_CONTENT_MAIN_CAMERA_PIP',
  CAMERA_MAIN_CONTENT_PIP: 'MBFD_CAMERA_MAIN_CONTENT_PIP',
});

const LAYOUTS = Object.freeze({
  CAMERA_ONLY: 'camera_only',
  CONTENT_MAIN_CAMERA_PIP: 'content_main_camera_pip',
  CAMERA_MAIN_CONTENT_PIP: 'camera_main_content_pip',
});

const AUDIO_POLICIES = Object.freeze({
  CAMERA: 'camera',
  CONTENT_REPLACE: 'content_replace',
});

const PUBLISHER_MODES = Object.freeze({
  DIRECT_CAMERA: 'direct_camera',
  FIXED_COMPOSITOR: 'fixed_compositor',
});

const SCENE_FOR_LAYOUT = Object.freeze({
  [LAYOUTS.CAMERA_ONLY]: FIXED_SCENES.CAMERA_ONLY,
  [LAYOUTS.CONTENT_MAIN_CAMERA_PIP]: FIXED_SCENES.CONTENT_MAIN_CAMERA_PIP,
  [LAYOUTS.CAMERA_MAIN_CONTENT_PIP]: FIXED_SCENES.CAMERA_MAIN_CONTENT_PIP,
});

function controllerError(code, message, status = 409) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function stableFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function initialState(workspaceId) {
  return {
    workspace_id: workspaceId,
    accepted: true,
    requested_layout: LAYOUTS.CAMERA_ONLY,
    confirmed_layout: LAYOUTS.CAMERA_ONLY,
    content_source: null,
    content_instance_id: null,
    receiver_state: {
      configured: false,
      content_active: false,
      render_ready: false,
    },
    compositor_state: {
      available: false,
      scene: FIXED_SCENES.CAMERA_ONLY,
      confirmed: false,
      audio_policy: AUDIO_POLICIES.CAMERA,
    },
    failure_code: null,
    failure_message: null,
    revision: 0,
    request_id: null,
    updated_at: null,
  };
}

function createMemoryCompositionStore() {
  const states = new Map();
  const requests = new Map();
  return {
    get(workspaceId) {
      return states.has(workspaceId)
        ? structuredClone(states.get(workspaceId))
        : initialState(workspaceId);
    },
    put(workspaceId, state) {
      states.set(workspaceId, structuredClone(state));
      return state;
    },
    getRequest(workspaceId, idempotencyKey) {
      const value = requests.get(`${workspaceId}:${idempotencyKey}`);
      return value ? structuredClone(value) : null;
    },
    putRequest(workspaceId, idempotencyKey, value) {
      requests.set(`${workspaceId}:${idempotencyKey}`, structuredClone(value));
    },
  };
}

function createSqlCompositionStore(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS live_stream_compositions (
      workspace_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS live_stream_composition_requests (
      workspace_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      request_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, idempotency_key)
    );
  `);
  return {
    get(workspaceId) {
      const row = database.prepare(
        'SELECT state_json FROM live_stream_compositions WHERE workspace_id = ?',
      ).get(workspaceId);
      if (!row) return initialState(workspaceId);
      try { return JSON.parse(row.state_json); } catch { return initialState(workspaceId); }
    },
    put(workspaceId, state) {
      database.prepare(`
        INSERT INTO live_stream_compositions (workspace_id, state_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(workspace_id) DO UPDATE SET
          state_json = excluded.state_json,
          updated_at = excluded.updated_at
      `).run(workspaceId, JSON.stringify(state), Date.now());
      return state;
    },
    getRequest(workspaceId, idempotencyKey) {
      const row = database.prepare(`
        SELECT request_json
        FROM live_stream_composition_requests
        WHERE workspace_id = ? AND idempotency_key = ?
      `).get(workspaceId, idempotencyKey);
      if (!row) return null;
      try { return JSON.parse(row.request_json); } catch { return null; }
    },
    putRequest(workspaceId, idempotencyKey, value) {
      database.prepare(`
        INSERT INTO live_stream_composition_requests (
          workspace_id, idempotency_key, request_json, created_at
        ) VALUES (?, ?, ?, ?)
      `).run(workspaceId, idempotencyKey, JSON.stringify(value), Date.now());
    },
  };
}

function normalizeLayout(layout) {
  const value = String(layout || '').trim().toLowerCase();
  if (!SCENE_FOR_LAYOUT[value]) {
    throw controllerError('INVALID_COMPOSITOR_LAYOUT', 'Unknown fixed compositor layout', 400);
  }
  return value;
}

function normalizeAudioPolicy(policy) {
  const value = String(policy || AUDIO_POLICIES.CAMERA).trim().toLowerCase();
  if (!Object.values(AUDIO_POLICIES).includes(value)) {
    throw controllerError(
      'INVALID_AUDIO_POLICY',
      'Audio policy must be camera or content_replace',
      400,
    );
  }
  return value;
}

function createFixedCompositorController({
  obs,
  receiver,
  store = createMemoryCompositionStore(),
  randomUUID = crypto.randomUUID,
  now = Date.now,
} = {}) {
  if (!obs || !receiver) throw new TypeError('obs and receiver adapters are required');
  const workspaceQueues = new Map();

  async function runSerialized(workspaceId, operation) {
    const key = String(workspaceId || '');
    const previous = workspaceQueues.get(key) || Promise.resolve();
    const queued = previous.catch(() => {}).then(operation);
    workspaceQueues.set(key, queued);
    try {
      return await queued;
    } finally {
      if (workspaceQueues.get(key) === queued) workspaceQueues.delete(key);
    }
  }

  function stateFor(workspaceId) {
    if (!String(workspaceId || '')) throw controllerError('WORKSPACE_REQUIRED', 'Workspace is required', 400);
    return store.get(String(workspaceId));
  }

  function assertRevision(state, expectedRevision) {
    const expected = Number(expectedRevision);
    if (!Number.isInteger(expected) || expected < 0) {
      throw controllerError(
        'COMPOSITOR_REVISION_REQUIRED',
        'A non-negative expected compositor revision is required',
        400,
      );
    }
    if (expected !== Number(state.revision || 0)) {
      throw controllerError(
        'COMPOSITOR_REVISION_CONFLICT',
        `Expected compositor revision ${expected}, current revision is ${Number(state.revision || 0)}`,
        409,
      );
    }
  }

  function beginIdempotent(workspaceId, idempotencyKey, fingerprint) {
    const key = String(idempotencyKey || '').trim();
    if (!key) {
      throw controllerError('IDEMPOTENCY_KEY_REQUIRED', 'An idempotency key is required', 400);
    }
    const prior = store.getRequest(workspaceId, key);
    if (!prior) return { key, replay: null };
    if (prior.fingerprint !== fingerprint) {
      throw controllerError(
        'IDEMPOTENCY_KEY_REUSED',
        'The idempotency key was already used for a different compositor request',
        409,
      );
    }
    return {
      key,
      replay: { ...prior.response, idempotent_replay: true },
    };
  }

  function finishIdempotent(workspaceId, key, fingerprint, response) {
    store.putRequest(workspaceId, key, { fingerprint, response });
    return response;
  }

  function responseState(state) {
    return structuredClone(state);
  }

  async function applyAudioPolicy(policy, context = {}) {
    // Receiver policy is set first so OBS never unmutes an input whose player
    // still has stale audio authority. The OBS adapter itself silences both
    // inputs before enabling exactly one source.
    await receiver.setAudioPolicy(policy, context);
    return obs.setAudioPolicy(policy);
  }

  async function fallbackCameraOnlyUnlocked(workspaceId, context = {}) {
    const previous = stateFor(workspaceId);
    let cameraOnlyConfirmed = false;
    try { await applyAudioPolicy(AUDIO_POLICIES.CAMERA, context); } catch (_) {}
    try {
      const confirmation = await obs.setCurrentProgramSceneConfirmed(FIXED_SCENES.CAMERA_ONLY);
      cameraOnlyConfirmed = confirmation?.currentProgramSceneName === FIXED_SCENES.CAMERA_ONLY;
    } catch (_) {}
    const failure = context.failure || null;
    const fallback = {
      ...previous,
      requested_layout: LAYOUTS.CAMERA_ONLY,
      confirmed_layout: cameraOnlyConfirmed
        ? LAYOUTS.CAMERA_ONLY
        : previous.confirmed_layout,
      compositor_state: {
        ...previous.compositor_state,
        scene: cameraOnlyConfirmed
          ? FIXED_SCENES.CAMERA_ONLY
          : previous.compositor_state.scene,
        confirmed: cameraOnlyConfirmed,
        audio_policy: AUDIO_POLICIES.CAMERA,
      },
      failure_code: failure?.code || previous.failure_code || null,
      failure_message: failure?.message || previous.failure_message || null,
      request_id: randomUUID(),
      revision: Number(previous.revision || 0) + 1,
      updated_at: new Date(now()).toISOString(),
    };
    store.put(workspaceId, fallback);
    return fallback;
  }

  async function addContentUnlocked(input) {
    const workspaceId = String(input.workspaceId || '');
    const state = stateFor(workspaceId);
    const layout = normalizeLayout(input.layout);
    if (layout === LAYOUTS.CAMERA_ONLY) {
      throw controllerError('CONTENT_LAYOUT_REQUIRED', 'Content requires one of the two fixed PiP layouts', 400);
    }
    const contentInstanceId = String(input.contentInstanceId || '').trim();
    if (!contentInstanceId) {
      throw controllerError('CONTENT_INSTANCE_REQUIRED', 'content_instance_id is required', 400);
    }
    if (!input.source || !input.source.type) {
      throw controllerError('CONTENT_SOURCE_REQUIRED', 'A content or presentation source is required', 400);
    }
    const audioPolicy = normalizeAudioPolicy(input.audioPolicy);
    const fingerprint = stableFingerprint({
      action: 'add',
      source: input.source,
      content_instance_id: contentInstanceId,
      layout,
      audio_policy: audioPolicy,
      expected_revision: Number(input.expectedRevision),
    });
    const idempotent = beginIdempotent(workspaceId, input.idempotencyKey, fingerprint);
    if (idempotent.replay) return idempotent.replay;
    assertRevision(state, input.expectedRevision);
    const requestId = randomUUID();

    try {
      const receiverState = await receiver.assignContent({
        workspaceId,
        userId: input.userId || null,
        source: input.source,
        contentInstanceId,
        layout,
        requestId,
        io: input.io || null,
        contentContext: input.contentContext || null,
      });
      if (!receiverState || receiverState.confirmed !== true) {
        throw controllerError(
          'RECEIVER_RENDER_NOT_CONFIRMED',
          'Managed Live Program receiver did not confirm the requested content instance',
          502,
        );
      }
      await applyAudioPolicy(audioPolicy, {
        workspaceId,
        io: input.io || null,
        revision: Number(state.revision || 0) + 1,
      });
      const sceneName = SCENE_FOR_LAYOUT[layout];
      const confirmedScene = await obs.setCurrentProgramSceneConfirmed(sceneName);
      const next = {
        workspace_id: workspaceId,
        accepted: true,
        request_id: requestId,
        requested_layout: layout,
        confirmed_layout: layout,
        content_source: input.source,
        content_instance_id: contentInstanceId,
        receiver_state: {
          configured: true,
          content_active: true,
          render_ready: true,
          content_id: receiverState.contentId || input.source.contentId || null,
          content_instance_id: contentInstanceId,
          playlist_revision: receiverState.playlistRevision || null,
          render_generation: receiverState.renderGeneration ?? null,
          render_state: receiverState.renderState || 'ready',
        },
        compositor_state: {
          available: true,
          scene: confirmedScene.currentProgramSceneName,
          confirmed: confirmedScene.currentProgramSceneName === sceneName,
          audio_policy: audioPolicy,
        },
        failure_code: null,
        failure_message: null,
        revision: Number(state.revision || 0) + 1,
        updated_at: new Date(now()).toISOString(),
      };
      store.put(workspaceId, next);
      return finishIdempotent(workspaceId, idempotent.key, fingerprint, responseState(next));
    } catch (error) {
      await fallbackCameraOnlyUnlocked(workspaceId, {
        workspaceId,
        io: input.io || null,
        failure: error,
      });
      throw error;
    }
  }

  async function setLayoutUnlocked(input) {
    const workspaceId = String(input.workspaceId || '');
    const state = stateFor(workspaceId);
    const layout = normalizeLayout(input.layout);
    const audioPolicy = normalizeAudioPolicy(input.audioPolicy || state.compositor_state.audio_policy);
    const fingerprint = stableFingerprint({
      action: 'layout',
      layout,
      audio_policy: audioPolicy,
      expected_revision: Number(input.expectedRevision),
    });
    const idempotent = beginIdempotent(workspaceId, input.idempotencyKey, fingerprint);
    if (idempotent.replay) return idempotent.replay;
    assertRevision(state, input.expectedRevision);
    if (layout !== LAYOUTS.CAMERA_ONLY && !state.content_instance_id) {
      throw controllerError('LIVE_CONTENT_REQUIRED', 'Add confirmed live content before selecting a PiP layout', 409);
    }
    const requestId = randomUUID();
    try {
      await applyAudioPolicy(audioPolicy, {
        workspaceId,
        io: input.io || null,
        revision: Number(state.revision || 0) + 1,
      });
      const sceneName = SCENE_FOR_LAYOUT[layout];
      const confirmed = await obs.setCurrentProgramSceneConfirmed(sceneName);
      const next = {
        ...state,
        accepted: true,
        request_id: requestId,
        requested_layout: layout,
        confirmed_layout: layout,
        compositor_state: {
          available: true,
          scene: confirmed.currentProgramSceneName,
          confirmed: confirmed.currentProgramSceneName === sceneName,
          audio_policy: audioPolicy,
        },
        failure_code: null,
        failure_message: null,
        revision: Number(state.revision || 0) + 1,
        updated_at: new Date(now()).toISOString(),
      };
      store.put(workspaceId, next);
      return finishIdempotent(workspaceId, idempotent.key, fingerprint, responseState(next));
    } catch (error) {
      await fallbackCameraOnlyUnlocked(workspaceId, {
        workspaceId,
        io: input.io || null,
        failure: error,
      });
      throw error;
    }
  }

  async function removeContentUnlocked(input) {
    const workspaceId = String(input.workspaceId || '');
    const state = stateFor(workspaceId);
    const requestedInstance = String(input.contentInstanceId || '').trim();
    const fingerprint = stableFingerprint({
      action: 'remove',
      content_instance_id: requestedInstance || null,
      expected_revision: Number(input.expectedRevision),
    });
    const idempotent = beginIdempotent(workspaceId, input.idempotencyKey, fingerprint);
    if (idempotent.replay) return idempotent.replay;
    assertRevision(state, input.expectedRevision);
    if (requestedInstance && state.content_instance_id && requestedInstance !== state.content_instance_id) {
      throw controllerError(
        'CONTENT_INSTANCE_CONFLICT',
        'Requested content instance is no longer active',
        409,
      );
    }
    const requestId = randomUUID();
    try {
      await applyAudioPolicy(AUDIO_POLICIES.CAMERA, {
        workspaceId,
        io: input.io || null,
        revision: Number(state.revision || 0) + 1,
      });
      const confirmed = await obs.setCurrentProgramSceneConfirmed(FIXED_SCENES.CAMERA_ONLY);
      const cleared = await receiver.clearContent({
        workspaceId,
        contentInstanceId: state.content_instance_id,
        requestId,
        io: input.io || null,
      });
      if (!cleared || cleared.confirmed !== true) {
        throw controllerError(
          'RECEIVER_CLEAR_NOT_CONFIRMED',
          'Managed Live Program receiver did not confirm content removal',
          502,
        );
      }
      const next = {
        workspace_id: workspaceId,
        accepted: true,
        request_id: requestId,
        requested_layout: LAYOUTS.CAMERA_ONLY,
        confirmed_layout: LAYOUTS.CAMERA_ONLY,
        content_source: null,
        content_instance_id: null,
        receiver_state: {
          configured: true,
          content_active: false,
          render_ready: false,
          cleared: true,
        },
        compositor_state: {
          available: true,
          scene: confirmed.currentProgramSceneName,
          confirmed: confirmed.currentProgramSceneName === FIXED_SCENES.CAMERA_ONLY,
          audio_policy: AUDIO_POLICIES.CAMERA,
        },
        failure_code: null,
        failure_message: null,
        revision: Number(state.revision || 0) + 1,
        updated_at: new Date(now()).toISOString(),
      };
      store.put(workspaceId, next);
      return finishIdempotent(workspaceId, idempotent.key, fingerprint, responseState(next));
    } catch (error) {
      await fallbackCameraOnlyUnlocked(workspaceId, {
        workspaceId,
        io: input.io || null,
        failure: error,
      });
      throw error;
    }
  }

  async function selectCameraOnlyUnlocked(input) {
    const state = stateFor(String(input.workspaceId || ''));
    if (state.content_instance_id) {
      return setLayoutUnlocked({ ...input, layout: LAYOUTS.CAMERA_ONLY });
    }
    const workspaceId = String(input.workspaceId || '');
    const fingerprint = stableFingerprint({
      action: 'camera_only',
      expected_revision: Number(input.expectedRevision),
    });
    const idempotent = beginIdempotent(workspaceId, input.idempotencyKey, fingerprint);
    if (idempotent.replay) return idempotent.replay;
    assertRevision(state, input.expectedRevision);
    await applyAudioPolicy(AUDIO_POLICIES.CAMERA, {
      workspaceId,
      io: input.io || null,
      revision: Number(state.revision || 0) + 1,
    });
    const confirmed = await obs.setCurrentProgramSceneConfirmed(FIXED_SCENES.CAMERA_ONLY);
    const next = {
      ...state,
      accepted: true,
      request_id: randomUUID(),
      requested_layout: LAYOUTS.CAMERA_ONLY,
      confirmed_layout: LAYOUTS.CAMERA_ONLY,
      compositor_state: {
        available: true,
        scene: confirmed.currentProgramSceneName,
        confirmed: confirmed.currentProgramSceneName === FIXED_SCENES.CAMERA_ONLY,
        audio_policy: AUDIO_POLICIES.CAMERA,
      },
      failure_code: null,
      failure_message: null,
      revision: Number(state.revision || 0) + 1,
      updated_at: new Date(now()).toISOString(),
    };
    store.put(workspaceId, next);
    return finishIdempotent(workspaceId, idempotent.key, fingerprint, responseState(next));
  }

  return {
    getComposition(workspaceId) {
      return responseState(stateFor(String(workspaceId || '')));
    },
    async health(workspaceId) {
      const [composition, obsHealth] = await Promise.all([
        Promise.resolve(responseState(stateFor(String(workspaceId || '')))),
        obs.health(),
      ]);
      return { composition, obs: obsHealth };
    },
    addContent(input) {
      return runSerialized(input?.workspaceId, () => addContentUnlocked(input || {}));
    },
    fallbackCameraOnly(workspaceId, context = {}) {
      return runSerialized(workspaceId, () => fallbackCameraOnlyUnlocked(workspaceId, context));
    },
    removeContent(input) {
      return runSerialized(input?.workspaceId, () => removeContentUnlocked(input || {}));
    },
    selectCameraOnly(input) {
      return runSerialized(input?.workspaceId, () => selectCameraOnlyUnlocked(input || {}));
    },
    setLayout(input) {
      return runSerialized(input?.workspaceId, () => setLayoutUnlocked(input || {}));
    },
  };
}

let defaultController = null;

function getFixedCompositorController() {
  if (defaultController) return defaultController;
  const config = require('../config');
  const { db } = require('../db/database');
  const { ObsWebSocketV5 } = require('./obs-websocket-v5');
  const receiver = require('./live-program-receiver');
  let obs;
  try {
    obs = new ObsWebSocketV5({
      url: config.liveStream.obsWebSocketUrl,
      password: config.liveStream.obsWebSocketPassword,
      requestTimeoutMs: config.liveStream.obsRequestTimeoutMs,
      cameraInputName: config.liveStream.obsCameraInputName,
      contentInputName: config.liveStream.obsContentInputName,
    });
  } catch (configurationError) {
    obs = {
      async health() {
        return {
          available: false,
          code: configurationError.code || 'OBS_NOT_CONFIGURED',
          message: configurationError.message,
        };
      },
      async setCurrentProgramSceneConfirmed() { throw configurationError; },
      async setAudioPolicy() { throw configurationError; },
      async getStreamStatus() { throw configurationError; },
      async startStreaming() { throw configurationError; },
      async stopStreaming() { throw configurationError; },
    };
  }
  defaultController = createFixedCompositorController({
    obs,
    receiver,
    store: createSqlCompositionStore(db),
  });
  defaultController.obs = obs;
  return defaultController;
}

function resetFixedCompositorControllerForTests() {
  if (defaultController && defaultController.obs && typeof defaultController.obs.close === 'function') {
    defaultController.obs.close();
  }
  defaultController = null;
}

module.exports = {
  AUDIO_POLICIES,
  FIXED_SCENES,
  LAYOUTS,
  PUBLISHER_MODES,
  SCENE_FOR_LAYOUT,
  createFixedCompositorController,
  createMemoryCompositionStore,
  createSqlCompositionStore,
  getFixedCompositorController,
  resetFixedCompositorControllerForTests,
};
