'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createPeerTubeIngestVerifier,
} = require('../lib/peertube-ingest-health');

test('unconfigured PeerTube ingest verification is explicitly unavailable without network access', async () => {
  let requests = 0;
  const verifier = createPeerTubeIngestVerifier({
    url: '',
    fetchImpl: async () => {
      requests += 1;
      throw new Error('must not run');
    },
  });
  const result = await verifier.waitForActive();
  assert.deepEqual(result, {
    available: false,
    confirmed: null,
    code: 'PEERTUBE_INGEST_HEALTH_NOT_CONFIGURED',
  });
  assert.equal(requests, 0);
});

test('configured PeerTube ingest verification polls until the program is active', async () => {
  const responses = [
    { active: false, state: 'starting' },
    { active: true, state: 'live' },
  ];
  const authorizationHeaders = [];
  const verifier = createPeerTubeIngestVerifier({
    url: 'https://videos.example.test/api/v1/live/health',
    token: 'test-health-token',
    confirmationTimeoutMs: 500,
    pollIntervalMs: 1,
    wait: async () => {},
    fetchImpl: async (_url, options) => {
      authorizationHeaders.push(options.headers.Authorization);
      const body = responses.shift();
      return {
        ok: true,
        status: 200,
        async json() { return body; },
      };
    },
  });

  const result = await verifier.waitForActive();
  assert.equal(result.available, true);
  assert.equal(result.confirmed, true);
  assert.equal(result.state, 'live');
  assert.deepEqual(authorizationHeaders, ['Bearer test-health-token', 'Bearer test-health-token']);
  assert.doesNotMatch(JSON.stringify(result), /test-health-token/);
});

test('configured but unreachable PeerTube health fails closed', async () => {
  const verifier = createPeerTubeIngestVerifier({
    url: 'https://videos.example.test/api/v1/live/health',
    confirmationTimeoutMs: 1,
    pollIntervalMs: 1,
    wait: async () => {},
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });
  const result = await verifier.waitForActive();
  assert.equal(result.available, true);
  assert.equal(result.confirmed, false);
  assert.equal(result.code, 'PEERTUBE_INGEST_UNREACHABLE');
});
