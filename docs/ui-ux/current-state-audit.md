# Current-State UI/UX Audit — Media Control Operator Journey

**Baseline:** `b0081ea` (`repair/enterprise-media-control` / `codex/live-program-autoconnect-20260722`)
**Scope:** Read-only audit of the existing operator surfaces (NOT the enterprise console built in this branch). Every finding references `file_path:line_number`. Internal concepts (device IDs, wall leaders, Socket.IO rooms, command queues, grid coords, DB group IDs) are called out where they leak to ordinary instructors.

This audit does **not** assume an existing button is correct merely because it works technically.

---

## How to read each table

| Column | Meaning |
|---|---|
| current control | The actual affordance the operator uses today |
| current location | Where it lives in the UI |
| required operator knowledge | What an instructor must already know to use it |
| backend endpoint | The REST/Socket contract it calls |
| current state source | Where the displayed value comes from |
| optimistic or confirmed | Does the UI assume success or wait for device truth? |
| failure presentation | What the operator sees when it breaks |
| reconnect behavior | What happens on socket/device reconnect |
| podium behavior | Touch/viewport behavior at the podium |
| web behavior | Desktop web behavior |
| usability defect | A concrete problem |
| recommended correction | The enterprise fix (implemented in this branch where non-conflicting) |

---

## 1. Room selection

| | |
|---|---|
| current control | There is no room picker. The active room is a single global `config.console.roomId` (`server/config.js:147`, env `ROOM_ID`, default `classroom-1`). The dashboard socket joins `room-state:<wsId>:<roomId>` on connect (`server/ws/dashboardSocket.js:199-213`). |
| current location | Implicit — the whole console is scoped to one room. |
| required operator knowledge | The instructor must know which physical room they are in and trust the deployment pinned the right `ROOM_ID`. |
| backend endpoint | None — no `GET /api/rooms`. |
| current state source | Server config. |
| optimistic or confirmed | n/a |
| failure presentation | None — a misconfigured `ROOM_ID` silently shows the wrong room. |
| reconnect behavior | Room re-joined on socket reconnect (`socket.js:72`). |
| podium behavior | Same. |
| web behavior | Same. |
| usability defect | No room choice; wrong-room misconfiguration is invisible. |
| recommended correction | Add a rooms catalog (`docs/ui-ux/backend-contract-gaps.md` G-01) and a "Choose room" step. Implemented here as a mock `enterpriseApi.rooms.list()` and the workflow's first step (`operator-console.js`). |

## 2. Display selection

| | |
|---|---|
| current control | Target Selector (`mountTargetSelector`, `frontend/js/views/media-control/target-selector.js`) + authoritative picker (`components/target-picker.js`, `openAuthoritativeTargetPicker`). REST selection `PUT /api/displays/selection` (`api.js:97`). Socket target `dashboard:select-target` (`socket.js:231`). |
| current location | Command Center stage rail. |
| required operator knowledge | Operators must understand "target", "wall", "group", "wall-group" and pick `type:id` references. Internal IDs leak into pickers (`target-catalog.js:parseTargetReference` accepts `"type:id"` strings, `:406`). |
| backend endpoint | `GET /api/displays/selection`, `PUT /api/displays/selection`, Socket `dashboard:select-target`/`clear-target`. |
| current state source | Authoritative room snapshot → `buildTargetCatalog` (`target-catalog.js:177`). |
| optimistic or confirmed | Confirmed topology (fail-closed `wait()` rejects on stale, `target-catalog-runtime.js:31-80`). |
| failure presentation | `routing-picker` shows "Live room topology is unavailable…" on timeout. |
| reconnect behavior | Selection re-announced on connect (`socket.js:72`, `emitSelectedTarget`). |
| podium behavior | Picker rows may be small; no documented 44px floor enforced here. |
| web behavior | Works on desktop. |
| usability defect | Concepts like "wall-group `span-left`" are topology-internal; an instructor must not choose grid coordinates. |
| recommended correction | Hide internal IDs; show display names + diagrams. The enterprise layout selector (`layout-selector.js`) presents visual diagrams and disables unavailable options with a reason. |

## 3. Wall / group selection

