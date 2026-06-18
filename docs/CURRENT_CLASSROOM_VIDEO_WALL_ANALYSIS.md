# Current Classroom 1 Video Wall Analysis

Snapshot date: 2026-06-17

## Summary
The production Media Control database still contains the old Classroom 1 two-wall model, but the room has already been re-scoped for a five-TV appliance build.

The classroom wall records are now treated as locked walls so their member set stays fixed while Media Control still preserves span/split routing and drag/drop playback.

I backed up the live DB file before making any structural change:

- `/app/data/db/remote_display.db.bak-20260617-before-classroom-wall-removal`

I also created the new Classroom 1 device groups in the live DB:

- `Classroom 1 Primary Wall`
- `Classroom 1 Secondary Wall`
- `Classroom 1 All Displays`

## Legacy Classroom 1 walls

| Wall | Wall ID | Device ID | Grid | Layout | Player Rect | Playlist |
| --- | --- | --- | --- | --- | --- | --- |
| Classroom 1 Video Wall 1 | `5ca5c8d3-2d83-4e47-aa0c-075bd4d6a027` | `5f16d288-7271-4b53-b252-9537dd8611bf` | `3 x 1` | `span` | `-248, -118, 12372 x 2160` | `d9711554-cb3d-4b2e-9e07-0e151ed4a6d7` |
| Classroom 1 Video Wall 2 | `e4d9bb9c-30d8-4606-8c21-079fd36df369` | `f6b69a52-cbb7-4b52-b742-2520ca3e2037` | `2 x 1` | `span` | `0, 0, 8192 x 2160` | `e806d61c-7d8f-472c-9ba8-7db4c3f0fa5a` |

## Legacy wall member rows

| Wall | Device | Status | Canvas |
| --- | --- | --- | --- |
| Classroom 1 Video Wall 1 | `Classroom 1 Video Wall 1` | offline | `-248, -118, 12372 x 2160` |
| Classroom 1 Video Wall 2 | `Classroom 1 Video Wall 2` | offline | `0, 0, 8192 x 2160` |

## Classroom 1 devices currently in the live DB

| Device | Device ID | Status | Screen | Wall |
| --- | --- | --- | --- | --- |
| Classroom 1 Smartboard | `84ecb89a-afc4-426a-aa92-9fe126936604` | offline | `1280 x 720 @ 60` | none |
| Classroom 1 Video Wall 1 | `5f16d288-7271-4b53-b252-9537dd8611bf` | offline | `12372 x 2160 @ 60` | `5ca5c8d3-2d83-4e47-aa0c-075bd4d6a027` |
| Classroom 1 Video Wall 2 | `f6b69a52-cbb7-4b52-b742-2520ca3e2037` | offline | `8192 x 2160` | `e4d9bb9c-30d8-4606-8c21-079fd36df369` |

## Relevant playlists

| Playlist | Playlist ID | Status | Notes |
| --- | --- | --- | --- |
| `test` | `d9711554-cb3d-4b2e-9e07-0e151ed4a6d7` | published | Single text/html remote URL item |
| `Classroom 1 Video Wall 2 playlist` | `e806d61c-7d8f-472c-9ba8-7db4c3f0fa5a` | published | Single PowerPoint item |

## Layout and zone state

- Total layouts in the workspace: 9
- Template layouts: 7 platform templates
- Workspace-specific layouts:
  - `Video wall 2 screen 2 regions`
  - `laptop test — regions`
- Total layout zones in production: 19
- Zones on `laptop test — regions`: 2
- Zones on `Video wall 2 screen 2 regions`: 0

This means the legacy Classroom 1 walls were not using a current workspace layout-zone model. Their behavior came from the wall record and wall-member geometry.

## Schedules and groups

- `schedules`: 0
- `device_groups`: 0 before the Classroom 1 groups were added
- `device_group_members`: 0

There were no schedule-driven dependencies to migrate for the old walls.

## What should be preserved

- The backup copy of the DB file.
- The historical wall IDs, device IDs, and playlist IDs in this document.
- The content/item history embedded in the legacy playlist snapshot rows.
- The general wall/player rendering patterns in Media Control.
- The wall lock policy for the Classroom 1 wall rows so their membership does not drift.

## What should be migrated

- The room should move to five individual TV devices.
- The new room groups should be:
  - `Classroom 1 Primary Wall`
  - `Classroom 1 Secondary Wall`
- The launcher should use five separate Electron profiles so each TV is its own Media Control device.

## What should be deprecated

- `Classroom 1 Video Wall 1`
- `Classroom 1 Video Wall 2`

## What must not be deleted without a cutover

- The backup file above.
- Any shared Media Control behavior used by other rooms.
- The legacy wall history until the five-display kiosk is operational and verified.
