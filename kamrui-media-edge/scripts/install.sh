#!/usr/bin/env bash
# MBFD Kamrui media-edge installer. Idempotent. Run as a user with sudo.
# Provisions MediaMTX (Docker), FFmpeg relays, camera-control API, root-owned
# recording broker (peer-verified Unix socket), and firewall rules from this
# committed source tree.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE=/etc/mbfd/media-stack/camera.env
STACK=/opt/mbfd/media-stack
RECORDING_ROOT=/mnt/data/recordings

echo "==> prerequisites"
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg rsync curl ca-certificates python3
# Do NOT curl-pipe the Docker convenience installer as root.  Require a
# verified, pre-existing Docker installation or fail closed.
if ! command -v docker >/dev/null 2>&1; then
  echo "ERROR: Docker is required but not installed." >&2
  echo "Install Docker Engine via the official apt repository:" >&2
  echo "  sudo apt-get install -y docker.io docker-compose-v2" >&2
  echo "Or follow https://docs.docker.com/engine/install/ubuntu/" >&2
  exit 1
fi

echo "==> dedicated service users and groups"
if ! getent group mbfd-recording >/dev/null; then
  sudo groupadd --system mbfd-recording
fi
if ! getent passwd mbfd-recording >/dev/null; then
  sudo useradd --system --gid mbfd-recording --home-dir /nonexistent --shell /usr/sbin/nologin mbfd-recording
fi
if ! getent group mbfd-camera-api >/dev/null; then
  sudo groupadd --system mbfd-camera-api
fi
if ! getent passwd mbfd-camera-api >/dev/null; then
  sudo useradd --system --gid mbfd-camera-api --home-dir /nonexistent --shell /usr/sbin/nologin mbfd-camera-api
fi
# Enforce supplemental access on every run, including hosts where the account
# was created by an earlier partial deployment.
sudo usermod -aG mbfd-recording mbfd-camera-api

echo "==> stack directory"
sudo mkdir -p "$STACK/camera-api" /etc/mbfd/media-stack
sudo install -d -o mbfd-camera-api -g mbfd-recording -m 2770 \
  "$RECORDING_ROOT" "$RECORDING_ROOT/active" "$RECORDING_ROOT/completed" \
  "$RECORDING_ROOT/failed" "$RECORDING_ROOT/metadata"
# Preserve every existing artifact and its owner while granting the dedicated
# API and recorder group the access legacy peter-owned 0600 files lacked.
sudo find "$RECORDING_ROOT" -xdev -type d \
  -exec chgrp mbfd-recording {} + \
  -exec chmod u+rwx,g+rwx,g+s {} +
sudo find "$RECORDING_ROOT" -xdev -type f \
  -exec chgrp mbfd-recording {} + \
  -exec chmod u+rw,g+rw {} +

echo "==> protected camera environment"
sudo chown root:mbfd-camera-api "$ENV_FILE"
sudo chmod 0640 "$ENV_FILE"

echo "==> camera-api source"
sudo cp "$HERE/camera-api/server.js" "$HERE/camera-api/recording-safety.js" \
  "$HERE/camera-api/recording-supervisor.js" "$HERE/camera-api/docker-recording-runtime.js" \
  "$HERE/camera-api/camera-service-signature.js" "$HERE/camera-api/livestream-audit.js" \
  "$HERE/camera-api/peertube-upload.js" "$HERE/camera-api/package.json" \
  "$HERE/camera-api/package-lock.json" "$STACK/camera-api/"
sudo chown -R mbfd-camera-api:mbfd-camera-api "$STACK/camera-api"
( cd "$STACK/camera-api" && sudo -u mbfd-camera-api npm ci --omit=dev --no-audit --no-fund )

echo "==> MediaMTX config (template -> live, creds from env, mode 0600)"
sudo install -o root -g root -m 0644 "$HERE/mediamtx.yml.tpl" "$STACK/mediamtx.yml.tpl"
sudo install -o root -g root -m 0644 "$HERE/docker-compose.mediamtx.yml" "$STACK/docker-compose.mediamtx.yml"
sudo /usr/bin/python3 "$HERE/scripts/render-mediamtx-config.py" \
  "$ENV_FILE" "$STACK/mediamtx.yml.tpl" "$STACK/mediamtx.yml"

