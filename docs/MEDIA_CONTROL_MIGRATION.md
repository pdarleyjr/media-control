# Media Control Migration Plan for Classroom 1

## Current model
- Two legacy Classroom 1 video walls exist in production.
- The wall model is span-based and does not match the room's current five-TV wiring.
- Media Control already supports devices, groups, pairing, and per-device playback.
- Classroom wall membership is now locked at the wall-record level so the fixed classroom TVs keep their span/split behavior without drifting into other groups.

## Proposed model
- Five independent display clients:
  - Classroom 1 - Front Left
  - Classroom 1 - Front Center
  - Classroom 1 - Front Right
  - Classroom 1 - Side Left
  - Classroom 1 - Side Right
- Two room groups:
  - Classroom 1 Primary Wall
  - Classroom 1 Secondary Wall
- Optional all-displays group:
  - Classroom 1 All Displays

## Implementation approach
- Keep the shared Media Control app behavior intact for all other rooms.
- Use a separate Electron kiosk repo for Classroom 1.
- Let each kiosk window use its own persistent Electron partition so `rd_web_player` storage is isolated per TV.
- Use the existing player and pairing flow unless a future managed provisioning helper becomes necessary.
- Create room groups in Media Control first, then pair the five displays into those groups.
- Preserve the locked classroom wall rows as the fixed physical grouping surface for drag/drop, span, split, and calibration.

## Database changes
- Add the Classroom 1 groups.
- Pair/create five new device rows for the five TVs.
- Add `video_walls.is_locked` so the classroom wall memberships can stay fixed.
- Once the new kiosk is verified, optionally deprecate the old Classroom 1 wall labels, but do not remove their history until the user approves a destructive cutover.
- Do not delete the backup copy of the DB file.

## UI and API impact
- No broad shared-app UI rewrite is required.
- The dashboard should manage the five displays as normal devices and group them as standard Media Control device groups.
- Any future provisioning helper must remain admin-only and must not break the normal `/player` pairing flow.

## Rollback plan
- If the kiosk build fails, the backup DB file can be restored.
- If a single TV profile breaks, clear only that profile and re-pair that TV.
- If the kiosk launch loop fails, stop the startup/watchdog tasks and return the room to manual recovery.

## Test plan
- Confirm each TV window gets a unique device ID and token.
- Confirm each TV reconnects after kiosk restart and full machine reboot.
- Confirm the primary and secondary groups can be controlled independently.
- Confirm the old wall rows are no longer used once the new five-display setup is live.

## Notes
- This migration is intentionally additive first and destructive last.
- The shared Media Control app remains the canonical control surface for every other room.
