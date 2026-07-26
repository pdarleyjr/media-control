'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  AUDIO_POLICIES,
  FIXED_SCENES,
  LAYOUTS,
  createFixedCompositorController,
} = require('../lib/fixed-compositor-controller');

function harness(overrides = {}) {
  const calls = [];
  let currentScene = FIXED_SCENES.CAMERA_ONLY;
  const obs = {
    async health() {
      calls.push(['obs.health']);
      return { available: true, version: 'test', currentProgramSceneName: currentScene };
    },
    async setCurrentProgramSceneConfirmed(sceneName) {
      calls.push(['obs.scene', sceneName]);
      currentScene = sceneName;
      return { currentProgramSceneName: sceneName };
    },
    async setAudioPolicy(policy) {
      calls.push(['obs.audio', policy]);
      return { policy, mixed: false };
    },
    ...overrides.obs,
  };
  const receiver = {
    async assignContent(input) {
      calls.push(['receiver.assign', input.contentInstanceId, input.layout]);
      return {
        confirmed: true,
        contentId: input.source.contentId,
        contentInstanceId: input.contentInstanceId,
        playlistRevision: 'playlist-revision-1',
        renderGeneration: 7,
        renderState: 'playing',
      };
    },
    async clearContent(input) {
      calls.push(['receiver.clear', input.contentInstanceId]);
      return { confirmed: true, cleared: true };
    },
    async setAudioPolicy(policy) {
      calls.push(['receiver.audio', policy]);
      return { policy };
    },
    ...overrides.receiver,
  };
  const controller = createFixedCompositorController({
    obs,
    receiver,
    randomUUID: (() => {
      let id = 0;
      return () => `request-${++id}`;
    })(),
  });
  return { calls, controller, obs, receiver };
}

test('fixed compositor exposes exactly the three authoritative scenes', () => {
  assert.deepEqual(FIXED_SCENES, {
    CAMERA_ONLY: 'MBFD_CAMERA_ONLY',
    CONTENT_MAIN_CAMERA_PIP: 'MBFD_CONTENT_MAIN_CAMERA_PIP',
    CAMERA_MAIN_CONTENT_PIP: 'MBFD_CAMERA_MAIN_CONTENT_PIP',
  });
  assert.deepEqual(Object.values(FIXED_SCENES), [
    'MBFD_CAMERA_ONLY',
    'MBFD_CONTENT_MAIN_CAMERA_PIP',
    'MBFD_CAMERA_MAIN_CONTENT_PIP',
  ]);
});

test('adding content waits for exact receiver render confirmation before switching scene', async () => {
  const { calls, controller } = harness();
  const result = await controller.addContent({
    workspaceId: 'workspace-a',
    source: { type: 'content', contentId: 'content-a' },
    contentInstanceId: 'instance-a',
    layout: LAYOUTS.CONTENT_MAIN_CAMERA_PIP,
    audioPolicy: AUDIO_POLICIES.CAMERA,
    idempotencyKey: 'idem-a',
    expectedRevision: 0,
  });

  assert.equal(result.accepted, true);
  assert.equal(result.confirmed_layout, LAYOUTS.CONTENT_MAIN_CAMERA_PIP);
  assert.equal(result.content_instance_id, 'instance-a');
  assert.equal(result.receiver_state.render_ready, true);
  assert.equal(result.compositor_state.scene, FIXED_SCENES.CONTENT_MAIN_CAMERA_PIP);
  assert.equal(result.revision, 1);
  assert.deepEqual(calls, [
    ['receiver.assign', 'instance-a', LAYOUTS.CONTENT_MAIN_CAMERA_PIP],
    ['receiver.audio', AUDIO_POLICIES.CAMERA],
    ['obs.audio', AUDIO_POLICIES.CAMERA],
    ['obs.scene', FIXED_SCENES.CONTENT_MAIN_CAMERA_PIP],
  ]);
});

