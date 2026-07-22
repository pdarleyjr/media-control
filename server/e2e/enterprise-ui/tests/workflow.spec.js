// Operator workflow + state-transition contract tests (task §15, §16).
const { test, expect } = require('@playwright/test');

test('pending command keeps a display visibly PENDING then resolves to CONFIRMED', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.evaluate(() => window.__applySnapshot(window.__snapshot(2, {
    confirmedState: { displays: [{ id: 'd1', name: 'Podium Left', status: 'online' }] },
    pendingCommands: [{ command_id: 'cmd1', target_id: 'd1', command_type: 'transport', status: 'sent' }],
  })));
  await expect(page.locator('.mc-e-ro-display[data-display-id="d1"]')).toHaveAttribute('data-op-state', 'pending');
  await page.evaluate(() => window.__applySnapshot(window.__snapshot(3, {
    confirmedState: { displays: [{ id: 'd1', name: 'Podium Left', status: 'online', contentId: 'c1', contentType: 'slides' }] },
    pendingCommands: [],
  })));
  await expect(page.locator('.mc-e-ro-display[data-display-id="d1"]')).toHaveAttribute('data-op-state', 'confirmed');
});

test('offline display shows OFFLINE regardless of pending', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.evaluate(() => window.__applySnapshot(window.__snapshot(2, {
    confirmedState: { displays: [{ id: 'd1', name: 'Podium Left', status: 'offline' }] },
    deviceStates: { displays: [{ id: 'd1', status: 'offline' }], nodes: [] },
    pendingCommands: [{ command_id: 'cmd1', target_id: 'd1', command_type: 'transport', status: 'sent' }],
  })));
  await expect(page.locator('.mc-e-ro-display[data-display-id="d1"]')).toHaveAttribute('data-op-state', 'offline');
});

test('failed command never appears confirmed', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.evaluate(() => window.__applySnapshot(window.__snapshot(2, {
    confirmedState: { displays: [{ id: 'd1', name: 'Podium Left', status: 'online', contentId: 'c1' }] },
    pendingCommands: [{ command_id: 'cmd1', target_id: 'd1', command_type: 'transport', status: 'failed' }],
  })));
  await expect(page.locator('.mc-e-ro-display[data-display-id="d1"]')).toHaveAttribute('data-op-state', 'failed');
});

test('layout selection reports the chosen intent', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.locator('button[data-layout="single"]').click();
  const sel = await page.evaluate(() => window.__selectedLayout?.key);
  expect(sel).toBe('single');
});

test('playback transport sends a command per click (no double-fire)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.evaluate(() => { window.__sent = []; });
  await page.locator('button[data-transport="next"]').click();
  await expect.poll(async () => page.evaluate(() => window.__sent?.length)).toBe(1);
  await page.locator('button[data-transport="next"]').click();
  await expect.poll(async () => page.evaluate(() => window.__sent?.length)).toBe(2);
});

test('content selection is reported to the host', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.locator('button[data-content-id]').first().click();
  const id = await page.evaluate(() => window.__selectedContent?.id);
  expect(id).toBeTruthy();
});

test('privacy blocks destructive deletion while content is in use', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await expect(page.locator('button[data-act="delete"]')).toBeDisabled();
  await expect(page.locator('.mc-e-privacy-inuse')).toBeVisible();
});
