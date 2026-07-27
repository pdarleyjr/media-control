'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const transportPath = path.join(
  __dirname, '..', '..', 'frontend', 'js', 'views', 'media-control', 'transport.js',
);

test('transport bar sends one workspace transaction and aggregates physical plus live confirmations', () => {
  const source = fs.readFileSync(transportPath, 'utf8');

  assert.match(source, /export function sendWorkspaceTransportTransaction/);
  assert.match(source, /dashboard:transport-transaction/);
  assert.match(source, /Promise\.all\(/);
  assert.match(source, /target_role/);
  assert.match(source, /physical_confirmations/);
  assert.match(source, /live_confirmation/);
  assert.match(source, /sendWorkspaceTransportTransaction\(\s*transportIds/);
  assert.doesNotMatch(
    source,
    /for\s*\(const id of transportIds\)[\s\S]{0,400}sendTransportCommand/,
    'one operator action must not loop into five independent transport sends',
  );
});

test('transaction confirmations tolerate player acknowledgements arriving before the socket callback', () => {
  const source = fs.readFileSync(transportPath, 'utf8');
  assert.match(source, /earlyCommandAcks/);
  assert.match(source, /earlyCommandAcks\.set\(commandId/);
  assert.match(source, /earlyCommandAcks\.get\(commandId\)/);
});
