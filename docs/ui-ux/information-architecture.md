# Information Architecture — Enterprise Operator Console

One surface, one workflow, one state vocabulary. Internal concepts are never exposed to ordinary instructors.

## Top-level structure

```
#/operator-console
├── Room overview pane        (always-on, glanceable)
├── Workflow pane             (the guided steps)
│   ├── 1 Choose room
│   ├── 2 Choose layout       (visual diagram cards)
│   ├── 3 Choose content     (unified selector)
│   ├── Surface switch       (PREVIEW / CLASSROOM PROGRAM / LIVESTREAM PROGRAM)
│   ├── Send actions          (Preview / Send to classroom / Take to livestream)
│   └── Error surface        (structured recovery, never "something went wrong")
├── Playback pane            (context-sensitive per content type)
└── Screen-share pane        (diagnostics + explicit degraded-fallback label)
```

## Navigation model

- Single hash route `#/operator-console` (additive; existing routes untouched).
- No hidden actions behind gestures; every action is a labeled button with an icon **and** text for critical actions.
- Routine playback (next/prev) needs no confirmation; high-impact/destructive/public actions (send-to-classroom, take-to-livestream, replace active, stop all, clear, publish) require explicit confirmation.

## State hierarchy (single source: operator store → room snapshot)

- The operator store (`state/operator-store.js`) is the ONE projection the UI renders from.
- It derives from the existing shared `roomState` store — no competing source, no second socket.
- Every surface renders the same `OPERATOR_STATE` chips, so a glance at any pane conveys STANDBY/REQUESTED/PENDING/CONFIRMED/FAILED/OFFLINE/STALE identically.

## Podium / web parity

- Same components, three viewports (podium 1280×800, handheld-admin 480×800, desktop 1440×900) covered by the Playwright projects.
- 44px+ touch targets, visible focus, no hover-only controls, no horizontal scroll at podium resolution, color-independent status (glyph + text + tone).
- Responsive grid collapses to a single column ≤900px.

## Privacy model in IA

- Visibility is the default-narrowest (`private`); broadening requires explicit confirmation.
- In-use content shows a non-destructive-deletion guard.
