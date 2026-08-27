#!/usr/bin/env bash
# Restore the media edge from an explicit, checksum-verified release snapshot.
# This script never selects a snapshot implicitly and never re-enables retired
# camera relay units.
set -euo pipefail
STACK=/opt/mbfd/media-stack
SNAPSHOT="${1:-}"

require_pinned_mediamtx_image() {
  local compose_file="$1"
  if grep -Fq 'bluenviron/mediamtx:latest' "$compose_file"; then
    echo "ERROR: refusing floating MediaMTX image reference" >&2
    exit 1
  fi
  if ! grep -Eq 'bluenviron/mediamtx(:[^@[:space:]]+)?@sha256:[a-f0-9]{64}' "$compose_file"; then
    echo "ERROR: MediaMTX image must be pinned by an immutable sha256 digest" >&2
    exit 1
  fi
}

if [ -z "$SNAPSHOT" ]; then
  echo "usage: rollback.sh /absolute/path/to/verified-snapshot" >&2
  exit 2
fi
SNAPSHOT=$(realpath "$SNAPSHOT")
case "$SNAPSHOT" in
  /home/peter/mbfd-backups/*|/opt/mbfd/media-stack/backups/*) ;;
  *) echo "snapshot is outside an approved backup root" >&2; exit 2 ;;
esac
test -f "$SNAPSHOT/SHA256SUMS"
( cd "$SNAPSHOT" && sha256sum -c SHA256SUMS )
test -f "$SNAPSHOT/opt/media-stack/mediamtx.yml"
test -f "$SNAPSHOT/opt/media-stack/docker-compose.mediamtx.yml"
test -f "$SNAPSHOT/etc/media-stack/camera.env"
require_pinned_mediamtx_image "$SNAPSHOT/opt/media-stack/docker-compose.mediamtx.yml"

# The current environment still contains the exact guest address. Revoke its
# narrow firewall opening before restoring a snapshot that might predate the
# guest authentication policy.
sudo /usr/local/sbin/mbfd-media-admin ufw-revoke-guest-rtmp

sudo install -o root -g root -m 0600 \
  "$SNAPSHOT/etc/media-stack/camera.env" /etc/mbfd/media-stack/camera.env
sudo install -o root -g root -m 0600 \
  "$SNAPSHOT/opt/media-stack/mediamtx.yml" "$STACK/mediamtx.yml"
sudo install -o root -g root -m 0644 \
  "$SNAPSHOT/opt/media-stack/docker-compose.mediamtx.yml" "$STACK/docker-compose.mediamtx.yml"
if [ -d "$SNAPSHOT/opt/media-stack/camera-api" ]; then
  sudo cp -a "$SNAPSHOT/opt/media-stack/camera-api/." "$STACK/camera-api/"
fi
( cd "$STACK" && sudo docker compose -f docker-compose.mediamtx.yml config --quiet )
( cd "$STACK" && sudo docker compose -f docker-compose.mediamtx.yml pull mediamtx )
( cd "$STACK" && sudo docker compose -f docker-compose.mediamtx.yml up -d --no-deps --force-recreate mediamtx )
sudo /usr/local/sbin/mbfd-media-admin restart-camera-api
echo "rollback complete"
