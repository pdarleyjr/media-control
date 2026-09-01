'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  confirmHostMuted,
  createAudioPolicyController,
  createRendererSessionId,
  normalizeAudioPolicy,
} = require('../player/audio-policy');

function policy(overrides = {}) {
  return {
    version: 1,
    output_device_id: 'tv1',
    owner_device_id: 'tv2',
    content_instance_id: 'broadcast-new',
    transaction_id: 'broadcast-new',
    generation: 8,
    revision: 200,
    playlist_revision: 'playlist-new',
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    content_instance_ids: ['broadcast-new'],
    content_generations: [8],
    playlist_revision: 'playlist-new',
    ...overrides,
  };
}

test('renderer session identity prefers randomUUID, securely falls back, and otherwise fails closed', () => {
  let fallbackCalls = 0;
  assert.equal(createRendererSessionId({
    randomUUID: () => 'preferred-random-uuid',
    getRandomValues: () => {
      fallbackCalls += 1;
      throw new Error('fallback must not run');
    },
  }), 'preferred-random-uuid');
  assert.equal(fallbackCalls, 0);

  const fallback = createRendererSessionId({
    getRandomValues: (bytes) => {
      for (let index = 0; index < bytes.length; index += 1) bytes[index] = index;
      return bytes;
    },
  });
  assert.equal(fallback, 'renderer-000102030405060708090a0b0c0d0e0f');
  assert.throws(
    () => createRendererSessionId(null),
    /secure renderer session identity unavailable/,
  );
  assert.throws(
    () => createRendererSessionId({}),
    /secure renderer session identity unavailable/,
  );

  const source = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const initialization = source.slice(
    source.indexOf('const rendererSessionId'),
    source.indexOf('const managedAudioConfig'),
  );
  assert.match(initialization, /createRendererSessionId\(window\.crypto\)/);
  assert.doesNotMatch(initialization, /Math\.random/);
});

test('normalization derives per-renderer mute state without changing the physical TV1/eARC output', () => {
  assert.deepEqual(normalizeAudioPolicy(policy(), 'tv2'), {
    version: 1,
    output_device_id: 'tv1',
    owner_device_id: 'tv2',
    content_instance_id: 'broadcast-new',
    transaction_id: 'broadcast-new',
    generation: 8,
    revision: 200,
    playlist_revision: 'playlist-new',
    audio_allowed: true,
    force_muted: false,
  });
  assert.equal(normalizeAudioPolicy(policy(), 'tv3').audio_allowed, false);
  assert.equal(normalizeAudioPolicy(policy(), 'tv3').force_muted, true);
});

test('missing or non-positive-safe ownership epochs are rejected before they can grant audio', () => {
  for (const invalid of [
    { generation: null },
    { generation: 0 },
    { generation: 1.5 },
    { revision: null },
    { revision: -1 },
    { revision: Number.MAX_SAFE_INTEGER + 1 },
    { transaction_id: null },
    { content_instance_id: null },
    { output_device_id: null },
  ]) {
    assert.equal(normalizeAudioPolicy(policy(invalid), 'tv2'), null);
  }
});

test('one same-content policy makes only its deterministic owner audible', () => {
  const controllers = ['tv1', 'tv2', 'tv3'].map((deviceId) => (
    createAudioPolicyController({ deviceId, fallbackAllowed: deviceId === 'tv1' })
  ));
  for (const controller of controllers) {
    const result = controller.apply(policy(), context());
    assert.equal(result.applied, true);
  }
  assert.deepEqual(controllers.map((controller) => controller.audioAllowed()), [false, true, false]);
});

test('every TV1-TV5 ownership choice yields exactly one audible renderer', () => {
  const deviceIds = ['tv1', 'tv2', 'tv3', 'tv4', 'tv5'];
  for (const ownerDeviceId of deviceIds) {
    const allowed = deviceIds.map((deviceId) => {
      const controller = createAudioPolicyController({ deviceId, fallbackAllowed: deviceId === 'tv1' });
      assert.equal(controller.apply(policy({ owner_device_id: ownerDeviceId }), context()).applied, true);
      return controller.audioAllowed();
    });
    assert.equal(allowed.filter(Boolean).length, 1);
    assert.equal(allowed[deviceIds.indexOf(ownerDeviceId)], true);
  }
});

