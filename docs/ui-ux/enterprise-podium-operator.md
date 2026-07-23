# Enterprise UI / Podium operator package

## Canonical routes

| Audience | Default when authorized | Emergency fallback |
|----------|-------------------------|--------------------|
| Classroom web user | `#/operator-console` | `#/control` |
| Podium `/console/classroom-1` | `#/operator-console` | `#/control` |

Enterprise mode is **server-authoritative** via `GET /api/features` → `features.enterpriseOperatorUi.authorized`. Query strings, localStorage, and client-only flags cannot enable it.

## Build identity

About / System panel shows truncated build commit (`window.__MC_BUILD_COMMIT` or meta `mc-build-commit`) and service-worker script URL.

## Livestream ladder

Dock shows examined states: Not configured, Receiver offline, OBS unavailable, Program not prepared, Scene unsafe, Ready, Preparing, Starting, On Air, Stopping, Failed.

Start is disabled until capability contract allows operator start. Failures surface `code` + `error` (never bare “Request failed”). No optimistic On Air.

## Screenshot polling

`frontend/js/services/screenshot-poll.js` bounds polling to visible non-retired devices, one in-flight per device, freshness skip, visibility pause, exponential backoff. Metrics: `window.__mcScreenshotPollMetrics()`.

## Ownership

Agent 4 Phase A UI work. Integration merges Agent 1–3 branches separately.
