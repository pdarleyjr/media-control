'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '../..');

async function dataModule(source) {
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
}

async function loadPickerModule() {
  const catalogSource = fs.readFileSync(
    path.join(root, 'frontend/js/services/target-catalog.js'),
    'utf8',
  );
  const catalogUrl = `data:text/javascript;base64,${Buffer.from(catalogSource).toString('base64')}`;
  const utilsUrl = `data:text/javascript;base64,${Buffer.from(
    "export const esc = (value) => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;').replace(/'/g, '&#39;');",
  ).toString('base64')}`;
  const i18nUrl = `data:text/javascript;base64,${Buffer.from(
    "export const t = (key, vars = {}) => `${key}${Object.keys(vars).length ? `:${JSON.stringify(vars)}` : ''}`; export const tn = (key, n) => `${key}:${n}`;",
  ).toString('base64')}`;
  let source = fs.readFileSync(
    path.join(root, 'frontend/js/components/target-picker.js'),
    'utf8',
  );
  source = source
    .replace("'../services/target-catalog.js'", `'${catalogUrl}'`)
    .replace("'../utils.js'", `'${utilsUrl}'`)
    .replace("'../i18n.js'", `'${i18nUrl}'`);
  return dataModule(source);
}

function snapshot() {
  return {
    schemaVersion: 1,
    workspaceId: 'ws-1',
    roomId: 'classroom-1',
    revision: 23,
    deviceStates: {
      displays: [
        { id: 'tv-1', name: 'Primary Left', status: 'online', width: 1920, height: 1080, capabilities: { screen_share: true } },
        { id: 'tv-2', name: 'Primary Center', status: 'online', width: 2560, height: 1440, capabilities: { screen_share: true } },
        { id: 'tv-3', name: 'Primary Right', status: 'offline', width: 3840, height: 2160, capabilities: { screen_share: false } },
        { id: 'confidence', name: 'Confidence Display', status: 'offline', width: 1920, height: 1080, capabilities: { screen_share: true } },
      ],
    },
    layoutState: {
      walls: [{
        id: 'primary-wall',
        name: 'Primary Wall',
        layoutMode: 'span',
        layoutRevision: 88,
        layout: {
          preset: 'span-left-right',
          groups: [
            { id: 'span-left', name: 'Left span', layout: 'span', member_ids: ['tv-1', 'tv-2'] },
            { id: 'span-right', name: 'Right solo', layout: 'solo', member_ids: ['tv-3'] },
          ],
        },
        members: [
          { deviceId: 'tv-1', viewport: { x: 0, y: 0, width: 1920, height: 1080 } },
          { deviceId: 'tv-2', viewport: { x: 1920, y: 0, width: 2560, height: 1440 } },
          { deviceId: 'tv-3', viewport: { x: 4480, y: 0, width: 3840, height: 2160 } },
        ],
      }],
      groups: [{ id: 'all-wall', name: 'All Wall Displays', memberIds: ['tv-1', 'tv-2', 'tv-3'] }],
    },
    livestreamProgram: {
      configured: true,
      displayId: 'live-stream-program-main',
      displayName: 'Live Stream Program',
      status: 'online',
      width: 1920,
      height: 1080,
    },
  };
}

test('picker model exposes the authoritative wall mode, canvas, revision, online count and member topology', async () => {
  const { createTargetPickerModel } = await loadPickerModule();
  const model = createTargetPickerModel({ snapshot: snapshot(), allowOffline: false });
  const wall = model.sections.find((section) => section.kind === 'walls').targets[0];

  assert.equal(wall.target.layoutMode, 'span');
  assert.equal(wall.target.dimensionsLabel, '8320 × 2160');
  assert.equal(wall.target.layoutRevision, 88);
  assert.equal(wall.target.onlineCount, 2);
  assert.deepEqual(wall.target.members.map((member) => [member.name, member.status]), [
    ['Primary Left', 'online'],
    ['Primary Center', 'online'],
    ['Primary Right', 'offline'],
  ]);
  assert.equal(wall.disabled, false, 'a partially online wall remains routable');
});

test('offline targets stay visible for situational awareness but are gated unless explicitly allowed', async () => {
  const { createTargetPickerModel } = await loadPickerModule();
  const guarded = createTargetPickerModel({ snapshot: snapshot() });
  const allowed = createTargetPickerModel({ snapshot: snapshot(), allowOffline: true });
  const guardedStandalone = guarded.sections.find((section) => section.kind === 'standalone').targets[0];
  const allowedStandalone = allowed.sections.find((section) => section.kind === 'standalone').targets[0];

  assert.equal(guardedStandalone.target.id, 'confidence');
  assert.equal(guardedStandalone.disabledReason, 'offline');
  assert.equal(allowedStandalone.disabled, false);
});

test('wall members are hidden by default and become individually addressable only when authorized', async () => {
  const { createTargetPickerModel } = await loadPickerModule();
  const normal = createTargetPickerModel({ snapshot: snapshot() });
  const serviceMode = createTargetPickerModel({
    snapshot: snapshot(),
    allowIndividualWallMembers: true,
    allowOffline: true,
  });

  assert.equal(normal.sections.some((section) => section.kind === 'wall-members'), false);
  assert.deepEqual(
    serviceMode.sections.find((section) => section.kind === 'wall-members').targets.map((item) => item.target.id),
    ['tv-1', 'tv-2', 'tv-3'],
  );
});