test('same idempotency key replays safely while a changed request is rejected', async () => {
  const { controller } = harness();
  const input = {
    workspaceId: 'workspace-a',
    source: { type: 'content', contentId: 'content-a' },
    contentInstanceId: 'instance-a',
    layout: LAYOUTS.CAMERA_MAIN_CONTENT_PIP,
    audioPolicy: AUDIO_POLICIES.CAMERA,
    idempotencyKey: 'idem-a',
    expectedRevision: 0,
  };
  const first = await controller.addContent(input);
  const replay = await controller.addContent(input);
  assert.equal(first.revision, 1);
  assert.equal(replay.idempotent_replay, true);
  assert.equal(replay.revision, 1);

  await assert.rejects(
    () => controller.addContent({
      ...input,
      source: { type: 'content', contentId: 'content-b' },
    }),
    (error) => error && error.code === 'IDEMPOTENCY_KEY_REUSED',
  );
});

test('concurrent duplicate requests are serialized and mutate the receiver only once', async () => {
  let releaseAssignment;
  let assignmentStarted;
  const gate = new Promise((resolve) => { releaseAssignment = resolve; });
  const started = new Promise((resolve) => { assignmentStarted = resolve; });
  let assignmentCount = 0;
  const { controller } = harness({
    receiver: {
      async assignContent(input) {
        assignmentCount += 1;
        assignmentStarted();
        await gate;
        return {
          confirmed: true,
          contentId: input.source.contentId,
          contentInstanceId: input.contentInstanceId,
          playlistRevision: 'playlist-revision-concurrent',
          renderGeneration: 8,
          renderState: 'playing',
        };
      },
    },
  });
  const input = {
    workspaceId: 'workspace-concurrent',
    source: { type: 'content', contentId: 'content-concurrent' },
    contentInstanceId: 'instance-concurrent',
    layout: LAYOUTS.CONTENT_MAIN_CAMERA_PIP,
    audioPolicy: AUDIO_POLICIES.CAMERA,
    idempotencyKey: 'idem-concurrent',
    expectedRevision: 0,
  };

  const firstPromise = controller.addContent(input);
  await started;
  const replayPromise = controller.addContent(input);
  releaseAssignment();
  const [first, replay] = await Promise.all([firstPromise, replayPromise]);

  assert.equal(assignmentCount, 1);
  assert.equal(first.revision, 1);
  assert.equal(replay.revision, 1);
  assert.equal(replay.idempotent_replay, true);
});

test('stale expected revision is rejected before receiver or OBS mutation', async () => {
  const { calls, controller } = harness();
  await assert.rejects(
    () => controller.setLayout({
      workspaceId: 'workspace-a',
      layout: LAYOUTS.CAMERA_MAIN_CONTENT_PIP,
      idempotencyKey: 'layout-a',
      expectedRevision: 4,
    }),
    (error) => error && error.code === 'COMPOSITOR_REVISION_CONFLICT',
  );
  assert.deepEqual(calls, []);
});

test('receiver or scene failure returns to Camera Only without stopping the publisher', async () => {
  const { calls, controller } = harness({
    obs: {
      async setCurrentProgramSceneConfirmed(sceneName) {
        calls.push(['obs.scene', sceneName]);
        if (sceneName !== FIXED_SCENES.CAMERA_ONLY) {
          const error = new Error('program scene was not confirmed');
          error.code = 'OBS_SCENE_NOT_CONFIRMED';
          throw error;
        }
        return { currentProgramSceneName: sceneName };
      },
    },
  });

  await assert.rejects(
    () => controller.addContent({
      workspaceId: 'workspace-a',
      source: { type: 'content', contentId: 'content-a' },
      contentInstanceId: 'instance-a',
      layout: LAYOUTS.CONTENT_MAIN_CAMERA_PIP,
      audioPolicy: AUDIO_POLICIES.CAMERA,
      idempotencyKey: 'idem-failure',
      expectedRevision: 0,
    }),
    (error) => error && error.code === 'OBS_SCENE_NOT_CONFIRMED',
  );
  assert.deepEqual(calls.slice(-3), [
    ['receiver.audio', AUDIO_POLICIES.CAMERA],
    ['obs.audio', AUDIO_POLICIES.CAMERA],
    ['obs.scene', FIXED_SCENES.CAMERA_ONLY],
  ]);
  assert.equal(calls.some(([name]) => name === 'obs.stopStreaming'), false);
});

