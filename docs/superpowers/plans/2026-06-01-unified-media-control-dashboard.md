# Unified "Media Control" Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate the Classroom tabs (Present, Displays, Share My Screen, Whiteboard, Scenes) + Studio Home into ONE stage+toolbox "Media Control" dashboard that becomes the post-login landing, fixing the navigate-away state-loss bug and adding templates-first display partitioning — with zero regression to existing tabs.

**Architecture:** A new additive SPA view (`#/control`) backed by (1) a server display-state read model (`GET /api/displays/state`) that is the source of truth for "what is live where", (2) a persistent screen-share engine singleton lifted OUT of the view so navigation never tears down a live broadcast, and (3) zone-id-preserving layout partitioning. The new view emits ONLY the player's existing socket vocabulary; all old routes stay registered.

**Tech Stack:** Node 20 + Express 4 + Socket.IO 4 + better-sqlite3 (synchronous) backend; vanilla-JS ES-module SPA frontend (no framework, no build step); `node --test` for backend unit tests (NEW — repo currently has none); Playwright MCP for frontend E2E verification against the running app.

**Reference spec:** `docs/superpowers/specs/2026-06-01-unified-media-control-dashboard-design.md` (read it first).

---

## Conventions (read before starting)

- **Branch:** all work on `feature/unified-media-control-dashboard` (already created). Commit after every task.
- **Backend tests:** runner is Node's built-in test module. Tests live in `server/test/<name>.test.js`. Run with `npm test` (added in Phase 0). Prefer **pure functions** for logic so tests need no DB/socket. Where a test needs the DB, use a temp file DB (`better-sqlite3`) seeded in the test, never the real `config.dbPath`.
- **Frontend verification:** the SPA has no JS test harness and we are NOT adding one (no build step, no jsdom). Verify frontend tasks with the **Playwright MCP** against a locally running server (`cd server && SELF_HOSTED=true npm run dev`) or against staging. Each frontend task lists explicit Playwright verification steps.
- **better-sqlite3 is synchronous** — `db.prepare(sql).get/.all/.run(...)` return immediately, no `await`. Multi-row writes go in `db.transaction(() => {...})`.
- **Tenancy:** every route is mounted `app.use('/api/<name>', requireAuth, resolveTenancy, require('./routes/<name>'))`. Handlers MUST scope queries by `req.workspaceId` and null-check it (return `[]`/`{}` or 400 when null). `req.user = { id, email, name, role, ... }`.
- **Player protocol is frozen** — never invent or rename a `device:*` / `wall:*` socket event. Drive everything through the existing `device:playlist-update` and `device:command` and `device:wb-*` and `device:screen-share-*` events. Phase 3 centralizes these strings in one module.
- **DO NOT touch** the Walls / Layouts / Playlists / Schedules / Admin **pages**, the player (`server/player/*`), or the player CSS.

---

## File Structure

**New files:**
- `server/test/display-state.test.js` — unit tests for the now-playing resolver.
- `server/test/reconcile-zones.test.js` — unit tests for zone-id-preserving reconcile.
- `server/test/smoke.test.js` — Phase 0 smoke test.
- `server/lib/display-state.js` — pure resolver: snapshot JSON → now-playing summary.
- `server/lib/reconcile-zones.js` — pure: (existingZones, desiredZones) → {updates, inserts, deleteIds} preserving ids by slot.
- `server/routes/displays.js` — `GET /api/displays/state`, `GET/PUT /api/displays/selection`.
- `frontend/js/player-protocol.js` — frozen event-name constants + typed emit helpers.
- `frontend/js/services/screen-share-engine.js` — persistent WebRTC broadcaster singleton (hoisted from the view).
- `frontend/js/services/display-state.js` — client store: fetch `/api/displays/state`, merge live socket events, notify subscribers.
- `frontend/js/views/media-control.js` — THE unified view.
- `frontend/js/views/media-control/` — view sub-components: `stage.js`, `toolbox.js`, `inspector.js`, `region-editor.js`, `send.js`, `broadcast-chip.js` (kept small, one responsibility each).
- `frontend/css/media-control.css` — view styles (reuse `--mc-*` tokens only).

**Modified files:**
- `server/package.json` — add `"test": "node --test"`.
- `server/db/database.js` — append migrations (devices.screen_on, dashboard_state table).
- `server/db/schema.sql` — add the same as canonical CREATE for fresh installs.
- `server/server.js` — mount `/api/displays`.
- `server/ws/dashboardSocket.js` — persist authoritative `screen_on/off` on acked delivery.
- `server/routes/layouts.js` — `apply-preset` uses reconcile (preserve zone ids).
- `frontend/js/views/screen-share.js` — delegate to the engine singleton; `unmount()` no longer stops the broadcast.
- `frontend/js/app.js` — import the new view, add route branch, add nav active-paint line, repoint landing (Phase 5).
- `frontend/index.html` — add the nav `<li>` (Phase 4) + `media-control.css` link + load order.

---

## Phase 0 — Test harness

### Task 0.1: Add the test runner

**Files:**
- Modify: `server/package.json`
- Create: `server/test/smoke.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/smoke.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('smoke: test runner works', () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 2: Add the test script**

In `server/package.json`, add to `"scripts"` (after the `"dev"` line):

```json
    "test": "node --test"
```

- [ ] **Step 3: Run the test**

Run: `cd server && npm test`
Expected: PASS — `tests 1`, `pass 1`, `fail 0`.

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/test/smoke.test.js
git commit -m "test: add node:test runner + smoke test"
```

---

## Phase 1 — Server display-state read model (the bug-fix backbone)

This phase makes the server the source of truth for "what is live where" so the dashboard can re-hydrate after navigation, and persists authoritative screen on/off + the per-user display selection.

### Task 1.1: Migration — `devices.screen_on` + `dashboard_state` table

**Files:**
- Modify: `server/db/database.js` (the `migrations` array, before its closing `];`)
- Modify: `server/db/schema.sql` (MBFD section, after line ~600)

- [ ] **Step 1: Append additive migrations**

In `server/db/database.js`, inside the `migrations` array (ends at the `];` near line 186), append these entries before the `];`:

```js
  // 2026-06-01 Unified Media Control dashboard: authoritative blank/on state
  // per display (written only on ACKED device-command delivery), and a tiny
  // per-user "what was I controlling" selection so the unified stage re-hydrates.
  "ALTER TABLE devices ADD COLUMN screen_on INTEGER NOT NULL DEFAULT 1",
```

- [ ] **Step 2: Add the `dashboard_state` table (one-shot migration fn)**

