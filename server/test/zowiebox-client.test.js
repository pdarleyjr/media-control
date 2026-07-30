'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createZowieboxClient } = require('../../kamrui-media-edge/camera-api/zowiebox-client');

function response(body, ok = true) {
  return {
    ok,
    async json() { return body; },
  };
}

test('ZowieBox client logs in once and reads HDMI status with the session UUID header', async () => {
  const requests = [];
  const client = createZowieboxClient({
    baseUrl: 'http://192.168.1.186',
    username: 'service-user',
    password: 'secret-value',
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      if (requests.length === 1) {
        return response({ status: '00000', data: { uuid: 'session-uuid' } });
      }
      return response({
        status: '00000',
        data: {
          hdmi_signal: 1,
          audio_signal: 1,
          width: 1920,
          height: 1080,
          framerate: 60,
          gsv2001: { input_exist: 1 },
        },
      });
    },
  });

  const input = await client.getInput();

  assert.equal(input.hdmi_signal, 1);
  assert.equal(requests.length, 2);
  assert.match(requests[0].url, /system\?option=setinfo/);
  assert.match(requests[1].url, /video\?option=getinfo/);
  assert.equal(requests[1].options.headers.uuid, 'session-uuid');
  assert.doesNotMatch(JSON.stringify(requests[1]), /secret-value/);
});

test('ZowieBox client rejects an unsuccessful device status without exposing the password', async () => {
  const client = createZowieboxClient({
    baseUrl: 'http://192.168.1.186',
    username: 'service-user',
    password: 'highly-sensitive',
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      if (body.opt === 'login_account') {
        return response({ status: '00000', data: { uuid: 'session-uuid' } });
      }
      return response({ status: '80003', rsp: 'not logged in' });
    },
  });

  await assert.rejects(
    () => client.getInput(),
    (error) => {
      assert.doesNotMatch(error.message, /highly-sensitive/);
      return /ZowieBox/.test(error.message);
    },
  );
});

test('ZowieBox client rejects every management origin except the confirmed appliance', () => {
  for (const baseUrl of [
    'http://192.168.1.187',
    'https://192.168.1.186',
    'http://192.168.1.186:8080',
    'http://user@192.168.1.186',
  ]) {
    assert.throws(
      () => createZowieboxClient({
        baseUrl,
        username: 'service-user',
        password: 'secret-value',
        fetchImpl: async () => response({ status: '00000' }),
      }),
      /confirmed appliance/,
    );
  }
});

test('camera API receives its protected environment from systemd without parsing camera.env', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.resolve(__dirname, '../..');
  const unit = fs.readFileSync(
    path.join(root, 'kamrui-media-edge/systemd/mbfd-camera-api.service'),
    'utf8',
  );
  const server = fs.readFileSync(
    path.join(root, 'kamrui-media-edge/camera-api/server.js'),
    'utf8',
  );

  assert.match(unit, /^EnvironmentFile=\/etc\/mbfd\/media-stack\/camera\.env$/m);
  assert.match(server, /const env = process\.env;/);
  assert.doesNotMatch(server, /readFileSync\('\/etc\/mbfd\/media-stack\/camera\.env'/);
});
