'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

const SERVER_DIR = path.resolve(__dirname, '..', '..');
const DOC_HTML = fs.readFileSync(path.join(SERVER_DIR, 'player', 'doc.html'), 'utf8');
const DEVICE_CONTRACT = fs.readFileSync(path.join(SERVER_DIR, 'player', 'device-contract.js'), 'utf8');
const ORIGIN = 'http://doc-player.test';

function slideSvg(page) {
  const colors = ['#000000', '#14532d', '#1d4ed8', '#7e22ce', '#c2410c', '#be123c'];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180">
    <rect width="320" height="180" fill="${colors[page] || '#334155'}"/>
    <text x="160" y="105" text-anchor="middle" fill="white" font-size="72">${page}</text>
  </svg>`;
}

test('document player commits only the newest decoded generation under delayed out-of-order responses', async ({ page }) => {
  const delays = new Map([[1, 5], [2, 220], [3, 35], [4, 90]]);
  const requests = [];
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body style="margin:0"><iframe id="player" src="/player/doc/test-deck?page=1" style="width:800px;height:450px;border:0"></iframe><script>
          window.transportMessages = [];
          addEventListener('message', (event) => { if (event.origin === location.origin) transportMessages.push(event.data); });
        <\/script></body></html>`,
      });
      return;
    }
    if (url.pathname === '/player/doc/test-deck') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
      return;
    }
    if (url.pathname === '/player/device-contract.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: DEVICE_CONTRACT });
      return;
    }
    if (url.pathname === '/player/doc-meta/test-deck') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pages: 5, filename: 'Race Deck', version: 'fixture-v1' }) });
      return;
    }
    const match = url.pathname.match(/^\/player\/doc-page\/test-deck\/(\d+)\.png$/);
    if (match) {
      const slide = Number(match[1]);
      requests.push({ slide, prefetch: url.searchParams.get('prefetch') === '1' });
      if (slide === 5) {
        await route.fulfill({ status: 503, contentType: 'text/plain', body: 'fixture render failure' });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delays.get(slide) || 10));
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: slideSvg(slide) });
      return;
    }
    await route.fulfill({ status: 404, body: 'not found' });
  });

  await page.goto(`${ORIGIN}/`);
  const player = page.frameLocator('#player');
  await expect(player.locator('#page')).toHaveAttribute('data-committed-page', '1');
  await player.locator('#stage').click({ position: { x: 24, y: 24 } });
  await expect(player.locator('#page')).toHaveAttribute('data-committed-page', '1');

  const resultsPromise = page.locator('#player').evaluate((frame) => {
    const child = frame.contentWindow;
    const actions = ['next', 'next', 'prev', 'next', 'next'];
    return Promise.all(actions.map((action, index) => child.handleAction({
      command_id: `rapid-${index + 1}`,
      action,
      payload: { action },
    })));
  });

  await page.waitForTimeout(55);
  await expect(player.locator('#page')).toHaveAttribute('data-committed-page', '1');
  await expect(player.locator('#stage')).toBeVisible();

  const results = await resultsPromise;
  expect(results.at(-1)).toMatchObject({ ok: true, status: 'acked', state: { slide_index: 4 } });
  expect(results.slice(0, -1).every((ack) => ack.ok === false && ack.status === 'superseded')).toBe(true);
  await expect(player.locator('#page')).toHaveAttribute('data-committed-page', '4');
  await expect(player.locator('body')).toHaveAttribute('data-error', '0');

  const state = await page.locator('#player').evaluate((frame) => frame.contentWindow.__mcTransportState);
  expect(state).toMatchObject({ page: 4, slide_index: 4, requested_slide_index: 4 });

  const screenshotSlides = await page.evaluate(() => window.transportMessages
    .filter((message) => typeof message.__mc_screenshot === 'string')
    .map((message) => message.slide_index));
  expect(screenshotSlides).toEqual([1, 4]);
  expect(requests.some((request) => request.slide === 2 && !request.prefetch)).toBe(true);

  const failed = await page.locator('#player').evaluate((frame) => frame.contentWindow.handleAction({
    command_id: 'recoverable-failure',
    action: 'go_to_slide',
    payload: { action: 'go_to_slide', slide: 5 },
  }));
  expect(failed).toMatchObject({ ok: false, status: 'failed', state: { slide_index: 4 } });
  await expect(player.locator('#page')).toHaveAttribute('data-committed-page', '4');
  await expect(player.locator('#stage')).toBeVisible();
  await expect(player.locator('body')).toHaveAttribute('data-error', '1');

  const recovered = await page.locator('#player').evaluate((frame) => frame.contentWindow.handleAction({
    command_id: 'recoverable-success',
    action: 'go_to_slide',
    payload: { action: 'go_to_slide', slide: 3 },
  }));
  expect(recovered).toMatchObject({ ok: true, state: { slide_index: 3 } });
  await expect(player.locator('#page')).toHaveAttribute('data-committed-page', '3');
  await expect(player.locator('body')).toHaveAttribute('data-error', '0');
});

