#!/usr/bin/env bash
# Upgrade the Kamrui media edge from this committed source tree (no secrets).
# Restarts services via the least-privilege admin helper.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STACK=/opt/mbfd/media-stack
ENV_FILE=/etc/mbfd/media-stack/camera.env
RECORDING_ROOT=/mnt/data/recordings

case "${1:-status}" in
  status)
    sudo /usr/local/sbin/mbfd-media-admin status
    echo "--- paths ---"; sudo sed -E 's/=.*/=<redacted>/' "$ENV_FILE"
    echo "--- mediamtx paths ---"
    curl -s http://127.0.0.1:9997/v3/paths/list | python3 -c "import sys,json;d=json.load(sys.stdin);[print(i['name'],'ready=',i.get('ready')) for i in d.get('items',[])]" 2>/dev/null || true
    ;;
  deploy)
    # ── Dedicated service users ──────────────────────────────────────
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
    # Enforce supplemental access on every run, including hosts where the
    # account was created by an earlier partial deployment.
    sudo usermod -aG mbfd-recording mbfd-camera-api

    sudo install -d -o mbfd-camera-api -g mbfd-recording -m 2770 \
      "$RECORDING_ROOT" "$RECORDING_ROOT/active" "$RECORDING_ROOT/completed" \
      "$RECORDING_ROOT/failed" "$RECORDING_ROOT/metadata"
    # Preserve every existing artifact and its owner while granting the
    # dedicated API and recorder group access to legacy 0600 metadata/nonces.
    sudo find "$RECORDING_ROOT" -xdev -type d \
      -exec chgrp mbfd-recording {} + \
      -exec chmod u+rwx,g+rwx,g+s {} +
    sudo find "$RECORDING_ROOT" -xdev -type f \
      -exec chgrp mbfd-recording {} + \
      -exec chmod u+rw,g+rw {} +

    # ── Camera API source ────────────────────────────────────────────
    sudo cp "$HERE/camera-api/server.js" "$HERE/camera-api/recording-safety.js" \
      "$HERE/camera-api/recording-supervisor.js" "$HERE/camera-api/docker-recording-runtime.js" \
      "$HERE/camera-api/live-source-health.js" "$HERE/camera-api/audio-level-health.js" \
      "$HERE/camera-api/zowiebox-client.js" \
      "$HERE/camera-api/camera-service-signature.js" "$HERE/camera-api/livestream-audit.js" \
      "$HERE/camera-api/peertube-upload.js" "$HERE/camera-api/package.json" \
      "$HERE/camera-api/package-lock.json" "$STACK/camera-api/"
    sudo chown -R mbfd-camera-api:mbfd-camera-api "$STACK/camera-api"
    ( cd "$STACK/camera-api" && sudo -u mbfd-camera-api npm ci --omit=dev --no-audit --no-fund )

    sudo /usr/bin/python3 "$HERE/scripts/render-mediamtx-config.py" \
      "$ENV_FILE" "$HERE/mediamtx.yml.tpl" "$STACK/mediamtx.yml"
    sudo install -o root -g root -m 0644 "$HERE/docker-compose.mediamtx.yml" "$STACK/docker-compose.mediamtx.yml"

    # ── Recording broker (root-owned, peer-verified Unix socket) ──────
    sudo install -o root -g root -m 0755 "$HERE/recording-broker/mbfd-recording-broker.py" /usr/local/sbin/mbfd-recording-broker
    sudo cp "$HERE/systemd/mbfd-recording-broker.socket" "$HERE/systemd/mbfd-recording-broker.service" /etc/systemd/system/
    sudo install -o root -g root -m 0644 "$HERE/tmpfiles.d/mbfd-recording-broker.conf" /etc/tmpfiles.d/mbfd-recording-broker.conf
    sudo systemd-tmpfiles --create /etc/tmpfiles.d/mbfd-recording-broker.conf

    # ── Systemd units ────────────────────────────────────────────────
    for u in mbfd-camera-api; do
      sudo cp "$HERE/systemd/$u.service" /etc/systemd/system/
    done
    sudo cp "$HERE/systemd/mbfd-camera-recording@.service" /etc/systemd/system/
    sudo install -o root -g root -m 0755 "$HERE/scripts/mbfd-camera-recording-run" /usr/local/libexec/mbfd-camera-recording-run
    sudo install -o root -g root -m 0644 "$HERE/tmpfiles.d/mbfd-camera-recording.conf" /etc/tmpfiles.d/mbfd-camera-recording.conf
    sudo systemd-tmpfiles --create /etc/tmpfiles.d/mbfd-camera-recording.conf

    # Remove stale wildcard sudoers rule from prior installs; install the
    # narrow read-only operator rule for the long-test harness.
    sudo rm -f /etc/sudoers.d/mbfd-recording-admin
    echo "$USER ALL=(root) NOPASSWD: /usr/local/sbin/mbfd-recording-admin status ses_*" | sudo tee /etc/sudoers.d/mbfd-recording-admin >/dev/null
    sudo chmod 0440 /etc/sudoers.d/mbfd-recording-admin
    sudo visudo -cf /etc/sudoers.d/mbfd-recording-admin
    sudo install -o root -g root -m 0755 "$HERE/mbfd-recording-admin" /usr/local/sbin/mbfd-recording-admin
    # Install the current fixed-command helper before invoking any newly added
    # allowlisted operation.  Older hosts do not know retire-legacy-relays yet.
    sudo install -o root -g root -m 0755 "$HERE/mbfd-media-admin" /usr/local/sbin/mbfd-media-admin
    sudo visudo -cf /etc/sudoers.d/mbfd-media-admin

    sudo install -d -o mbfd-camera-api -g mbfd-camera-api -m 0755 "$STACK/scripts"
    sudo install -o mbfd-camera-api -g mbfd-camera-api -m 0755 "$HERE/scripts/user-long-recording-test.sh" "$STACK/scripts/user-long-recording-test.sh"

    # Change the environment-file access only after all replacement artifacts
    # are installed. If an earlier step fails, the still-running legacy
    # peter-owned service remains able to restart with its existing config.
    # Root ownership prevents service-account modification while group read
    # gives only the dedicated API access. No value is emitted to stdout.
    sudo chown root:mbfd-camera-api "$ENV_FILE"
    sudo chmod 0640 "$ENV_FILE"

    sudo systemctl daemon-reload
    sudo /usr/local/sbin/mbfd-media-admin retire-legacy-relays

    # ── Restart services ─────────────────────────────────────────────
    sudo systemctl enable --now mbfd-recording-broker.socket
    sudo systemctl restart mbfd-recording-broker.service
    sudo /usr/local/sbin/mbfd-media-admin restart-mediamtx
    sleep 4
    sudo /usr/local/sbin/mbfd-media-admin restart-camera-api
    echo "deploy complete"
    ;;
  *) echo "usage: upgrade.sh [status|deploy]"; exit 2 ;;
esac
