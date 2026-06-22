# MBFD Hand-Appliance Fleet (repo-side)

Repo-side code + runbooks for the managed classroom appliances. These directories
are **committed code only** — on-box install, secrets, and tuning are by the
owner. **No real token / device id / RTMP key is ever committed**; every secrets
file is an example placeholder, and every real config lives in a gitignored
`config.local.json` / `config.env` on the box.

Why a separate tree (not `ops/`): appliances ship their own `package.json`
(`socket.io-client` + `better-sqlite3`) independent of the server bundle, so
they can be staged to a box and `npm install`d standalone.

## Layout
- `p3/`      — Lenovo P3 (Windows 11) room-agent + audio enforcement + kiosk launcher.
  - `room-agent/`   Node Socket.IO client + asset sync worker (own `package.json`).
  - `audio/`         `audio-enforce.ps1` / `audio-watchdog.ps1` / `audio-restore.ps1`.
  - `kiosk-launcher.ps1`, `healthcheck.ps1`, `install/update.ps1`, `config.example.json`, `README.md`.
- `podium/`  — Kamrui Linux podium room-agent (mirror of P3 minus audio) + Electron.
  - `room-agent/`   Node Socket.IO client + asset sync worker + loopback cache probe.
  - `systemd/`      `mbfd-console-agent.service`.
  - `install/update/install.sh`, `config.example.json`, `README.md`.
- `electron/` — thin Kamrui kiosk shell (Command Center + `mcmedia://` resolver
  + offline reconnect screen). NOT a full Electron app — just `main.js` /
  `preload.js` / `offline-fallback/`.

## Where secrets live (on-box, NEVER committed)
- **P3**:     `appliance/p3/room-agent/config.local.json` (gitignored) + Scheduled-Task env.
- **Podium**: `/etc/mbfd/media-control-console/config.env` (mode 0600, gitignored).
- **Backfill reports**: `backfill-report-*.json` (gitignored, written to cwd).

See `planning/command-center/P3_ROOM_AGENT.md`, `KAMRUI_ROOM_AGENT.md`,
`ASSET_SYNC_ARCHITECTURE.md`, and `BACKFILL_EXISTING_MEDIA.md` for the model.