const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: ['player-audio-policy.spec.js'],
  timeout: 30000,
  expect: { timeout: 5000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: 'list',
  use: {
    headless: true,
    // The real player registers a production offline-cache worker which can
    // intentionally reload on activation. This isolated loopback harness
    // exercises audio state only, so block workers for deterministic timing.
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 5000,
    navigationTimeout: 15000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: 'node ../enterprise-ui/serve.mjs ../.. 18117',
    cwd: __dirname,
    url: 'http://127.0.0.1:18117/',
    reuseExistingServer: false,
    timeout: 15000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