In `server/db/database.js`, model on `migrateScenes()` (near line 681). Add after the existing migration function calls:

```js
function migrateDashboardState() {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS dashboard_state (
        user_id        TEXT NOT NULL,
        workspace_id   TEXT NOT NULL,
        selection_json TEXT NOT NULL DEFAULT '[]',
        updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
        PRIMARY KEY (user_id, workspace_id)
      );
    `);
  } catch (e) {
    console.error('[dashboard_state] migration failed:', e.message);
  }
}
migrateDashboardState();
```

- [ ] **Step 3: Mirror into `schema.sql` for fresh installs**

In `server/db/schema.sql`, after the last MBFD index (line ~600), add:

```sql
-- 2026-06-01 Unified Media Control dashboard
CREATE TABLE IF NOT EXISTS dashboard_state (
    user_id        TEXT NOT NULL,
    workspace_id   TEXT NOT NULL,
    selection_json TEXT NOT NULL DEFAULT '[]',
    updated_at     INTEGER NOT NULL DEFAULT (strftime('%s','now')),
    PRIMARY KEY (user_id, workspace_id)
);
```

> Note: do NOT add `screen_on` to the `devices` CREATE in schema.sql unless you also confirm fresh-boot ordering — the migration ALTER is idempotent and covers both fresh and existing DBs because `database.js` runs `schema.exec` THEN the migrations array. Leaving the column out of the CREATE and relying on the ALTER matches how every prior `devices` column (`remote_url`, etc.) was added.

- [ ] **Step 4: Verify the migration runs cleanly**

Run: `cd server && node -e "const {db}=require('./db/database'); console.log(db.prepare('PRAGMA table_info(devices)').all().map(c=>c.name).includes('screen_on')); console.log(!!db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' AND name='dashboard_state'\").get());"`
Expected: prints `true` then `true`. (Boots against the dev DB; if `config.dbPath` doesn't exist it is created.)

- [ ] **Step 5: Commit**

```bash
git add server/db/database.js server/db/schema.sql
git commit -m "feat(db): add devices.screen_on + dashboard_state migration"
```

### Task 1.2: Pure now-playing resolver

**Files:**
- Create: `server/lib/display-state.js`
- Test: `server/test/display-state.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/display-state.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nowPlayingFromSnapshot } = require('../lib/display-state');

test('null snapshot -> idle', () => {
  assert.deepEqual(nowPlayingFromSnapshot(null), { label: 'Idle', kind: 'idle', itemCount: 0 });
});

test('malformed snapshot -> idle (never throws)', () => {
  assert.equal(nowPlayingFromSnapshot('{not json').kind, 'idle');
});

test('single image item -> its filename', () => {
  const snap = JSON.stringify({ items: [{ content_id: 'c1', filename: 'welcome.jpg', mime_type: 'image/jpeg' }] });
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.label, 'welcome.jpg');
  assert.equal(r.kind, 'image');
  assert.equal(r.itemCount, 1);
});

test('youtube remote_url -> youtube kind', () => {
  const snap = JSON.stringify({ items: [{ remote_url: 'https://youtu.be/abc', mime_type: 'video/youtube', filename: 'Intro' }] });
  assert.equal(nowPlayingFromSnapshot(snap).kind, 'youtube');
});

