const { test, expect } = require('@playwright/test');

test('content send picker exposes physical split members and stable Mosaic regions', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Send selected content' }).click();

  await expect(page.getByRole('heading', { name: 'Individual wall displays' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Mosaic screen regions' })).toBeVisible();
  await expect(page.getByText('Physical Front Wall · Front Center', { exact: true })).toBeVisible();
  await expect(page.getByText('Mosaic Front Wall · Center TV', { exact: true })).toBeVisible();

  const choices = page.locator('.mc-target-picker-choice');
  const count = await choices.count();
  for (let index = 0; index < count; index += 1) {
    expect((await choices.nth(index).boundingBox()).height).toBeGreaterThanOrEqual(48);
  }
});

test('keyboard-only region selection returns a revision-bound wall-region target', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Send selected content' }).click();

  const region = page.locator('input[value="wall-region:mosaic-wall:center-tv"]');
  await region.focus();
  await page.keyboard.press('Space');
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect.poll(() => page.evaluate(() => window.__splitRoutingResult)).toEqual({
    references: [{
      type: 'wall-region',
      id: 'mosaic-wall:center-tv',
      wall_id: 'mosaic-wall',
      region_id: 'center-tv',
      layout_revision: 51,
    }],
    targets: [expect.objectContaining({
      type: 'wall-region',
      regionId: 'center-tv',
      zoneId: 'mosaic-center',
      playerDeviceId: 'mosaic-player',
    })],
    deviceIds: ['mosaic-player'],
    liveProgram: null,
    includesLiveProgram: false,
  });
});

test('tap workflow selects one physical split display without drag and drop', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Send selected content' }).click();

  await page.getByText('Physical Front Wall · Front Right', { exact: true }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  const result = await page.evaluate(() => window.__splitRoutingResult);
  expect(result.references).toEqual([{
    type: 'wall-member',
    id: 'physical-wall:front-right',
    wall_id: 'physical-wall',
    device_id: 'front-right',
    layout_revision: 50,
  }]);
  expect(result.deviceIds).toEqual(['front-right']);
});
