# Unified "Media Control" Dashboard — Design Spec

- **Date:** 2026-06-01
- **Status:** Approved (design); pending implementation plan
- **Repo:** `media-control` (deployed as the live `media.mbfdhub.com`)
- **Branch target:** `feature/mbfd-media-control-studio` (work branch)

---

## 1. Goal

Consolidate the **Classroom** tabs (Present, Displays, Share My Screen, Whiteboard/Smartboard, Scenes) plus the **Studio "Home"** tab into ONE unified, smart, enterprise-grade **"Media Control"** dashboard that loads as the post-login home page. It must:

1. Provide a single workflow to broadcast any content type to one or multiple displays.
2. Reflect each display's real resolution/aspect and its operator-assigned name.
3. Support template-based partitioning of a single display into independent regions (PPT left, YouTube right).
4. **Fix the "lose control of active media when I navigate away" bug** — return to the control surface and still see/manage exactly what is live, without dropping the active stream.
5. Re-hydrate on load to the displays the operator was last broadcasting to.
6. Scale to a large and growing number of displays.
7. **Zero regression** to existing stable tabs/displays. Keep the color scheme. Do not touch unrelated tabs.

UX inspiration: Haivision Command 360 / StreamHub single-pane control.

## 2. Decisions (locked)

| Decision | Choice |
|---|---|
| Center "what is live where" surface | **Hybrid stage**: top = the displays you control (real aspect + title + live preview), with an "Add display" picker and a Grid⇄Wall toggle; bottom = toolbox dock. Re-hydrates to last-controlled displays on load. |
| Send behavior | **Instant (hot cut)** — one tap/drag goes live immediately. |
| Rollout | **Flip the post-login landing to the new dashboard as soon as it's built** (existing tabs remain reachable as deep links). |
| Partitioning | **Templates first** (preset splits), then optional drag-to-refine. |
| Whiteboard / Share My Screen | Surfaced as **toolbox actions on a selected display**, not their own sub-tabs. |
| Video walls / Layouts / Playlists / Schedules pages | **Untouched.** Walls appear as an advanced stage card; their own pages are not modified. |

## 3. Current architecture (as-found)

Vanilla-JS, hash-routed SPA; Express + Socket.IO backend; SQLite (better-sqlite3); workspace-scoped tenancy.

- **No formal route table.** Views are `import`ed in `frontend/js/app.js` (lines 2–29) and dispatched via an if/else chain in `route()` (≈233–437). The sidebar is **static HTML** in `frontend/index.html` grouped into nav-sections: Classroom (44–82), Studio (84–121), Operate (123–155), Admin (157–176). `app.js` toggles `.active` via a manual hash→`data-view` chain (323–352) and gates groups by role. Post-login landing decision at `app.js:268–279` (instructor → `#/present`, others → `#/home`).
- **Two broadcast control planes (no shared backend code):**
  1. **Content push (durable, DB-backed):** `POST /api/broadcast` → `sceneEngine.pushSourceToDevice` (`server/services/scene-engine.js:106`) writes `devices.playlist_id` + `playlists.published_snapshot`, then emits `device:playlist-update` via `command-queue.queueOrEmitPlaylistUpdate`. Scenes trigger uses the SAME primitive. **Present, dashboard broadcast picker, Broadcast Center, and Scenes are four front-ends over this one primitive.**
  2. **Room/transport control (ephemeral, relay-only):** socket `dashboard:device-command {device_id,type,payload}` → `server/ws/dashboardSocket.js:169` re-emits `device:command {type,payload}` to the device room (or queues if offline). **Nothing about transport position or blank state is persisted.**
- **Shared plumbing:** the dashboard Socket.IO connection is a **session singleton** (`socket.js connectSocket`, called once at `app.js:502`) that SURVIVES navigation. The WebRTC signaling relay (`server/ws/screen-share-signaling.js`) holds the only cross-view session registry (in-memory `activeSessions` Map). The player (`server/player/index.html`) rebuilds "what to show" server-side from `published_snapshot` on every reconnect (`deviceSocket.js buildPlaylistPayload`).

## 4. The state-persistence bug — root causes & fixes

Three compounding causes:

