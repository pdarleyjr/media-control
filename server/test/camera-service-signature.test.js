'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const mediaSignature = require('../lib/camera-service-signature');
const edgeSignature = require('../../kamrui-media-edge/camera-api/camera-service-signature');

const CURRENT_KEY = Object.freeze({
  id: 'media-control',
  version: '2026-07',
  secret: 'fixture-current-camera-service-secret',
});
const PREVIOUS_KEY = Object.freeze({
  id: 'media-control',
  version: '2026-06',
  secret: 'fixture-previous-camera-service-secret',
});
const TIMESTAMP_MS = 1785072600123;
const NONCE = '12345678-1234-4234-8234-123456789abc';

function requestFixture(overrides = {}) {
  return {
    method: 'patch',
    target: '/api/recordings/ses_fixture?z=last&a=hello%20world&a=first',
    rawBody: Buffer.from('{"confirm":"ses_fixture","reason":"operator requested"}'),
    timestampMs: TIMESTAMP_MS,
    nonce: NONCE,
    operatorId: 'user-fixture',
    ifMatch: '  "revision-fixture"  ',
    contentType: ' Application/JSON ; Charset=UTF-8 ',
    key: CURRENT_KEY,
    ...overrides,
  };
}

test('canonical request binds uppercase method, exact path, sorted query, raw body, headers, operator and key identity', () => {
  const request = requestFixture();
  const media = mediaSignature.signServiceRequest(request);
  const edge = edgeSignature.signServiceRequest(request);

  assert.deepEqual(edge, media);
  assert.equal(media.headers['X-Service-Timestamp'], String(TIMESTAMP_MS));
  assert.equal(media.headers['X-Service-Nonce'], NONCE);
  assert.equal(media.headers['X-Service-Key-Id'], CURRENT_KEY.id);
  assert.equal(media.headers['X-Service-Key-Version'], CURRENT_KEY.version);
  assert.equal(media.headers['X-Operator-Id'], 'user-fixture');
  assert.match(media.headers['X-Service-Signature'], /^[a-f0-9]{64}$/);
  assert.match(media.canonicalRequest, /^MBFD-CAMERA-SERVICE-HMAC-SHA256-V1\nPATCH\n/);
  assert.match(
    media.canonicalRequest,
    /\n\/api\/recordings\/ses_fixture\?a=first&a=hello%20world&z=last\n/
  );
  assert.match(media.canonicalRequest, /\napplication\/json;charset=UTF-8\n/);
  assert.match(media.canonicalRequest, /\n"revision-fixture"\n/);

  const sorted = mediaSignature.signServiceRequest(requestFixture({
    target: '/api/recordings/ses_fixture?a=first&z=last&a=hello%20world',
  }));
  assert.equal(sorted.signature, media.signature);

  const rawBodyChanged = mediaSignature.signServiceRequest(requestFixture({
    rawBody: Buffer.from('{"reason":"operator requested","confirm":"ses_fixture"}'),
  }));
  assert.notEqual(rawBodyChanged.signature, media.signature);

  const pathEncodingChanged = mediaSignature.signServiceRequest(requestFixture({
    target: '/api/recordings/ses%5Ffixture?z=last&a=hello%20world&a=first',
  }));
  assert.notEqual(pathEncodingChanged.signature, media.signature);
});

test('Media Control and edge use byte-identical canonicalization source', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const mediaSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'camera-service-signature.js'), 'utf8');
  const edgeSource = fs.readFileSync(
    path.join(__dirname, '..', '..', 'kamrui-media-edge', 'camera-api', 'camera-service-signature.js'),
    'utf8'
  );
  assert.equal(edgeSource.replace(/\r\n/g, '\n'), mediaSource.replace(/\r\n/g, '\n'));
});

