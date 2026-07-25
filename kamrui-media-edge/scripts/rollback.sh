#!/usr/bin/env bash
# Rollback the Kamrui media edge to the prior backup snapshot.
# Backups live under /opt/mbfd/media-stack/backup-*-<date>/.
set -euo pipefail
STACK=/opt/mbfd/media-stack
LATEST=$(ls -1d "$STACK"/backup-corrective2-* "$STACK"/backup-corrective-* 2>/dev/null | tail -1)
if [ -z "$LATEST" ]; then echo "no backup snapshot found"; exit 1; fi
echo "rolling back to: $LATEST"
cp "$LATEST/server.js.pre-corrective2" "$STACK/camera-api/server.js"
cp "$LATEST/peertube-upload.js.pre-corrective2" "$STACK/camera-api/peertube-upload.js"
cp "$LATEST/annke-main-relay.sh.pre-corrective2" "$STACK/annke-main-relay.sh"
cp "$LATEST/annke-preview-relay.sh.pre-corrective2" "$STACK/annke-preview-relay.sh"
chmod +x "$STACK/annke-main-relay.sh" "$STACK/annke-preview-relay.sh"
sudo /usr/local/sbin/mbfd-media-admin restart-camera-api
sudo /usr/local/sbin/mbfd-media-admin restart-annke-main
sudo /usr/local/sbin/mbfd-media-admin restart-annke-preview
echo "rollback complete"
