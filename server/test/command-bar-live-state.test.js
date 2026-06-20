const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

test('live stream controls follow the authoritative AI Director stream state', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'command-bar.js'),
    'utf8'
  );

  assert.match(source, /await api\.liveStream\.status\(\)/);
  assert.match(source, /status\?\.ai_director\?\.data\?\.stream_active === true/);
  assert.match(source, /liveStartBtn\.hidden = active/);
  assert.match(source, /liveStopBtn\.hidden = !active/);
});