1. **PRIMARY — router-driven teardown.** `route()` calls BOTH `cleanup()` and `unmount()` on the outgoing view on EVERY hashchange (`app.js:237–240`). Share-My-Screen's `unmount()` (`screen-share.js:242`) calls `stopCapture()`, closing every `RTCPeerConnection` and stopping every `getDisplayMedia` track — navigating away **hard-terminates the live broadcast**. All broadcast state lives only in module-scoped globals (`screen-share.js:110–116`); re-entry calls `resetState()`. Present and Smartboard share this pattern.
2. **SECONDARY — no server source of truth for live control.** `dashboardSocket.js:169` is a pure relay; it never records the command, targets, or resulting display state. Broadcast Center holds its entire selection in module vars (`sel/targets/blanked`, `broadcast-center.js:19–21`), hard-reset on every render; `cleanup()` is a no-op. The single `blanked` boolean desyncs from reality.
3. **TERTIARY — dashboard never re-renders durable content state.** The content-push half IS durable (`devices.playlist_id` + `published_snapshot` survive; player re-hydrates on reconnect), but the dashboard never resolves `published_snapshot` into a per-card "now playing" label, and the per-card progress bar is fed only by live events and cleared in `cleanup()`.

**Not the cause:** the socket is NOT torn down (session singleton); the workspace room subscription is NOT dropped; `command-queue.js` is a TTL delivery buffer, not a state store.

**Fixes:**

1. **Hoist the screen-share engine to a persistent singleton** `frontend/js/services/screen-share-engine.js` holding `stream/peerConnections/iceConfig` and the (already-idempotent, `sock.__screenShareDashboardWired`) signaling listeners. Views become thin presenters. `unmount()` STOPS calling `stopCapture()`. A persistent **"● Live broadcast" chip** in the shell surfaces and controls the active broadcast from anywhere. Reuse `refreshSessionList` (`screen-share.js:817–863`) as that widget.
2. **Server display-state read model** — `GET /api/displays/state` resolves each display's current source from `published_snapshot` (now-playing label), online status, geometry, last-screenshot URL+timestamp, and an **authoritative `screen_on/off` flag** written in the `dashboard:device-command` handler **only on delivered/acked commands** (never on the offline-queue branch). The dashboard fetches on mount and re-fetches on socket reconnect. Single query; cache the snapshot parse (SQL already `LIMIT 500`).
3. **Persist per-user active display selection** so the stage re-hydrates to "what you were just controlling" on load.

## 5. Layout zones (the "lost template remapping")

The feature is **layout zones** (split ONE display into N independent regions) — distinct from **video walls** (composite MANY displays into one canvas).

- **Data model (`server/db/schema.sql`):** `layouts` (L125) owns N `layout_zones` (L139), each a **percentage rectangle** (`x/y/width/height_percent` + `z_index` + `zone_type content|widget` + `fit_mode` + `sort_order`). A layout is assigned to one device via `devices.layout_id` (`PUT /api/layouts/device/:deviceId`). `playlist_items.zone_id` (L355) routes an item to a region. Percentages make zones resolution-independent.
- **End-to-end pipeline EXISTS today:** `layout-editor.js` (drag/resize + 7 presets) → `routes/layouts.js` CRUD + `POST /:id/apply-preset` (`lib/layout-presets.js`: full/quad/columns_2/columns_3/rows_2/main_sidebar/six) → assign to device → `device-detail.js` per-item `.zone-select` (1062–1096) → `playlists.js buildSnapshotItems` carries `zone_id` into snapshot → `deviceSocket.js buildPlaylistPayload` attaches layout+zones → player `renderZones()` (`index.html:1958`) draws CSS % boxes routed by `assignment.zone_id`.
- **Regressed once, since patched:** `zone_id` was dropped in the Phase-2 migration (commit 73f41c3) and restored (73f41c3 + 12fe0e4). It is NOT currently missing.
- **Rough edges to fix for a clean UX:**
  1. Design step (layout-editor) and content-assign step (device-detail) live in two views → **fold per-zone assignment into the unified inspector** (lift the `device-detail.js:1062–1096` zone-select logic).
  2. Editor exposes no `fit_mode`/`background_color` control though schema+player support per-zone.
  3. **DATA-LOSS FOOTGUN:** editor Save (383–397) and apply-preset DELETE-then-recreate zones, minting new ids; `playlist_items.zone_id` is `ON DELETE SET NULL`, so every content→zone binding is **orphaned on each save**. → **Region editor must update zones in place (preserve ids).**
  4. Player runs `renderZones()` only `if zones.length>1 && !wallConfig` (`index.html:1840`) — a device can't be both partitioned AND a wall member; wall wins. **Decision:** forbid/warn when assigning a layout to a wall member (don't silently drop).
  5. Remove the stale frontend reference to a non-existent `GET /:id/zones` (zones ship inside `GET /:id`).

