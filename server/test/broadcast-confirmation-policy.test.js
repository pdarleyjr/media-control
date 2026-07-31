'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', relPath), 'utf8');
}

test('the shared broadcast client permanently pre-authorizes routine routing', () => {
  const api = read('frontend/js/api.js');
  assert.match(api, /const authorizedPayload = \{[\s\S]{0,180}confirm_all: true,[\s\S]{0,100}confirm_wall_replace: true/);
  assert.match(api, /body: JSON\.stringify\(authorizedPayload\)/);
  assert.doesNotMatch(api, /Surface the confirm-all gate/);
});

test('no broadcast entry point opens a confirmation popup', () => {
  const paths = [
    'frontend/js/views/files.js',
    'frontend/js/views/broadcast-center.js',
    'frontend/js/views/dashboard.js',
    'frontend/js/views/present.js',
    'frontend/js/views/presentations.js',
    'frontend/js/views/media-control.js',
    'frontend/js/views/media-control/toolbox.js',
    'frontend/js/views/media-control/send.js',
    'frontend/js/views/media-control-enterprise/operator-console.js',
  ];
  for (const relPath of paths) {
    const source = read(relPath);
    assert.doesNotMatch(source, /CONFIRM_ALL_REQUIRED|CONFIRM_WALL_REPLACE_REQUIRED/, relPath);
  }
  const operator = read('frontend/js/views/media-control-enterprise/operator-console.js');
  assert.doesNotMatch(operator, /confirmAction|mc\.e\.send\.confirm/);
});

test('destructive confirmations remain available outside routine broadcast', () => {
  const actionDock = read('frontend/js/views/media-control/action-dock.js');
  const inspector = read('frontend/js/views/media-control/inspector.js');
  assert.match(actionDock, /confirmDialog[\s\S]*stop_live/);
  assert.match(inspector, /confirmDialog/);
});