| | |
|---|---|
| current control | Span/Split toggle (`span-split.js:20`) with presets `[1+2][3]`/`[1][2+3]` (3-member only). Wall-group targets from the catalog. |
| current location | Command Center stage. |
| required operator knowledge | "span" vs "split", "layout_mode", "leader_device_id", "layout_revision". |
| backend endpoint | `PUT /api/walls/:id/layout` (revision-checked, `video-walls.js:251`); `PUT /api/walls/:id/devices`/`/content`. |
| current state source | Room snapshot `layoutState.walls` (`room-snapshot.js:428`). |
| optimistic or confirmed | Confirmed; revision-safe — 409 `LAYOUT_REVISION_CONFLICT` returned on stale (`video-walls.js:251-285`). |
| failure presentation | `confirmDialog` when content is live before switching (`span-split.js:54-72`); 409 surfaces as an error toast generically. |
| reconnect behavior | Wall membership re-derived from snapshot on resume. |
| podium behavior | Two buttons; adequate size. |
| web behavior | Works. |
| usability defect | "span/split" terminology; revision-conflict errors are generic ("Request failed"), not operator-actionable. |
| recommended correction | Operator state vocabulary + structured recovery (`error-recovery.js` → `REVISION_MISMATCH`). |

## 4. Layout selection

| | |
|---|---|
| current control | Region editor presets (`region-editor.js:29-37`: full/columns_2/rows_2/columns_3/quad/main_sidebar/six); scene presets (`room-presets.js`). |
| current location | Region editor modal; Command Center "Room setup". |
| required operator knowledge | Zone percent coordinates, fit modes, preset keys. |
| backend endpoint | `PUT /api/layouts/:id/zones/:zoneId`; `POST /api/scenes/:id/trigger`. |
| current state source | `layoutState` + per-device `layout_context` (`deviceSocket.js:253-427`). |
| optimistic or confirmed | Confirmed via snapshot publish after mutate. |
| failure presentation | Generic error toast. |
| reconnect behavior | Layout state survives via snapshot. |
| usability defect | Layout is conflated with zones; no unified layout-for-content-type experience; unavailable layouts silently disabled or unclear. |
| recommended correction | Universal layout selector with diagrams + availability reasons (`layout-selector.js`). |

## 5. Content selection

| | |
|---|---|
| current control | Toolbox media tabs + content library (`content-library.js`); drag-to-stage (`toolbox.js attachTileHandlers`). |
| current location | Command Center library drawer. |
| required operator knowledge | Mime-type taxonomy, folders, visibility levels. |
| backend endpoint | `GET /api/content` (`api.getGovernedContent`, `api.js:127`); `POST /api/content` (upload). |
| current state source | REST content list (not room snapshot). |
| optimistic or confirmed | Confirmed list; `in_use` indicator exists (`content-library.js`). |
| failure presentation | Generic error. |
| usability defect | Filters partial (search/visibility/type/mine/archived) — no Recent/Favorites/Owner/Processing facets; private content segregation is backend-enforced but not visually salient. |
| recommended correction | Unified content selector with full facet set + in-use/processing/compatibility badges (`content-selector.js`). |

## 6. Preview

| | |
|---|---|
| current control | Stage card (`stage.js previewSource/renderStage`); live embed (`live-preview.js:liveEmbedHtml`). |
| current location | Command Center stage. |
| backend endpoint | Screenshots via `dashboard:request-screenshot` (`socket.js:221`); player embed URLs. |
| current state source | `display-state.js` projection merges snapshot + events. |
| optimistic or confirmed | Observed (screenshot/progress). |
| usability defect | "Preview" is not distinguished from "classroom program" or "livestream program" as a target surface — sending can hit the live program by accident. |
| recommended correction | Explicit PREVIEW / CLASSROOM PROGRAM / LIVESTREAM PROGRAM surface switch with deliberate send actions (`operator-console.js`). |

## 7. Send / take live

| | |
|---|---|
| current control | "Send to all", drag-drop, scene trigger, toolbox tiles (`send.js:sendToDisplays`). |
| current location | Command Center. |
| required operator knowledge | The 409 `CONFIRM_ALL_REQUIRED` gate; the live-stream inclusion 3-button dialog; YouTube must be materialized. |
| backend endpoint | `POST /api/broadcast` (`api.broadcast`); `POST /api/content/youtube` for URLs. |
| current state source | Action result. |
| optimistic or confirmed | Confirmed by `content-ack`/`state-sync`. |
| failure presentation | Toast with offline tail (`sentToast`); 409 prompts confirm-all. |
| usability defect | "take to livestream" vs "send to classroom" is a 3-button dialog mid-flow — easy to mis-pick; replace-active/stop-all/publish require no explicit high-impact confirmation path. |
| recommended correction | Deliberate, separated send buttons with confirmation for high-impact surfaces (`operator-console.js`). |

## 8. PowerPoint control