test('verifier accepts current and overlapping previous keys and rejects every signed-field mutation', () => {
  const signed = mediaSignature.signServiceRequest(requestFixture());
  const base = {
    method: 'PATCH',
    target: '/api/recordings/ses_fixture?a=hello%20world&z=last&a=first',
    rawBody: requestFixture().rawBody,
    headers: signed.headers,
    keys: [CURRENT_KEY, PREVIOUS_KEY],
    nowMs: TIMESTAMP_MS + 500,
    maxSkewMs: 60_000,
    acceptNonce: () => true,
  };

  assert.deepEqual(edgeSignature.verifyServiceRequest(base), {
    ok: true,
    operatorId: 'user-fixture',
    keyId: CURRENT_KEY.id,
    keyVersion: CURRENT_KEY.version,
  });

  for (const mutation of [
    { method: 'DELETE' },
    { target: '/api/recordings/ses_other?a=first&a=hello%20world&z=last' },
    { target: '/api/recordings/ses_fixture?a=first&a=hello%20world&z=changed' },
    { rawBody: Buffer.from('{"confirm":"tampered"}') },
    { headers: { ...signed.headers, 'If-Match': '"other"' } },
    { headers: { ...signed.headers, 'Content-Type': 'text/plain' } },
    { headers: { ...signed.headers, 'X-Operator-Id': 'other-user' } },
    { headers: { ...signed.headers, 'X-Service-Nonce': 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
    { headers: { ...signed.headers, 'X-Service-Key-Version': PREVIOUS_KEY.version } },
  ]) {
    const result = edgeSignature.verifyServiceRequest({ ...base, ...mutation });
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  }

  assert.equal(edgeSignature.verifyServiceRequest({ ...base, nowMs: TIMESTAMP_MS + 60_001 }).ok, false);
  assert.equal(edgeSignature.verifyServiceRequest({ ...base, nowMs: TIMESTAMP_MS - 60_001 }).ok, false);
  assert.deepEqual(
    edgeSignature.verifyServiceRequest({ ...base, acceptNonce: () => false }),
    { ok: false, status: 409, error: 'Replayed service nonce' }
  );
  const missingSignatureHeaders = { ...signed.headers };
  delete missingSignatureHeaders['X-Service-Signature'];
  assert.deepEqual(
    edgeSignature.verifyServiceRequest({ ...base, headers: missingSignatureHeaders }),
    { ok: false, status: 401, error: 'Invalid service signature' }
  );

  const previous = mediaSignature.signServiceRequest(requestFixture({ key: PREVIOUS_KEY }));
  assert.equal(edgeSignature.verifyServiceRequest({
    ...base,
    headers: previous.headers,
  }).ok, true);
});

test('raw HTTP bytes verify once and a replay is refused', async (t) => {
  const seen = new Set();
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      const result = edgeSignature.verifyServiceRequest({
        method: req.method,
        target: req.url,
        rawBody: Buffer.concat(chunks),
        headers: req.headers,
        keys: [CURRENT_KEY],
        nowMs: TIMESTAMP_MS,
        maxSkewMs: 60_000,
        acceptNonce: nonce => {
          if (seen.has(nonce)) return false;
          seen.add(nonce);
          return true;
        },
      });
      res.statusCode = result.ok ? 204 : result.status;
      res.setHeader('Content-Type', 'application/json');
      res.end(result.ok ? '' : JSON.stringify(result));
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));

  const rawBody = Buffer.from('{"exact":"raw bytes","order":2}');
  const target = '/api/admin?second=2&first=1';
  const signed = mediaSignature.signServiceRequest(requestFixture({
    method: 'patch',
    target,
    rawBody,
    contentType: 'application/json',
  }));
  const url = `http://127.0.0.1:${server.address().port}${target}`;
  const first = await fetch(url, {
    method: 'PATCH',
    headers: signed.headers,
    body: rawBody,
  });
  assert.equal(first.status, 204);

  const replay = await fetch(url, {
    method: 'PATCH',
    headers: signed.headers,
    body: rawBody,
  });
  assert.equal(replay.status, 409);

  const tamperedBytes = await fetch(url, {
    method: 'PATCH',
    headers: mediaSignature.signServiceRequest(requestFixture({
      method: 'patch',
      target,
      rawBody,
      contentType: 'application/json',
      nonce: '87654321-4321-4321-8321-cba987654321',
    })).headers,
    body: Buffer.from('{"order":2,"exact":"raw bytes"}'),
  });
  assert.equal(tamperedBytes.status, 401);
});