test('failed Camera Only fallback is never reported as confirmed', async () => {
  const { controller } = harness({
    obs: {
      async setCurrentProgramSceneConfirmed() {
        const error = new Error('OBS unavailable');
        error.code = 'OBS_CONNECTION_CLOSED';
        throw error;
      },
    },
  });

  await assert.rejects(
    () => controller.addContent({
      workspaceId: 'workspace-fallback-failure',
      source: { type: 'content', contentId: 'content-a' },
      contentInstanceId: 'instance-a',
      layout: LAYOUTS.CONTENT_MAIN_CAMERA_PIP,
      audioPolicy: AUDIO_POLICIES.CAMERA,
      idempotencyKey: 'idem-fallback-failure',
      expectedRevision: 0,
    }),
    (error) => error && error.code === 'OBS_CONNECTION_CLOSED',
  );
  const state = controller.getComposition('workspace-fallback-failure');
  assert.equal(state.compositor_state.confirmed, false);
  assert.equal(state.failure_code, 'OBS_CONNECTION_CLOSED');
});

test('content audio is explicit and replace-not-mix at both receiver and OBS', async () => {
  const { calls, controller } = harness();
  await controller.addContent({
    workspaceId: 'workspace-a',
    source: { type: 'content', contentId: 'content-a' },
    contentInstanceId: 'instance-a',
    layout: LAYOUTS.CONTENT_MAIN_CAMERA_PIP,
    audioPolicy: AUDIO_POLICIES.CONTENT_REPLACE,
    idempotencyKey: 'idem-audio',
    expectedRevision: 0,
  });
  assert.deepEqual(calls.slice(1, 3), [
    ['receiver.audio', AUDIO_POLICIES.CONTENT_REPLACE],
    ['obs.audio', AUDIO_POLICIES.CONTENT_REPLACE],
  ]);
});

test('removing content confirms Camera Only before clearing the receiver', async () => {
  const { calls, controller } = harness();
  await controller.addContent({
    workspaceId: 'workspace-a',
    source: { type: 'content', contentId: 'content-a' },
    contentInstanceId: 'instance-a',
    layout: LAYOUTS.CONTENT_MAIN_CAMERA_PIP,
    audioPolicy: AUDIO_POLICIES.CAMERA,
    idempotencyKey: 'idem-a',
    expectedRevision: 0,
  });
  calls.length = 0;

  const removed = await controller.removeContent({
    workspaceId: 'workspace-a',
    contentInstanceId: 'instance-a',
    idempotencyKey: 'remove-a',
    expectedRevision: 1,
  });
  assert.equal(removed.confirmed_layout, LAYOUTS.CAMERA_ONLY);
  assert.equal(removed.content_instance_id, null);
  assert.deepEqual(calls, [
    ['receiver.audio', AUDIO_POLICIES.CAMERA],
    ['obs.audio', AUDIO_POLICIES.CAMERA],
    ['obs.scene', FIXED_SCENES.CAMERA_ONLY],
    ['receiver.clear', 'instance-a'],
  ]);
});

test('receiver clear failure retains content for retry but records Camera Only as the only confirmed layout', async () => {
  const { controller } = harness({
    receiver: {
      async clearContent() {
        const error = new Error('receiver clear timed out');
        error.code = 'RECEIVER_CLEAR_TIMEOUT';
        throw error;
      },
    },
  });
  await controller.addContent({
    workspaceId: 'workspace-clear-failure',
    source: { type: 'content', contentId: 'content-a' },
    contentInstanceId: 'instance-a',
    layout: LAYOUTS.CONTENT_MAIN_CAMERA_PIP,
    audioPolicy: AUDIO_POLICIES.CAMERA,
    idempotencyKey: 'idem-clear-failure-add',
    expectedRevision: 0,
  });

  await assert.rejects(
    () => controller.removeContent({
      workspaceId: 'workspace-clear-failure',
      contentInstanceId: 'instance-a',
      idempotencyKey: 'idem-clear-failure-remove',
      expectedRevision: 1,
    }),
    (error) => error && error.code === 'RECEIVER_CLEAR_TIMEOUT',
  );
  const state = controller.getComposition('workspace-clear-failure');
  assert.equal(state.confirmed_layout, LAYOUTS.CAMERA_ONLY);
  assert.equal(state.compositor_state.scene, FIXED_SCENES.CAMERA_ONLY);
  assert.equal(state.compositor_state.confirmed, true);
  assert.equal(state.content_instance_id, 'instance-a');
  assert.equal(state.failure_code, 'RECEIVER_CLEAR_TIMEOUT');
});
