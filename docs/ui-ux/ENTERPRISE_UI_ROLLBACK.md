# Enterprise UI Rollback Procedure

> The enterprise UI rollback does NOT require database restoration (no schema
> change is involved). Two rollback options are available; use the fastest one
> for the situation.

## Option 1 — Immediate (Feature Flag)

Disable the enterprise operator UI without a redeploy:

```bash
export ENTERPRISE_OPERATOR_UI_ENABLED=false
# Restart the server (or send SIGHUP if config hot-reload is supported)
```

After this:
- The `#/operator-console` route redirects to the existing `#/control` view.
- The "Operator Console" nav item disappears.
- The existing Media Control interface is unaffected.
- The enterprise CSS/JS files remain on disk but are inert (the route gate
  prevents them from loading).

This is the preferred rollback for UI-only issues (layout bugs, accessibility
regressions, enterprise console errors).

## Option 2 — Release Rollback (Full Artifact Restore)

If the integrated release introduced a regression in the existing interface or
the server:

1. **Restore prior Media Control artifact** — deploy the previously backed-up
   build (the commit SHA noted before canary step 3).
2. **Restore prior service-worker/cache version** — the service worker version
   is bumped on each build. The prior version's cache will be activated on
   reload. If the service worker is stuck on the new version, users may need
   to:
   - Close all tabs of the Media Control URL.
   - Reopen — the service worker will fetch the prior version's cache.
   - If stuck, clear site data for the Media Control URL (Settings → Site
     Data → Clear) and reload.
3. **Verify existing interface** — load `#/control`; confirm it works.
4. **Verify podium** — confirm the podium kiosk loads the existing interface.
5. **Verify classroom content** — confirm displays show the correct content
   and the classroom audio is working.

## Rollback Triggers

Roll back immediately if ANY of the following occur:

| Trigger | Action |
|---|---|
| Blank screen on any display | Option 1 (flag off); if persistent, Option 2 |
| Module-load error in browser console | Option 1 |
| Stale room state (no recovery in 30s) | Option 1; investigate server |
| Duplicate commands in pending queue | Option 1 |
| Web/podium state divergence | Option 1 |
| Missing classroom sound state | Option 1; verify audio contract |
| Incorrect display targeting | Option 1 immediately |
| Unauthorized control visible or executable | Option 1 immediately; audit auth |
| Existing interface regression | Option 2 (full rollback) |
| Excessive browser CPU/memory on podium | Option 1; investigate enterprise CSS/JS |

## Service-Worker / Cache Transition

The enterprise UI adds new versioned assets under `/css/media-control-enterprise/`
and `/js/state/` and `/js/views/media-control-enterprise/`. The service worker
must cache these new assets and remove the old cache only after successful
activation. The transition:

1. **Old build loaded** — user has the existing service worker with the old
   cache version.
2. **New build deployed** — the service worker fetches the new version, installs
   the new cache (including enterprise assets), and activates after all tabs
   are closed or on the next reload.
3. **Enterprise assets load consistently** — the new cache includes all
   enterprise CSS/JS; there is no mixed old/new state.
4. **Rollback** — deploying the prior build restores the prior service worker
   version. The prior cache (without enterprise assets) is activated. Users do
   not need to manually clear browser storage unless the service worker is
   stuck (rare; see Option 2 step 2).

## Verification After Rollback

- [ ] Existing `#/control` route works
- [ ] Podium kiosk loads existing interface
- [ ] Classroom displays show correct content
- [ ] Classroom audio is working
- [ ] No enterprise console nav item visible
- [ ] `#/operator-console` redirects to `#/control`
- [ ] No browser console errors