## 6. Player protocol (the dashboard MUST speak these exact strings)

Player connects on Socket.IO namespace `/device`. The dashboard is a controller that emits the SAME event names — TVs won't update in lockstep. **All emits route through one shared `frontend/js/player-protocol.js` (event-name constants + emit helpers)** so no component can typo an event.

**Server → player (commands the dashboard drives via relays):**
- `device:playlist-update { assignments[], orientation, wall_config, layout, suspended, message, detail }` — THE primary "show this content/scene/layout" command. **There is NO separate scene or layout event; `layout` (with `.zones[]`) and `wall_config` ride inside this payload.** `assignments[]` items may carry `zone_id` + `fit_mode`.
- `device:command { type, payload }`, `type ∈ refresh | launch | screen_off | screen_on | transport`; transport payload `{ action: next | prev | play_pause | restart }`.
- `device:identify { label }`.
- Whiteboard: `device:wb-show {}`, `device:wb-stroke {...}`, `device:wb-clear {}`, `device:wb-undo {}`, `device:wb-stop {}`.
- Walls: `wall:sync {...}` (leader→followers ~4Hz), `wall:sync-request {...}`.
- Broadcast: `device:screen-share-start { wall_tile? }`, `device:screen-share-offer { sdp }`, `device:screen-share-ice-candidate { candidate }`, `device:screen-share-end`.

**Player → server (consumed for live UI):** `device:register`, `device:heartbeat` (15s), `display:viewport { css_w, css_h, screen_w, screen_h, device_pixel_ratio, orientation, capabilities }` (geometry self-report — drives real-aspect stage cards), `device:play-event` → `dashboard:playback-progress`, `device:screenshot` → `dashboard:screenshot-ready`.

**Server → dashboard (workspace rooms; all ephemeral, none replayed on connect):** `dashboard:device-status`, `dashboard:screenshot-ready`, `dashboard:playback-progress`, `dashboard:playback-state`, `dashboard:device-added/removed`, `dashboard:wall-changed`, `dashboard:content-ack`.

**Screen-share signaling (dashboard ns, gated by `canActOnDevice(...,'write')`):** `screen-share:start/offer/ice-candidate/stop`; server→broadcaster `screen-share:answer/device-ice-candidate/preempted/ended-by-device`.

## 7. Unified dashboard — layout & components

**Layout** (responsive CSS grid; reuse `--mc-*` tokens / studio classes; `branding.js` must keep writing `.sidebar-header .logo span`):

- **Top bar:** title, `Grid | Wall` stage toggle, persistent **"● Live broadcast"** chip.
- **STAGE (top):** the displays you're controlling. Re-hydrates to last-controlled set on load. Each card sized to the display's **true aspect** from `display:viewport`, titled with the operator's name, showing the live screenshot preview (server-generated, pulled on existing ~30s + on-demand cadence — **never** stream N live videos to the browser), now-playing label, status dot, progress bar, and an "updated Ns ago" staleness flag. **"+ Add display"** picker adds any display or a wall. `Grid` = uniform cards (default); `Wall` = scaled geometric canvas.
- **TOOLBOX dock (bottom):** segmented — **Templates · Media · Presentations · Whiteboard · Share My Screen · YouTube/URL · Scenes**. Drag a tile onto a display (or a region) to broadcast, or select a display then click. Instant hot-cut.
- **Inspector (slide-in right, contextual on selection):** source binding, `fit_mode`, per-region **audio** (only-one-unmuted default + conflict warning), layer order, **"Partition into regions"** (templates-first → drag-refine), and a **Behaviors/macros** list named in operator language ("Start Lecture", "Show Video").
- **Bottom bar:** Scenes/Layout presets as recallable thumbnails + routing-mode presets: **Lecture** (one source → all), **Group Share** (independent per display), **Mirror**.