test('active wall layout groups appear as accurate typed revisioned choices', async () => {
  const { createTargetPickerModel, buildTargetSelectionResult } = await loadPickerModule();
  const model = createTargetPickerModel({ snapshot: snapshot(), allowOffline: true });
  const groups = model.sections.find((section) => section.kind === 'wall-groups').targets;
  assert.deepEqual(groups.map((item) => item.target.name), [
    'Primary Wall · Left span',
    'Primary Wall · Right solo',
  ]);
  const result = buildTargetSelectionResult(model.catalog, ['wall-group:primary-wall:span-left']);
  assert.deepEqual(result.references, [{
    type: 'wall-group', id: 'primary-wall:span-left', wall_id: 'primary-wall',
    group_id: 'span-left', layout_revision: 88,
  }]);
  assert.deepEqual(result.deviceIds, ['tv-1', 'tv-2']);
});

test('all-member operations label partial targets and disable them', async () => {
  const { createTargetPickerModel, renderTargetPickerContent } = await loadPickerModule();
  const model = createTargetPickerModel({ snapshot: snapshot(), availability: 'all', allowOffline: false });
  const wall = model.sections.find((section) => section.kind === 'walls').targets[0];
  assert.equal(wall.disabledReason, 'partial');
  assert.match(renderTargetPickerContent(model), /mc\.target_picker\.status_partial/);
});

test('single selection renders a shared radio group and retains only the first valid initial destination', async () => {
  const { createTargetPickerModel, renderTargetPickerContent } = await loadPickerModule();
  const model = createTargetPickerModel({
    snapshot: snapshot(),
    selection: 'single',
    selectedTargets: ['wall:primary-wall', 'group:all-wall'],
  });
  const html = renderTargetPickerContent(model, { titleId: 'singlePicker' });

  assert.deepEqual([...model.initialSelection], ['wall:primary-wall']);
  assert.match(html, /type="radio"/);
  assert.match(html, /name="singlePicker-selection"/);
  assert.doesNotMatch(html, /type="checkbox" name="singlePicker-selection"/);
});

test('an incomplete injected catalog fails safely as an empty picker', async () => {
  const { createTargetPickerModel } = await loadPickerModule();
  const model = createTargetPickerModel({ catalog: { workspaceId: 'ws-1' } });

  assert.deepEqual(model.sections, []);
  assert.equal(model.liveProgram, null);
});

test('capability gates known-incompatible destinations without excluding legacy targets with unknown capability data', async () => {
  const { createTargetPickerModel } = await loadPickerModule();
  const model = createTargetPickerModel({
    snapshot: snapshot(),
    capability: 'screen_share',
    allowIndividualWallMembers: true,
    allowOffline: true,
  });
  const wall = model.sections.find((section) => section.kind === 'walls').targets[0];
  const members = model.sections.find((section) => section.kind === 'wall-members').targets;

  assert.equal(wall.disabledReason, 'unsupported', 'every wall member must support a wall-wide operation');
  assert.equal(members.find((item) => item.target.id === 'tv-1').disabled, false);
  assert.equal(members.find((item) => item.target.id === 'tv-3').disabledReason, 'unsupported');
});

test('live program is absent by default and rendered as a separate guarded destination only on explicit opt-in', async () => {
  const { createTargetPickerModel, renderTargetPickerContent } = await loadPickerModule();
  const normal = createTargetPickerModel({ snapshot: snapshot() });
  const live = createTargetPickerModel({ snapshot: snapshot(), allowLiveProgram: true });

  assert.equal(normal.liveProgram, null);
  assert.equal(live.liveProgram.target.type, 'live-program');
  const html = renderTargetPickerContent(live, { liveAcknowledged: false });
  assert.match(html, /data-target-live-guard/);
  assert.match(html, /data-target-key="live-program:live-stream-program-main"[^>]*disabled/);
  assert.match(html, /mc-target-picker-live/);
  assert.match(html, /mc\.target_picker\.live_warning/);
});

test('selection results are typed, deduplicated and keep live output separate from physical devices', async () => {
  const { createTargetPickerModel, buildTargetSelectionResult } = await loadPickerModule();
  const model = createTargetPickerModel({ snapshot: snapshot(), allowLiveProgram: true });
  const result = buildTargetSelectionResult(model.catalog, [
    'wall:primary-wall',
    'display:tv-1',
    'live-program:live-stream-program-main',
  ]);

  assert.deepEqual(result.references, [
    { type: 'wall', id: 'primary-wall', layout_revision: 88 },
    { type: 'display', id: 'tv-1' },
    { type: 'live-program', id: 'live-stream-program-main' },
  ]);
  assert.deepEqual(result.deviceIds, ['tv-1', 'tv-2', 'tv-3']);
  assert.equal(result.liveProgram.id, 'live-stream-program-main');
  assert.equal(result.includesLiveProgram, true);
});

test('component contract uses semantic dialog controls, localization, and touch-safe styling', () => {
  const component = fs.readFileSync(path.join(root, 'frontend/js/components/target-picker.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'frontend/css/media-control.css'), 'utf8');
  const english = fs.readFileSync(path.join(root, 'frontend/js/i18n/en.js'), 'utf8');

  assert.match(component, /aria-modal/);
  assert.match(component, /aria-labelledby/);
  assert.match(component, /type="(?:radio|checkbox)"/);
  assert.match(component, /t\('mc\.target_picker\./);
  assert.match(component, /esc\(item\.target\.name\)/);
  assert.match(css, /\.mc-target-picker-choice\s*\{[\s\S]*?min-height:\s*var\(--tap-min/);
  assert.match(css, /\.mc-target-picker-choice:focus-within/);
  assert.match(css, /@media \(max-width:\s*640px\)/);
  assert.match(english, /'mc\.target_picker\.title'/);
});
