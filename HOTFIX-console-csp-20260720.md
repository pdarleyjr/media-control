# Hotfix: Podium USB Console CSP (2026-07-20)

## Purpose
The podium kiosk's USB import agent runs a local loopback service that the
`/console/*` dashboard pages must connect to. The dashboard CSP previously
blocked that loopback origin, breaking the on-kiosk USB import workflow.

This hotfix adds a **route-scoped** CSP exception: `/console/*` pages are
served with `http://127.0.0.1:8755` added **only** to their `connect-src`,
via a dedicated `consoleCsp` policy. No other page (`/app`, `/player`,
widget/kiosk renders, API) is affected.

## Scope (console-only, by design)
- Only `connect-src` of `/console/*` routes gained `http://127.0.0.1:8755`.
- `/app` and every other route keep the original `dashboardCsp` (no agent origin).
- No wildcard (`http://*`) and no loopback-port wildcard (`http://127.0.0.1:*`)
  was added — the single exact origin only.
- `upgrade-insecure-requests` remains disabled.
- No application rebuild, dependency change, database change, or other runtime
  modification.

## Production image identity (verified)
- **Hotfix (current production):** `media-control-media-control:hotfix-console-csp-20260720-r2`
  - Image ID `sha256:5dd2a8fe35c70f84b4ab4d2d40e4bf44324f55c1482644f2b27e989583e5db46`
  - Minimal derivative of the pre-hotfix image; only `server/server.js` differs
    from the pre-hotfix filesystem (verified by full `/app` SHA-256 inventory diff).
- **Rollback (pre-hotfix):** `media-control:pre-usb-hotfix-20260720`
  - Image ID `sha256:a31ceb2a076e67d664bb3ff00185318c3b1973c4756107f68b23ad15beb9fc7c`
  - `docker-compose.rollback-prehotfix.yml` pins this image with `pull_policy: never`.

## Validation performed
- Full `/app` filesystem inventory diff (pre-hotfix vs r2): only `server/server.js`
  differs; no production uploads, certs, DB, node_modules contamination.
- Isolated automated test suite (Node 22, `node --test`) run against both
  pre-hotfix and r2 images in ephemeral containers with temp DB/uploads/certs:
  - New `console-csp-route.test.js` PASSES on r2 (asserts `/console` allows
    `http://127.0.0.1:8755`, `/app` does not, no wildcard, upgrade-insecure
    requests disabled, existing websocket/cloudflare/media/frame sources kept).
  - Same test FAILS on pre-hotfix (proving the fix is the exact differentiator).
  - No new regression vs pre-hotfix; the only stable failures are two
    pre-existing, environment-coupled test fixtures that reference physical-host
    files absent from the container (`/app/appliance/p3/...`, `/app/ops/podium/...`)
    and are unrelated to this change. (TUS MIME / `upload-policy.test.js` passes.)
- Rollback image proven startable in isolation; rollback override validated via
  `docker compose config` (no build block, ports/volumes/env/health identical).

## Remaining on-site validation (operator, pre-event)
- Actual podium kiosk USB panel render + refresh.
- Actual kiosk USB import to a Guest/test account; confirm physical display.
- Five-physical-display walk (Front L/C/R, Side L/R) + audio.
- Required wall modes (incl. hybrid `1|2+3`, `1+2|3`) and whiteboard modes.
- Live screen-share from instructor laptop if required tomorrow.