**Components (single responsibility, extracted from existing modules):**
- `DisplayTile` ← `dashboard.js renderDeviceCard` + `renderProgressFor` (pure; props = device row + playback state).
- `SourceTile` / `SourceRail` ← `broadcast-center.js renderSources` + `present.js` tiles.
- `sendToDisplays(source, targetIds, label)` ← extracted from `present.js broadcastSource` (already handles the `409 CONFIRM_ALL_REQUIRED` resolve-not-throw handshake). **Replaces the four parallel send paths.**
- `RegionEditor` ← `layout-editor.js` percentage model + `layout-presets.js` + `device-detail.js:1062–1096` zone-assign; reuse `video-wall.js boundsOf/intersect/attachDragResize` for drag math.
- `TransportBar` ← Broadcast Center transport/screen_off.
- `AnnotateAction` ← `smartboard.js` as a per-display action (single-target session fits an action, not a tab).
- `player-protocol.js` ← shared event-name constants + emit helpers.
- `screen-share-engine.js` ← persistent singleton (see §4).

**Data flow (this is the fix, not a reskin):**
1. Mount → `GET /api/displays/state` (resolved now-playing + online + screen-on/off + geometry + screenshot) → render stage.
2. Subscribe via the **existing session-singleton socket** to `dashboard:device-status / screenshot-ready / playback-progress` for live updates. Re-fetch state on socket reconnect. **Do NOT** tear down/reconnect the socket per view.
3. CONTENT writes → `sendToDisplays` → `POST /api/broadcast` → `sceneEngine.pushSourceToDevice` (untouched, durable). ROOM/transport writes → `dashboard:device-command`, now also persisting authoritative `screen_on/off` on ack.
4. SCREEN-SHARE via the singleton engine; navigation never calls `stopCapture()`.

## 8. Backend changes (surgical)

- **New:** `GET /api/displays/state` (resolved per-display state; single query; cache snapshot parse).
- **New:** authoritative `screen_on/off` written in `dashboard:device-command` handler **only on acked delivery**; `blanked` becomes **per-display**, not a single boolean.
- **New:** per-user `active_display_selection` persistence (small table or column + GET/PUT).
- **Changed:** region-editor save → **update zones in place** (preserve `zone_id`); add `fit_mode` per zone.
- **Unchanged:** entire content-push path, the player, ALL socket event names, the command queue.

## 9. Scenarios

- **PPT on Display A + YouTube on Display B:** two stage cards; drop a presentation on A, a YouTube tile on B. Instant.
- **One display split PPT | YouTube:** select display → Partition → 2-up → drop into each region; per-region audio (YouTube unmuted, PPT silent).
- **Whiteboard:** toolbox → "Turn Classroom 1 into a whiteboard" (`device:wb-show`).
- **Share my screen to a smartboard:** toolbox → Share My Screen → pick display; survives navigation.
- **Video wall:** one advanced stage card; existing wall editor unchanged.

## 10. Zero-regression guardrails

- Keep ALL old routes registered & reachable (`#/present`, `#/`, `#/screen-share`, `#/smartboard`, `#/scenes`, `#/home`, `#/walls`, `#/layouts`). New view is additive: new import + one `route()` branch + one nav `<li>` with a UNIQUE `data-view` + one active-paint line.
- Repoint post-login landing (`app.js:268–279`): **all roles now land on the unified dashboard** (collapsing the old instructor→`#/present` vs other→`#/home` split). The role *permissions* themselves are preserved untouched — the same role taxonomy still gates the Setup nav in `updateSidebarUser` and controls what is visible/editable within the dashboard (e.g. `workspace_viewer` cannot broadcast). Only the landing target changes, not the permission model.
- The unified view owns **NO module-scoped live resource** — engine + live-control state live in app-level singletons; engine `unmount()` must NOT `stopCapture()`.
- **Never rename/split a player socket event;** drive scenes/layouts through `device:playlist-update`; route all emits through `player-protocol.js`.
- Region editor save must **preserve `zone_id`** (no delete-recreate); any new snapshot/playlist_items write path must **carry `zone_id` forward**.
- Persist blank/transport state **only on delivered/acked** commands; `blanked` per-display.
- **Do NOT** tear down the session-singleton socket to "subscribe to state."
- Preserve wall-member **de-duplication** (`dashboard.js:791–793`) so a display never appears twice; prune wall-absorbed `device_ids` from broadcast targets.
- Fix the latent `dashboard.js cleanup()` handler-leak (1100–1101 unregister no-ops that never match the original closures) when consolidating — capture named handler refs.
- **Do NOT** "normalize" the player's `!important` iframe CSS (`index.html:154–160,179–180`) — it defeats the YouTube 300×150 baked-size bug.
- YouTube uses `POST /content/youtube` (`content.js:279`), NOT Present's raw-URL tile (which `resolveRemoteUrlContent` stamps as an image).
- Forbid/warn assigning a layout to a wall member (player silently ignores zones for wall members).