echo "==> relay scripts (credential-free)"
sudo install -o root -g root -m 0755 "$HERE/annke-main-relay.sh" "$STACK/annke-main-relay.sh"
sudo install -o root -g root -m 0755 "$HERE/annke-preview-relay.sh" "$STACK/annke-preview-relay.sh"

echo "==> recording broker (root-owned, peer-verified Unix socket)"
sudo install -o root -g root -m 0755 "$HERE/recording-broker/mbfd-recording-broker.py" /usr/local/sbin/mbfd-recording-broker
sudo install -o root -g root -m 0644 "$HERE/systemd/mbfd-recording-broker.socket" /etc/systemd/system/
sudo install -o root -g root -m 0644 "$HERE/systemd/mbfd-recording-broker.service" /etc/systemd/system/
sudo install -o root -g root -m 0644 "$HERE/tmpfiles.d/mbfd-recording-broker.conf" /etc/tmpfiles.d/mbfd-recording-broker.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/mbfd-recording-broker.conf

echo "==> systemd units"
for u in mbfd-annke-main-relay mbfd-annke-preview-relay mbfd-camera-api; do
  sudo cp "$HERE/systemd/$u.service" /etc/systemd/system/
done
sudo cp "$HERE/systemd/mbfd-camera-recording@.service" /etc/systemd/system/
sudo install -o root -g root -m 0755 "$HERE/scripts/mbfd-camera-recording-run" /usr/local/libexec/mbfd-camera-recording-run
sudo install -o root -g root -m 0644 "$HERE/tmpfiles.d/mbfd-camera-recording.conf" /etc/tmpfiles.d/mbfd-camera-recording.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/mbfd-camera-recording.conf
# Keep the recording-admin helper for the operator's long-test harness (status
# only).  The camera API does NOT use this helper — it uses the broker socket.
# Remove any stale wildcard sudoers rule from prior installs.
sudo rm -f /etc/sudoers.d/mbfd-recording-admin
# Narrow, read-only operator rule: only the status action with a ses_ prefix.
echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/mbfd-recording-admin status ses_*" | sudo tee /etc/sudoers.d/mbfd-recording-admin >/dev/null
sudo chmod 0440 /etc/sudoers.d/mbfd-recording-admin
sudo visudo -cf /etc/sudoers.d/mbfd-recording-admin
sudo install -o root -g root -m 0755 "$HERE/mbfd-recording-admin" /usr/local/sbin/mbfd-recording-admin
sudo install -d -o mbfd-camera-api -g mbfd-camera-api -m 0755 "$STACK/scripts"
sudo install -o mbfd-camera-api -g mbfd-camera-api -m 0755 "$HERE/scripts/user-long-recording-test.sh" "$STACK/scripts/user-long-recording-test.sh"
sudo systemctl daemon-reload

echo "==> least-privilege media admin helper (operator use only)"
sudo install -o root -g root -m 0755 "$HERE/mbfd-media-admin" /usr/local/sbin/mbfd-media-admin
echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/mbfd-media-admin" | sudo tee /etc/sudoers.d/mbfd-media-admin >/dev/null
sudo chmod 0440 /etc/sudoers.d/mbfd-media-admin
sudo visudo -cf /etc/sudoers.d/mbfd-media-admin

echo "==> firewall (deny default; SSH from Tailscale+LAN; media ports GMKtec-only)"
sudo /usr/local/sbin/mbfd-media-admin ufw-apply

echo "==> enable + start broker and services"
sudo systemctl enable --now mbfd-recording-broker.socket
sudo systemctl enable --now mbfd-camera-api mbfd-annke-main-relay mbfd-annke-preview-relay
( cd "$STACK" && docker compose -f docker-compose.mediamtx.yml up -d )

echo "==> install complete. Verify with: scripts/upgrade.sh status"