test('cold start is muted until a durable or fresh authoritative policy is applied', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv1', fallbackAllowed: true });
  assert.equal(controller.isBlocked(), true);
  assert.equal(controller.audioAllowed(), false);
  controller.clear();
  assert.equal(controller.isBlocked(), false);
  assert.equal(controller.audioAllowed(), true);
});

test('stale generation and transaction cannot re-enable a former owner', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv3', fallbackAllowed: false });
  assert.equal(controller.apply(policy({ owner_device_id: 'tv2' }), context()).applied, true);
  const stale = controller.apply(policy({
    owner_device_id: 'tv3',
    content_instance_id: 'broadcast-old',
    transaction_id: 'broadcast-old',
    generation: 7,
    revision: 199,
    playlist_revision: 'playlist-old',
  }), context({ content_instance_ids: ['broadcast-old'], playlist_revision: 'playlist-old' }));
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale_audio_policy');
  assert.equal(controller.audioAllowed(), false);
  assert.equal(controller.snapshot().owner_device_id, 'tv2');
});

test('a stale lower revision fail-mutes the current owner before context validation', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: true });
  assert.equal(controller.apply(policy(), context()).applied, true);
  assert.equal(controller.audioAllowed(), true);
  const stale = controller.apply(policy({
    content_instance_id: 'broadcast-old',
    transaction_id: 'broadcast-old',
    generation: 7,
    revision: 199,
    playlist_revision: 'playlist-old',
  }), context({
    content_instance_ids: ['broadcast-old'],
    content_generations: [7],
    playlist_revision: 'playlist-old',
  }));
  assert.equal(stale.applied, false);
  assert.equal(stale.reason, 'stale_audio_policy');
  assert.equal(controller.audioAllowed(), false);
});

test('a policy for a different content instance or playlist revision fails muted', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: false });
  const wrongContent = controller.apply(policy(), context({ content_instance_ids: ['another-content'] }));
  assert.equal(wrongContent.applied, false);
  assert.equal(wrongContent.reason, 'audio_content_instance_mismatch');
  assert.equal(controller.audioAllowed(), false);

  const wrongPlaylist = controller.apply(policy(), context({ playlist_revision: 'another-playlist' }));
  assert.equal(wrongPlaylist.applied, false);
  assert.equal(wrongPlaylist.reason, 'audio_playlist_revision_mismatch');
  assert.equal(controller.audioAllowed(), false);
});

test('a former owner fails muted when a newer policy does not match mounted content', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: true });
  assert.equal(controller.apply(policy(), context()).applied, true);
  assert.equal(controller.audioAllowed(), true);
  const mismatch = controller.apply(policy({
    transaction_id: 'broadcast-next',
    content_instance_id: 'broadcast-next',
    revision: 201,
  }), context());
  assert.equal(mismatch.applied, false);
  assert.equal(mismatch.reason, 'audio_content_instance_mismatch');
  assert.equal(controller.audioAllowed(), false);
});

test('content generation mismatch is rejected and cannot grant audio', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: true });
  const mismatch = controller.apply(policy({ generation: 7 }), context());
  assert.equal(mismatch.applied, false);
  assert.equal(mismatch.reason, 'audio_generation_mismatch');
  assert.equal(controller.audioAllowed(), false);
});

test('same revision with a conflicting transaction is rejected without owner oscillation', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: false });
  controller.apply(policy(), context());
  const conflict = controller.apply(policy({
    transaction_id: 'conflicting-transaction',
    owner_device_id: 'tv3',
  }), context());
  assert.equal(conflict.applied, false);
  assert.equal(conflict.reason, 'audio_policy_revision_conflict');
  assert.equal(controller.audioAllowed(), false);

  const sameTransactionDifferentOwner = controller.apply(policy({
    owner_device_id: 'tv3',
  }), context());
  assert.equal(sameTransactionDifferentOwner.applied, false);
  assert.equal(sameTransactionDifferentOwner.reason, 'audio_policy_revision_conflict');
  assert.equal(controller.audioAllowed(), false);
});

