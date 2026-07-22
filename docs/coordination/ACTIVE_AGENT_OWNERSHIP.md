# Active Agent Ownership Manifest

> Last updated: 2026-07-22 by the managed-program-receiver agent.
> This file coordinates two parallel AI coding agents working on the
> media-control repository. It MUST be updated before any merge.

## Worktree and Branch Inventory

| Worktree | Branch | HEAD | Agent | Status |
|---|---|---|---|---|
| `D:/CodexWorktrees/media-control-live-program-20260722` | `codex/live-program-autoconnect-20260722` | `b0081ea8` | Managed program receiver (this agent) | Uncommitted changes preserved |
| `D:/CodexWorktrees/media-control-enterprise-ux-20260722` | `codex/enterprise-operator-ux-20260722` | `b0081ea8` | UI/UX enterprise operator agent | Clean (no changes yet) |
| `D:/CodexWorktrees/media-control-classroom-recovery-20260722` | `recovery/classroom-player-stabilization-20260722` | `09af3384` | Emergency stabilization (preserved) | Uncommitted changes preserved |
| `D:/CodexWorktrees/media-control-peertube-hardening-20260722` | `codex/peertube-replay-hardening-20260722` | `09af3384` | PeerTube backend hardening | Preserved |
| `D:/GitHub_Repos/media-control` | `feature/peertube-replay-integration` | `09af3384` | Main worktree (shared base) | Clean |
| `D:/GitHub_Repos/media-control-enterprise` | `repair/enterprise-media-control` | `b0081ea8` | Deployed production mirror | Clean |

**Production deployed commit:** `b0081ea8` on `repair/enterprise-media-control`.

## Managed Program Receiver Agent (this agent) — Owned Files

### New library files
- `server/lib/obs-bootstrap-access.js` — loopback-only bootstrap security gate
- `server/lib/program-receiver-policy.js` — receiver permission/event guard
- `server/lib/live-stream-safety.js` — livestream startup safety gates

### New browser bootstrap
- `server/player/managed-bootstrap.js` — OBS browser source managed bootstrap

### Modified backend
- `server/config.js` — `liveStream` configuration block
- `server/lib/live-stream-display.js` — display authority, token auth, content freshness
- `server/routes/live-stream.js` — separated prepare/start/stop, safety gates
- `server/server.js` — managed bootstrap route, player URL endpoint
- `server/ws/deviceSocket.js` — program receiver socket guard, room snapshot handler
- `server/player/index.html` — managed bootstrap integration, receiver health UI

### Modified frontend (minimal, contract-level only)
- `frontend/js/views/media-control/command-bar.js` — live program state exposure
- `frontend/js/views/media-control/action-dock.js` — live program action separation
- `frontend/js/views/media-control.js` — live program view wiring
- `frontend/js/api.js` — live program API client
- `frontend/css/media-control.css` — live program styling
- `frontend/js/i18n/*.js` — live program labels (de, en, es, fr, it, pt)

### New test files
- `server/test/player-managed-bootstrap.test.js`
- `server/test/live-stream-config.test.js`
- `server/test/live-stream-safety.test.js`
- `server/test/live-stream-route-integration.test.js`
- `server/test/obs-bootstrap-access.test.js`
- `server/test/program-receiver-policy.test.js`
- `server/test/obs-program-receiver-contract.test.js`
- `server/test/program-receiver-socket-integration.test.js`

### Modified test files
- `server/test/command-bar-live-state.test.js`
- `server/test/live-stream-display.test.js`
- `server/test/live-stream-start-safety.test.js`

## UI/UX Enterprise Operator Agent — Planned Owned Files

> The UI/UX agent has NOT yet started making changes. The following are the
> EXPECTED ownership boundaries per the task brief. Do not modify these files
> without coordinating with that agent.

- Enterprise room overview components
- Universal layout selector UI
- Content-library redesign views
- Global playback-control redesign
- Screen-share operator panel UI
- Privacy/publishing interface UI
- Responsive podium layout components
- Accessibility overhaul (ARIA, keyboard, focus)
- Frontend authoritative state-store architecture

## Shared Contracts (both agents may read, neither should independently redesign)

| Contract | Location | Consumer |
|---|---|---|
| Room snapshot schema | `server/lib/room-state-broadcaster.js` → `createRoomSnapshot()` | Both |
| Audio state contract | `docs/contracts/audio-state-contract.md` | UI/UX reads, backend owns |
| Live program state | `GET /api/live-stream/program-state` | Both |
| Live stream status | `GET /api/live-stream/status` | Both |
| Topology catalog | `server/lib/topology-catalog.js` | Both |
| Device socket protocol | `server/ws/deviceSocket.js` | Both |

## Files Requiring Later Integration

1. **Frontend live-program UI**: The minimal frontend changes in this branch
   (command-bar, action-dock, api.js) expose backend state for the UI/UX agent
   to consume. The UI/UX agent may redesign these views; the backend contracts
   must remain stable.

2. **Player index.html**: The managed bootstrap integration in this branch
   adds the OBS receiver health overlay. The UI/UX agent's responsive podium
   work may need to accommodate the receiver health element.

3. **Audio state exposure**: The audio state contract
   (`docs/contracts/audio-state-contract.md`) defines the stable schema. The
   UI/UX agent should build its audio status UI against this contract.

## Merge Order

1. **Managed program receiver branch** (`codex/live-program-autoconnect-20260722`)
   merges first — it provides the backend foundation and stable contracts.
2. **UI/UX enterprise operator branch** (`codex/enterprise-operator-ux-20260722`)
   merges second — it consumes the contracts established above.
3. **PeerTube hardening** (`codex/peertube-replay-hardening-20260722`) merges
   after the program receiver is accepted.
4. **Classroom recovery** (`recovery/classroom-player-stabilization-20260722`)
   is reconciled into the program receiver branch (see section 10 of the brief).

## Known Conflicts

- **None currently.** The UI/UX agent has no changes yet.
- **Potential future conflict**: `frontend/js/views/media-control/` files are
  touched minimally by this branch and will be extensively redesigned by the
  UI/UX agent. Resolution: UI/UX agent's version wins for UI; this branch's
  backend contract calls must be preserved.
- **Potential future conflict**: `server/player/index.html` is modified by
  this branch for managed bootstrap. If the UI/UX agent also modifies the
  player, the managed bootstrap integration must be preserved.

## Coordination Rules

1. Before modifying any file listed under "Shared Contracts," update this
   manifest and notify the other agent.
2. The managed program receiver agent owns backend state and contracts.
3. The UI/UX agent owns operator-facing interface components.
4. Neither agent should independently redesign the other's owned surface.
5. All merges require reviewing the completed handoff of the other agent.
