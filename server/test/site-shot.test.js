const assert = require('assert');
const test = require('node:test');
const { isExternalHttpUrl, clampWidth, clampHeight, clampInterval, cacheFileName } = require('../lib/site-shot');

test('isExternalHttpUrl only accepts absolute http(s) URLs', () => {
  assert.equal(isExternalHttpUrl('https://example.com'), true);
  assert.equal(isExternalHttpUrl('http://x.io/a?b=1'), true);
  assert.equal(isExternalHttpUrl('/player/grid.html'), false); // our own pages iframe directly
  assert.equal(isExternalHttpUrl('/api/content/x/file'), false);
  assert.equal(isExternalHttpUrl('ftp://x'), false);
  assert.equal(isExternalHttpUrl('javascript:alert(1)'), false);
  assert.equal(isExternalHttpUrl('data:text/html,x'), false);
  assert.equal(isExternalHttpUrl(''), false);
  assert.equal(isExternalHttpUrl(null), false);
});

test('clamps width/height/interval into safe ranges', () => {
  assert.equal(clampWidth(99999), 3840);
  assert.equal(clampWidth(10), 320);
  assert.equal(clampWidth('1280'), 1280);
  assert.equal(clampWidth('not-a-number'), 1600); // default
  assert.equal(clampHeight(99999), 2160);
  assert.equal(clampHeight(1), 240);
  assert.equal(clampHeight('720'), 720);
  assert.equal(clampInterval(1), 5);   // min
  assert.equal(clampInterval(99999), 600); // max
  assert.equal(clampInterval('30'), 30);
  assert.equal(clampInterval(undefined), 20); // default
});

test('cacheFileName is scoped by id + dimensions', () => {
  assert.equal(cacheFileName('abc-123', 1600, 900), 'siteshot_abc-123_1600x900.jpg');
  assert.notEqual(cacheFileName('abc', 1600, 900), cacheFileName('abc', 800, 600));
});