test('heartbeat/state fields preserve the accepted owner decision without recomputing it', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv4', fallbackAllowed: false });
  controller.apply(policy({ owner_device_id: 'tv4' }), context());
  assert.deepEqual(controller.stateFields(), {
    audio_owner_device_id: 'tv4',
    audio_output_device_id: 'tv1',
    audio_policy_transaction_id: 'broadcast-new',
    audio_policy_generation: 8,
    audio_policy_revision: 200,
  });
  assert.equal(controller.audioAllowed(), true);
});

test('presentation/video transport operations do not mutate playlist-owned audio state', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv5', fallbackAllowed: false });
  controller.apply(policy({ owner_device_id: 'tv5' }), context());
  for (const action of ['play', 'pause', 'seek', 'restart', 'go_to_slide']) {
    assert.equal(controller.audioAllowed(), true, `${action} preserves owner`);
    assert.equal(controller.snapshot().transaction_id, 'broadcast-new');
  }
});

test('a kiosk restart reconstructs the same policy from the durable playlist payload', () => {
  const before = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: false });
  before.apply(policy(), context());
  const durablePolicy = before.snapshot();
  const after = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: false });
  const restored = after.apply(durablePolicy, context());
  assert.equal(restored.applied, true);
  assert.equal(after.audioAllowed(), true);
  assert.equal(after.snapshot().transaction_id, 'broadcast-new');
});

test('owner loss policy with no replacement owner fails every renderer muted', () => {
  for (const deviceId of ['tv1', 'tv2', 'tv3', 'tv4', 'tv5']) {
    const controller = createAudioPolicyController({ deviceId, fallbackAllowed: deviceId === 'tv1' });
    controller.apply(policy({ owner_device_id: null, revision: 201 }), context());
    assert.equal(controller.audioAllowed(), false);
  }
});

test('mute fence blocks an old owner immediately and only its exact final generation may grant audio', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv2', fallbackAllowed: true });
  assert.equal(controller.apply(policy({ revision: 200 }), context()).applied, true);
  assert.equal(controller.audioAllowed(), true);

  const fenced = controller.fence(policy({
    transaction_id: 'broadcast-next',
    content_instance_id: 'broadcast-next',
    generation: 9,
    revision: 201,
  }));
  assert.equal(fenced.applied, true);
  assert.equal(controller.audioAllowed(), false);
  assert.deepEqual(controller.statusSnapshot(), {
    ...policy({
      owner_device_id: null,
      transaction_id: 'broadcast-next',
      content_instance_id: 'broadcast-next',
      generation: 9,
      revision: 201,
    }),
    audio_allowed: false,
    force_muted: true,
  });
  assert.equal(controller.snapshot().transaction_id, 'broadcast-new');

  const late = controller.apply(policy({ revision: 200 }), context());
  assert.equal(late.applied, false);
  assert.equal(late.reason, 'stale_audio_policy');
  assert.equal(controller.audioAllowed(), false);

  const conflict = controller.apply(policy({
    transaction_id: 'wrong-next',
    content_instance_id: 'broadcast-next',
    generation: 9,
    revision: 201,
  }), context({ content_instance_ids: ['broadcast-next'], content_generations: [9] }));
  assert.equal(conflict.applied, false);
  assert.equal(conflict.reason, 'audio_policy_fence_conflict');
  assert.equal(controller.audioAllowed(), false);

  const wrongGeneration = controller.apply(policy({
    transaction_id: 'broadcast-next',
    content_instance_id: 'broadcast-next',
    generation: 8,
    revision: 201,
  }), context({ content_instance_ids: ['broadcast-next'], content_generations: [8] }));
  assert.equal(wrongGeneration.applied, false);
  assert.equal(wrongGeneration.reason, 'audio_policy_fence_conflict');
  assert.equal(controller.audioAllowed(), false);

  const committed = controller.apply(policy({
    transaction_id: 'broadcast-next',
    content_instance_id: 'broadcast-next',
    generation: 9,
    revision: 201,
  }), context({ content_instance_ids: ['broadcast-next'], content_generations: [9] }));
  assert.equal(committed.applied, true);
  assert.equal(controller.audioAllowed(), true);
});