test('primary grouped and secondary span wall followers converge on committed document slides', async ({ page }) => {
  const wallOrigin = 'http://wall-doc-sync.test';
  await page.route(`${wallOrigin}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') {
      await route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: `<!doctype html><html><body>${['primary-leader', 'primary-follower', 'secondary-leader', 'secondary-follower']
          .map((id) => `<iframe id="${id}" src="/player/doc/wall-deck?page=1"></iframe>`).join('')}<script>
          window.relayWallAction = async (leaderId, followerId, action, commandId) => {
            const leader = document.getElementById(leaderId).contentWindow;
            const follower = document.getElementById(followerId).contentWindow;
            const leaderAck = await leader.handleAction({ command_id: commandId, action, payload: { action } });
            const committedSlide = leader.__mcTransportState.slide_index;
            const followerAck = await follower.handleAction({
              action: 'go_to_slide',
              payload: { action: 'go_to_slide', slide: committedSlide },
            });
            return { leaderAck, followerAck, committedSlide };
          };
        <\/script></body></html>`,
      });
      return;
    }
    if (url.pathname === '/player/doc/wall-deck') {
      await route.fulfill({ status: 200, contentType: 'text/html', body: DOC_HTML });
      return;
    }
    if (url.pathname === '/player/device-contract.js') {
      await route.fulfill({ status: 200, contentType: 'application/javascript', body: DEVICE_CONTRACT });
      return;
    }
    if (url.pathname === '/player/doc-meta/wall-deck') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ pages: 20, filename: 'Wall Deck', version: 'fixture-v1' }) });
      return;
    }
    const match = url.pathname.match(/^\/player\/doc-page\/wall-deck\/(\d+)\.png$/);
    if (match) {
      const slide = Number(match[1]);
      const interactiveDelay = url.searchParams.get('prefetch') === '1' ? 2 : ((slide % 3) * 13) + 4;
      await new Promise((resolve) => setTimeout(resolve, interactiveDelay));
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: slideSvg(slide) });
      return;
    }
    await route.fulfill({ status: 404, body: 'not found' });
  });

  await page.goto(`${wallOrigin}/`);
  for (const id of ['primary-leader', 'primary-follower', 'secondary-leader', 'secondary-follower']) {
    await expect(page.frameLocator(`#${id}`).locator('#page')).toHaveAttribute('data-committed-page', '1');
  }

  for (const [wallName, leaderId, followerId] of [
    ['primary', 'primary-leader', 'primary-follower'],
    ['secondary', 'secondary-leader', 'secondary-follower'],
  ]) {
    for (let index = 0; index < 10; index += 1) {
      const result = await page.evaluate(({ leader, follower, commandId }) => (
        window.relayWallAction(leader, follower, 'next', commandId)
      ), { leader: leaderId, follower: followerId, commandId: `${wallName}-next-${index}` });
      expect(result.leaderAck).toMatchObject({ ok: true, state: { slide_index: index + 2 } });
      expect(result.followerAck).toMatchObject({ ok: true, state: { slide_index: index + 2 } });
    }

    for (let index = 0; index < 3; index += 1) {
      const expectedSlide = 10 - index;
      const result = await page.evaluate(({ leader, follower, commandId }) => (
        window.relayWallAction(leader, follower, 'prev', commandId)
      ), { leader: leaderId, follower: followerId, commandId: `${wallName}-prev-${index}` });
      expect(result.leaderAck).toMatchObject({ ok: true, state: { slide_index: expectedSlide } });
      expect(result.followerAck).toMatchObject({ ok: true, state: { slide_index: expectedSlide } });
    }

    const rapid = await page.evaluate(async ({ leaderId: leader, followerId: follower, wallName: name }) => {
      const leaderWindow = document.getElementById(leader).contentWindow;
      const followerWindow = document.getElementById(follower).contentWindow;
      const acknowledgements = await Promise.all(['next', 'next', 'prev', 'next'].map((action, index) => (
        leaderWindow.handleAction({ command_id: `${name}-rapid-${index}`, action, payload: { action } })
      )));
      const committedSlide = leaderWindow.__mcTransportState.slide_index;
      const followerAck = await followerWindow.handleAction({
        action: 'go_to_slide',
        payload: { action: 'go_to_slide', slide: committedSlide },
      });
      return { acknowledgements, followerAck, leaderState: leaderWindow.__mcTransportState };
    }, { leaderId, followerId, wallName });

    expect(rapid.acknowledgements.at(-1)).toMatchObject({ ok: true, state: { slide_index: 10 } });
    expect(rapid.acknowledgements.slice(0, -1).every((ack) => ack.status === 'superseded')).toBe(true);
    expect(rapid.leaderState).toMatchObject({ slide_index: 10, requested_slide_index: 10 });
    expect(rapid.followerAck).toMatchObject({ ok: true, state: { slide_index: 10 } });
    await expect(page.frameLocator(`#${leaderId}`).locator('#page')).toHaveAttribute('data-committed-page', '10');
    await expect(page.frameLocator(`#${followerId}`).locator('#page')).toHaveAttribute('data-committed-page', '10');
  }
});
