#!/usr/bin/env bash
# MBFD Kamrui media-edge installer. Idempotent. Run as a user with sudo.
# Provisions MediaMTX (Docker), FFmpeg relays, camera-control API, least-privilege
# sudo helper, and firewall rules from this committed source tree.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE=/etc/mbfd/media-stack/camera.env
STACK=/opt/mbfd/media-stack

echo "==> prerequisites"
sudo apt-get update -qq
sudo apt-get install -y -qq ffmpeg rsync curl ca-certificates
curl -fsSL https://get.docker.com | sudo sh

echo "==> stack directory"
sudo mkdir -p "$STACK/camera-api" /etc/mbfd/media-stack /mnt/data/recordings/{active,completed,failed,metadata}
if ! getent group mbfd-recording >/dev/null; then
  sudo groupadd --system mbfd-recording
fi
if ! getent passwd mbfd-recording >/dev/null; then
  sudo useradd --system --gid mbfd-recording --home-dir /nonexistent --shell /usr/sbin/nologin mbfd-recording
fi
sudo chown -R "$USER:mbfd-recording" "$STACK" /mnt/data/recordings
sudo chmod 2770 /mnt/data/recordings /mnt/data/recordings/{active,completed,failed,metadata}

echo "==> camera-api source"
cp "$HERE/camera-api/server.js" "$HERE/camera-api/recording-safety.js" \
  "$HERE/camera-api/recording-supervisor.js" "$HERE/camera-api/docker-recording-runtime.js" \
  "$HERE/camera-api/camera-service-signature.js" \
  "$HERE/camera-api/peertube-upload.js" "$HERE/camera-api/package.json" \
  "$HERE/camera-api/package-lock.json" "$STACK/camera-api/"
( cd "$STACK/camera-api" && npm ci --omit=dev --no-audit --no-fund )

echo "==> MediaMTX config (template -> live, creds from env, mode 0600)"
cp "$HERE/mediamtx.yml.tpl" "$STACK/mediamtx.yml.tpl"
cp "$HERE/docker-compose.mediamtx.yml" "$STACK/docker-compose.mediamtx.yml"
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a
sed -e "s|__ANNKE_MAIN_RTSP_URL__|${ANNKE_MAIN_RTSP_URL}|g" \
    -e "s|__ANNKE_PREVIEW_RTSP_URL__|${ANNKE_PREVIEW_RTSP_URL}|g" \
    "$STACK/mediamtx.yml.tpl" > "$STACK/mediamtx.yml"
chmod 600 "$STACK/mediamtx.yml"

echo "==> relay scripts (credential-free)"
cp "$HERE/annke-main-relay.sh" "$HERE/annke-preview-relay.sh" "$STACK/"
chmod +x "$STACK/annke-main-relay.sh" "$STACK/annke-preview-relay.sh"

echo "==> systemd units"
for u in mbfd-annke-main-relay mbfd-annke-preview-relay mbfd-camera-api; do
  sudo cp "$HERE/systemd/$u.service" /etc/systemd/system/
done
sudo cp "$HERE/systemd/mbfd-camera-recording@.service" /etc/systemd/system/
sudo install -o root -g root -m 0755 "$HERE/scripts/mbfd-camera-recording-run" /usr/local/libexec/mbfd-camera-recording-run
sudo install -o root -g root -m 0755 "$HERE/mbfd-recording-admin" /usr/local/sbin/mbfd-recording-admin
sudo install -o root -g root -m 0644 "$HERE/tmpfiles.d/mbfd-camera-recording.conf" /etc/tmpfiles.d/mbfd-camera-recording.conf
sudo systemd-tmpfiles --create /etc/tmpfiles.d/mbfd-camera-recording.conf
echo "peter ALL=(root) NOPASSWD: /usr/local/sbin/mbfd-recording-admin *" | sudo tee /etc/sudoers.d/mbfd-recording-admin >/dev/null
sudo chmod 0440 /etc/sudoers.d/mbfd-recording-admin
sudo visudo -cf /etc/sudoers.d/mbfd-recording-admin
sudo install -d -o peter -g peter -m 0755 "$STACK/scripts"
sudo install -o peter -g peter -m 0755 "$HERE/scripts/user-long-recording-test.sh" "$STACK/scripts/user-long-recording-test.sh"
sudo systemctl daemon-reload

echo "==> least-privilege admin helper"
sudo install -o root -g root -m 0755 "$HERE/mbfd-media-admin" /usr/local/sbin/mbfd-media-admin
echo "peter ALL=(root) NOPASSWD: /usr/local/sbin/mbfd-media-admin" | sudo tee /etc/sudoers.d/mbfd-media-admin >/dev/null
sudo chmod 0440 /etc/sudoers.d/mbfd-media-admin
sudo visudo -cf /etc/sudoers.d/mbfd-media-admin

echo "==> firewall (deny default; SSH from Tailscale+LAN; media ports GMKtec-only)"
sudo /usr/local/sbin/mbfd-media-admin ufw-apply

echo "==> enable + start"
sudo systemctl enable --now mbfd-camera-api mbfd-annke-main-relay mbfd-annke-preview-relay
( cd "$STACK" && docker compose -f docker-compose.mediamtx.yml up -d )

echo "==> install complete. Verify with: scripts/upgrade.sh status"