test('disconnect block cannot be cleared by a legacy missing-policy payload', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv1', fallbackAllowed: true });
  controller.apply(policy({ owner_device_id: 'tv1' }), context());
  assert.equal(controller.audioAllowed(), true);
  controller.block('socket_disconnected');
  assert.equal(controller.audioAllowed(), false);
  assert.equal(controller.blockReason(), 'socket_disconnected');
});

test('authorization revocation cannot be cleared by a late ownership policy before reauthentication', () => {
  const controller = createAudioPolicyController({ deviceId: 'tv2' });
  assert.equal(controller.apply(policy(), context()).applied, true);
  assert.equal(controller.audioAllowed(), true);

  controller.revokeAuthorization('device_auth_rejected');
  for (const candidate of [
    policy(),
    policy({ transaction_id: 'broadcast-late', revision: 201 }),
  ]) {
    const result = controller.apply(candidate, context());
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'device_auth_rejected');
    assert.equal(controller.audioAllowed(), false);
  }
  controller.clear();
  assert.equal(controller.audioAllowed(), false);
  assert.equal(controller.blockReason(), 'device_auth_rejected');

  controller.restoreAuthorization();
  const restored = controller.apply(
    policy({ transaction_id: 'broadcast-restored', revision: 202 }),
    context(),
  );
  assert.equal(restored.applied, true);
  assert.equal(controller.audioAllowed(), true);
});

test('host mute confirmation is bounded and accepts only the exact renderer generation', async () => {
  const state = {
    version: 1,
    device_id: 'tv2',
    renderer_session_id: 'renderer-new',
    transaction_id: 'broadcast-new',
    revision: 200,
    generation: 8,
  };
  let release;
  const pending = confirmHostMuted({
    bridge: {
      confirmHostMuted(request) {
        assert.deepEqual(request, state);
        return new Promise((resolve) => { release = resolve; });
      },
    },
    state,
    timeoutMs: 50,
  });
  release({
    ...state,
    confirmed: true,
    process_muted: true,
  });
  assert.deepEqual(await pending, { confirmed: true, reason: null });

  assert.equal((await confirmHostMuted({
    bridge: { confirmHostMuted: async () => ({
      ...state,
      generation: 7,
      confirmed: true,
      process_muted: true,
    }) },
    state,
    timeoutMs: 50,
  })).confirmed, false);

  assert.deepEqual(await confirmHostMuted({ bridge: null, state, timeoutMs: 50 }), {
    confirmed: false,
    reason: 'host_mute_bridge_unavailable',
  });
  assert.deepEqual(await confirmHostMuted({
    bridge: { confirmHostMuted: () => new Promise(() => {}) },
    state,
    timeoutMs: 5,
  }), {
    confirmed: false,
    reason: 'host_mute_confirmation_timeout',
  });
});

