const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../lib/performance-metrics');

beforeEach(() => metrics.reset());

test('performance metrics reject malformed samples and remain bounded', () => {
  assert.equal(metrics.record([{ name: '../bad', duration_ms: 4 }, { name: 'route', duration_ms: -1 }]), 0);
  for (let index = 0; index < metrics.MAX_SAMPLES + 20; index += 1) {
    metrics.record([{ name: 'route', duration_ms: index }], { surface: 'web' });
  }
  assert.equal(metrics.summarize()[0].count, metrics.MAX_SAMPLES);
});

test('performance summary reports deterministic p50 p95 and max by surface', () => {
  metrics.record([10, 20, 30, 40, 100].map((duration_ms) => ({ name: 'command.ack', duration_ms, surface: 'podium' })));
  assert.deepEqual(metrics.summarize(), [{
    surface: 'podium', name: 'command.ack', count: 5, p50_ms: 30, p95_ms: 100, max_ms: 100,
  }]);
});