| | |
|---|---|
| current control | Transport bar prev/restart/next (`transport.js:60-158`). |
| backend endpoint | `sendCommand(id, TRANSPORT, {action})` (`socket.js:270`); `go_to_slide` via device-contract (`device-contract.js:42-82`). |
| current state source | `display_states` (`slide_index/count`) → `now_playing` (`room-display-projection.js:34-44`). |
| optimistic or confirmed | Commanded; confirmed via `state-sync`. |
| usability defect | No direct-slide selector; "restore" absent; paused state can be `null` (ambiguous button label `⏯ Play/Pause`, `transport.js:85-87`). |
| recommended correction | Context-sensitive PowerPoint controls with slide picker + restore (`playback-control.js`). |

## 9. Video control

| | |
|---|---|
| current control | Transport bar (play/pause). |
| backend endpoint | `TRANSPORT` actions; `seek`. |
| current state source | `now_playing.currentTime/duration` from `playback-progress` (`display-state.js:91-105`). |
| usability defect | No seek bar, volume, mute, stop+restore in the transport bar. |
| recommended correction | Full video controls (`playback-control.js`). |

## 10. Screen sharing

| | |
|---|---|
| current control | Screen-share engine + view (`screen-share-engine.js`, `screen-share.js`). |
| backend endpoint | WebRTC signaling `screen-share:*` (`player-protocol.js:23-27`); ICE config via API. |
| current state source | Engine `getTargetDiagnostics()` / `getTargetStates()`. |
| usability defect | Degraded JPEG-relay fallback is NOT explicitly labelled in the operator UI (`screen-share-engine.js:77-88`); no audio-track/transport/fit-mode panel. |
| recommended correction | Screen-share panel with explicit DEGRADED FALLBACK label and diagnostics (`screen-share-panel.js`). |

## 11. Camera selection

| | |
|---|---|
| current control | Camera feeds catalog (`camera-feeds-catalog.js`); classroom cameras via `/player/classroom-camera.html`. |
| usability defect | No PiP/swap/PTZ/health UI; cameras sent as `remote_url` tiles. |
| recommended correction | Camera controls in `playback-control.js`. |

## 12. PiP

| | |
|---|---|
| current control | None as a first-class layout; only via layout presets. |
| usability defect | No content-with-camera-PiP / camera-with-content-PiP intent. |
| recommended correction | Layout catalog includes both PiP intents (`layout-selector.js`). |

## 13. Livestream

| | |
|---|---|
| current control | Command bar live buttons (`command-bar.js:148-213`); action dock live controls (`action-dock.js`). |
| backend endpoint | `api.liveStream.*` (`api.js:370-377`); OBS/AI Director sequence (`live-stream.js:170`). |
| current state source | `livestreamProgram` snapshot + `streamState`. |
| usability defect | Start/stop/clear are mixed with routine controls; OBS-unavailable errors bubble as 502/503 generic. |
| recommended correction | Dedicated livestream surface + `OBS_UNAVAILABLE` recovery (`error-recovery.js`). |

## 14. Recording

| | |
|---|---|
| current control | Indirect (broadcast center). |
| backend endpoint | AI Director `/status` → `recordingState` snapshot. |
| usability defect | No recording start/failure panel; recording failure is silent. |
| recommended correction | Room overview recording chip + `RECORDING_FAILURE` recovery. |

## 15. Content library / error recovery

| | |
|---|---|
| current control | Library view + toasts. |
| usability defect | Operational failures surface as generic "Request failed" (`api.js:22-28`); no "what happened / what's active / what to do / retry safe" structure. Stale snapshot, revision mismatch, unauthorized, content-processing, incompatible media, missing SS audio, disconnected camera, failed layout, PeerTube/OBS unavailable, recording failure are all collapsed. |
| recommended correction | Structured error-recovery model (`error-recovery.js`) + the operator-state vocabulary. |

---

## Cross-cutting defects

1. **Internal IDs leak** to operators (wall-group keys, leader device IDs, grid coords, DB group IDs).
2. **No single state vocabulary** — "online", "playing", "paused", "sent", "acked", "timeout" are inconsistent surfaces.
3. **Confirmed vs commanded** is not visually distinguished everywhere (transport bar acts on `paused` which may be `null`).
4. **Color-only signals** risk (status dots rely on color class; the live badge is color-only in places — `--live`).
5. **Podium parity** is not asserted (no 44px floor enforced globally; hover-only affordances in some modals).
6. **Preview vs classroom vs livestream** surfaces are not separated — accidental live changes are possible.

## Files deliberately not modified

All reserved files listed in the task (`frontend/css/media-control.css`, `frontend/js/api.js`, `frontend/js/views/media-control.js`, `frontend/js/views/media-control/*`, `frontend/js/i18n/*`, `server/config.js`, `server/server.js`, `server/player/*`, `server/routes/live-stream.js`, `server/lib/live-stream-safety.js`) were read only. No edits were made to them in this branch.
