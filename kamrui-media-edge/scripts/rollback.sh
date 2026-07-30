#!/usr/bin/env bash
# Restore the media edge from an explicit, checksum-verified release snapshot.
# This script never selects a snapshot implicitly and never re-enables retired
# camera relay units.
set -euo pipefail
STACK=/opt/mbfd/media-stack
SNAPSHOT="${1:-}"
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
test -f "$SNAPSHOT/etc/media-stack/camera.env"

sudo install -o root -g root -m 0600 \
  "$SNAPSHOT/etc/media-stack/camera.env" /etc/mbfd/media-stack/camera.env
sudo install -o root -g root -m 0600 \
  "$SNAPSHOT/opt/media-stack/mediamtx.yml" "$STACK/mediamtx.yml"
if [ -d "$SNAPSHOT/opt/media-stack/camera-api" ]; then
  sudo cp -a "$SNAPSHOT/opt/media-stack/camera-api/." "$STACK/camera-api/"
fi
sudo /usr/local/sbin/mbfd-media-admin restart-camera-api
sudo /usr/local/sbin/mbfd-media-admin restart-mediamtx
echo "rollback complete"