test('camera client signs the exact serialized bytes and wire request target', async (t) => {
  const config = require('../config');
  const cameraClient = require('../lib/camera-control-client');
  const previousConfig = { ...config.cameraControl };
  const previousFetch = global.fetch;
  t.after(() => {
    Object.assign(config.cameraControl, previousConfig);
    global.fetch = previousFetch;
  });
  Object.assign(config.cameraControl, {
    baseUrl: 'https://camera.example.invalid',
    token: 'fixture-api-token',
    signingSecret: CURRENT_KEY.secret,
    signingKeyId: CURRENT_KEY.id,
    signingKeyVersion: CURRENT_KEY.version,
  });

  let captured;
  global.fetch = async (url, options) => {
    captured = {
      target: `${url.pathname}${url.search}`,
      method: options.method,
      headers: options.headers,
      rawBody: Buffer.from(options.body),
    };
    return new Response('{"accepted":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const result = await cameraClient.callCameraApi(
    'patch',
    '/api/admin/%73es_fixture?z=last&a=first',
    { reason: 'exact order', confirm: 'ses_fixture' },
    1_000,
    {
      headers: {
        'If-Match': ' "revision-fixture" ',
        'X-Operator-Id': 'caller-supplied-operator-must-be-ignored',
      },
      operatorId: 'platform-admin-fixture',
    }
  );
  assert.equal(result.ok, true);
  assert.equal(captured.method, 'PATCH');
  assert.equal(captured.target, '/api/admin/%73es_fixture?z=last&a=first');
  assert.equal(captured.rawBody.toString(), '{"reason":"exact order","confirm":"ses_fixture"}');
  const verified = edgeSignature.verifyServiceRequest({
    ...captured,
    keys: [CURRENT_KEY],
    nowMs: Number(captured.headers['X-Service-Timestamp']),
    maxSkewMs: 60_000,
    acceptNonce: () => true,
  });
  assert.equal(verified.ok, true);
  assert.equal(verified.operatorId, 'platform-admin-fixture');
});

test('client, edge and nginx preserve the signed request contract', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..', '..');
  const client = fs.readFileSync(path.join(root, 'server/lib/camera-control-client.js'), 'utf8');
  const edge = fs.readFileSync(path.join(root, 'kamrui-media-edge/camera-api/server.js'), 'utf8');
  const nginx = fs.readFileSync(path.join(root, 'cameras-proxy/nginx.conf.tpl'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'server/routes/live-stream.js'), 'utf8');
  const contract = fs.readFileSync(path.join(root, 'docs/camera-service-signature.md'), 'utf8');

  assert.match(client, /signServiceRequest/);
  assert.match(client, /rawBody/);
  assert.match(edge, /express\.json\(\{[\s\S]*verify:/);
  assert.match(edge, /verifyServiceRequest/);
  assert.match(edge, /serviceSigningKeys/);
  assert.match(edge, /deletion-impact', authMiddleware, requireServiceAuth/);
  assert.match(nginx, /proxy_pass http:\/\/kamrui_api;/);
  assert.match(nginx, /limit_except GET POST PATCH DELETE/);
  assert.match(routes, /getDeletionImpact\(req\.params\.id, \{ operatorId: req\.user\.id \}\)/);
  assert.match(routes, /requirePlatformAdmin/);
  assert.match(contract, /Unix timestamp in decimal milliseconds/);
  assert.match(contract, /exact raw request-body bytes/);
});
