#!/usr/bin/env bash
# Restore only the MediaMTX topology from an explicit verified snapshot.
#
# This is intentionally not the broad historical media-edge rollback: it never
# copies camera-api files, restarts Camera API, alters UFW, or manages any
# recording/systemd resource. The live-source cutover owner controls those
# separate concerns. A legacy ``:latest`` Compose file is restored byte for
# byte, but is overlaid temporarily with its captured immutable RepoDigest so
# this command never resolves or pulls ``latest``.
set -euo pipefail

STACK=/opt/mbfd/media-stack
SNAPSHOT="${1:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VALIDATOR="$SCRIPT_DIR/validate-rollback-snapshot.py"
ACTIVE_CONFIG="$STACK/mediamtx.yml"
ACTIVE_COMPOSE="$STACK/docker-compose.mediamtx.yml"
CONTAINER=mbfd-mediamtx
OVERRIDE=""

cleanup() {
  if [ -n "$OVERRIDE" ]; then
    rm -f -- "$OVERRIDE"
  fi
}
trap cleanup EXIT

fail() {
  echo "ERROR: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command is unavailable: $1"
}

if [ -z "$SNAPSHOT" ]; then
  echo "usage: rollback.sh /absolute/path/to/verified-snapshot" >&2
  exit 2
fi

require_command realpath
require_command python3
require_command docker
require_command curl
test -f "$VALIDATOR" || fail "rollback snapshot validator is unavailable"
SNAPSHOT="$(realpath -e -- "$SNAPSHOT")"

# The validator is the single source of truth for checksum, manifest, approved
# root, pinned-vs-legacy, and immutable image checks. Its TSV output contains
# only constrained image/version identifiers; it never includes camera.env.
PLAN="$(python3 "$VALIDATOR" "$SNAPSHOT" \
  --approved-root /home/peter/mbfd-backups \
  --approved-root /opt/mbfd/media-stack/backups \
  --print-plan)"
IFS=$'\t' read -r SNAPSHOT_KIND RESTORE_IMAGE EXPECTED_VERSION EXPECTED_IMAGE_ID EXPECTED_REPO_DIGEST <<< "$PLAN"
case "$SNAPSHOT_KIND" in
  pinned-release|verified-legacy) ;;
  *) fail "rollback snapshot validator returned an invalid snapshot kind" ;;
esac
case "$RESTORE_IMAGE" in
  bluenviron/mediamtx@sha256:*|bluenviron/mediamtx:*@sha256:*) ;;
  *) fail "rollback snapshot validator returned a non-immutable image" ;;
esac
case "$EXPECTED_IMAGE_ID" in
  sha256:*) ;;
  *) fail "rollback snapshot validator returned an invalid image ID" ;;
esac
case "$EXPECTED_REPO_DIGEST" in
  bluenviron/mediamtx@sha256:*) ;;
  *) fail "rollback snapshot validator returned an invalid repo digest" ;;
esac
test -n "$EXPECTED_VERSION" || fail "rollback snapshot validator returned no MediaMTX version"

SNAPSHOT_CONFIG="$SNAPSHOT/opt/media-stack/mediamtx.yml"
SNAPSHOT_COMPOSE="$SNAPSHOT/opt/media-stack/docker-compose.mediamtx.yml"

# Pull only the exact immutable reference if the captured image is absent.
# In particular, this is never `docker pull bluenviron/mediamtx:latest`.
if ! sudo docker image inspect "$RESTORE_IMAGE" >/dev/null 2>&1; then
  sudo docker pull "$RESTORE_IMAGE"
fi
LOCAL_IMAGE_ID="$(sudo docker image inspect --format '{{.Id}}' "$RESTORE_IMAGE")"
[ "$LOCAL_IMAGE_ID" = "$EXPECTED_IMAGE_ID" ] || fail "captured immutable digest does not resolve to the expected image ID"

# These installs copy the original captured bytes. In the legacy case, Compose
# is not rewritten: the ephemeral second file below changes only the image used
# for this one recreate operation and is removed on all exits.
sudo install -o root -g root -m 0600 "$SNAPSHOT_CONFIG" "$ACTIVE_CONFIG"
sudo install -o root -g root -m 0644 "$SNAPSHOT_COMPOSE" "$ACTIVE_COMPOSE"

COMPOSE_FILES=(-f "$ACTIVE_COMPOSE")
if [ "$SNAPSHOT_KIND" = "verified-legacy" ]; then
  OVERRIDE="$(mktemp /tmp/mbfd-mediamtx-legacy-rollback.XXXXXX.yml)"
  chmod 0600 "$OVERRIDE"
  {
    printf '%s\n' 'services:'
    printf '%s\n' '  mediamtx:'
    printf '    image: %s\n' "$RESTORE_IMAGE"
  } > "$OVERRIDE"
  COMPOSE_FILES+=(-f "$OVERRIDE")
fi

(
  cd "$STACK"
  sudo docker compose "${COMPOSE_FILES[@]}" config --quiet
  sudo docker compose "${COMPOSE_FILES[@]}" up -d --no-deps --force-recreate mediamtx
)

RUNNING="$(sudo docker inspect --format '{{.State.Running}}' "$CONTAINER")"
[ "$RUNNING" = "true" ] || fail "MediaMTX is not running after rollback"
ACTUAL_IMAGE_ID="$(sudo docker inspect --format '{{.Image}}' "$CONTAINER")"
[ "$ACTUAL_IMAGE_ID" = "$EXPECTED_IMAGE_ID" ] || fail "MediaMTX container image ID differs from captured runtime"
ACTUAL_REPO_DIGESTS="$(sudo docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$ACTUAL_IMAGE_ID")"
grep -Fxq -- "$EXPECTED_REPO_DIGEST" <<< "$ACTUAL_REPO_DIGESTS" \
  || fail "MediaMTX image does not retain the captured immutable RepoDigest"
ACTUAL_VERSION="$(sudo docker exec "$CONTAINER" /mediamtx --version)"
[ "$ACTUAL_VERSION" = "$EXPECTED_VERSION" ] || fail "MediaMTX version differs from captured runtime"

# API readiness is deliberately not required: an RTSP source can be temporarily
# unavailable during rollback. The expected Anpviz paths themselves must still
# exist in the restored topology.
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:9997/v3/paths/list \
  | python3 -c '
import json
import sys
payload = json.load(sys.stdin)
names = {item.get("name") for item in payload.get("items", []) if isinstance(item, dict)}
missing = {"anpviz-video", "anpviz-main"}.difference(names)
if missing:
    raise SystemExit("missing restored Anpviz path(s): " + ", ".join(sorted(missing)))
'

# Explicit cleanup makes it clear that a legacy :latest image override is not
# retained as active deployment configuration. The trap covers failures too.
cleanup
OVERRIDE=""
echo "MediaMTX topology rollback complete ($SNAPSHOT_KIND, $EXPECTED_REPO_DIGEST)"
