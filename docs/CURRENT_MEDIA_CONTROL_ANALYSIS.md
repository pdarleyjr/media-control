# Current Media Control Analysis

## Repository and Build System

- The current Media Control repository is a private MBFD fork of ScreenTinker.
- Backend: Node.js, Express, Socket.IO, SQLite through `better-sqlite3` under `server/`.
- Frontend: static ES-module SPA under `frontend/`; no existing frontend bundler.
- Android display player: Gradle/Kotlin under `android/`.
- Existing server package manager: npm with `server/package-lock.json`.
- This branch adds a light pnpm workspace wrapper at the repo root for the new Linux console and podium agent while leaving the existing server package intact.

## Main Runtime Shape

- `server/server.js` owns HTTP, HTTPS, static assets, API route mounting, Socket.IO namespaces, heartbeat checks, scheduler, alerts, and APK/player serving.
- `/app` serves the authenticated dashboard SPA from `frontend/index.html`.
- `/player` serves the unattended display/player surface and is already treated as no-auth display content.
- Protected dashboard APIs use `requireAuth` and `resolveTenancy`.
- Public display routes are intentionally limited and mounted before the protected API block.

## Authentication and Profile Model

- Normal users authenticate through `/api/auth/login`, OAuth, or MBFD Hub sync.
- Browser sessions use a JWT in `localStorage`; the JWT includes `current_workspace_id`.
- `/api/auth/me` returns the current user, workspace context, organization context, roles, and accessible workspaces.
- Users are shared-display members through the primary workspace model in `server/lib/primary-workspace.js`.
- Per-user files/content remain scoped by `(workspace_id, user_id)` through `server/lib/content-scope.js`.

## Content Library Flow

- Content lives in `content`, with upload, remote URL, YouTube, thumbnails, folders, metadata, tags, and workspace ownership.
- `server/routes/content.js` filters normal library views to the active workspace and active user, plus platform template content where `workspace_id IS NULL`.
- Presentations use `presentations` and related MBFD deck tables.
- Playlists and playlist items map content/widgets to displays and video walls.

## Display Control Flow

- Devices pair through a 6-digit pairing code and then authenticate with long-lived `device_token` values.
- `server/ws/deviceSocket.js` handles display/player sockets, heartbeat, telemetry, screenshots, player state, wall state, screen-share signaling, and device command delivery.
- `server/ws/dashboardSocket.js` handles authenticated dashboard sockets and relays commands to devices with workspace permission checks.
- `server/routes/displays.js` exposes dashboard display state and the per-user selected display set.
- The Command Center UI under `frontend/js/views/media-control.js` is the main control surface for room operation.

## WebSocket and Live Update Model

- Dashboard clients connect to the `/dashboard` namespace with the JWT.
- Display clients connect to the `/device` namespace with `device_id` and `device_token`.
- The server emits workspace-scoped dashboard events for device status, screenshots, now-playing state, wall changes, and command acknowledgements.
- Offline device commands are queued briefly through `server/lib/command-queue.js`.

## Deployment Model

- Production is Docker-based on the GMKtec server with code mounted into the Laravel/media-control stack area.
- SQLite data is expected outside the code directory through `DB_PATH`.
- Cloudflare Tunnel exposes public hostnames; unattended display routes already need Cloudflare Access bypass behavior.
- README and scripts also document Raspberry Pi/Windows kiosk players, but the Raspberry Pi script has drift and still references older health-route assumptions.

## ScreenTinker Fork Customizations

- The fork has MBFD-specific Command Center UI, shared primary workspace behavior, Studio/presentation tools, AI deck generation, Nextcloud integration hooks, display hardening, wall/smartboard work, and security hardening.
- Billing/Stripe exists in package dependencies and older docs but is effectively defanged for MBFD internal operation.

## Console Integration Decision

- The safest v1 approach is not a separate unauthenticated clone of every dashboard API.
- The Linux console route now uses `/api/console/session` to mint a normal dashboard JWT for the trusted physical device and selected profile.
- The console starts as Guest, stores a normal JWT, then reuses the existing authenticated Command Center, content, settings, permissions, display state, and Socket.IO flow.
- Profile switching mints a new JWT for the selected member and reconnects the dashboard socket, so the existing per-user content/settings model remains authoritative.

## New Files Touching Existing Behavior

- `server/routes/console.js` adds trusted-device no-login console bootstrap/profile switching.
- `server/config.js` adds console-specific environment settings.
- `server/server.js` mounts `/api/console` before the protected API block.
- `frontend/js/app.js` adds console-mode bootstrapping/header behavior only when the path starts with `/console/`.
- `frontend/css/console.css` styles the console header and boot screen.

Normal `/app` authentication and existing display/player behavior are preserved.
