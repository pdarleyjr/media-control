'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  ObsWebSocketV5,
  buildObsAuthentication,
  isPrivateWebSocketUrl,
} = require('../lib/obs-websocket-v5');

class ObsProtocolSimulator {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = new Map();
    this.requests = [];
    this.currentScene = 'MBFD_CAMERA_ONLY';
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open', {});
      this.emitJson({
        op: 0,
        d: {
          obsWebSocketVersion: '5.5.2',
          rpcVersion: 1,
          authentication: {
            challenge: 'challenge-value',
            salt: 'salt-value',
          },
        },
      });
    });
  }

  addEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    handlers.push(handler);
    this.listeners.set(type, handlers);
  }

  removeEventListener(type, handler) {
    const handlers = this.listeners.get(type) || [];
    this.listeners.set(type, handlers.filter((entry) => entry !== handler));
  }

  emit(type, event) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }

  emitJson(payload) {
    this.emit('message', { data: JSON.stringify(payload) });
  }

  send(raw) {
    const frame = JSON.parse(raw);
    if (frame.op === 1) {
      assert.equal(
        frame.d.authentication,
        buildObsAuthentication('test-password', 'salt-value', 'challenge-value'),
      );
      queueMicrotask(() => this.emitJson({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      return;
    }
    assert.equal(frame.op, 6);
    this.requests.push(frame.d);
    let responseData = {};
    if (frame.d.requestType === 'GetCurrentProgramScene') {
      responseData = { currentProgramSceneName: this.currentScene };
    } else if (frame.d.requestType === 'SetCurrentProgramScene') {
      this.currentScene = frame.d.requestData.sceneName;
    } else if (frame.d.requestType === 'GetStreamStatus') {
      responseData = { outputActive: false, outputReconnecting: false };
    }
    queueMicrotask(() => this.emitJson({
      op: 7,
      d: {
        requestType: frame.d.requestType,
        requestId: frame.d.requestId,
        requestStatus: { result: true, code: 100 },
        responseData,
      },
    }));
  }

  close() {
    this.readyState = 3;
    this.emit('close', {});
  }
}

test('OBS authentication follows the v5 challenge algorithm without exposing the password', () => {
  const secret = crypto
    .createHash('sha256')
    .update('test-passwordsalt-value')
    .digest('base64');
  const expected = crypto
    .createHash('sha256')
    .update(`${secret}challenge-value`)
    .digest('base64');
  assert.equal(buildObsAuthentication('test-password', 'salt-value', 'challenge-value'), expected);
  assert.equal(expected.includes('test-password'), false);
});

test('OBS adapter fails closed for public and unauthenticated websocket endpoints', () => {
  assert.equal(isPrivateWebSocketUrl('ws://127.0.0.1:4455'), true);
  assert.equal(isPrivateWebSocketUrl('ws://192.168.1.10:4455'), true);
  assert.equal(isPrivateWebSocketUrl('ws://100.81.154.123:4455'), true);
  assert.equal(isPrivateWebSocketUrl('wss://obs.example.test:4455'), false);
  assert.throws(
    () => new ObsWebSocketV5({ url: 'wss://obs.example.test:4455', password: 'secret' }),
    /private/i,
  );
  assert.throws(
    () => new ObsWebSocketV5({ url: 'ws://127.0.0.1:4455', password: '' }),
    /password/i,
  );
});

test('OBS adapter uses official scene request names and confirms the selected program scene', async () => {
  let simulator;
  const adapter = new ObsWebSocketV5({
    url: 'ws://127.0.0.1:4455',
    password: 'test-password',
    requestTimeoutMs: 1000,
    webSocketFactory: (url) => {
      simulator = new ObsProtocolSimulator(url);
      return simulator;
    },
  });

  const before = await adapter.getCurrentProgramScene();
  assert.equal(before, 'MBFD_CAMERA_ONLY');

  const confirmed = await adapter.setCurrentProgramSceneConfirmed(
    'MBFD_CONTENT_MAIN_CAMERA_PIP',
  );
  assert.equal(confirmed.currentProgramSceneName, 'MBFD_CONTENT_MAIN_CAMERA_PIP');
  assert.deepEqual(
    simulator.requests.map((request) => request.requestType),
    [
      'GetCurrentProgramScene',
      'SetCurrentProgramScene',
      'GetCurrentProgramScene',
    ],
  );
  adapter.close();
});
