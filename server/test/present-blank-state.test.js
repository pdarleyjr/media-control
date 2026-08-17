'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Present surface reuses confirmed blank state without an optimistic boolean', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'js', 'views', 'present.js'), 'utf8');
  assert.match(source, /deriveBlankState/);
  assert.match(source, /createBlankIntentTracker/);
  assert.match(source, /displayState\.subscribe/);
  assert.match(source, /blankPresentation/);
  assert.match(source, /blankIntentTracker\.begin/);
  assert.doesNotMatch(source, /let blanked\s*=/);
  assert.doesNotMatch(source, /blanked\s*=\s*!blanked/);
});
