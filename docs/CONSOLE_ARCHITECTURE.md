# MBFD Media Control Console Architecture

## Purpose

The MBFD Media Control Console turns the Kamrui AK1 Plus and UPERFECT touchscreen into a dedicated classroom AV appliance. It is not plain Chrome kiosk mode. The user-facing shell is an Electron desktop application launched by Cage and systemd.

## Layers

1. Ubuntu LTS boots into a dedicated kiosk user/session.
2. systemd starts `mbfd-podium-agent.service` on localhost.
3. systemd starts `mbfd-console.service`, which launches Cage.
4. Cage launches the Electron app `mbfd-media-control-console`.
5. Electron loads `MBFD_CONSOLE_URL`, defaulting to `/console/classroom-1`.
6. The Media Control web app detects `/console/` path, starts a no-login console session as Guest, and routes into Command Center.

## Electron Shell

- App name: MBFD Media Control Console.
- Executable: `mbfd-media-control-console`.
- Fullscreen/kiosk with no frame, menu, URL bar, or browser chrome.
- Production context menu is disabled.
- Production DevTools are disabled unless `ENABLE_DEVTOOLS=true`.
- Navigation is allowlisted by `ALLOWED_HOSTS`.
- Remote content runs with `nodeIntegration=false`, `contextIsolation=true`, `sandbox=true`, and no webview tag.
- The Electron main process injects trusted console headers:
  - `X-MBFD-Room-Id`
  - `X-MBFD-Device-Id`
  - `X-MBFD-Device-Token` when configured
- Local splash/offline screens show boot and reconnect states before/after loading the remote route.

## No-Auth Guest Profile Mode

- Normal `/app` users still authenticate normally.
- The physical console route intentionally bypasses visible login.
- `/api/console/session` validates the optional device token and mints a normal dashboard JWT for the selected profile.
- On first console page load, the frontend requests profile `guest`.
- If Guest does not exist, the backend creates a `Guest` user with `auth_provider='console_guest'`, no password hash, and shared primary workspace membership.
- The console then uses the existing authenticated APIs and Socket.IO dashboard namespace with the minted JWT.

## Profile Dropdown

- `frontend/js/app.js` renders a fixed top console header only on `/console/*` routes.
- Header fields:
  - MBFD Media Control
  - Classroom 1
  - system status
  - network status
  - profile dropdown
  - current time
  - hidden long-press service target on the MBFD logo
- Profiles are loaded from `/api/console/session` and `/api/console/profiles`.
- Selecting a profile calls `/api/console/session` again with the selected profile and previous profile.
- The new JWT replaces the old JWT, the dashboard Socket.IO connection reconnects, and Command Center re-renders.
- Existing user-specific content, settings, files, playlists, and presentations load through the existing authenticated APIs.
- Profile switches are logged to `activity_log` with timestamp, device ID, room ID, previous profile, and selected profile.

## Podium Agent

- Service name: `mbfd-podium-agent.service`.
- Localhost API: `127.0.0.1:8755`.
- Required endpoints:
  - `GET /health`
  - `GET /device`
  - `GET /network`
  - `POST /app/restart`
  - `POST /device/reboot`
  - `GET /usb/status`
- Additional recovery endpoint:
  - `POST /kiosk/disable`
- The API rejects non-loopback clients.
- USB status is read-only; the agent does not mount, open, or execute USB content.
- USB import v1 lets the console list supported files from a connected USB drive, stage only selected files, and upload those selected files to the active profile's Media Control library.

## Kiosk and Recovery

- `mbfd-console.service` runs as `mbfdkiosk` with video/input/render groups.
- `mbfd-podium-agent.service` runs as root because restart/reboot/disable-kiosk are privileged local actions; it is loopback-only and systemd-hardened.
- Emergency recovery is available through SSH/Tailscale with `scripts/emergency-disable-kiosk.sh`.
- Electron hidden admin entry is a 5-second long press on the MBFD logo followed by `ADMIN_PIN`.

## Future Ubuntu Frame Path

Cage is the first implementation because it is simple, package-managed, and directly launches the Electron app. Ubuntu Frame remains a future hardening path if snap packaging and broader compositor management become preferable.
