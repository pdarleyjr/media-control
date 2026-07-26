'use strict';

/**
 * Release-gate reporter that turns silent Playwright coverage loss into a hard
 * failure.  The required project list is supplied by each config so deleting a
 * browser/device project cannot accidentally leave a green, narrower matrix.
 */
class NoSkipsReporter {
  constructor(options = {}) {
    this.requiredProjects = [...new Set(options.requiredProjects || [])];
    this.discoveredProjects = new Set();
    this.skipped = [];
    this.completed = 0;
    this.total = 0;
  }

  onBegin(config, suite) {
    this.total = suite.allTests().length;
    for (const project of config.projects || []) {
      this.discoveredProjects.add(project.name);
    }
  }

  onTestEnd(test, result) {
    this.completed += 1;
    if (result.status === 'skipped') {
      this.skipped.push(`${test.titlePath().join(' > ')} [${test.parent.project()?.name || 'unknown'}]`);
    }
  }

  onEnd(result) {
    const missingProjects = this.requiredProjects.filter(
      (project) => !this.discoveredProjects.has(project),
    );
    const failures = [];

    if (this.total === 0 || this.completed === 0) {
      failures.push(`zero tests executed (discovered=${this.total}, completed=${this.completed})`);
    }
    if (this.skipped.length > 0) {
      failures.push(`${this.skipped.length} skipped test(s): ${this.skipped.join('; ')}`);
    }
    if (missingProjects.length > 0) {
      failures.push(`required project(s) missing: ${missingProjects.join(', ')}`);
    }

    if (failures.length > 0) {
      console.error(`[no-skips-reporter] FAIL: ${failures.join(' | ')}`);
      return { status: 'failed' };
    }

    console.log(
      `[no-skips-reporter] PASS: ${this.completed}/${this.total} tests completed; projects=${[
        ...this.discoveredProjects,
      ].join(',')}; upstream=${result.status}`,
    );
    return undefined;
  }
}

module.exports = NoSkipsReporter;
