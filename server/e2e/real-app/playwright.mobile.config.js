// Playwright config for mobile defect reproduction + acceptance tests.
// Runs Chromium and WebKit (iPhone-class) across 9 mobile viewports.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: '.',
  testMatch: 'mobile-defect.spec.js',
  timeout: 120000,
  expect: { timeout: 20000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report-mobile' }]],
  use: {
    headless: true,
    actionTimeout: 20000,
    navigationTimeout: 30000,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },
  projects: [
    {
      name: 'chromium-mobile',
      use: {
        browserName: 'chromium',
        launchOptions: { args: ['--no-sandbox'] },
      },
    },
    {
      name: 'webkit-mobile',
      use: {
        browserName: 'webkit',
        launchOptions: {},
      },
    },
  ],
});
