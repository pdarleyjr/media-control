#!/usr/bin/env bash
# Idempotent install/update of the Kamrui podium room-agent as a systemd unit
# (mbfd-console-agent.service) under /opt/mbfd/room-agent/. Templated from the
# existing ops/podium/mbfd-console.service pattern. Safe to re-run after a
# `git pull` to pick up new agent.js / sync-worker.js.
#
# Secrets live ONLY in /etc/mbfd/media-control-console/config.env (mode 0600,
# gitignored). This script never writes a token to disk.
set -euo pipefail

DEST_DIR="/opt/mbfd/room-agent"
SERVICE_SRC="$(dirname "$0")/../systemd/mbfd-console-agent.service"
SERVICE_DST="/etc/systemd/system/mbfd-console-agent.service"
SERVICE_NAME="mbfd-console-agent.service"
KIOSK_USER="${MBFD_KIOSK_USER:-mbfdkiosk}"

echo "podium agent install: target=$DEST_DIR user=$KIOSK_USER"

# Ensure the kiosk user exists (no login shell).
if ! id -u "$KIOSK_USER" >/dev/null 2>&1; then
  echo "creating user $KIOSK_USER"
  useradd --system --no-create-home --shell /usr/sbin/nologin "$KIOSK_USER"
  usermod -aG video,input "$KIOSK_USER" || true
fi

# Stage the agent code (this repo subtree) under the service dir.
mkdir -p "$DEST_DIR" "$DEST_DIR/cache/assets" "$DEST_DIR/cache/thumbnails" "$DEST_DIR/manifests" "$DEST_DIR/logs"
SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)/room-agent"
if [ -f "$SCRIPT_DIR/agent.js" ]; then
  cp -f "$SCRIPT_DIR/agent.js" "$DEST_DIR/agent.js"
  cp -f "$SCRIPT_DIR/sync-worker.js" "$DEST_DIR/sync-worker.js"
  cp -f "$SCRIPT_DIR/package.json" "$DEST_DIR/package.json"
  echo "staged agent code -> $DEST_DIR"
else
  echo "WARN: $SCRIPT_DIR/agent.js not found; running against whatever is already staged."
fi

# Install node deps for the agent (socket.io-client + better-sqlite3) if npm is available.
if command -v npm >/dev/null 2>&1; then
  (cd "$DEST_DIR" && npm install --omit=dev --no-audit --no-fund) || echo "WARN: npm install failed (non-fatal); agent may degrade to stateless mode."
else
  echo "WARN: npm not on PATH; agent dependencies not installed."
fi

# Make the cache tree writable by the kiosk user.
chown -R "$KIOSK_USER":"$KIOSK_USER" "$DEST_DIR" || true
chmod -R u+rwX "$DEST_DIR" || true

# Install + reload the systemd unit.
if [ -f "$SERVICE_SRC" ]; then
  cp -f "$SERVICE_SRC" "$SERVICE_DST"
  echo "installed unit -> $SERVICE_DST"
else
  echo "ERROR: service unit not found at $SERVICE_SRC"; exit 3
fi
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null 2>&1 || true
systemctl restart "$SERVICE_NAME" || systemctl start "$SERVICE_NAME" || true
echo "service $SERVICE_NAME: $(systemctl is-active "$SERVICE_NAME" 2>/dev/null || echo unknown)"

cat <<'NOTE'
Secrets handling:
  Place node credentials in /etc/mbfd/media-control-console/config.env (mode 0600), e.g.:
    MC_NODE_ID=podium-1
    MC_NODE_TOKEN=<SECRET — populate on-box only; never commit>
    MC_SERVER_URL=http://100.81.154.123:8096
  The systemd unit reads them via EnvironmentFile=-/etc/mbfd/.../config.env.
  NEVER commit a real token to this repo; example files only.
NOTE