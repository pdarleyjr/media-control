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
- `kiosk-launcher.ps1` — launches N `/player/managed` windows (replaces the
  legacy `FiveDisplayKiosk`; non-TV1 windows started with `--mute`).
- `healthcheck.ps1` — prints `{players, audio, agent}` JSON for watchdogs.
- `config.example.json` — placeholders only. Copy to `config.local.json`
  (gitignored) and populate on-box.
- `install/update.ps1` — registers `MBFD_RoomAgent` + `MBFD_AudioEnforce`
  Scheduled Tasks.

## Install / update
1. `cd appliance/p3/room-agent && npm install --omit=dev`
2. Copy `config.example.json` -> `config.local.json`; fill `MC_NODE_TOKEN`,
   `deviceId`/`deviceToken`, etc. on-box. **Never commit `config.local.json`.**
3. From an elevated prompt: `powershell -ExecutionPolicy Bypass -File
   appliance\p3\install\update.ps1`. Creates the Scheduled Tasks and starts them.

## Env (read by `agent.js`)
| Env | Default | Notes |
|-----|---------|-------|
| `MC_SERVER_URL` | `http://100.81.154.123:8096` | GMKtec Tailnet origin |
| `MC_NODE_TOKEN` | — | per-node secret (REQUIRED, gitignored) |
| `MC_NODE_ID` | — | node id (REQUIRED) |
| `MC_SOFTWARE_VERSION` | `p3-agent-1.0.0` | surfaced in heartbeat |
| `MC_ACTIVE_DISPLAYS` | — | comma list, e.g. `TV1,TV2,TV3,TV4,TV5` |
| `MC_AUDIO_ENDPOINT` | `eARC` | Ultimea/eARC endpoint name |
| `MBFD_ROOM_AGENT_CACHE_DIR` | `C:\MBFD\RoomAgent` | cache root |
| `MBFD_ROOM_AGENT_CACHE_Q` | `60G` | LRU quota |

## Troubleshooting
- **Agent not connecting**: confirm Tailscale is up + `MC_SERVER_URL` reachable
  from the P3 (`curl http://100.81.154.123:8096`). Check Task Scheduler history
  for `MBFD_RoomAgent`.
- **Audio wrong device**: optionally `Install-Module AudioDeviceCmdlets -Scope
  CurrentUser` so `audio-enforce.ps1` can actually switch defaults. Without it the
  script logs the chosen endpoint but cannot change it (graceful degradation).
- **Restart loop**: agent emits stack traces to Task Scheduler output; the 60s
  watchdog restart re-attempts with exponential backoff.
- **Firewall**: Windows Firewall stays ENABLED (constraint). Do not disable it;
  the agent only needs outbound Tailnet.

## Secrets handling
`config.local.json`, `.env`, `cache/`, `manifests/`, `logs/`, `backups/` are
gitignored (see `.gitignore`). No real `device_token` / `node_token` / RTMP key
lives in any committed file — only the example placeholder.