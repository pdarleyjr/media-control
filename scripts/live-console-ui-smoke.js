#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function required(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function jsonFetch(url, timeoutMs = 1000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

class CdpClient {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP websocket connect timeout')), 10000);
      this.ws.onopen = () => { clearTimeout(timer); resolve(); };
      this.ws.onerror = () => { clearTimeout(timer); reject(new Error('CDP websocket error')); };
      this.ws.onmessage = (event) => this.onMessage(event.data);
    });
  }

  onMessage(raw) {
    const message = JSON.parse(String(raw));
    if (message.id) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || 'CDP command failed'));
      else pending.resolve(message.result || {});
      return;
    }
    if (message.method) this.events.push(message);
  }

  send(method, params = {}, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try { this.ws.close(); } catch { /* */ }
  }
}

async function waitForTarget(port) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const targets = await jsonFetch(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find((target) => target.type === 'page');
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* Chromium is still starting. */ }
    await sleep(150);
  }
  throw new Error('Chromium DevTools target did not become ready');
}

async function evaluate(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'browser evaluation failed');
  }
  return result.result?.value;
}

async function waitFor(cdp, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await evaluate(cdp, expression).catch((error) => ({ error: error.message }));
    if (last && last !== false) return last;
    await sleep(150);
  }
  throw new Error(`${label} timeout; last=${JSON.stringify(last)}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function csv(value) {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function dragDropConfig() {
  const contentId = String(process.env.SMOKE_DRAG_CONTENT_ID || '').trim();
  if (!contentId) return null;
  const config = {
    contentId,
    wallId: required('SMOKE_DRAG_WALL_ID'),
    deviceIds: csv(required('SMOKE_DRAG_DEVICE_IDS')),
    restoreContentId: required('SMOKE_DRAG_RESTORE_CONTENT_ID'),
    restoreUserEmail: String(process.env.SMOKE_DRAG_RESTORE_USER_EMAIL || 'peterdarley@miamibeachfl.gov').trim().toLowerCase(),
  };
  if (!config.deviceIds.length) throw new Error('SMOKE_DRAG_DEVICE_IDS must contain at least one display');
  return config;
}

async function waitForPhysicalContent(db, deviceIds, contentId, timeoutMs = 20000) {
  const placeholders = deviceIds.map(() => '?').join(',');
  const deadline = Date.now() + timeoutMs;
  let rows = [];
  while (Date.now() < deadline) {
    rows = db.prepare(`
      SELECT target_id, current_content_id, render_state, error_state, state_revision
      FROM display_states
      WHERE target_type = 'display' AND target_id IN (${placeholders})
      ORDER BY target_id
    `).all(...deviceIds);
    if (rows.length === deviceIds.length && rows.every((row) => (
      row.current_content_id === contentId
      && row.render_state === 'playing'
      && !row.error_state
    ))) return rows;
    await sleep(250);
  }
  throw new Error(`display state did not converge to ${contentId}: ${JSON.stringify(rows)}`);
}

async function restoreDragDropContent(db, config) {
  const { generateToken } = require('../server/middleware/auth');
  const user = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(config.restoreUserEmail);
  if (!user) throw new Error(`drag restore user not found: ${config.restoreUserEmail}`);
  const target = db.prepare('SELECT workspace_id FROM devices WHERE id = ?').get(config.deviceIds[0]);
  if (!target?.workspace_id) throw new Error('drag restore target workspace not found');
  const membership = db.prepare('SELECT 1 FROM workspace_members WHERE workspace_id = ? AND user_id = ?')
    .get(target.workspace_id, user.id);
  if (!membership && user.role !== 'platform_admin') throw new Error('drag restore user cannot access the target workspace');
  const response = await fetch('http://127.0.0.1:3001/api/broadcast', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${generateToken(user, target.workspace_id)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content_id: config.restoreContentId, device_ids: config.deviceIds }),
  });
  const body = await response.json();
  if (!response.ok || body.sent !== config.deviceIds.length) {
    throw new Error(`drag restore failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return waitForPhysicalContent(db, config.deviceIds, config.restoreContentId);
}

