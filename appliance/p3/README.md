# P3 Room Appliance (Windows)

Repo-side appliances for the Lenovo P3 classroom control box. See
`planning/command-center/P3_ROOM_AGENT.md` for the full model. This directory is
**code + runbooks only** — on-box execution (install, secrets, audio tuning)
is by the owner; nothing here commits a real token.

## Layout
- `room-agent/` — Node Socket.IO client (`agent.js`) + asset sync worker
  (`sync-worker.js`). Ships its own `package.json` (`socket.io-client`,
  `better-sqlite3`).
- `audio/` — `audio-enforce.ps1` (idempotent default-device setter),
  `audio-watchdog.ps1` (60s loop + backoff), `audio-restore.ps1` (rollback).
- `network-enforce.ps1` / `network-watchdog.ps1` — wired-first policy that
  disables Wi-Fi when Ethernet is active and keeps the P3 on the LAN uplink.
- `kiosk-launcher.ps1` — launches N `/player/managed` windows (replaces the
  legacy `FiveDisplayKiosk`; non-TV1 windows started with `--mute`).
- `healthcheck.ps1` — prints `{players, audio, network, agent}` JSON for watchdogs.
- `config.example.json` — placeholders only. Copy to `config.local.json`
  (gitignored) and populate on-box.
- `install/update.ps1` — registers `MBFD_RoomAgent` + `MBFD_AudioEnforce`
  Scheduled Tasks.

## Install / update
1. `cd appliance/p3/room-agent && npm install --omit=dev`
2. Copy `config.example.json` -> `config.local.json`; fill `MC_NODE_TOKEN`,
   `deviceId`/`deviceToken`, etc. on-box. **Never commit `config.local.json`.**
3. From an elevated prompt: `powershell -ExecutionPolicy Bypass -File
   appliance\p3\install\update.ps1`. Creates the Scheduled Tasks and starts them
   (including the wired-first network watchdog).

## Env (read by `agent.js`)
| Env | Default | Notes |
|-----|---------|-------|
| `MC_SERVER_LAN_URL` | `http://gmktec.local:8096` | Preferred wired LAN origin when the box is on the same switch |
| `MC_SERVER_URL` | `http://100.81.154.123:8096` | Tailnet fallback origin |
| `MC_NODE_TOKEN` | — | per-node secret (REQUIRED, gitignored) |
| `MC_NODE_ID` | — | node id (REQUIRED) |
| `MC_SOFTWARE_VERSION` | `p3-agent-1.0.0` | surfaced in heartbeat |
| `MC_ACTIVE_DISPLAYS` | — | comma list, e.g. `TV1,TV2,TV3,TV4,TV5` |
| `MC_AUDIO_ENDPOINT` | `eARC` | Ultimea/eARC endpoint name |
| `MBFD_ROOM_AGENT_CACHE_DIR` | `C:\MBFD\RoomAgent` | cache root |
| `MBFD_ROOM_AGENT_CACHE_Q` | `60G` | LRU quota |

## Troubleshooting
- **Agent not connecting**: confirm Ethernet is up, the LAN hostname resolves,
  and `MC_SERVER_LAN_URL` or `MC_SERVER_URL` is reachable from the P3 (`curl
  http://gmktec.local:8096` or the configured fallback). Check Task Scheduler
  history for `MBFD_RoomAgent` and `MBFD_NetworkEnforce`.
- **Audio wrong device**: optionally `Install-Module AudioDeviceCmdlets -Scope
  CurrentUser` so `audio-enforce.ps1` can actually switch defaults. Without it the
  script logs the chosen endpoint but cannot change it (graceful degradation).
- **Restart loop**: agent emits stack traces to Task Scheduler output; the 60s
  watchdog restart re-attempts with exponential backoff.
- **Firewall**: Windows Firewall stays ENABLED (constraint). Do not disable it;
  the agent only needs outbound LAN access to the GMKtec host.

## Secrets handling
`config.local.json`, `.env`, `cache/`, `manifests/`, `logs/`, `backups/` are
gitignored (see `.gitignore`). No real `device_token` / `node_token` / RTMP key
lives in any committed file — only the example placeholder.

## Read-through content cache (classroom-only, fallback-safe)

`cache-agent.js` + `cache-server.js` give the classroom video walls a LOCAL copy
of broadcast media so playback loads from the P3, not the server. It is a
read-through proxy: a cache miss transparently streams from the origin and is
saved for next time, so the walls keep playing even before the cache is warm.
The web player also auto-falls back from a local `asset_url` to the server
`/api/content/:id/file`, so a down/cold cache can never blank a wall.

Only `socket.io-client` is required (no native build). On-box install:
1. Portable Node lives at `C:\MBFD\node\...\node.exe` (`node-path.txt` records it).
2. Agent files in `C:\MBFD\RoomAgent\` (`cache-server.js`, `cache-agent.js`,
   `common-loader.js`, `package.json`) and shared runtime modules in
   `C:\MBFD\common\` (`server-url.js`, `network-state.js`); run
   `npm install --omit=dev` in `C:\MBFD\RoomAgent`.
3. `run-agent.cmd` sets env and launches the agent; a Scheduled Task
   `MBFD_RoomCacheAgent` runs it as SYSTEM at startup.

Env (read by `cache-agent.js`):
| Env | Example | Notes |
|-----|---------|-------|
| `MC_SERVER_LAN_URL` | `http://gmktec.local:8096` | preferred wired origin to proxy/pre-warm from |
| `MC_SERVER_URL` | `http://100.81.154.123:8096` | fallback origin to proxy/pre-warm from |
| `MC_NODE_ID` | `classroom-1-p3` | node id (matches server logs) |
| `MC_NODE_TOKEN` | — | must equal server `CLASSROOM_LOCAL_CACHE_NODE_TOKEN` |
| `MC_AGENT_PORT` | `8097` | loopback HTTP port the player windows fetch from |
| `MBFD_ROOM_AGENT_CACHE_DIR` | `C:\MBFD\RoomAgent` | cache root (`cache\content\<id>`) |

Server side (GMKtec `.env`): `CLASSROOM_LOCAL_CACHE_ENABLED=true`,
`CLASSROOM_LOCAL_CACHE_BASE=http://127.0.0.1:8097`,
`CLASSROOM_LOCAL_CACHE_WALL_IDS=<primary>,<secondary>`,
`CLASSROOM_LOCAL_CACHE_NODE_TOKEN=<secret>`. Only displays in those walls get the
local URL; every other display/room is unaffected. Health check on-box:
`curl http://127.0.0.1:8097/healthz`.
