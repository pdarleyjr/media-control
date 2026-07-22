# Operator State Model — One Enterprise Interaction Vocabulary

**Module:** `frontend/js/state/operator-state.js`

The enterprise console exposes exactly ONE state vocabulary to operators. Internal concepts (device IDs, wall leaders, Socket.IO rooms, command queues, grid coordinates, database group IDs) are NEVER surfaced. Every state has **both text and visual styling** and is **never color-only** (WCAG 1.4.1): each state ships a `tone` (semantic CSS class) **plus** a glyph **plus** a text label (`labelKey`).

## The workflow

```
Choose room → choose layout → choose content or source → preview → take/send
          → receive confirmation → control playback
```

## State vocabulary

| State | rank | tone (class) | glyph | label-key | Meaning |
|---|---|---|---|---|---|
| STANDBY | 0 | `is-idle` | ◯ | `mc.e.op_state.standby` | No active command; device idle / nothing sent |
| REQUESTED | 1 | `is-requested` | ◐ | `mc.e.op_state.requested` | Operator just issued a command; not yet acknowledged by the server |
| PENDING | 2 | `is-pending` | ◓ | `mc.e.op_state.pending` | Command accepted/delivered, awaiting device confirmation |
| CONFIRMED | 3 | `is-ok` | ● | `mc.e.op_state.confirmed` | Device reported state matching the command |
| FAILED | 4 | `is-error` | ✕ | `mc.e.op_state.failed` | Command rejected, timed out, or device reported an error |
| OFFLINE | 5 | `is-offline` | ⊘ | `mc.e.op_state.offline` | Device unreachable; commands may queue but cannot confirm |
| STALE | 6 | `is-stale` | ◷ | `mc.e.op_state.stale` | Snapshot revision gap / no confirmation within tolerance |

Higher rank = more attention-worthy. When a surface has multiple signals, `highestState()` surfaces the highest-rank state (e.g. OFFLINE outranks a prior FAILED because a failed command is not actionable while the device is down).

## Derivation (no invention)

Each state maps to concrete signals already present in the authoritative room contract (`server/lib/room-snapshot.js`):

| Signal | Maps to | Source |
|---|---|---|
| `display.status !== 'online'` | OFFLINE | `confirmedState.displays[].status` (`room-snapshot.js:331-378`) |
| pending command `status==='failed'` or `ok===false` | FAILED | `pendingCommands[]` (`:34-40`, `:520-577`) |
| pending command `status==='timeout'` | STALE | ack sweep (`command-model.js:410-438`) |
| pending command `status==='sent'/'requested'/'queued'` | PENDING | `command_logs` (`:116-186`) |
| `display.contentId`/`contentType` present, no pending | CONFIRMED | `confirmedState.displays` |
| else | STANDBY | — |
| production `error` | FAILED | `recordingState`/`streamState` (`:156-175`) |
| production `stale===true` | STALE | — |
| production `active && !reachable` | STALE | — |
| production `active && reachable` | CONFIRMED | — |
| production `available===false` | OFFLINE | — |

## Invariants enforced by the store

`frontend/js/state/operator-store.js` (derives from the existing revision-aware `room-state-store.js`):

- **Newer revisions replace older** — delegated to the shared store (`room-state-store.js:53-68`).
- **Duplicate revisions are idempotent** — same revision + newer `serverTimestamp` only (`:56-63`).
- **Older events are rejected** (`:53-54`).
- **Revision gaps request a complete snapshot** — `onGap` → `requestAuthoritativeRoomSnapshot` (`socket.js:30-39`, `:85-89`).
- **Reconnect replaces stale local state** — `roomState.reset()` on identity change (`socket.js:48-54`); the operator store re-derives on the next snapshot.
- **Pending commands stay visibly pending until acknowledged** — `trackLocalCommand`/`resolveLocalCommand` (`operator-store.js`).
- **Failed commands never appear confirmed** — `displayOperatorState` checks `failed` before any content check.
- **Another user's changes update every open controller immediately** — the shared `roomState` store fans to all subscribers; the operator store re-derives.
- **Podium and web derive UI from the same store** — components take the injected store; no per-surface state.

## Visualization

Each chip renders `<span class="mc-e-state-chip is-{tone}" data-op-state="{state}" role="status"><span class="glyph">…</span><span class="text">{label}</span></span>`. CSS (`operator-console.css`) supplies the tone color; the glyph + text guarantee legibility without color.

## Mock vs real

The vocabulary is pure (no IO) and fully unit-tested (`server/test/ui-contract/operator-state.test.js`). The derivation is exercised against mock snapshots in `operator-store.test.js` and against the live DOM in the Playwright harness (`tests/workflow.spec.js`).
