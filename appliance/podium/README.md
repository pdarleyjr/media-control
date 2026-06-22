# Kamrui Podium Room Appliance (Linux)

Repo-side agent for the Kamrui mini-PC podium. Linux sibling of the P3
room-agent **minus audio enforcement** (the podium sends no audio path; the
Electron shell handles its own UI). See `planning/command-center/KAMRUI_ROOM_AGENT.md`.

## Layout
- `room-agent/` — Node Socket.IO client (`agent.js`) + asset sync worker
  (`sync-worker.js`). Its own `package.json` deps: `socket.io-client`,
  `better-sqlite3`. `agent.js` ALSO runs a loopback HTTP probe (`127.0.0.1:8097`)
  exposing `/asset-available?sha256=<hex>` + `/asset?sha256=<hex>` so the
  Electron preload bridge can ask "is this asset cached locally?" for
  `mcmedia://` fallback. Exports `localAssetResolver(sha)` for in-process use.
- `systemd/mbfd-console-agent.service` — systemd unit (`After=network-online.target`,
  `Restart=on-failure`, `User=mbfdkiosk`).
- `install/update/install.sh` — idempotent install under `/opt/mbfd/room-agent/`.
- `config.example.json` — placeholders only. Real values go in
  `/etc/mbfd/media-control-console/config.env` (gitignored, mode 0600).

## Install / update
```
sudo bash appliance/podium/install/update/install.sh
```
This stages `agent.js`/`sync-worker.js`/`package.json` into
`/opt/mbfd/room-agent/`, runs `npm install --omit=dev`, installs +
`systemctl enable --now` the `mbfd-console-agent.service` unit.

## Env (read by `agent.js`, via config.env)
| Env | Default | Notes |
|-----|---------|-------|
| `MC_SERVER_URL` | `http://100.81.154.123:8096` | GMKtec Tailnet origin |
| `MC_NODE_TOKEN` | — | per-node secret (REQUIRED, gitignored) |
| `MC_NODE_ID` | — | node id (REQUIRED) |
| `MC_NODE_TYPE` | `podium` | surfaced in heartbeat (no `audio_endpoint`) |
| `MC_AGENT_PORT` | `8097` | loopback cache-probe port (127.0.0.1 only) |
| `MBFD_ROOM_AGENT_CACHE_DIR` | `/opt/mbfd/room-agent` | cache root |
| `MBFD_ROOM_AGENT_CACHE_Q` | `60G` | LRU quota |

## Troubleshooting
- **Service not active**: `systemctl status mbfd-console-agent` then
  `journalctl -u mbfd-console-agent -n 100`.
- **No node deps**: `cd /opt/mbfd/room-agent && sudo -u mbfdkiosk npm install
  --omit=dev` (the agent degrades to stateless mode without `better-sqlite3`).
- **Loopback probe blocked**: confirm nothing else is bound on `127.0.0.1:8097`;
  override with `MC_AGENT_PORT`.

## Secrets handling
Real values live ONLY in `/etc/mbfd/media-control-console/config.env` (mode 0600,
gitignored). No real `node_token` / `RTMP key` / endpoint token appears in any
committed file — the committed `config.example.json` carries placeholders only.