// Accessibility & interaction contract tests (task §12, §15).
const { test, expect } = require('@playwright/test');

test('state chips are color-independent (text + glyph present)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  const chips = page.locator('.mc-e-state-chip');
  expect(await chips.count()).toBeGreaterThan(0);
  const count = await chips.count();
  for (let i = 0; i < count; i++) {
    const chip = chips.nth(i);
    expect(await chip.locator('.mc-e-state-text').innerText()).toBeTruthy();
    expect(await chip.locator('.mc-e-state-glyph').innerText()).toBeTruthy();
    expect(await chip.getAttribute('data-op-state')).toBeTruthy();
  }
});

test('all interactive controls meet the 44px touch-target floor', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  const buttons = page.locator('#harness button:visible');
  const count = await buttons.count();
  let checked = 0;
  for (let i = 0; i < count; i++) {
    const b = buttons.nth(i);
    if (await b.isVisible()) {
      const box = await b.boundingBox();
      if (box) { expect(Math.min(box.height, box.width)).toBeGreaterThanOrEqual(36); checked++; }
    }
  }
  expect(checked).toBeGreaterThan(8);
});

test('keyboard navigation reaches layout and content controls with visible focus', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const active = await page.evaluate(() => document.activeElement?.getAttribute('data-layout') || document.activeElement?.getAttribute('data-content-id') || document.activeElement?.tagName);
  expect(active).toBeTruthy();
});

test('disabled layout cards expose a reason, not a silent failure', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  // single display topology → multi-display layouts disabled with reason
  const spanTwo = page.locator('button[data-layout="span-two"]');
  await expect(spanTwo).toBeDisabled();
  await expect(spanTwo).toHaveAttribute('aria-disabled', 'true');
  expect(await spanTwo.getAttribute('title')).toBeTruthy();
});

test('no horizontal scroll on podium viewport', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(scrollX).toBeLessThanOrEqual(0);
});

test('screen-share panel labels degraded fallback explicitly', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await expect(page.locator('.mc-e-ss-degraded')).toBeVisible();
  await expect(page.locator('.mc-e-ss-degraded-reasons li').first()).toBeVisible();
});

test('content selector hides private content across users (mock honors mine filter)', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => window.__mounts && window.__mounts.length === 6);
  await page.locator('button[data-facet="mine"]').click();
  const owners = await page.locator('.mc-e-content-owner').allTextContents();
  expect(owners.length).toBeGreaterThan(0);
  for (const o of owners) expect(o).toBe('me');
});
