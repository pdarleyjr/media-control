# Repo Decision: MBFD Five Display Kiosk

## Decision
Create a separate private repository for the room-specific Windows launcher:

- `mbfd-five-display-kiosk`

## Why separate
- The kiosk is Windows-only and Electron-based.
- It needs its own packaging, startup, watchdog, and recovery path.
- It should not be coupled to the shared Media Control deployment lifecycle.
- Keeping it separate reduces the risk of accidental regressions in the production web app.

## What stays in `media-control`
- Shared device pairing and player behavior.
- Device and group management for all rooms.
- Legacy classroom analysis and migration notes.
- Any minimal, shared server changes that help the kiosk without changing normal Media Control behavior.

## What belongs in the kiosk repo
- Electron main process and window manager.
- Per-TV partition/profile management.
- Windows startup, watchdog, healthcheck, and audio enforcement scripts.
- Local config, logs, and recovery runbooks.
- Room-specific launcher behavior for Classroom 1.

## Operational note
The shared Media Control app remains the source of truth for every other device and room. The kiosk repo only customizes the Classroom 1 room appliance behavior.
