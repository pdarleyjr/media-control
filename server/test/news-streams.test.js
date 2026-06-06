const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveNewsStream, isValidStation, STATIONS } = require('../lib/news-streams');
const { rewriteManifest, buildProxyUrl, b64urlEncode, b64urlDecode, SYNCBAK_HOST } = require('../lib/hls-proxy');

test('isValidStation whitelists exactly the known keys', () => {
  for (const k of ['mbtv', 'cbs', 'nbc6', 'local10', 'wsvn', 'univision23', 'telemundo51']) assert.ok(isValidStation(k));
  assert.ok(!isValidStation('evil'));
  assert.ok(!isValidStation('../../etc'));
});

test('direct stations resolve to their static master with no network', async () => {
  const cbs = await resolveNewsStream('cbs');
  assert.equal(cbs.station, 'cbs');
  assert.match(cbs.source, /^https:\/\/cbsn-mia\.cbsnstream\.cbsnews\.com\/.*master\.m3u8$/);
  const mbtv = await resolveNewsStream('mbtv');
  assert.match(mbtv.source, /swagit\.com\/live\/miamibeachfl/);
  // NBC6 + Telemundo Xumo masters MUST keep their mandatory ads.* params.
  assert.match((await resolveNewsStream('nbc6')).source, /\?ads\./);
  assert.match((await resolveNewsStream('telemundo51')).source, /\?ads\./);
});

test('unknown station rejects with status 404', async () => {
  await assert.rejects(() => resolveNewsStream('nope'), (e) => e.status === 404);
});

test('b64url encode/decode round-trips a path with a querystring', () => {
  const p = '/cpl/20359441/dai2v5/1.0/abc/master.m3u8?access_token=JWT.tok-en';
  assert.equal(b64urlDecode(b64urlEncode(p)), p);
  assert.ok(!/[+/=]/.test(b64urlEncode(p))); // url-safe, unpadded
});

test('rewriteManifest proxies Syncbak children but leaves CloudFront segments direct', () => {
  const body = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=3659760,RESOLUTION=1280x720',
    '/media.m3u8?bitrate=3659760&session=deadbeef',
  ].join('\n');
  const out = rewriteManifest(body, '/cpl/20359441/dai2v5/1.0/abc/master.m3u8?access_token=JWT');
  assert.match(out, /\/player\/hls-proxy\?p=/);
  assert.equal(b64urlDecode(out.match(/p=([A-Za-z0-9_-]+)/)[1]), '/media.m3u8?bitrate=3659760&session=deadbeef');
});

test('rewriteManifest proxies the AES key URI and keeps absolute CDN segments', () => {
  const body = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="/aeskey?data=abc123",IV=0x00',
    '#EXTINF:4.0,',
    'https://d27wx7ytq78mow.cloudfront.net/live/5178/seg1.ts',
  ].join('\n');
  const out = rewriteManifest(body, '/media.m3u8?bitrate=1&session=x');
  assert.match(out, /URI="\/player\/hls-proxy\?p=/);                       // key proxied
  assert.match(out, /https:\/\/d27wx7ytq78mow\.cloudfront\.net\/live\/5178\/seg1\.ts/); // segment untouched
});

test('buildProxyUrl targets the same-origin proxy path', () => {
  assert.match(buildProxyUrl('/x/master.m3u8?a=1'), /^\/player\/hls-proxy\?p=/);
  assert.equal(SYNCBAK_HOST, 'dai2-playlistserver.aws.syncbak.com');
});

test('wsvn resolves via Brightcove->Syncbak and returns a proxied source', async () => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    if (u.includes('config.json')) return { ok: true, text: async () => 'x="BCpkADawqM14abcdefghijklmnopqrstuvwxyz0123456789ABCDE"' };
    if (u.includes('edge.api.brightcove.com')) {
      return { ok: true, text: async () => JSON.stringify({ name: '7NewsLive', sources: [{ src: `https://${SYNCBAK_HOST}/cpl/20359441/dai2v5/1.0/abc/master.m3u8?access_token=JWT` }] }) };
    }
    throw new Error('unexpected fetch ' + u);
  };
  try {
    const r = await resolveNewsStream('wsvn');
    assert.match(r.source, /^\/player\/hls-proxy\?p=/);
    assert.equal(b64urlDecode(r.source.match(/p=([A-Za-z0-9_-]+)/)[1]), '/cpl/20359441/dai2v5/1.0/abc/master.m3u8?access_token=JWT');
  } finally { global.fetch = realFetch; }
});
