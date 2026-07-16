'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { classifyThroughput, runLanHealthTest } = require('./lan-health-test');

test('throughput classification matches classroom link targets', () => {
  assert.equal(classifyThroughput(95).status, 'critical');
  assert.equal(classifyThroughput(940).status, 'warning');
  assert.equal(classifyThroughput(2200).status, 'healthy');
});

test('LAN health test refuses non-LAN origins and active cache work', async () => {
  await assert.rejects(
    runLanHealthTest({ originBaseUrl: 'https://media.mbfdhub.com', nodeToken: 'x', testId: '1234567890abcdef' }),
    /lan_origin_required/,
  );
  await assert.rejects(
    runLanHealthTest({
      originBaseUrl: 'http://192.168.1.116:8096',
      nodeToken: 'x',
      testId: '1234567890abcdef',
      cacheStats: { downloading: 1, queued: 0 },
    }),
    /cache_busy/,
  );
});

test('LAN health test measures the fixed authenticated object', async (t) => {
  const expectedToken = 'test-node-token';
  const body = Buffer.alloc(256 * 1024, 0x5a);
  const server = http.createServer((req, res) => {
    assert.equal(req.url, '/api/status/lan-health-test-object?id=1234567890abcdef');
    assert.equal(req.headers['x-mbfd-node-token'], expectedToken);
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const address = server.address();
  const result = await runLanHealthTest({
    originBaseUrl: `http://127.0.0.1:${address.port}`,
    nodeToken: expectedToken,
    testId: '1234567890abcdef',
    allowLoopbackForTest: true,
    timeoutMs: 5_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.bytes, body.length);
  assert.ok(result.elapsed_ms >= 0);
  assert.ok(result.mbps > 0);
  assert.ok(result.ttfb_ms >= 0);
});
