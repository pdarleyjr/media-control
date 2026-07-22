# UI-Contract Playwright Harness (isolated)

Browser-level accessibility + operator-workflow tests for the enterprise operator
console. This harness is **fully isolated** from the production `server/package.json`
— it has its own `package.json`, config, static server, and fixtures. No production
configuration is modified.

> **Location note (2026-07-22):** moved out of `server/test/` to
> `server/e2e/enterprise-ui/` so Node's default `node --test` discovery never
> imports Playwright config/harness files as unit tests (which previously hung
> the suite by leaving `serve.mjs` listening on :4321).

## Run (one-time browser install)

```bash
cd server/e2e/enterprise-ui
npm install
npm run install-browsers   # one-time: downloads Chromium
npm test                    # runs across podium / handheld-admin / desktop viewports
```

Or from `server/`:

```bash
npm run test:playwright
```

The harness serves the worktree root over a zero-dependency static server
(`serve.mjs`) on `http://127.0.0.1:4321` so the ES module components resolve. The
fixture (`fixtures/console.html`) mounts every enterprise component with a mock
operator store and `globalThis.__MC_ENTERPRISE_MOCK_ONLY = true` so no backend or
real socket is required. The server binds loopback only and exits on SIGINT/SIGTERM.

## What it covers

`tests/accessibility.spec.js`
- color-independent state chips (text + glyph present)
- 44px touch-target floor for visible buttons
- keyboard navigation + visible focus
- disabled layout cards expose a reason (no silent failure)
- no horizontal scroll on the podium viewport
- explicit DEGRADED FALLBACK label on the screen-share panel
- private content segregation (mock `mine` filter)

`tests/workflow.spec.js`
- pending → confirmed transition
- offline display shows OFFLINE regardless of pending
- failed command never appears confirmed
- layout selection reports the chosen intent
- playback transport fires exactly once per click (no double-fire)
- content selection reported to host
