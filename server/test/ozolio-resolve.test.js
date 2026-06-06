const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveOzolioStream, posterUrl, OID_RE } = require('../lib/ozolio-resolve');

// Ozolio camera OIDs: only the EMB_ alphanumeric form resolves on the relay; the
// strict regex also blocks SSRF/injection since the oid is interpolated into the
// upstream URL. (See server/lib/ozolio-resolve.js + the /player/oz-stream route.)
test('OID_RE accepts EMB_ alphanumeric ids and rejects everything else', () => {
  assert.ok(OID_RE.test('EMB_RANL0000044E'));
  assert.ok(OID_RE.test('EMB_FDVN00000417'));
  assert.ok(!OID_RE.test('CID_KSNR000018D5'));      // CID_ form 404s on the relay
  assert.ok(!OID_RE.test('KSNR000018D5'));           // bare raw id
  assert.ok(!OID_RE.test('EMB_../../etc/passwd'));   // traversal
  assert.ok(!OID_RE.test('EMB_a&cmd=open'));         // query injection
  assert.ok(!OID_RE.test(''));
});

test('posterUrl builds the relay poster URL for a valid oid, null otherwise', () => {
  assert.equal(posterUrl('EMB_RANL0000044E'), 'https://relay.ozolio.com/pub.api?cmd=poster&oid=EMB_RANL0000044E');
  assert.equal(posterUrl('bogus'), null);
});

test('resolveOzolioStream rejects an invalid oid with status 400 (no network)', async () => {
  await assert.rejects(() => resolveOzolioStream('not-an-oid'), (e) => e.status === 400);
});

test('resolveOzolioStream does init->open and returns {source, poster}', async () => {
  const realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('cmd=init')) {
      return { ok: true, json: async () => ({ session: { id: 'SID_TEST0001ABCD' } }) };
    }
    return { ok: true, json: async () => ({ output: { source: 'https://edge.ozolio.com/hls-live/x/playlist.m3u8' } }) };
  };
  try {
    const oid = 'EMB_TESTOID01';
    const data = await resolveOzolioStream(oid);
    assert.equal(data.source, 'https://edge.ozolio.com/hls-live/x/playlist.m3u8');
    assert.equal(data.poster, `https://relay.ozolio.com/pub.api?cmd=poster&oid=${oid}`);
    // init must carry the allow-listed document; open must request M3U8.
    assert.ok(calls[0].includes('cmd=init') && calls[0].includes('document=https%3A%2F%2Fwww.miamiandbeaches.com%2F'));
    assert.ok(calls[1].includes('cmd=open') && calls[1].includes('format=M3U8') && calls[1].includes('SID_TEST0001ABCD'));
  } finally {
    global.fetch = realFetch;
  }
});

test('resolveOzolioStream surfaces a 502 when the relay denies init', async () => {
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 403, json: async () => ({}) });
  try {
    await assert.rejects(() => resolveOzolioStream('EMB_DENIED0002'), (e) => e.status === 502);
  } finally {
    global.fetch = realFetch;
  }
});