async function main() {
  const deviceToken = required('CONSOLE_DEVICE_TOKEN');
  const dragConfig = dragDropConfig();
  const url = String(process.env.SMOKE_CONSOLE_URL || 'http://127.0.0.1:3001/console/classroom-1#/control');
  const screenshotPath = String(process.env.SMOKE_SCREENSHOT_PATH || '/tmp/console-ui-smoke.png');
  const cameraScreenshotPath = screenshotPath.replace(/(\.png)?$/i, '-camera.png');
  const chromium = String(process.env.CHROMIUM_PATH || '/usr/bin/chromium-browser');
  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbfd-console-smoke-'));
  const child = spawn(chromium, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--disable-background-networking',
    '--window-size=1920,1080',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let chromiumError = '';
  child.stderr.on('data', (chunk) => { chromiumError = (chromiumError + chunk).slice(-4000); });

  let cdp;
  try {
    const target = await waitForTarget(port);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await Promise.all([
      cdp.send('Page.enable'),
      cdp.send('Runtime.enable'),
      cdp.send('Network.enable'),
      cdp.send('Log.enable'),
    ]);
    await cdp.send('Network.setExtraHTTPHeaders', {
      headers: { 'X-MBFD-Device-Token': deviceToken },
    });
    await cdp.send('Page.navigate', { url });

    const ready = await waitFor(cdp, `(() => {
      const buttons = [...document.querySelectorAll('.mc-target-wall-btn')];
      if (!document.querySelector('.mc-cc-shell') || buttons.length < 2) return false;
      return buttons.map((button) => ({ text: button.textContent.trim(), value: button.dataset.targetValue }));
    })()`, 'command center ready', 30000);
    assert(ready.some((item) => /Video Wall 1/i.test(item.text)), 'Video Wall 1 target is missing');
    assert(ready.some((item) => /Video Wall 2/i.test(item.text)), 'Video Wall 2 target is missing');

    for (const label of ['Video Wall 2', 'Video Wall 1']) {
      await evaluate(cdp, `(() => {
        const button = [...document.querySelectorAll('.mc-target-wall-btn')]
          .find((item) => item.textContent.trim().includes(${JSON.stringify(label)}));
        if (!button) return false;
        button.click();
        return true;
      })()`);
      await waitFor(cdp, `(() => {
        const button = [...document.querySelectorAll('.mc-target-wall-btn')]
          .find((item) => item.textContent.trim().includes(${JSON.stringify(label)}));
        return !!button && button.getAttribute('aria-pressed') === 'true' && button.classList.contains('is-active');
      })()`, `${label} selection`);
    }

    let dragDrop = null;
    if (dragConfig) {
      const { db } = require('../server/db/database');
      const inventory = await waitFor(cdp, `(() => {
        const wallId = ${JSON.stringify(dragConfig.wallId)};
        const target = document.querySelector('.mc-wall[data-wall-id="' + wallId + '"] .mc-wall-all');
        const sources = [...document.querySelectorAll('.mc-tile[data-drag-source]')].map((item) => {
          try {
            const source = JSON.parse(item.dataset.dragSource || '{}');
            return { content_id: source.content_id || null, label: item.textContent.trim().slice(0, 120) };
          } catch { return null; }
        }).filter(Boolean);
        if (!target || !sources.length) return false;
        return { target: true, sources };
      })()`, 'podium drag inventory', 30000);

      if (dragConfig.contentId.toLowerCase() === 'auto') {
        const selected = inventory.sources.find((source) => (
          source.content_id && source.content_id !== dragConfig.restoreContentId
        ));
        if (!selected) throw new Error(`no visible drag source differs from restore content: ${JSON.stringify(inventory.sources)}`);
        dragConfig.contentId = selected.content_id;
      }

      const configuredSource = inventory.sources.find((source) => source.content_id === dragConfig.contentId);
      assert(configuredSource, `configured drag source is not visible: ${dragConfig.contentId}; visible=${JSON.stringify(inventory.sources)}`);
      await waitFor(cdp, `(() => {
        const contentId = ${JSON.stringify(dragConfig.contentId)};
        const wallId = ${JSON.stringify(dragConfig.wallId)};
        const tile = [...document.querySelectorAll('.mc-tile[data-drag-source]')].find((item) => {
          try { return JSON.parse(item.dataset.dragSource || '{}').content_id === contentId; } catch { return false; }
        });
        return !!tile && !!document.querySelector('.mc-wall[data-wall-id="' + wallId + '"] .mc-wall-all');
      })()`, 'podium drag source and wall target', 30000);

      let dispatched = false;
      try {
        const dragStartedAt = Date.now();
        const browserResult = await evaluate(cdp, `(() => {
          const contentId = ${JSON.stringify(dragConfig.contentId)};
          const wallId = ${JSON.stringify(dragConfig.wallId)};
          const tile = [...document.querySelectorAll('.mc-tile[data-drag-source]')].find((item) => {
            try { return JSON.parse(item.dataset.dragSource || '{}').content_id === contentId; } catch { return false; }
          });
          const target = document.querySelector('.mc-wall[data-wall-id="' + wallId + '"] .mc-wall-all');
          if (!tile || !target) return { ok: false, reason: 'source or target missing' };
          const dataTransfer = new DataTransfer();
          tile.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer }));
          const source = dataTransfer.getData('application/x-mc-source');
          const label = dataTransfer.getData('application/x-mc-label');
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }));
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
          return { ok: true, source, label, types: [...dataTransfer.types] };
        })()`);
        assert(browserResult?.ok, `podium drag event failed: ${JSON.stringify(browserResult)}`);
        assert(browserResult.types.includes('application/x-mc-source'), 'podium drag event omitted the media-control source MIME');
        dispatched = true;
        const probeState = await waitForPhysicalContent(db, dragConfig.deviceIds, dragConfig.contentId);
        dragDrop = {
          browser: browserResult,
          probe_state: probeState,
          convergence_ms: Date.now() - dragStartedAt,
        };
      } finally {
        if (dispatched) {
          const restoredState = await restoreDragDropContent(db, dragConfig);
          dragDrop = { ...(dragDrop || {}), restored_state: restoredState };
        }
      }

      let touchDispatched = false;
      try {
        const touchStartedAt = Date.now();
        const touchResult = await evaluate(cdp, `(() => {
          const contentId = ${JSON.stringify(dragConfig.contentId)};
          const wallId = ${JSON.stringify(dragConfig.wallId)};
          const tile = [...document.querySelectorAll('.mc-tile[data-drag-source]')].find((item) => {
            try { return JSON.parse(item.dataset.dragSource || '{}').content_id === contentId; } catch { return false; }
          });
          const target = document.querySelector('.mc-wall[data-wall-id="' + wallId + '"] .mc-wall-all');
          if (!tile || !target) return { ok: false, reason: 'touch source or target missing' };
          const from = tile.getBoundingClientRect();
          const to = target.getBoundingClientRect();
          const pointerId = 73;
          const event = (type, x, y, buttons) => new PointerEvent(type, {
            bubbles: true,
            cancelable: true,
            pointerId,
            pointerType: 'touch',
            isPrimary: true,
            clientX: x,
            clientY: y,
            buttons,
          });
          tile.dispatchEvent(event('pointerdown', from.left + from.width / 2, from.top + from.height / 2, 1));
          tile.dispatchEvent(event('pointermove', to.left + to.width / 2, to.top + to.height / 2, 1));
          const ghostVisible = !!document.querySelector('.mc-touch-drag-ghost');
          tile.dispatchEvent(event('pointerup', to.left + to.width / 2, to.top + to.height / 2, 0));
          return { ok: true, ghost_visible: ghostVisible };
        })()`);
        assert(touchResult?.ok, `podium touch drag failed: ${JSON.stringify(touchResult)}`);
        assert(touchResult.ghost_visible, 'podium touch drag did not enter dragging state');
        touchDispatched = true;
        const touchProbeState = await waitForPhysicalContent(db, dragConfig.deviceIds, dragConfig.contentId);
        dragDrop = {
          ...(dragDrop || {}),
          touch_browser: touchResult,
          touch_probe_state: touchProbeState,
          touch_convergence_ms: Date.now() - touchStartedAt,
        };
      } finally {
        if (touchDispatched) {
          const touchRestoredState = await restoreDragDropContent(db, dragConfig);
          dragDrop = { ...(dragDrop || {}), touch_restored_state: touchRestoredState };
        }
      }
    }

    const whiteboardOpened = await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-mc-rail="whiteboard"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(whiteboardOpened, 'Whiteboard rail action is missing');
    let whiteboard = null;
    try {
      await waitFor(cdp, `(() => {
        const overlay = document.querySelector('.mc-wb-overlay');
        const canvas = overlay?.querySelector('#mc-wb-canvas');
        const target = overlay?.querySelector('#mc-wb-target-select');
        return !!overlay && !!canvas && canvas.width > 0 && canvas.height > 0 && !!target?.value;
      })()`, 'whiteboard overlay', 30000);

      const modeResult = await evaluate(cdp, `(() => {
        const overlay = document.querySelector('.mc-wb-overlay');
        const blank = overlay?.querySelector('[data-wb-mode="blank"]');
        const canvas = overlay?.querySelector('#mc-wb-canvas');
        if (!blank || !canvas) return { ok: false };
        blank.click();
        return { ok: true, width: canvas.width, height: canvas.height };
      })()`);
      assert(modeResult?.ok, 'Whiteboard Blank mode control is missing');
      await waitFor(cdp, `document.querySelector('[data-wb-mode="blank"]')?.getAttribute('aria-pressed') === 'true'`, 'whiteboard Blank mode');
      await evaluate(cdp, `document.querySelector('[data-wb-mode="overlay"]')?.click()`);
      await waitFor(cdp, `document.querySelector('[data-wb-mode="overlay"]')?.getAttribute('aria-pressed') === 'true'`, 'whiteboard Overlay mode');

      const drawResult = await evaluate(cdp, `(() => {
        const overlay = document.querySelector('.mc-wb-overlay');
        const canvas = overlay?.querySelector('#mc-wb-canvas');
        if (!canvas) return { ok: false };
        const rect = canvas.getBoundingClientRect();
        const before = canvas.toDataURL();
        const point = (type, x, y, buttons) => canvas.dispatchEvent(new PointerEvent(type, {
          bubbles: true,
          cancelable: true,
          pointerId: 41,
          pointerType: 'mouse',
          isPrimary: true,
          buttons,
          clientX: rect.left + x,
          clientY: rect.top + y,
        }));
        point('pointerdown', Math.max(20, rect.width * 0.25), Math.max(20, rect.height * 0.35), 1);
        point('pointermove', Math.max(40, rect.width * 0.50), Math.max(40, rect.height * 0.55), 1);
        point('pointerup', Math.max(60, rect.width * 0.70), Math.max(60, rect.height * 0.65), 0);
        return {
          ok: true,
          before,
          target: overlay.querySelector('#mc-wb-target-select')?.selectedOptions?.[0]?.textContent?.trim() || '',
          options: [...overlay.querySelectorAll('#mc-wb-target-select option')].map((item) => item.textContent.trim()),
        };
      })()`);
      assert(drawResult?.ok, 'Whiteboard canvas is missing');
      await sleep(250);
      const drawingChanged = await evaluate(cdp, `(() => {
        const canvas = document.querySelector('.mc-wb-overlay #mc-wb-canvas');
        return !!canvas && canvas.toDataURL() !== ${JSON.stringify(drawResult.before)};
      })()`);
      assert(drawingChanged, 'Whiteboard pointer stroke did not render on the operator canvas');
      whiteboard = {
        target: drawResult.target,
        targets: drawResult.options,
        blank_mode: true,
        overlay_mode: true,
        drawing_changed: drawingChanged,
        canvas: { width: modeResult.width, height: modeResult.height },
      };
      await evaluate(cdp, `document.querySelector('.mc-wb-overlay #mc-wb-clear')?.click()`);
    } finally {
      await evaluate(cdp, `document.querySelector('.mc-wb-overlay #mc-wb-close')?.click()`).catch(() => {});
      await waitFor(cdp, `!document.querySelector('.mc-wb-overlay')`, 'whiteboard close').catch(() => {});
    }

    const viewport = await evaluate(cdp, `(() => {
      const rect = (selector) => {
        const node = document.querySelector(selector);
        if (!node) return null;
        const box = node.getBoundingClientRect();
        return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
      };
      return {
        innerWidth, innerHeight,
        htmlScrollWidth: document.documentElement.scrollWidth,
        htmlScrollHeight: document.documentElement.scrollHeight,
        bodyScrollWidth: document.body.scrollWidth,
        bodyScrollHeight: document.body.scrollHeight,
        shell: rect('.mc-cc-shell'),
        main: rect('.mc-cc-main'),
        stage: rect('.mc-stage'),
      };
    })()`);
    assert(viewport.htmlScrollWidth <= viewport.innerWidth + 2, `command center has horizontal overflow: ${JSON.stringify(viewport)}`);
    assert(viewport.htmlScrollHeight <= viewport.innerHeight + 2, `command center has page-level vertical overflow: ${JSON.stringify(viewport)}`);
    assert(viewport.shell && viewport.shell.bottom <= viewport.innerHeight + 2, 'command center shell exceeds the viewport');

    await evaluate(cdp, `localStorage.setItem('mc_multiview_cells_v1', JSON.stringify({
      L1: { cellUrl: '/assets/mbfd-logo.png', monitorUrl: null, kind: 'm', label: 'UI smoke source', thumb: '/assets/mbfd-logo.png', category: 'image' }
    }))`);
    const opened = await evaluate(cdp, `(() => {
      const button = document.querySelector('[data-dock="multiview"]');
      if (!button) return false;
      button.click();
      return true;
    })()`);
    assert(opened, 'Multiview action is missing');
    await waitFor(cdp, `!!document.querySelector('.mc-multiview-host:not([hidden]) .mc-mv-stage')`, 'Multiview overlay');

    const multiview = await evaluate(cdp, `(() => {
      const host = document.querySelector('.mc-multiview-host:not([hidden])');
      const card = host?.querySelector('.mc-mv');
      const stage = host?.querySelector('.mc-mv-stage');
      const send = host?.querySelector('.mc-mv-send');
      const box = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { top:r.top, right:r.right, bottom:r.bottom, left:r.left, width:r.width, height:r.height }; })() : null;
      const style = host ? getComputedStyle(host) : null;
      return {
        host: box(host), card: box(card), stage: box(stage), send: box(send),
        overflowY: style?.overflowY,
        scrollHeight: host?.scrollHeight || 0,
        clientHeight: host?.clientHeight || 0,
        sendDisabled: !!send?.disabled,
      };
    })()`);
    assert(multiview.host?.top === 0 && multiview.host?.bottom <= viewport.innerHeight + 2, `Multiview overlay is not viewport bounded: ${JSON.stringify(multiview)}`);
    assert(['auto', 'scroll'].includes(multiview.overflowY), `Multiview overlay is not scrollable: ${JSON.stringify(multiview)}`);
    assert(multiview.stage?.height > 100, `Multiview stage did not render: ${JSON.stringify(multiview)}`);
    assert(!multiview.sendDisabled, 'Multiview Send remained disabled with a valid source');

    await evaluate(cdp, `document.querySelector('.mc-mv-send').click()`);
    await waitFor(cdp, `!!document.querySelector('dialog.mc-route-dialog[open]')`, 'routing picker');
    const routeDialog = await evaluate(cdp, `(() => {
      const dialog = document.querySelector('dialog.mc-route-dialog[open]');
      const card = dialog?.querySelector('.mc-route-card');
      const list = dialog?.querySelector('.mc-route-list');
      const actions = dialog?.querySelector('.mc-dialog-actions');
      const box = (node) => node ? (() => { const r = node.getBoundingClientRect(); return { top:r.top, right:r.right, bottom:r.bottom, left:r.left, width:r.width, height:r.height }; })() : null;
      return {
        dialog: box(dialog), card: box(card), list: box(list), actions: box(actions),
        listOverflowY: list ? getComputedStyle(list).overflowY : null,
      };
    })()`);
    assert(routeDialog.card?.top >= -1 && routeDialog.card?.bottom <= viewport.innerHeight + 1, `routing picker exceeds viewport: ${JSON.stringify(routeDialog)}`);
    assert(routeDialog.actions?.bottom <= viewport.innerHeight + 1, `routing actions are unreachable: ${JSON.stringify(routeDialog)}`);
    assert(['auto', 'scroll'].includes(routeDialog.listOverflowY), `routing choices are not independently scrollable: ${JSON.stringify(routeDialog)}`);

    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(screenshotPath, Buffer.from(shot.data, 'base64'));
    await evaluate(cdp, `document.querySelector('[data-route-cancel]')?.click()`);
    await waitFor(cdp, `!document.querySelector('dialog.mc-route-dialog[open]')`, 'routing picker close');
    await evaluate(cdp, `document.querySelector('.mc-mv-close')?.click()`);
    await waitFor(cdp, `document.querySelector('.mc-multiview-host')?.hidden === true`, 'Multiview close');

    const cameraTabOpened = await evaluate(cdp, `(() => {
      const tab = document.querySelector('.mc-tb-tab[data-tab="camerafeeds"]');
      if (!tab) return false;
      tab.click();
      return true;
    })()`);
    assert(cameraTabOpened, 'Camera Feeds tab is missing');
    await waitFor(cdp, `!!document.querySelector('.mc-cf-control-open')`, 'camera controls card');
    await evaluate(cdp, `document.querySelector('.mc-cf-control-open').click()`);
    await waitFor(cdp, `(() => {
      const frame = document.querySelector('.mc-view-modal[open] .mc-camera-control-frame');
      const doc = frame?.contentDocument;
      const video = doc?.querySelector('#video');
      return !!doc?.querySelector('#eptz.is-visible')
        && doc.querySelector('#state')?.hidden === true
        && video?.readyState >= 2;
    })()`, 'live Focus 210 camera controls', 30000);
    const cameraControl = await evaluate(cdp, `(() => {
      const frame = document.querySelector('.mc-view-modal[open] .mc-camera-control-frame');
      const video = frame.contentDocument.querySelector('#video');
      const before = video.style.transform;
      frame.contentDocument.querySelector('[data-eptz="wall-2"]').click();
      return { before, after: video.style.transform, readyState: video.readyState, paused: video.paused };
    })()`);
    assert(cameraControl.before !== cameraControl.after, `Wall 2 PTZ preset did not change the live transform: ${JSON.stringify(cameraControl)}`);
    const cameraShot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(cameraScreenshotPath, Buffer.from(cameraShot.data, 'base64'));
    await evaluate(cdp, `document.querySelector('.mc-view-modal[open] [data-modal-close]')?.click()`);
    await waitFor(cdp, `!document.querySelector('.mc-view-modal[open]')`, 'camera controls close');

    const runtimeExceptions = cdp.events.filter((event) => event.method === 'Runtime.exceptionThrown');
    console.log(JSON.stringify({
      ok: true,
      wall_targets: ready.map((item) => item.text),
      viewport,
      multiview,
      route_dialog: routeDialog,
      camera_control: cameraControl,
      drag_drop: dragDrop,
      whiteboard,
      runtime_exceptions: runtimeExceptions.length,
      screenshot: screenshotPath,
      camera_screenshot: cameraScreenshotPath,
    }));
  } catch (error) {
    if (chromiumError) error.message += `; chromium=${chromiumError.replace(/\s+/g, ' ').slice(-800)}`;
    throw error;
  } finally {
    if (cdp) cdp.close();
    child.kill('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      sleep(3000),
    ]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try {
        fs.rmSync(profileDir, { recursive: true, force: true });
        break;
      } catch (error) {
        if (!['EBUSY', 'EPERM'].includes(error.code) || attempt === 9) break;
        await sleep(250);
      }
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
