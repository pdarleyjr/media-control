#!/usr/bin/env bash
# Upgrade the Kamrui media edge from this committed source tree (no secrets).
# Restarts services via the least-privilege admin helper.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
STACK=/opt/mbfd/media-stack
ENV_FILE=/etc/mbfd/media-stack/camera.env

case "${1:-status}" in
  status)
    sudo /usr/local/sbin/mbfd-media-admin status
    echo "--- paths ---"; sed -E 's/=.*/=<redacted>/' "$ENV_FILE"
    echo "--- mediamtx paths ---"
    curl -s http://127.0.0.1:9997/v3/paths/list | python3 -c "import sys,json;d=json.load(sys.stdin);[print(i['name'],'ready=',i.get('ready')) for i in d.get('items',[])]" 2>/dev/null || true
    ;;
  deploy)
    if ! getent group mbfd-recording >/dev/null; then
      sudo groupadd --system mbfd-recording
    fi
    if ! getent passwd mbfd-recording >/dev/null; then
      sudo useradd --system --gid mbfd-recording --home-dir /nonexistent --shell /usr/sbin/nologin mbfd-recording
    fi
    sudo install -d -o peter -g mbfd-recording -m 2770 \
      /mnt/data/recordings /mnt/data/recordings/active /mnt/data/recordings/completed \
      /mnt/data/recordings/failed /mnt/data/recordings/metadata
    cp "$HERE/camera-api/server.js" "$HERE/camera-api/recording-safety.js" \
      "$HERE/camera-api/recording-supervisor.js" "$HERE/camera-api/camera-service-signature.js" \
      "$HERE/camera-api/peertube-upload.js" "$HERE/camera-api/package.json" \
      "$HERE/camera-api/package-lock.json" "$STACK/camera-api/"
    ( cd "$STACK/camera-api" && npm ci --omit=dev --no-audit --no-fund )
    cp "$HERE/annke-main-relay.sh" "$HERE/annke-preview-relay.sh" "$STACK/"
    chmod +x "$STACK/annke-main-relay.sh" "$STACK/annke-preview-relay.sh"
    set -a; . "$ENV_FILE"; set +a
    sed -e "s|__ANNKE_MAIN_RTSP_URL__|${ANNKE_MAIN_RTSP_URL}|g" \
        -e "s|__ANNKE_PREVIEW_RTSP_URL__|${ANNKE_PREVIEW_RTSP_URL}|g" \
        "$HERE/mediamtx.yml.tpl" > "$STACK/mediamtx.yml"; chmod 600 "$STACK/mediamtx.yml"
    cp "$HERE/docker-compose.mediamtx.yml" "$STACK/docker-compose.mediamtx.yml"
    for u in mbfd-annke-main-relay mbfd-annke-preview-relay mbfd-camera-api; do
      sudo cp "$HERE/systemd/$u.service" /etc/systemd/system/; done
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
    sudo /usr/local/sbin/mbfd-media-admin restart-mediamtx
    sleep 4
    sudo /usr/local/sbin/mbfd-media-admin restart-annke-main
    sudo /usr/local/sbin/mbfd-media-admin restart-annke-preview
    sudo /usr/local/sbin/mbfd-media-admin restart-camera-api
    echo "deploy complete"
    ;;
  *) echo "usage: upgrade.sh [status|deploy]"; exit 2 ;;
esac
