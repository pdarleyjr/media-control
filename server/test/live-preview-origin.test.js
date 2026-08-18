'use strict';

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const root = path.join(__dirname, '..', '..');

test('presentation previews normalize the sibling Media Control hostname to the dashboard origin', async () => {
  global.location = {
    origin: 'https://media.mbfdhub.com',
    host: 'media.mbfdhub.com',
  };
  const moduleUrl = `${pathToFileURL(path.join(
    root,
    'frontend',
    'js',
    'views',
    'media-control',
    'live-preview.js',
  )).href}?sibling-origin`;
  const { liveEmbedHtml } = await import(moduleUrl);

  const html = liveEmbedHtml({
    kind: 'presentation',
    contentId: 'deck-1',
    remoteUrl: 'https://media-control.mbfdhub.com/player/deck/deck-1',
    slideIndex: 3,
  }, 'mc-card-shot');

  assert.match(html, /src="\/player\/deck\/deck-1\?slide=3&amp;preview=1"/);
});

test('the global modal delegate ignores locally-owned close buttons without a modal id', () => {
  const source = fs.readFileSync(path.join(root, 'frontend', 'js', 'app.js'), 'utf8');
  const handler = source.slice(source.indexOf("document.addEventListener('click', (e) => {", source.indexOf('// Close-modal buttons')));

  assert.match(handler, /const id = closer\.dataset\.closeModal;\s*if \(!id\) return;\s*const modal = document\.getElementById\(id\);/);
});
