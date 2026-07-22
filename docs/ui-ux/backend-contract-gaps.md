# Backend Contract Gaps — Enterprise Operator Console

This documents the contracts the enterprise console needs that the baseline does **not** yet expose. For each gap we list the recommended endpoint/event, request, response, authorization, revision behavior, error behavior, and the frontend consumer. The active agent's reserved files (notably `server/routes/live-stream.js`) are NOT replaced — we only document what is missing so the integration phase can add endpoints without conflicting with the live-program branch.

Mocks for every gap live in `frontend/js/state/enterprise-api.js` (gated by `globalThis.__MC_ENTERPRISE_MOCK_ONLY`).

---

## G-01 — Rooms catalog

- **Why:** The console's first step is "Choose room". Today there is one global `config.console.roomId` (`server/config.js:147`); no `GET /api/rooms`.
- **Endpoint:** `GET /api/rooms`
- **Request:** —
- **Response:** `{ rooms: [{ id, name, isDefault }] }`
- **Authorization:** `requireAuth + resolveTenancy` (any workspace member).
- **Revision:** none (static config-derived).
- **Error:** 401/403.
- **Frontend consumer:** `enterpriseApi.rooms.list()` → operator-console room step.

## G-02 — Confirmed playback state accessor (typed)

- **Why:** Playback controls must show confirmed observed state, not the last command. The data already exists in `confirmedState.displays[]` (`room-snapshot.js:331-378`) and `display_states`; the gap is a typed, per-target accessor the components can rely on without re-deriving.
- **Endpoint:** none new — consume the room snapshot (`operator-store.js` derives `slideIndex/slideCount/currentTime/duration/paused/contentType`). Documented so a future REST mirror (`GET /api/displays/:id/playback`) can share the shape.
- **Response shape:** `{ contentId, contentType, paused, slideIndex, slideCount, currentTime, duration }`
- **Revision:** follows room snapshot revision.
- **Frontend consumer:** `mountPlaybackControl`.

## G-03 — Layout catalog availability

- **Why:** The universal layout selector needs to know which layouts are available for the current topology. Availability is derivable client-side from `displayCount` (`enterprise-api.layouts.availability()`); no endpoint needed. **Gap:** topology-specific region mapping (which physical displays a layout targets) is not exposed as a contract — it's encoded in `wall-layout.js` presets (`span-all/split-all/span-left/span-right`). Recommend exposing a stable layout-intent → device-mapping resolver.
- **Endpoint (recommended):** `GET /api/walls/:id/layout-options` → `{ options: [{ key, available, memberIds, audioAuthority, unavailableReason }] }`
- **Revision:** include `layout_revision` for revision-safe application (mirrors `PUT /api/walls/:id/layout` 409, `video-walls.js:251`).
- **Error:** 409 `LAYOUT_REVISION_CONFLICT` (existing).
- **Frontend consumer:** `mountLayoutSelector` (currently uses displayCount + mock).

## G-04 — Content library facets (Recent/Favorites/Owner/Processing)

- **Why:** `GET /api/content` supports `visibility/type/search/owner=me/archived` (`api.js:127-137`, `content-library.js:128-145`) but not Recent, Favorites, or Processing-state filters.
- **Endpoint:** extend `GET /api/content` with `?recent=true&favorite=true&processing=true&owner=<id>`.
- **Response:** unchanged content rows.
- **Authorization:** governed (`content-visibility.js`).
- **Frontend consumer:** `mountContentSelector`.

## G-05 — Screen-share diagnostics event

- **Why:** The screen-share panel needs video/audio track, resolution, fps, transport, fit, PiP, latency/health. The engine exposes `getTargetDiagnostics()`/`getTargetStates()` (`screen-share-engine.js`) but these are local-only; a multi-operator room needs a shared, server-relayed diagnostics summary for peers.
- **Event (recommended):** `dashboard:ss-diagnostics` (server → room-state room) carrying per-target diagnostics. Or `GET /api/screen-share/diagnostics`.
- **Revision:** none.
- **Frontend consumer:** `mountScreenSharePanel` (uses engine directly today; mock fixture for degraded fallback).

## G-06 — Content visibility transitions

- **Why:** Privacy/publishing needs `request organization publication`, `approve`, `duplicate privately`, `transfer ownership`, `archive`, `set visibility`. The baseline has `content_capabilities` + `content_publication_requests` (`server/routes/content.js:641-727`, `:968-982`) but the frontend adapter methods (`api.requestOrganizationPublication`, `api.setContentVisibility`) are not present on `api.js` today — `enterprise-api.js` falls back to mocks.
- **Endpoint (recommended):** `POST /api/content/:id/visibility`, `POST /api/content/:id/publication-request`, `POST /api/content/:id/publication-request/approve`, `POST /api/content/:id/duplicate-private`, `POST /api/content/:id/transfer`.
- **Authorization:** per-permission booleans already returned by `contentCapabilities`.
- **Error:** 403 when active routes exist (narrowing/deleting while in use).
- **Frontend consumer:** `mountPrivacyPublishing`.

## G-07 — Structured error envelopes for operational failures

- **Why:** Operational failures (OBS/PeerTube unavailable, recording failure, revision mismatch, offline) currently bubble as generic `error.message` (`api.js:22-28`). The error-recovery model needs a `code` to map to a structured recovery.
- **Recommended:** all control endpoints return `{ error, code, details }` consistently (some already do: `LAYOUT_REVISION_CONFLICT`, `CONFIRM_ALL_REQUIRED`, `DEVICE_ALREADY_IN_WALL`). Extend to OBS/PeerTube/recording with `OBS_UNAVAILABLE`, `PEERTUBE_UNAVAILABLE`, `RECORDING_FAILURE`.
- **Frontend consumer:** `deriveErrorCode` (`error-recovery.js`).

## G-08 — Revision-mismatch recovery for command dispatch

- **Why:** `dashboard:device-command` acks with `{delivered, queued, reason}` (`socket.js:292`). A revision mismatch on a layout-adjacent command should return `REVISION_MISMATCH` with the current revision so the UI can refresh and reapply (the integration guide covers the reapply loop).
- **Frontend consumer:** `operator-console.js` send flow + `error-recovery.js`.

---

## Contracts deliberately NOT reimplemented

Per task §17: no competing authoritative room-state service, no duplicate livestream routes, no second Socket.IO connection. The operator store **derives from** the shared `roomState` store (`socket.js:41`); the socket adapter (`socket-adapter.js`) wires the EXISTING local events — it does not open a connection.
