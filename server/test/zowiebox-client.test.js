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
    baseUrl: 'http://zowiebox.invalid',
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
    baseUrl: 'http://zowiebox.invalid',
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
