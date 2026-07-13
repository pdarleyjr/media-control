const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const css = fs.readFileSync(
  path.resolve(__dirname, '../../frontend/css/media-control.css'),
  'utf8',
);

test('routing dialogs size the native top-layer element instead of overflowing its generic cap', () => {
  assert.match(css, /\.mc-route-dialog\s*\{[\s\S]*?width:\s*min\(720px,/);
  assert.match(css, /\.mc-route-dialog\s*\{[\s\S]*?max-width:\s*none;/);
  assert.match(css, /\.mc-route-dialog\s*\{[\s\S]*?margin:\s*auto;/);
  assert.match(css, /\.mc-route-dialog\s*\{[\s\S]*?max-height:\s*calc\(100dvh/);
  assert.match(css, /\.mc-route-card\s*\{[\s\S]*?width:\s*100%;[\s\S]*?overflow:\s*hidden;/);
});

test('routing options scroll independently while actions remain visible', () => {
  assert.match(css, /\.mc-route-list\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?min-height:\s*0;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.mc-route-card\s*>\s*\.mc-dialog-actions\s*\{\s*flex:\s*0 0 auto;/);
});

test('wall section choices cannot force horizontal dialog overflow', () => {
  assert.match(css, /\.mc-route-sections\s*\{[^}]*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css, /@media\s*\(max-width:\s*720px\)[\s\S]*?\.mc-route-sections[^}]*grid-template-columns:\s*1fr;/);
});
