# Kamrui Podium Electron Kiosk Shell (thin)

Locks the Kamrui mini-PC into a full-screen, no-login Command Center. The UI
itself is the SAME `#/control` page as the web app; this shell just provides a
hardened canvas + the `mcmedia://` local-asset resolver + an offline reconnect
screen. See `planning/command-center/KAMRUI_ROOM_AGENT.md`.

## What it does
- Boots `MC_COMMAND_CENTER_URL` (default `https://media-control.mbfdhub.com/app`)
  or — with `--offline-bundle=<dir>` — a baked local bundle (e.g. the bundled
  `offline-fallback/` reconnect screen).
- Registers `mcmedia://asset/<sha256>` as a privileged scheme. Resolution goes to
  the Kamrui room-agent cache at `/opt/mbfd/room-agent/cache/assets/<sha256>`,
  verifying its real SHA256 on demand + matching the filename; refuses to serve
  on any mismatch.
- Blocks `will-navigate` / window-open to any host outside the allowlist
  (the CC host, the wired LAN host when configured, GMKtec Tailnet fallback
  `100.81.154.123`, loopback).
- Hardened: `fullscreen:true`, `autoHideMenuBar`, `webPreferences.devtools:false`,
  no `nodeIntegration`, `contextIsolation:true`, `sandbox:true`.
- The renderer sees ONLY the `window.mcBridge` surface exposed by `preload.js`
  (`getReconnectState()`, `launchWhiteboard()`, `localAssetAvailable(sha)`).

## Run
```
cd appliance/electron && npm install
npm start                       # boots the remote Command Center
npm run offline                 # boots ./offline-fallback (reconnect screen)
node main.js --offline-bundle=./offline-fallback   # explicit bundle path
```

## Env
| Env | Default | Notes |
|-----|---------|-------|
| `MC_COMMAND_CENTER_LAN_URL` | `http://gmktec.local:8096/app` | preferred wired CC URL when the mini-server is on the same switch |
| `MC_COMMAND_CENTER_URL` | `https://media-control.mbfdhub.com/app` | remote CC URL fallback |
| `MC_ROOM_AGENT_ASSETS_DIR` | `/opt/mbfd/room-agent/cache/assets` | cache to resolve `mcmedia://` |
| `MC_AGENT_PORT` | `8097` | loopback probe port for `localAssetAvailable` |
| `MC_OFFLINE_BUNDLE` | — | baked bundle dir (also `--offline-bundle=`) |

## Secrets
The shell holds NO secrets — node cookies / tokens live in the media-control
session and/or on-box `config.env` consumed by the room-agent, NOT here. Only
placeholder example files are committed; no `.env`/`config.local.json` is
committed (see `.gitignore`).
