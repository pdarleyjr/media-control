# Integration with the Live-Program Branch

**Status:** READY TO REBASE (with documented gaps G-01…G-08 in `backend-contract-gaps.md`).

This branch (`codex/enterprise-operator-ux-20260722`, worktree `D:\CodexWorktrees\media-control-enterprise-ux-20260722`) builds the enterprise operator console in **new, non-conflicting paths only**. The eventual wiring into the active livestream/bootstrap branch requires the **exact minimal edits below** — none of which are applied in this branch (reserved files were read only).

---

## 1. Active branch dependency

- Baseline (shared): `b0081ea84a58ec39ea52391e49946d0277ff11d3`.
- Active branch: `codex/live-program-autoconnect-20260722` (worktree `D:\CodexWorktrees\media-control-live-program-20260722`), same baseline.
- This branch was created from the same baseline, so it rebases cleanly onto the active branch's tip after that branch is committed.

## 2. Reserved files (do not edit in this branch)

```
frontend/css/media-control.css
frontend/js/api.js
frontend/js/views/media-control.js
frontend/js/views/media-control/action-dock.js
frontend/js/views/media-control/command-bar.js
frontend/js/i18n/*
server/config.js
server/server.js
server/player/index.html
server/player/managed-bootstrap.js
server/routes/live-stream.js
server/lib/live-stream-safety.js
```

## 3. New files created (all in non-conflicting paths)

**State layer** (`frontend/js/state/`)
- `operator-state.js` — state vocabulary + derivation (pure).
- `operator-store.js` — derived normalized store (subscribes to the shared `roomState`).
- `socket-adapter.js` — wires local socket events to the operator store (no new connection).
- `error-recovery.js` — structured recovery catalog.
- `enterprise-api.js` — documented adapter + mocks for gaps G-01…G-08.
- `enterprise-i18n.js` — `mc.e.*` translation overlay.

**Components** (`frontend/js/components/`)
- `room-state/room-overview.js`
- `display-layout/layout-selector.js`, `display-layout/render-helpers.js`
- `content-library/content-selector.js`, `content-library/privacy-publishing.js`
- `playback-control/playback-control.js`
- `operator-console/screen-share-panel.js`

**View** (`frontend/js/views/media-control-enterprise/`)
- `operator-console.js` — orchestrator shell.

**CSS** (`frontend/css/media-control-enterprise/`)
- `operator-console.css` — scoped `.mc-e-*`, podium-safe.

**Tests** (`server/test/ui-contract/`)
- `operator-state.test.js`, `operator-store.test.js`, `error-recovery.test.js`, `enterprise-api.test.js`, `enterprise-i18n.test.js` (Node `--test`, 24 pass).
- `lib/esm-bundle.js` — ESM bundling helper.
- `playwright/` — isolated Playwright harness (config, static server, fixture, `tests/*.spec.js`).

**Docs** (`docs/ui-ux/`)
- `current-state-audit.md`, `operator-state-model.md`, `backend-contract-gaps.md`, this file.

## 4. Required imports (exact minimal edit)

The only new import needed in a shared (non-reserved) file is the console entry. `frontend/js/app.js` is NOT in the reserved list and owns the route dispatch (an `if (isControlRoute) … else if …` chain starting at `app.js:782`). Two one-line edits:

**Edit A — add a static import near the existing view imports** (`app.js`, alongside line 29 `import * as mediaControl from './views/media-control.js'`):

```js
import * as operatorConsole from './views/media-control-enterprise/operator-console.js';
```

**Edit B — add a route branch** in the `else if` chain (e.g. before the `#/content` case at `app.js:802`):

```js
} else if (hash === '#/operator-console') {
  currentView = operatorConsole;
  operatorConsole.render(app);
```

`mountOperatorConsole` is re-exported as `render` by the console module (add a `render` alias export — see below). No other changes to `app.js`.

> `operator-console.js` currently exports `mountOperatorConsole` (default + named). At integration add: `export const render = (host) => mountOperatorConsole(host)` so the app router's `currentView.render(app)` contract is satisfied. (One line in this branch's own file — not a reserved file.)

## 5. Required CSS inclusion (exact minimal edit)

Add one `<link>` in `frontend/index.html` (NOT reserved) inside `<head>`:

```html
<link rel="stylesheet" href="/css/media-control-enterprise/operator-console.css">
```

`operator-console.css` is scoped to `.mc-e-*`; it does not affect existing `.mc-*` surfaces.

## 6. Required socket-store adapter

No change to `socket.js` is required. `operator-console.js` imports `roomState` from `../socket.js` (existing export, `socket.js:41`) and the socket functions (`on/off/sendCommand/selectTarget/clearTarget/requestRoomSnapshot`) via `createOperatorSocketAdapter`. The adapter subscribes to the **existing** local events (`command-sent`, `command-ack`, `state-sync`, `room-snapshot`, `connected`, `disconnected`) — it does not emit new server events and does not open a second connection.

## 7. Required navigation entry

A single nav link/button pointing to `#/operator-console`. If the nav is rendered from a reserved file, add one `<a href="#/operator-console">Operator Console</a>` entry there at integration time (one line).

## 8. Potential conflicts

- `frontend/index.html` and `frontend/js/app.js` are NOT in the reserved list but are shared; merge trivial (one link + one route case).
- No overlap with the active agent's reserved files (different paths entirely).
- `operator-console.js` imports `roomState` from `socket.js`; if the active branch changes `socket.js`'s export name, update the one import line.

## 9. Exact recommended merge order

```
1. active livestream/bootstrap branch  → committed (codex/live-program-autoconnect-20260722)
2. enterprise UI/UX branch rebased   → git rebase <active-branch-tip>
3. resolve the 2 minimal integration points (app.js route + index.html link)
4. complete combined frontend tests   → node --test server/test/ui-contract/*.test.js
                                        + (isolated) cd server/test/ui-contract/playwright && npm test
5. podium/web canary                   → load #/operator-console on a podium touchscreen
```

Do NOT merge branches while the active agent is working.

## 10. Exact tests after integration

```bash
# Node UI-contract (runs anywhere; no backend, no browser):
node --test "server/test/ui-contract/*.test.js"          # expect 24 pass

# Isolated Playwright DOM/a11y/viewport (one-time browser install):
cd server/test/ui-contract/playwright
npm install
npm run install-browsers
npm test                                                  # a11y + workflow specs across 3 viewports

# Existing suite (unchanged, from server/):
cd ../../.. && cd server && npm test
```

## 11. Rollback

Reverting integration = remove the one route case + one `<link>` + one nav link. The new files are additive and self-contained; deleting `frontend/js/state/`, `frontend/js/components/{room-state,display-layout,content-library,playback-control,operator-console}/`, `frontend/js/views/media-control-enterprise/`, `frontend/css/media-control-enterprise/`, `server/test/ui-contract/`, and `docs/ui-ux/` fully removes the feature with zero impact on the existing console.
