'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildUrlDownloadArgs,
  buildYoutubeDownloadArgs,
  normalizeYoutubeId,
  youtubeSourceIdentity,
} = require('../lib/media-pipeline');

test('YouTube identity normalization accepts supported URL forms and rejects ambiguous input', () => {
  const id = 'dQw4w9WgXcQ';
  assert.equal(normalizeYoutubeId(`https://www.youtube.com/watch?v=${id}&t=5`), id);
  assert.equal(normalizeYoutubeId(`https://youtu.be/${id}`), id);
  assert.equal(normalizeYoutubeId(`https://www.youtube.com/shorts/${id}`), id);
  assert.equal(normalizeYoutubeId(id), id);
  assert.equal(normalizeYoutubeId('https://example.com/watch?v=dQw4w9WgXcQ'), null);
  assert.equal(youtubeSourceIdentity(id), `youtube:${id}`);
});

test('generic URL downloads use the same bounded classroom profile without a shell', () => {
  const args = buildUrlDownloadArgs({
    url: 'https://media.example.test/training?id=1',
    outputPath: '/content/download.part.mp4',
    maxBytes: 2048,
  });
  assert.equal(args[0], '--no-config');
  assert.match(args[args.indexOf('-f') + 1], /height<=1080/);
  assert.equal(args[args.indexOf('--concurrent-fragments') + 1], '1');
  assert.equal(args[args.indexOf('--max-filesize') + 1], '2048');
  assert.equal(args.at(-1), 'https://media.example.test/training?id=1');
  assert.throws(
    () => buildUrlDownloadArgs({ url: 'file:///etc/passwd', outputPath: '/tmp/out.mp4' }),
    /invalid_download_url/,
  );
});

test('YouTube classroom profile is bounded to 1080p H.264/AAC preference and one fragment', () => {
  const args = buildYoutubeDownloadArgs({
    videoId: 'dQw4w9WgXcQ',
    outputPath: '/content/job.part.mp4',
    maxHeight: 1080,
    maxBytes: 1024 * 1024,
  });
  const format = args[args.indexOf('-f') + 1];
  assert.match(format, /height<=1080/);
  assert.match(format, /vcodec\^=avc1/);
  assert.match(format, /acodec\^=mp4a/);
  assert.ok(!format.includes('bestvideo+bestaudio/best'), 'unbounded 4K/8K selector must not return');
  assert.equal(args[args.indexOf('--concurrent-fragments') + 1], '1');
  assert.equal(args[args.indexOf('--max-filesize') + 1], String(1024 * 1024));
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});
