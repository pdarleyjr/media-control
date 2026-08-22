'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const viewPath = path.join(root, 'frontend', 'js', 'views', 'downloads.js');
const cssPath = path.join(root, 'frontend', 'css', 'main.css');
const localePath = path.join(root, 'frontend', 'js', 'i18n', 'en.js');
const indexPath = path.join(root, 'frontend', 'index.html');
const logoPath = path.join(root, 'frontend', 'assets', 'youtube-logo.png');

test('YouTube Downloader navigation and page copy use the locale system', () => {
  const locale = fs.readFileSync(localePath, 'utf8');
  const index = fs.readFileSync(indexPath, 'utf8');
  const view = fs.readFileSync(viewPath, 'utf8');

  assert.match(locale, /'nav\.downloads': 'YouTube Downloader'/);
  assert.match(locale, /'downloads\.instructions':/);
  assert.match(index, /data-view="downloads"[\s\S]*?<span>YouTube Downloader<\/span>/);
  assert.match(view, /import \{ t \} from '\.\.\/i18n\.js'/);
  assert.match(view, /t\('downloads\.instructions'\)/);
  assert.doesNotMatch(view, />Downloads</);
  assert.doesNotMatch(view, /Status refresh delayed/);
  assert.doesNotMatch(view, /No downloads yet/);
});

test('YouTube Downloader uses the supplied logo and an accessible submit form', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  const css = fs.readFileSync(cssPath, 'utf8');

  const signature = fs.readFileSync(logoPath).subarray(0, 8);
  assert.deepEqual([...signature], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.match(view, /src="\/assets\/youtube-logo\.png"/);
  assert.match(view, /<form id="dlForm"/);
  assert.match(view, /addEventListener\('submit'/);
  assert.match(view, /if \(submitting\) return/);
  assert.match(css, /\.mc-downloader-control[^}]*min-height:\s*var\(--tap-min\)/s);
  assert.match(css, /@media \(max-width: 760px\)[^{]*\{[\s\S]*?\.mc-downloader-form[^}]*flex-direction:\s*column/s);
});

test('YouTube Downloader presents concise errors instead of raw worker commands', () => {
  const view = fs.readFileSync(viewPath, 'utf8');

  assert.doesNotMatch(view, /esc\(j\.error_msg\)/);
  assert.match(view, /t\('downloads\.failed_detail'\)/);
  assert.match(view, /t\(`downloads\.status\.\$\{j\.status\}`\)/);
});

test('completed downloads expose a visible Media Library handoff only after the strict ready invariant', () => {
  const view = fs.readFileSync(viewPath, 'utf8');
  const downloadsRoute = fs.readFileSync(path.join(root, 'server', 'routes', 'downloads.js'), 'utf8');
  const library = fs.readFileSync(path.join(root, 'frontend', 'js', 'views', 'content-library.js'), 'utf8');

  assert.match(view, /j\.ready[\s\S]*downloads\.open_library/);
  assert.match(view, /j\.ready[\s\S]*downloads\.preview/);
  assert.match(view, /downloads\.completed_named/);
  assert.match(downloadsRoute, /processing_status[\s\S]*filepath[\s\S]*file_size[\s\S]*remote_url/);
  assert.match(downloadsRoute, /media_library_url/);
  assert.match(library, /hashQuery\.get\('focus'\)/);
  assert.match(library, /api\.getContentItem\(state\.focusContentId\)/);
  assert.match(library, /scrollIntoView/);
});
