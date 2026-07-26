'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const NoSkipsReporter = require('../e2e/no-skips-reporter');

function fakeConfig(projects) {
  return { projects: projects.map((name) => ({ name })) };
}

function fakeSuite(testCount) {
  return { allTests: () => Array.from({ length: testCount }, () => ({})) };
}

function fakeTest(title, project = 'chromium') {
  return {
    titlePath: () => ['suite', title],
    parent: { project: () => ({ name: project }) },
  };
}

test('passes a complete, non-skipped required project matrix', () => {
  const reporter = new NoSkipsReporter({ requiredProjects: ['chromium', 'firefox'] });
  reporter.onBegin(fakeConfig(['chromium', 'firefox']), fakeSuite(2));
  reporter.onTestEnd(fakeTest('one', 'chromium'), { status: 'passed' });
  reporter.onTestEnd(fakeTest('two', 'firefox'), { status: 'passed' });

  assert.equal(reporter.onEnd({ status: 'passed' }), undefined);
});

test('fails when Playwright discovers or completes zero tests', () => {
  const reporter = new NoSkipsReporter({ requiredProjects: ['chromium'] });
  reporter.onBegin(fakeConfig(['chromium']), fakeSuite(0));

  assert.deepEqual(reporter.onEnd({ status: 'passed' }), { status: 'failed' });
});

test('fails when a test is skipped', () => {
  const reporter = new NoSkipsReporter({ requiredProjects: ['chromium'] });
  reporter.onBegin(fakeConfig(['chromium']), fakeSuite(1));
  reporter.onTestEnd(fakeTest('must run'), { status: 'skipped' });

  assert.deepEqual(reporter.onEnd({ status: 'passed' }), { status: 'failed' });
});

test('fails when a required browser or device project is removed', () => {
  const reporter = new NoSkipsReporter({ requiredProjects: ['chromium', 'webkit'] });
  reporter.onBegin(fakeConfig(['chromium']), fakeSuite(1));
  reporter.onTestEnd(fakeTest('one'), { status: 'passed' });

  assert.deepEqual(reporter.onEnd({ status: 'passed' }), { status: 'failed' });
});