## 11. Testing

- **TDD (logic units):** display-state resolver; zone-id-preserving save; per-user selection persistence; engine-singleton "survives navigation"; per-display blank reconciliation.
- **Playwright E2E on staging** against the real 2 displays + 1 wall: send → navigate away → return → still controlling & state correct; split a display into regions; PPT+YouTube on two displays; whiteboard; screen-share-survives-navigation; "Send to all".
- Verify other tabs still load and old deep-links still work (zero regression).

## 12. Rollout

Build at `#/control` alongside everything; verify live with real displays; then **flip the post-login landing to it** in the same release. Old tabs remain reachable as deep links. Deploy manually on the box (CI billing-blocked): `git reset --hard origin/main` equivalent → rebuild `app/` build context → `docker compose up -d`.

## 13. Tenancy model — shared displays, private files (added 2026-06-01)

**Requirement (from the user):** every member logs in and can **see + broadcast to all displays** (displays are a shared org resource); but **each member's files/content are private to them** ("what should be user-specific should be their files"). Anything the admin adds (displays) is available to all.

**Why this needs a change:** today the app couples *both* devices AND content to a single `workspace` tenant (devices: `WHERE workspace_id = ?`; content: `WHERE (workspace_id = ? OR workspace_id IS NULL)`). There is no built-in "share displays but keep files private" mode. Verified in `routes/devices.js:38` and `routes/content.js:62`.

**Approach (one shared workspace + per-user content scoping):**
- **Shared (stay workspace-scoped, no change):** `devices`, `video_walls` + `video_wall_devices`, `layouts`/`layout_zones`, `scenes` (`operational_activities`) — these describe the shared displays and how to drive them.
- **Private (add `AND user_id = ?` to the workspace filter on list/get/update/delete):** `content` (uploads/media/YouTube), `presentations`, `playlists` + `playlist_items`, `content_folders`, and the per-user `download_jobs` / `ai_generation_jobs` lists. Platform templates (`workspace_id IS NULL`) remain visible to all. Each member sees only their own files.
- **Broadcast still works across the boundary:** a member broadcasts their *own* (private) content to a *shared* display. The server pushes by `content_id` (not user-scoped) and the player fetches by id with no user check, so private files render fine on shared displays. The per-user filter applies only to the **authoring/list UI surfaces**, never the server→player push path or `GET /api/content/:id` used by the player.
- **Membership (deploy-time data migration, idempotent):** add **all org users** to the single shared workspace (`dd3e4549-7c7b-441e-b515-ef39a5096402`, which already holds the displays) as broadcast-capable members — `workspace_admin` for platform-admins (Peter, Juan, Shari), `workspace_editor` for the rest (can broadcast: `canWrite` allows editor). Set their `joined_at` so the shared workspace is each user's **default** at login (`firstAccessibleWorkspace` orders by `joined_at ASC`). Users with a pre-existing personal workspace (e.g. Daniel Gato) keep it but default into the shared one.

**Zero-regression notes:** the `user_id` column already exists on `content` (and the owned tables), so scoping is additive — no migration to add columns. Existing live workspaces (Peter's, Daniel's) keep working; per-user scoping simply narrows each list to the caller's own rows. The shared-workspace membership migration runs at deploy (not in unit tests). Confirm the exact private/shared split for **playlists** and **scenes** with the user during review (current default: playlists private, scenes shared).

## 14. Out of scope

- No changes to Walls / Layouts / Playlists / Schedules / Admin pages themselves.
- No player code changes beyond what's strictly required to render existing capabilities (ideally none).
- Live video preview streaming to the browser (stick to server-generated screenshots; live preview only on a focused tile is a possible future enhancement).
- Take/preview buffer (instant hot-cut chosen for V1).
- Behaviors/macros are a stretch goal; ship the routing-mode presets (Lecture/Group Share/Mirror) first.
