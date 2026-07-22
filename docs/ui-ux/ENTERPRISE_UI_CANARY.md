# Enterprise UI Canary Procedure

> **Post-class only.** Do NOT execute any step in this document during an active
> class, presentation, stream, or recording.

## Prerequisites

1. No active classroom presentation.
2. No active stream or recording.
3. The integrated branch `codex/enterprise-operator-ux-integration-20260722`
   has been pushed, merged, and deployed.
4. The existing Media Control interface is confirmed working.
5. `ENTERPRISE_OPERATOR_UI_ENABLED` is OFF (default).

## Canary Sequence

1. **Confirm no active classroom presentation** — check the podium and all displays are idle.
2. **Confirm no stream or recording** — check OBS and the live-stream status endpoint.
3. **Back up current Media Control release** — note the deployed commit SHA and keep the prior artifact available for rollback.
4. **Deploy integrated release candidate** — deploy the build that includes the enterprise operator console.
5. **Keep enterprise feature flag off** — verify `ENTERPRISE_OPERATOR_UI_ENABLED` is not set (or set to `false`).
6. **Verify existing interface** — load `#/control` in a browser; confirm the existing Media Control interface works identically.
7. **Enable enterprise UI for one authorized web user**:
   ```bash
   export ENTERPRISE_OPERATOR_UI_ENABLED=true
   export ENTERPRISE_OPERATOR_UI_USERS=<user-id-of-canary-operator>
   ```
   Restart the server (or reload config). Only the listed user ID can access the enterprise route.
8. **Verify room snapshot** — as the canary user, navigate to `#/operator-console`. Confirm the room overview loads with real display state from the room snapshot.
9. **Verify read-only room overview** — confirm display names, health, and aggregate state match the existing interface. Do NOT send any commands yet.
10. **Test one non-destructive layout preview** — select a layout card that is available for the current topology. Do NOT apply it to the classroom surface; use the Preview button only.
11. **Test PowerPoint controls** — if a slide deck is the active content, test next/previous slide. These are routine controls that do not require confirmation. Verify the display state updates (PENDING → CONFIRMED).
12. **Test video controls and classroom sound** — if video content is active, test play/pause. Verify the audio status block shows the real confirmed audio state (or "audio state unavailable" if the audio contract is not yet populated by the backend).
13. **Test screen-share audio state** — if screen share is active, verify the screen-share panel shows real diagnostics from the engine (or "diagnostics unavailable" if no engine).
14. **Verify second web client convergence** — open a second browser tab as the same or another authorized user. Confirm both tabs show the same confirmed room state. Make a change in one tab and verify it appears in the other without a refresh.
15. **Test podium through canary flag** — if the podium user is in the allowlist, load `#/operator-console` on the podium touchscreen. Verify no horizontal scrolling at the podium viewport (1280×800). Verify all touch targets are ≥44px. Do NOT make enterprise UI the default podium interface.
16. **Disable flag** — set `ENTERPRISE_OPERATOR_UI_ENABLED=false` and restart. Verify the enterprise nav item disappears and `#/operator-console` redirects to the existing `#/control` view.
17. **Verify old interface** — confirm the existing Media Control interface still works after the flag is disabled.
18. **Re-enable and continue only when all checks pass** — if any check fails, do NOT re-enable. File the issue and use the rollback procedure.

## Canary Abort Triggers

Abort immediately and roll back if any of the following occur:
- Blank screen on any display
- Module-load error in the browser console
- Stale room state that does not recover within 30 seconds
- Duplicate commands appearing in the pending queue
- Web/podium divergence in confirmed state
- Missing classroom sound state that was previously available
- Incorrect display targeting (content appears on the wrong display)
- Unauthorized control visible or executable
- Existing interface regression (`#/control` no longer works)
- Excessive browser CPU or memory on the podium

## Rollback

See `docs/ui-ux/ENTERPRISE_UI_ROLLBACK.md`.