test('multiple items -> playlist label with count', () => {
  const snap = JSON.stringify({ items: [{ filename: 'a' }, { filename: 'b' }, { filename: 'c' }] });
  const r = nowPlayingFromSnapshot(snap);
  assert.equal(r.kind, 'playlist');
  assert.equal(r.itemCount, 3);
  assert.match(r.label, /3/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- test/display-state.test.js`
Expected: FAIL — "Cannot find module '../lib/display-state'".

- [ ] **Step 3: Implement the resolver**

Create `server/lib/display-state.js`:

```js
// Pure: resolve a playlist published_snapshot (JSON string) into a compact
// "now playing" summary for the dashboard stage. Never throws — a display
// that can't be resolved is reported as Idle rather than crashing the grid.
function nowPlayingFromSnapshot(snapshotJson) {
  const idle = { label: 'Idle', kind: 'idle', itemCount: 0 };
  if (!snapshotJson) return idle;
  let snap;
  try { snap = JSON.parse(snapshotJson); } catch { return idle; }
  const items = Array.isArray(snap && snap.items) ? snap.items : [];
  if (items.length === 0) return idle;
  if (items.length > 1) {
    return { label: `Playlist · ${items.length} items`, kind: 'playlist', itemCount: items.length };
  }
  const it = items[0];
  const name = it.filename || it.name || it.remote_url || 'Content';
  let kind = 'content';
  const mime = String(it.mime_type || '');
  if (mime === 'video/youtube') kind = 'youtube';
  else if (mime.startsWith('image/')) kind = 'image';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (it.remote_url) kind = 'web';
  return { label: name, kind, itemCount: 1 };
}

module.exports = { nowPlayingFromSnapshot };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm test -- test/display-state.test.js`
Expected: PASS — 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/lib/display-state.js server/test/display-state.test.js
git commit -m "feat: pure now-playing snapshot resolver"
```

### Task 1.3: `GET /api/displays/state` + `GET/PUT /api/displays/selection`

**Files:**
- Create: `server/routes/displays.js`
- Modify: `server/server.js` (protected-routes block, near the `/api/devices` mount ~line 424)

- [ ] **Step 1: Write the route**

Create `server/routes/displays.js` (mirrors the canonical `routes/scenes.js` tenancy pattern):

```js
const express = require('express');
const router = express.Router();
const { db } = require('../db/database');
const { nowPlayingFromSnapshot } = require('../lib/display-state');

// Deny writes for read-only members (mirrors scenes.js inline gate).
function requireWorkspaceWrite(req, res) {
  if (!req.workspaceId) { res.status(400).json({ error: 'No active workspace' }); return false; }
  if (!req.actingAs && req.workspaceRole === 'workspace_viewer') {
    res.status(403).json({ error: 'Read-only access' }); return false;
  }
  return true;
}

// GET /api/displays/state — authoritative "what is live where" for the stage.
// Resolves each workspace device's published_snapshot into a now-playing
// summary, plus online status, screen_on flag, geometry, and last screenshot.
router.get('/state', (req, res) => {
  if (!req.workspaceId) return res.json({ displays: [] });
  const now = Math.floor(Date.now() / 1000);
  const rows = db.prepare(`
    SELECT d.id, d.name, d.status, d.last_heartbeat, d.screen_width, d.screen_height,
           d.screen_on, d.playlist_id, d.layout_id,
           p.published_snapshot AS snapshot,
           (SELECT s.captured_at FROM screenshots s WHERE s.device_id = d.id ORDER BY s.captured_at DESC LIMIT 1) AS shot_at
    FROM devices d
    LEFT JOIN playlists p ON p.id = d.playlist_id
    WHERE d.workspace_id = ?
    ORDER BY d.name COLLATE NOCASE
    LIMIT 500
  `).all(req.workspaceId);

  const displays = rows.map(r => {
    const online = r.status === 'online' && r.last_heartbeat && (now - r.last_heartbeat) < 60;
    const np = nowPlayingFromSnapshot(r.snapshot);
    return {
      id: r.id,
      name: r.name,
      online,
      screen_on: r.screen_on !== 0,
      width: r.screen_width || null,
      height: r.screen_height || null,
      layout_id: r.layout_id || null,
      now_playing: np,
      screenshot_url: r.shot_at ? `/api/devices/${r.id}/screenshot?t=${r.shot_at}` : null,
      screenshot_at: r.shot_at || null,
    };
  });
  res.json({ displays });
});

// GET /api/displays/selection — the per-user "what was I last controlling".
router.get('/selection', (req, res) => {
  if (!req.workspaceId) return res.json({ device_ids: [] });
  const row = db.prepare('SELECT selection_json FROM dashboard_state WHERE user_id = ? AND workspace_id = ?')
    .get(req.user.id, req.workspaceId);
  let ids = [];
  if (row) { try { ids = JSON.parse(row.selection_json) || []; } catch { ids = []; } }
  res.json({ device_ids: Array.isArray(ids) ? ids : [] });
});

// PUT /api/displays/selection { device_ids: [] } — persist the stage selection.
router.put('/selection', (req, res) => {
  if (!requireWorkspaceWrite(req, res)) return;
  const ids = Array.isArray(req.body && req.body.device_ids) ? req.body.device_ids.filter(x => typeof x === 'string') : [];
  db.prepare(`
    INSERT INTO dashboard_state (user_id, workspace_id, selection_json, updated_at)
    VALUES (?, ?, ?, strftime('%s','now'))
    ON CONFLICT(user_id, workspace_id) DO UPDATE SET selection_json = excluded.selection_json, updated_at = excluded.updated_at
  `).run(req.user.id, req.workspaceId, JSON.stringify(ids));
  res.json({ device_ids: ids });
});

module.exports = router;
```

> Verify the screenshot URL: confirm an existing route serves a device's latest screenshot. If the existing endpoint differs (search `routes/devices.js` for `screenshot`), use that exact path instead of `/api/devices/:id/screenshot`. Do not invent an endpoint — reuse the one `dashboard.js` already uses to render previews.

- [ ] **Step 2: Mount the route**

In `server/server.js`, in the protected-routes block (near line 424, next to `app.use('/api/devices', ...)`), add:

```js
app.use('/api/displays', requireAuth, resolveTenancy, require('./routes/displays'));
```

(`requireAuth` and `resolveTenancy` are already imported at the top of that block — reuse them.)

- [ ] **Step 3: Manual smoke (no auth) — route is wired**

Run: `cd server && SELF_HOSTED=true node -e "const app=require('./server'); " 2>&1 | head -5` — if `server.js` exports nothing/auto-listens, instead start it (`SELF_HOSTED=true npm run dev`) and in another shell: `curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/displays/state` Expected: `401` (auth required = route mounted correctly).

- [ ] **Step 4: Commit**

```bash
git add server/routes/displays.js server/server.js
git commit -m "feat(api): GET /api/displays/state + per-user selection persistence"
```

### Task 1.4: Authoritative `screen_on/off` on acked delivery

**Files:**
- Modify: `server/ws/dashboardSocket.js` (the `dashboard:device-command` handler)

- [ ] **Step 1: Read the handler**

Open `server/ws/dashboardSocket.js` and locate the `socket.on('dashboard:device-command', ...)` handler (~line 160-200). Identify the branch where the command is **delivered to an online device** vs **queued for offline**, and where the ack callback is invoked (the handler supports an ack per `socket.js sendCommand` → `socket.timeout(5000).emit(..., (err, ack) => ...)`).

- [ ] **Step 2: Persist on delivered screen_on/off only**

In the **delivered** branch (NOT the offline-queue branch), after the command is emitted to the device room, add:

```js
// Unified dashboard: record authoritative on/off ONLY when actually delivered
// to a live display. Never write it for a merely-queued command — that would
// make the dashboard lie about reality.
if (type === 'screen_off' || type === 'screen_on') {
  try {
    db.prepare("UPDATE devices SET screen_on = ?, updated_at = strftime('%s','now') WHERE id = ?")
      .run(type === 'screen_on' ? 1 : 0, device_id);
  } catch (_) { /* non-fatal */ }
}
```

Ensure `const { db } = require('../db/database');` is present at the top of the file (add if missing). Use the exact variable names already in scope in that handler (`type`, `device_id` / `payload` — match what the handler destructures; adjust if it uses `data.type`/`data.device_id`).

- [ ] **Step 3: Verify it compiles + boots**

Run: `cd server && node -e "require('./ws/dashboardSocket'); console.log('ok')"`
Expected: prints `ok` (no syntax/require errors).

- [ ] **Step 4: Commit**

```bash
git add server/ws/dashboardSocket.js
git commit -m "feat(ws): persist authoritative screen on/off on acked delivery"
```

---

## Phase 2 — Zone-id-preserving partitioning

Fixes the data-loss footgun: `apply-preset` deletes+recreates zones with new ids, orphaning every `playlist_items.zone_id` (ON DELETE SET NULL). We reconcile by slot so existing zone ids survive.

### Task 2.1: Pure `reconcileZones`

**Files:**
- Create: `server/lib/reconcile-zones.js`
- Test: `server/test/reconcile-zones.test.js`

- [ ] **Step 1: Write the failing test**

Create `server/test/reconcile-zones.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reconcileZones } = require('../lib/reconcile-zones');

const existing = [
  { id: 'z1', sort_order: 0, x_percent: 0, y_percent: 0, width_percent: 50, height_percent: 100 },
  { id: 'z2', sort_order: 1, x_percent: 50, y_percent: 0, width_percent: 50, height_percent: 100 },
];

test('same count -> updates in place, no inserts/deletes, ids preserved', () => {
  const desired = [
    { sort_order: 0, x_percent: 0, y_percent: 0, width_percent: 60, height_percent: 100, name: 'L' },
    { sort_order: 1, x_percent: 60, y_percent: 0, width_percent: 40, height_percent: 100, name: 'R' },
  ];
  const r = reconcileZones(existing, desired);
  assert.equal(r.updates.length, 2);
  assert.equal(r.updates[0].id, 'z1');
  assert.equal(r.updates[0].width_percent, 60);
  assert.equal(r.inserts.length, 0);
  assert.deepEqual(r.deleteIds, []);
});

test('more desired -> extra inserted, existing ids kept', () => {
  const desired = [ {sort_order:0}, {sort_order:1}, {sort_order:2} ];
  const r = reconcileZones(existing, desired);
  assert.equal(r.updates.length, 2);
  assert.equal(r.inserts.length, 1);
  assert.deepEqual(r.deleteIds, []);
});

test('fewer desired -> surplus deleted', () => {
  const desired = [ {sort_order:0} ];
  const r = reconcileZones(existing, desired);
  assert.equal(r.updates.length, 1);
  assert.equal(r.inserts.length, 0);
  assert.deepEqual(r.deleteIds, ['z2']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd server && npm test -- test/reconcile-zones.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `server/lib/reconcile-zones.js`:

```js
// Pure: reconcile a layout's EXISTING zone rows against a DESIRED zone set
// (e.g. a preset) by slot index (sort_order), so existing zone ids are reused
// instead of deleted+recreated. This preserves playlist_items.zone_id bindings.
// Returns { updates:[{id, ...desiredFields}], inserts:[...desiredZones], deleteIds:[...] }.
function reconcileZones(existing, desired) {
  const ex = [...(existing || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const want = [...(desired || [])].sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  const updates = [];
  const inserts = [];
  for (let i = 0; i < want.length; i++) {
    if (i < ex.length) updates.push({ id: ex[i].id, ...want[i] });
    else inserts.push(want[i]);
  }
  const deleteIds = ex.slice(want.length).map(z => z.id);
  return { updates, inserts, deleteIds };
}

module.exports = { reconcileZones };
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd server && npm test -- test/reconcile-zones.test.js`
Expected: PASS — 3 tests.

- [ ] **Step 5: Commit**

```bash
git add server/lib/reconcile-zones.js server/test/reconcile-zones.test.js
git commit -m "feat: pure zone reconcile (preserve zone ids by slot)"
```

### Task 2.2: Rewrite `apply-preset` to reconcile

**Files:**
- Modify: `server/routes/layouts.js` (the `POST /:id/apply-preset` handler, lines 204-233)

- [ ] **Step 1: Replace the delete-recreate transaction**

In `server/routes/layouts.js`, add the require near the other requires (after line 13):

```js
const { reconcileZones } = require('../lib/reconcile-zones');
```

Replace the body from the `const insertStmt = ...` (line 214) through `applyPreset(req.params.id, zones);` (line 229) with:

```js
  const insertStmt = db.prepare(`
    INSERT INTO layout_zones (id, layout_id, name, x_percent, y_percent, width_percent, height_percent, z_index, zone_type, fit_mode, background_color, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const updateStmt = db.prepare(`
    UPDATE layout_zones SET name=?, x_percent=?, y_percent=?, width_percent=?, height_percent=?, z_index=?, zone_type=?, fit_mode=?, sort_order=? WHERE id=?
  `);
  const delStmt = db.prepare('DELETE FROM layout_zones WHERE id = ?');

  const applyPreset = db.transaction((layoutId, zoneList) => {
    const existing = db.prepare('SELECT * FROM layout_zones WHERE layout_id = ? ORDER BY sort_order').all(layoutId);
    const { updates, inserts, deleteIds } = reconcileZones(existing, zoneList);
    updates.forEach((z, i) => updateStmt.run(z.name, z.x_percent, z.y_percent, z.width_percent,
      z.height_percent, z.z_index, z.zone_type, z.fit_mode, z.sort_order != null ? z.sort_order : i, z.id));
    inserts.forEach((z, i) => insertStmt.run(uuidv4(), layoutId, z.name, z.x_percent, z.y_percent,
      z.width_percent, z.height_percent, z.z_index, z.zone_type, z.fit_mode, '#000000',
      z.sort_order != null ? z.sort_order : (updates.length + i)));
    deleteIds.forEach(id => delStmt.run(id));
    db.prepare("UPDATE layouts SET updated_at = strftime('%s','now') WHERE id = ?").run(layoutId);
  });

  applyPreset(req.params.id, zones);
```

> The DELETE in `deleteIds` only removes SURPLUS zones (when the new preset has fewer regions). Their `playlist_items.zone_id` bindings correctly clear (those slots no longer exist). Reused slots keep their id → bindings survive.

- [ ] **Step 2: Verify it boots**

Run: `cd server && node -e "require('./routes/layouts'); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Integration check (manual, with running server)**

With the dev server running and an authed session (use an existing layout id from the DB), apply a preset twice and confirm zone ids are stable across the second apply (query `layout_zones` before/after). Document the before/after zone ids in the commit body.

- [ ] **Step 4: Commit**

```bash
git add server/routes/layouts.js
git commit -m "fix(layouts): apply-preset reconciles zones in place (preserve zone_id)"
```

---

## Phase 3 — Frontend shared services

### Task 3.1: Player-protocol constants

**Files:**
- Create: `frontend/js/player-protocol.js`

- [ ] **Step 1: Create the constants module**

```js
// FROZEN player protocol. The player (server/player/index.html) and deployed
// TVs only react to THESE exact event strings. NEVER add or rename one here
// without changing the player in lockstep — TVs do not auto-update.
// Controller emits go over the /dashboard socket; the server relays them to the
// device room as the device:* events listed in comments.

export const DEVICE_COMMAND = 'dashboard:device-command'; // -> device:command {type,payload}
export const COMMAND_TYPES = Object.freeze({
  REFRESH: 'refresh', LAUNCH: 'launch',
  SCREEN_ON: 'screen_on', SCREEN_OFF: 'screen_off',
  TRANSPORT: 'transport', // payload: { action: 'next'|'prev'|'play_pause'|'restart' }
});
export const TRANSPORT_ACTIONS = Object.freeze(['next', 'prev', 'play_pause', 'restart']);

// Whiteboard (NOTE the asymmetry: controller emits dashboard:wb-START, the
// player receives device:wb-SHOW; the other four keep their suffix).
export const WB = Object.freeze({
  START: 'dashboard:wb-start', STROKE: 'dashboard:wb-stroke',
  CLEAR: 'dashboard:wb-clear', UNDO: 'dashboard:wb-undo', STOP: 'dashboard:wb-stop',
});

// Screen-share signaling (broadcaster -> server -> device:screen-share-*).
export const SS = Object.freeze({
  START: 'screen-share:start', OFFER: 'screen-share:offer',
  ICE: 'screen-share:ice-candidate', STOP: 'screen-share:stop',
});

export const FIT_MODES = Object.freeze(['cover', 'contain', 'fill', 'none', 'scale-down']);
export function isValidFit(m) { return FIT_MODES.includes(m); }
```

- [ ] **Step 2: Quick consistency test (node)**

Run: `node --input-type=module -e "import('./frontend/js/player-protocol.js').then(m=>{if(m.TRANSPORT_ACTIONS.length!==4)throw new Error('bad');console.log('ok')})"` (run from repo root)
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add frontend/js/player-protocol.js
git commit -m "feat(fe): frozen player-protocol constants module"
```

### Task 3.2: Screen-share engine singleton

**Files:**
- Create: `frontend/js/services/screen-share-engine.js`
- Modify: `frontend/js/views/screen-share.js`

- [ ] **Step 1: Read the current view**

Read `frontend/js/views/screen-share.js`. Identify the module-scoped state (`stream`, `peerConnections` Map, `iceConfig`, active flags ~lines 110-116), `resetState()` (~154), `render()`, `unmount()`→`stopCapture()` (~242), `startBroadcastTo(deviceId)`, `primeIceServers()`, `bitrateCeilingKbps()`/`computeAdaptiveBitrate()`, and `refreshSessionList()` (~817-863).

- [ ] **Step 2: Create the engine with this exact public interface**

Create `frontend/js/services/screen-share-engine.js`. MOVE the WebRTC state + logic out of the view into this singleton. Public API:

```js
// Persistent screen-share broadcaster. Lives for the SPA session — NOT tied to
// any view — so navigating away from the dashboard does NOT tear down a live
// broadcast (the bug this fixes). The view becomes a thin presenter that calls
// these methods and subscribes to onChange.
//
// Public interface:
//   engine.init()                      // idempotent: wire signaling listeners once on the singleton socket
//   engine.startBroadcastTo(deviceId, opts?) -> Promise   // capture (once) + add a peer for this device
//   engine.stopBroadcastTo(deviceId)   // close one peer; stop capture if it was the last
//   engine.stopAll()                   // close all peers + stop capture
//   engine.getActiveTargets() -> string[]   // device ids currently being broadcast to
//   engine.isActive() -> boolean
//   engine.onChange(cb) -> unsubscribe  // cb({ active, targets }) on every state change
```

Requirements:
- Hold `stream`, `peerConnections` (Map), `iceConfig` at MODULE scope here (not in the view).
- Wire the signaling listeners (`screen-share:answer`, `screen-share:device-ice-candidate`, `screen-share:preempted`, `screen-share:ended-by-device`) ONCE, guarded by the existing `sock.__screenShareDashboardWired` sentinel pattern (reuse it, don't double-wire).
- Emit via `getSocket()` from `socket.js` using the `SS.*` constants from `player-protocol.js`.
- Keep the adaptive-bitrate logic (`computeAdaptiveBitrate`, `bitrateCeilingKbps`) intact, moved verbatim.
- Notify all `onChange` subscribers `{ active: peerConnections.size > 0, targets: [...peerConnections.keys()] }` after start/stop.

- [ ] **Step 3: Refactor the view to delegate**

In `frontend/js/views/screen-share.js`:
- Replace direct WebRTC calls with `engine.startBroadcastTo/stopBroadcastTo/stopAll`.
- **`unmount()` MUST NOT call `stopCapture()`** — change it to just unsubscribe its `onChange` listener and detach DOM handlers. The broadcast keeps running.
- `render()` subscribes to `engine.onChange` to repaint the session list (reuse the existing `refreshSessionList` diff-renderer, now fed by engine state).

- [ ] **Step 4: Verify via Playwright (engine survives navigation)**

Start dev server. With Playwright MCP:
1. Navigate to `#/screen-share`, start a broadcast to a (real or paired test) display.
2. Navigate to `#/` (dashboard), wait 2s.
3. Navigate back to `#/screen-share`.
Expected: the session list still shows the active broadcast; `engine.isActive()` is true throughout (check via `browser_evaluate` → `window.__mcEngineActive` if you expose a debug hook, or assert the session row persists). The broadcast was NOT torn down on step 2.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/services/screen-share-engine.js frontend/js/views/screen-share.js
git commit -m "refactor(fe): hoist screen-share to persistent engine singleton (survives navigation)"
```

### Task 3.3: Display-state client store

**Files:**
- Create: `frontend/js/services/display-state.js`

- [ ] **Step 1: Create the store**

```js
// Client store for "what is live where". Fetches GET /api/displays/state once,
// then merges live dashboard:* socket events (status / screenshot / playback)
// on top, and notifies subscribers. Re-fetches on socket reconnect so the stage
// is correct after navigation, reload, or a second operator's change.
import { api } from '../api.js';
import { on as onSocket } from '../socket.js';

let displays = new Map();          // id -> display state
const subs = new Set();
let wired = false;

function notify() { const list = [...displays.values()]; subs.forEach(cb => cb(list)); }

export async function refresh() {
  const { displays: list } = await api.getDisplaysState();   // added in Task 4.x api.js
  displays = new Map(list.map(d => [d.id, d]));
  notify();
}

export function getAll() { return [...displays.values()]; }
export function get(id) { return displays.get(id) || null; }

export function subscribe(cb) {
  subs.add(cb);
  ensureWired();
  return () => subs.delete(cb);
}

function ensureWired() {
  if (wired) return;
  wired = true;
  onSocket('connected', () => { refresh().catch(() => {}); });
  onSocket('device-status', (d) => {
    // Only patch fields actually present — never clobber screen_on with undefined
    // when a status event doesn't carry it.
    const patch = { online: d.status === 'online' };
    if (d.screen_on !== undefined) patch.screen_on = !!d.screen_on;
    merge(d.device_id || d.id, patch);
  });
  onSocket('screenshot-ready', (d) => { const id = d.device_id || d.id; const cur = displays.get(id); if (cur) { cur.screenshot_url = `/api/devices/${id}/screenshot?t=${Date.now()}`; cur.screenshot_at = Math.floor(Date.now()/1000); notify(); } });
  onSocket('playback-progress', (d) => { merge(d.device_id || d.id, { progress: d }); });
  onSocket('wall-changed', () => { refresh().catch(() => {}); });
}

function merge(id, patch) {
  const cur = displays.get(id);
  if (!cur) return;
  displays.set(id, { ...cur, ...patch });
  notify();
}
```

- [ ] **Step 2: Verify import resolves (Playwright console)**

Load the app, then `browser_evaluate`: `import('/js/services/display-state.js').then(m=>!!m.subscribe)` → expect `true`. (No behavior yet; just confirms the module + its imports resolve in the browser.)

- [ ] **Step 3: Commit**

```bash
git add frontend/js/services/display-state.js
git commit -m "feat(fe): display-state client store (fetch + live merge + reconnect refresh)"
```

---

## Phase 4 — The unified Media Control view

> The view is large; it is decomposed into small sub-modules under `frontend/js/views/media-control/`. Each task adds ONE sub-component, registered into the parent `media-control.js`. Build it at `#/control` (landing flip is Phase 5). Verify each task with Playwright. Reuse existing rendering helpers by importing them — do NOT duplicate markup.

### Task 4.1: View skeleton + additive route registration + api methods

**Files:**
- Create: `frontend/js/views/media-control.js`
- Create: `frontend/css/media-control.css`
- Modify: `frontend/js/app.js` (import + route branch + nav active-paint)
- Modify: `frontend/index.html` (nav `<li>` + css link)
- Modify: `frontend/js/api.js` (add `getDisplaysState`, `getDisplaysSelection`, `putDisplaysSelection`)

- [ ] **Step 1: Add the api methods**

In `frontend/js/api.js`, add (follow the existing method style in that file):

```js
  getDisplaysState() { return this._get('/displays/state'); },
  getDisplaysSelection() { return this._get('/displays/selection'); },
  putDisplaysSelection(device_ids) { return this._put('/displays/selection', { device_ids }); },
```

(Match the actual helper names used in `api.js` — if it uses `request('GET', ...)` rather than `_get`, mirror that. Read the file first.)

- [ ] **Step 2: Create the view skeleton**

Create `frontend/js/views/media-control.js`:

```js
import { api } from '../api.js';
import * as displayState from '../services/display-state.js';

let unsub = null;

export async function render() {
  const app = document.getElementById('app');
  app.innerHTML = `
    <div class="mc-control">
      <div class="mc-topbar">
        <h1>Media Control</h1>
        <div class="mc-view-toggle"><button data-mode="grid" class="active">Grid</button><button data-mode="wall">Wall</button></div>
        <div id="mc-broadcast-chip" class="mc-chip" hidden></div>
      </div>
      <section id="mc-stage" class="mc-stage" aria-label="Displays you are controlling"></section>
      <section id="mc-toolbox" class="mc-toolbox" aria-label="Sources and actions"></section>
      <aside id="mc-inspector" class="mc-inspector" hidden></aside>
    </div>`;
  await displayState.refresh().catch(() => {});
  unsub = displayState.subscribe(() => { /* stage repaint wired in 4.2 */ });
}

export function unmount() {
  // The view owns NO live broadcast resource (that's the engine singleton),
  // so unmount only detaches this view's subscriptions. Broadcasts persist.
  if (unsub) { unsub(); unsub = null; }
}
```

- [ ] **Step 3: Register the route additively in `app.js`**

In `frontend/js/app.js`:
- Add to the import block (after line 29): `import * as mediaControl from './views/media-control.js';`
- In `route()`'s if/else dispatch chain, add a branch (mirror the existing one-liners) for `#/control`:
```js
  else if (hash === '#/control') { currentView = mediaControl; await mediaControl.render(); }
```
(Match the EXACT shape of the surrounding branches — some `await render()`, some assign `currentView` differently. Copy a neighbor's pattern verbatim.)
- In the nav active-paint chain (lines 323-352), add:
```js
    else if (hash === '#/control' && link.dataset.view === 'control') link.classList.add('active');
```

- [ ] **Step 4: Add the nav item + css link in `index.html`**

In `frontend/index.html`, in the **Classroom** nav-section group (lines 44-82), add as the FIRST item:

```html
<li><a href="#/control" class="nav-link" data-view="control"><span class="nav-icon">🎛️</span><span class="nav-label">Media Control</span></a></li>
```

In `<head>`, add (next to other css links): `<link rel="stylesheet" href="/css/media-control.css">`

- [ ] **Step 5: Minimal css**

Create `frontend/css/media-control.css` using ONLY existing `--mc-*` tokens:

```css
.mc-control { display: flex; flex-direction: column; gap: var(--mc-space-4, 16px); padding: var(--mc-space-4, 16px); }
.mc-topbar { display: flex; align-items: center; gap: 16px; }
.mc-stage { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
.mc-toolbox { border-top: 1px solid var(--mc-border, #243044); padding-top: 12px; }
.mc-inspector { position: fixed; right: 0; top: 0; height: 100%; width: 340px; background: var(--mc-surface, #0f172a); box-shadow: -8px 0 24px rgba(0,0,0,.4); }
```

- [ ] **Step 6: Verify (Playwright)**

Load app → navigate `#/control`. Expected: the page renders the topbar + empty stage/toolbox, the **Media Control** nav item is highlighted, AND navigating to `#/present`, `#/`, `#/scenes` still works (zero regression). Capture a screenshot.

- [ ] **Step 7: Commit**

```bash
git add frontend/js/views/media-control.js frontend/css/media-control.css frontend/js/app.js frontend/index.html frontend/js/api.js
git commit -m "feat(fe): unified Media Control view skeleton at #/control (additive route+nav)"
```

### Task 4.2: Stage — real-aspect display cards + add-display + re-hydrated selection

**Files:**
- Create: `frontend/js/views/media-control/stage.js`
- Modify: `frontend/js/views/media-control.js`

- [ ] **Step 1: Build the stage component**

Create `frontend/js/views/media-control/stage.js` exporting `renderStage(container, { displays, selectedIds, onSelect, onAddDisplay })`. Each selected display renders a card sized to its true aspect using `aspect-ratio: <width>/<height>` (fallback `16/9` when geometry unknown), titled with `display.name`, containing the live screenshot (`<img src=display.screenshot_url>` with an "updated Ns ago" caption derived from `screenshot_at`; dim/flag when `> 30s` stale), a status dot (`online`→green, `!online`→grey, `!screen_on`→amber "Blanked"), and the `now_playing.label`. Append a "+ Add display" tile that calls `onAddDisplay()`.

- [ ] **Step 2: Wire selection persistence + re-hydration into the view**

In `media-control.js`: on `render()`, `const { device_ids } = await api.getDisplaysSelection()` → that's the initial `selectedIds` (re-hydrates last-controlled). `onSelect`/`onAddDisplay` mutate `selectedIds` and call `api.putDisplaysSelection(selectedIds)`. The `displayState.subscribe` callback re-invokes `renderStage` with fresh data. "Add display" opens a picker listing all `displayState.getAll()` not already selected.

- [ ] **Step 2b: Wall-member de-duplication (zero-regression guardrail)**

A device that is a member of a video wall must NOT appear as its own stage card — the wall is shown as a single card (mirrors `dashboard.js:791-793`). Fetch walls (`api.getWalls()` / the walls list endpoint) and build a `Set` of member `device_ids`; in both the stage and the "Add display" picker, exclude any display whose id is in that set, and render one card per wall instead (an advanced card; clicking it deep-links to `#/walls` for now). If a selected id later becomes a wall member, drop it from `selectedIds` and persist the pruned selection.

- [ ] **Step 3: Verify (Playwright)**

Load `#/control`. Expected: cards for the previously-selected displays appear at correct aspect ratios with names + live thumbnails; selecting a new display via "+ Add" persists (reload the page → it's still on the stage). A blanked display shows amber; offline shows grey + stale flag.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/views/media-control/stage.js frontend/js/views/media-control.js
git commit -m "feat(fe): Media Control stage — real-aspect cards, live preview, re-hydrated selection"
```

### Task 4.3: Toolbox dock + the one shared `sendToDisplays` funnel

**Files:**
- Create: `frontend/js/views/media-control/send.js`
- Create: `frontend/js/views/media-control/toolbox.js`
- Modify: `frontend/js/views/media-control.js`

- [ ] **Step 1: Extract the send funnel**

Read `frontend/js/views/present.js broadcastSource` and `frontend/js/api.js broadcast` (note the `409 CONFIRM_ALL_REQUIRED` resolve-not-throw contract). Create `frontend/js/views/media-control/send.js` exporting `sendToDisplays(source, targetIds, label)` that POSTs to `/api/broadcast` for each target (or the batch shape the route accepts), handling the 409 confirm-all handshake exactly as `present.js` does. **YouTube/URL sources MUST go through `POST /content/youtube` first** (then broadcast the created content id) — do NOT broadcast a raw `remote_url` (that renders as a still image).

- [ ] **Step 2: Build the toolbox**

Create `frontend/js/views/media-control/toolbox.js` exporting `renderToolbox(container, { selectedIds, onAfterSend })`. A segmented dock with tabs: **Templates · Media · Presentations · YouTube/URL · Scenes**. Media/Presentations tabs list content tiles (reuse `api.getContent()`/`api.getPresentations()`); clicking a tile (or dropping it on a stage card) calls `sendToDisplays(tile, selectedIds, label)` — **instant hot-cut**. Scenes tab lists `api.scenes.list()`; clicking triggers `api.scenes.trigger(id)`. Templates tab is handled by the inspector (Task 4.4) — show a hint "Select a display to partition it".

- [ ] **Step 3: Wire drag-drop onto stage cards**

In `media-control.js`, make stage cards drop targets: dropping a toolbox tile on a card calls `sendToDisplays(tile, [cardDeviceId], label)`. "Send to all" button in the topbar calls `sendToDisplays(tile, selectedIds, label)`.

- [ ] **Step 4: Verify (Playwright)**

Select two displays. Drop a presentation on display A and a YouTube tile on display B. Expected: both go live instantly (verify via the now-playing label updating on each card after the next state refresh, and on the real player if available). Trigger a Scene → displays update.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/views/media-control/send.js frontend/js/views/media-control/toolbox.js frontend/js/views/media-control.js
git commit -m "feat(fe): toolbox dock + shared sendToDisplays funnel (instant hot-cut, YouTube via /content/youtube)"
```

### Task 4.4: Inspector — templates-first partitioning + per-zone fit/audio

**Files:**
- Create: `frontend/js/views/media-control/region-editor.js`
- Create: `frontend/js/views/media-control/inspector.js`
- Modify: `frontend/js/views/media-control.js`

- [ ] **Step 1: Build the region editor (templates-first, drag-refine)**

Create `region-editor.js` exporting `renderRegionEditor(container, { layoutId, onChange })`. Show the 7 preset buttons (call `POST /api/layouts/:id/apply-preset` — now zone-id-preserving). After a preset, render the zones as draggable/resizable percentage boxes on a 16:9 canvas (reuse `video-wall.js` `boundsOf`/`intersect`/`attachDragResize` drag math via import; persist edits via `PUT /api/layouts/:id/zones/:zoneId` — update-in-place, preserves id). Each zone exposes a `fit_mode` select (`FIT_MODES` from player-protocol) and a content-assign dropdown (lift the logic from `device-detail.js:1062-1096`).

- [ ] **Step 2: Build the inspector shell**

Create `inspector.js` exporting `renderInspector(container, { display, onClose })`. When a stage card is selected, the inspector slides in showing: display name + geometry, a **"Partition into regions"** button (creates/loads a layout for the display via the layouts API + assigns it via `PUT /api/layouts/device/:deviceId`, then mounts `renderRegionEditor`), per-region **audio** toggle (default: only one region unmuted; warn if a second is unmuted), and the **fit_mode** control. **Guard:** if the display is a video-wall member, disable Partition and show "This display is part of a video wall — partitioning is unavailable" (the player ignores zones for wall members).

- [ ] **Step 3: Wire selection → inspector in the view**

In `media-control.js`, selecting a stage card opens the inspector for that display; closing hides it.

- [ ] **Step 4: Verify (Playwright)**

Select a display → Partition → pick "2-up vertical" → drop a presentation in the left region and a YouTube in the right. Expected: the player shows split content. Re-apply a preset and confirm content→zone bindings survive (zone-id preservation). Verify a wall-member display shows the Partition-disabled message.

- [ ] **Step 5: Commit**

```bash
git add frontend/js/views/media-control/region-editor.js frontend/js/views/media-control/inspector.js frontend/js/views/media-control.js
git commit -m "feat(fe): inspector with templates-first partitioning + per-zone fit/audio"
```

### Task 4.5: Whiteboard + Share My Screen actions + live-broadcast chip

**Files:**
- Modify: `frontend/js/views/media-control/inspector.js`
- Modify: `frontend/js/views/media-control.js`
- Create: `frontend/js/views/media-control/broadcast-chip.js`

- [ ] **Step 1: Add per-display actions to the inspector**

Add two buttons to the inspector: **"Turn into Whiteboard"** (uses `WB.START` via `getSocket()` to the selected display, reusing the smartboard emit flow — wrap, don't reimplement) and **"Share My Screen here"** (calls `engine.startBroadcastTo(display.id)` from the screen-share engine singleton). A "Stop" appears when active.

- [ ] **Step 2: Build the persistent broadcast chip**

Create `broadcast-chip.js` exporting `mountBroadcastChip(el)` that subscribes to `engine.onChange` and shows "● Live broadcast → N display(s)" with a Stop-all button when `active`, hidden otherwise. Mount it on `#mc-broadcast-chip` in `media-control.js render()`. Because the engine is a singleton, the chip reflects reality even after navigation.

- [ ] **Step 3: Verify (Playwright)**

Start "Share My Screen here" on a display → chip shows "● Live broadcast → 1 display". Navigate to `#/` and back → chip still shows it (broadcast survived). Stop → chip hides. Turn a display into a whiteboard → player shows the annotation overlay over live content (playback not torn down).

- [ ] **Step 4: Commit**

```bash
git add frontend/js/views/media-control/inspector.js frontend/js/views/media-control/broadcast-chip.js frontend/js/views/media-control.js
git commit -m "feat(fe): whiteboard + share-screen per-display actions + persistent live-broadcast chip"
```

### Task 4.6: Transport bar + routing-mode presets

**Files:**
- Modify: `frontend/js/views/media-control/toolbox.js` (or a new `transport.js`)
- Modify: `frontend/js/views/media-control.js`

- [ ] **Step 1: Transport + blank controls per display**

On each stage card (and/or inspector), add transport controls (prev / play_pause / next / restart) via `sendCommand(deviceId, COMMAND_TYPES.TRANSPORT, { action })` and a Blank toggle via `sendCommand(deviceId, COMMAND_TYPES.SCREEN_OFF/SCREEN_ON)` using the ack callback to reflect the authoritative state (the server now persists it). Use `player-protocol.js` constants.

- [ ] **Step 2: Routing-mode presets**

In the topbar/bottom bar add three buttons: **Lecture** (send the chosen source to ALL selected displays), **Group Share** (no-op grouping hint — each display independent, the default), **Mirror** (clone display A's current source to the others via `sendToDisplays`). Lecture/Mirror reuse `sendToDisplays`.

- [ ] **Step 3: Verify (Playwright)**

Blank a display → card shows amber "Blanked"; reload page → still amber (authoritative persistence). Un-blank → green. Lecture mode → one source hits all selected displays.

- [ ] **Step 4: Commit**

```bash
git add frontend/js/views/media-control/ frontend/js/views/media-control.js
git commit -m "feat(fe): transport bar + blank (authoritative) + routing-mode presets"
```

---

## Phase 5 — Landing flip + zero-regression verification

### Task 5.1: Repoint the post-login landing to `#/control`

**Files:**
- Modify: `frontend/js/app.js` (lines 266-279)

- [ ] **Step 1: Repoint both landing branches**

In `app.js`, in the `isAuthenticated() && hash === '#/login'` block, replace the role-split landing with a single target for all roles (preserving the onboarding gate and the role *permission* model untouched):

```js
  if (isAuthenticated() && hash === '#/login') {
    if (!localStorage.getItem('rd_onboarded')) { window.location.hash = '#/onboarding'; return; }
    // Unified Media Control is the home for everyone. Role permissions still
    // gate what is editable + the Setup nav (updateSidebarUser is unchanged).
    window.location.hash = '#/control';
    return;
  }
```

- [ ] **Step 2: Verify (Playwright)**

Log out → log in as (a) an admin and (b) an instructor-role user. Expected: both land on `#/control`. The Setup nav visibility for each role is unchanged from before. `#/home` and `#/present` are still reachable by typing the hash.

- [ ] **Step 3: Commit**

```bash
git add frontend/js/app.js
git commit -m "feat(fe): unified Media Control is the post-login landing (#/control)"
```

### Task 5.2: End-to-end scenario verification (Playwright)

- [ ] **Step 1: Run the scenario matrix against staging/live with the real 2 displays + 1 wall**

Verify and record each:
1. **Re-hydration / state persistence:** send media → navigate to `#/scenes` → return to `#/control` → the stage still shows what's live and you still control it; the broadcast never dropped.
2. **PPT + YouTube on two displays** simultaneously (instant).
3. **Partition one display** PPT|YouTube; re-apply a preset → bindings survive.
4. **Whiteboard** on a display (overlay over content, no teardown).
5. **Share My Screen** to a display; survives navigation (chip persists).
6. **Send to all** (Lecture).
7. **Blank/un-blank** authoritative across reload.

- [ ] **Step 2: Document results in a verification note**

Append a short PASS/FAIL table to `docs/superpowers/plans/2026-06-01-unified-media-control-dashboard.md` under a "## Verification log" heading. Commit.

### Task 5.3: Zero-regression sweep

- [ ] **Step 1: Confirm every old route still loads**

With Playwright, visit each and confirm it renders without console errors: `#/present`, `#/`, `#/displays`, `#/screen-share`, `#/smartboard`, `#/scenes`, `#/home`, `#/walls`, `#/layouts`, `#/playlists`, `#/schedule`, `#/content`, `#/settings`, `#/admin`.

- [ ] **Step 2: Confirm backend tests pass + server boots**

Run: `cd server && npm test` (all PASS) and `SELF_HOSTED=true node -e "require('./server'); setTimeout(()=>process.exit(0),1500)"` (boots clean).

- [ ] **Step 3: Final commit + push the branch**

```bash
git add -A
git commit -m "test: zero-regression sweep — all legacy routes load, backend tests green"
git push -u origin feature/unified-media-control-dashboard
```

---

## Deployment (after the branch is verified)

CI is billing-blocked — deploy manually on the GMKtec box (`mbfd@/opt/...` per the deploy runbook): merge to `main`, on the box `git pull` (read-only deploy key), then rebuild the `app/` build context and `docker compose up -d`. The player and all socket event names are unchanged, so deployed TVs need no update and currently-connected displays stay connected.

---

## Notes / known sequencing

- Phase 1–2 (backend) are independent of Phase 3–4 (frontend) except that the view (4.x) consumes `/api/displays/*` (Phase 1) and the engine (3.2). Build backend first.
- The `screenshot_url` path in Task 1.3 and `display-state.js` MUST match the real device-screenshot endpoint — confirm against `routes/devices.js` / how `dashboard.js` renders previews before finalizing.
- If `apply-preset` zone reconciliation by `sort_order` ever needs to be smarter (geometry-match instead of slot-match), the pure `reconcileZones` is the single place to change.
