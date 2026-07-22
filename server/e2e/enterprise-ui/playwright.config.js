// Playwright config for the isolated UI-contract harness.
// Runs a zero-dependency static server (serve.mjs) over the worktree root so ES
// module imports resolve. Browser install is one-time: npm run install-browsers.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  timeout: 30000,
  expect: { timeout: 10000 },
  fullyParallel: false,
  workers: 1,
  use: {
    headless: true,
    baseURL: 'http://127.0.0.1:4321',
    viewport: { width: 1440, height: 900 },
  },
  projects: [
    { name: 'podium', use: { viewport: { width: 1280, height: 800 } } },
    { name: 'handheld-admin', use: { viewport: { width: 480, height: 800 } } },
    { name: 'desktop', use: { viewport: { width: 1440, height: 900 } } },
  ],
  webServer: {
    command: 'node serve.mjs',
    url: 'http://127.0.0.1:4321/',
    reuseExistingServer: false,
    timeout: 15000,
  },
});
