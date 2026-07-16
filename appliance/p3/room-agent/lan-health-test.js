'use strict';

const http = require('node:http');
const https = require('node:https');
const { URL } = require('node:url');

const TEST_PATH = '/api/status/lan-health-test-object';

function isLanAddress(hostname, allowLoopbackForTest = false) {
  const host = String(hostname || '').toLowerCase();
  if (allowLoopbackForTest && (host === '127.0.0.1' || host === 'localhost' || host === '::1')) return true;
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || !parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) return false;
  return parts[0] === 10
    || (parts[0] === 192 && parts[1] === 168)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31);
}

function classifyThroughput(mbps, thresholds = {}) {
  const measured = Number(mbps) || 0;
  const warningMbps = Math.max(100, Number(thresholds.warningMbps) || 800);
  const healthyMbps = Math.max(warningMbps, Number(thresholds.healthyMbps) || 2_000);
  if (measured < warningMbps) {
    return { status: 'critical', degraded: true, degraded_reason: 'throughput_below_1_gbps_class' };
  }
  if (measured < healthyMbps) {
    return { status: 'warning', degraded: true, degraded_reason: 'throughput_below_2_5_gbps_target' };
  }
  return { status: 'healthy', degraded: false, degraded_reason: null };
}

function runLanHealthTest(options = {}) {
  const cacheStats = options.cacheStats || {};
  if (Number(cacheStats.downloading) > 0 || Number(cacheStats.queued) > 0) {
    return Promise.reject(new Error('cache_busy'));
  }

  let url;
  try { url = new URL(TEST_PATH, String(options.originBaseUrl || '')); }
  catch { return Promise.reject(new Error('invalid_origin')); }
  if (!isLanAddress(url.hostname, options.allowLoopbackForTest === true)) {
    return Promise.reject(new Error('lan_origin_required'));
  }
  const testId = String(options.testId || '');
  if (!/^[A-Za-z0-9-]{16,128}$/.test(testId)) return Promise.reject(new Error('invalid_test_id'));
  url.searchParams.set('id', testId);

  const nodeToken = String(options.nodeToken || '');
  if (!nodeToken) return Promise.reject(new Error('node_token_required'));
  const timeoutMs = Math.max(5_000, Math.min(60_000, Number(options.timeoutMs) || 30_000));
  const startedAt = process.hrtime.bigint();

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(result);
    };
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, {
      headers: { 'X-MBFD-Node-Token': nodeToken, Accept: 'application/octet-stream' },
      timeout: timeoutMs,
    }, (response) => {
      const firstByteAt = process.hrtime.bigint();
      if (response.statusCode !== 200) {
        response.resume();
        return finish(new Error(`health_test_http_${response.statusCode || 0}`));
      }
      let bytes = 0;
      response.on('data', (chunk) => { bytes += chunk.length; });
      response.on('error', (error) => finish(error));
      response.on('end', () => {
        const endedAt = process.hrtime.bigint();
        const elapsedMs = Math.max(0.001, Number(endedAt - startedAt) / 1e6);
        const mbps = bytes * 8 / elapsedMs / 1_000;
        const classification = classifyThroughput(mbps, options);
        finish(null, {
          ok: true,
          at: Math.floor(Date.now() / 1000),
          bytes,
          elapsed_ms: Math.round(elapsedMs),
          ttfb_ms: Math.round(Number(firstByteAt - startedAt) / 1e6),
          mbps: Math.round(mbps * 100) / 100,
          ...classification,
        });
      });
    });
    request.on('timeout', () => request.destroy(new Error('health_test_timeout')));
    request.on('error', (error) => finish(error));
  });
}

module.exports = { TEST_PATH, classifyThroughput, isLanAddress, runLanHealthTest };