test('managed player installs authoritative policy before rendering and retains its fence contract', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  assert.match(source, /<script src="\/player\/audio-policy\.js"><\/script>/);
  assert.doesNotMatch(source, /loadAudioPolicyCache/);
  assert.match(
    source,
    /audioPolicyController\.hasPolicy\(\) \|\| audioPolicyController\.isBlocked\(\)/,
    'the page must not bypass the fail-muted controller before its first authoritative playlist',
  );
  const playlistHandler = source.slice(
    source.indexOf('function handlePlaylistUpdate(data)'),
    source.indexOf('function playCurrentItem()'),
  );
  assert.match(playlistHandler, /applyPlaylistAudioPolicy\(data/);
  assert.ok(
    playlistHandler.indexOf('applyPlaylistAudioPolicy(data') < playlistHandler.indexOf('applyWallMode('),
    'audio ownership must be installed before the new media is rendered',
  );
  // DOM/media behavior is exercised by server/e2e/real-app/player-audio-policy.spec.js.
  // Keep this unit check limited to the durable policy/fence contract.
  assert.match(source, /device:audio-policy-fence/);
  assert.match(source, /device:audio-policy-clamp/);
  assert.match(source, /window\.__mbfdAudioPolicyState/);
  assert.match(source, /mbfd:audio-policy-state/);
  assert.match(source, /const accepted = audioPolicyController\.statusSnapshot\(\)/);
  assert.match(source, /generation:\s*accepted\?\.generation/);
  const fence = source.slice(
    source.indexOf("socket.on('device:audio-policy-fence'"),
    source.indexOf("socket.on('device:audio-policy-clamp'"),
  );
  assert.match(fence, /async \(data, acknowledge\)/);
  assert.match(fence, /await window\.MbfdAudioPolicy\.confirmHostMuted/);
  assert.ok(
    fence.indexOf('muteAllPlayerAudio()') < fence.indexOf('await window.MbfdAudioPolicy.confirmHostMuted'),
    'local audio and the durable state event must be muted before waiting for Electron host confirmation',
  );
  assert.ok(
    fence.indexOf('await window.MbfdAudioPolicy.confirmHostMuted') < fence.indexOf('acknowledge({'),
    'server ACK must wait for verified Electron host mute',
  );
  assert.match(fence, /host_muted:\s*hostMute\.confirmed === true/);
  assert.match(source, /audioPolicyController\.block\('socket_disconnected'\)/);
  assert.match(source, /audio_policy_state:/);
});

test('unpair and authentication rejection fail-mute before receiver exits or credential clearing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'player', 'index.html'), 'utf8');
  const unpaired = source.slice(
    source.indexOf("socket.on('device:unpaired'"),
    source.indexOf("socket.on('device:auth-error'"),
  );
  const authError = source.slice(
    source.indexOf("socket.on('device:auth-error'"),
    source.indexOf("socket.on('device:program-audio-policy'"),
  );

  for (const [handler, reason] of [
    [unpaired, 'device_unpaired'],
    [authError, 'device_auth_rejected'],
  ]) {
    assert.match(handler, new RegExp(`audioPolicyController\\.revokeAuthorization\\('${reason}'\\)`));
    assert.match(handler, /muteAllPlayerAudio\(\)/);
    assert.match(handler, new RegExp(`publishAudioPolicyState\\('${reason}'\\)`));
    assert.ok(
      handler.indexOf(`audioPolicyController.revokeAuthorization('${reason}')`) < handler.indexOf('muteAllPlayerAudio()')
      && handler.indexOf('muteAllPlayerAudio()') < handler.indexOf(`publishAudioPolicyState('${reason}')`),
      `${reason} must block, locally mute, then publish the fail-muted state`,
    );
    assert.ok(
      handler.indexOf(`publishAudioPolicyState('${reason}')`) < handler.indexOf('if (isManagedProgramReceiver())'),
      `${reason} must fail-mute managed program receivers before their reload return`,
    );
    assert.ok(
      handler.indexOf(`publishAudioPolicyState('${reason}')`) < handler.indexOf('delete config.deviceId'),
      `${reason} must publish the exact device identity before credentials are cleared`,
    );
  }

  const registered = source.slice(
    source.indexOf("socket.on('device:registered'"),
    source.indexOf("socket.on('device:room-snapshot'"),
  );
  assert.match(
    registered,
    /if \(data\.status === 'online'\) audioPolicyController\.restoreAuthorization\(\);/,
    'only a successful known-device registration may reopen the policy controller',
  );
});

test('audio policy controller bytes participate in frontend and player reload hashes', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(
    server,
    /files\.push\(fs\.readFileSync\(path\.join\(__dirname, 'player', 'audio-policy\.js'\)\)\)/,
  );
  const playerHash = server.slice(
    server.indexOf('const playerFiles = ['),
    server.indexOf("playerHash = crypto.createHash('sha256')"),
  );
  assert.match(playerHash, /'audio-policy\.js'/);
});
