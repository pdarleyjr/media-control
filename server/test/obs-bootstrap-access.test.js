'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedObsBootstrapRequest } = require('../lib/obs-bootstrap-access');

function request({ host = '127.0.0.1:8096', remoteAddress = '127.0.0.1', headers = {} } = {}) {
  return {
    headers: { host, ...headers },
    socket: { remoteAddress },
  };
}

test('OBS bootstrap accepts direct loopback requests', () => {
  assert.equal(isAllowedObsBootstrapRequest(request()), true);
  assert.equal(isAllowedObsBootstrapRequest(request({ host: 'localhost:8096', remoteAddress: '::1' })), true);
  assert.equal(isAllowedObsBootstrapRequest(request({ host: '[::1]:8096', remoteAddress: '::ffff:127.0.0.1' })), true);
});

test('OBS bootstrap rejects Cloudflare-forwarded requests even when Host is loopback', () => {
  assert.equal(isAllowedObsBootstrapRequest(request({
    headers: { 'cf-ray': 'abc-IAD', 'cf-connecting-ip': '203.0.113.9' },
  })), false);
});

test('OBS bootstrap rejects public hosts and non-loopback clients by default', () => {
  assert.equal(isAllowedObsBootstrapRequest(request({ host: 'media.example.test', remoteAddress: '127.0.0.1' })), false);
  assert.equal(isAllowedObsBootstrapRequest(request({ host: '127.0.0.1:8096', remoteAddress: '192.168.1.20' })), false);
});

test('OBS bootstrap permits an explicit direct-LAN host and client allowlist', () => {
  const options = {
    allowedHosts: ['192.168.1.10'],
    allowedRemoteAddresses: ['192.168.1.20'],
  };
  assert.equal(isAllowedObsBootstrapRequest(request({
    host: '192.168.1.10:8096',
    remoteAddress: '192.168.1.20',
  }), options), true);
});
