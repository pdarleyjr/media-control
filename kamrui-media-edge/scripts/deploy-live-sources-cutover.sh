#!/usr/bin/env bash
# Narrow KAMRUI cutover for the podium RTSP pull and guest RTMP publisher.
#
# This script deliberately owns only two active files and one container:
#   /opt/mbfd/media-stack/mediamtx.yml
#   /opt/mbfd/media-stack/docker-compose.mediamtx.yml
#   mbfd-mediamtx
# It defaults to a read-only preflight.  --apply is for an approved maintenance
# window only and requires an explicit environment acknowledgement.
set -Eeuo pipefail

umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STACK=/opt/mbfd/media-stack
ACTIVE_CONFIG="$STACK/mediamtx.yml"
ACTIVE_COMPOSE="$STACK/docker-compose.mediamtx.yml"
ENV_FILE=/etc/mbfd/media-stack/camera.env
CONTAINER=mbfd-mediamtx
SNAPSHOT_ROOT=/home/peter/mbfd-backups
ROLLBACK_SCRIPT="$HERE/scripts/rollback.sh"
FEATURE_ROLLBACK_SCRIPT="$HERE/scripts/rollback-live-sources-cutover.sh"
SNAPSHOT_VALIDATOR="$HERE/scripts/validate-rollback-snapshot.py"
RENDERER="$HERE/scripts/render-mediamtx-config.py"
TEMPLATE="$HERE/mediamtx.yml.tpl"
SOURCE_COMPOSE="$HERE/docker-compose.mediamtx.yml"
EXPECTED_HOSTNAME=peter-Default-string
EXPECTED_MEDIAMTX_VERSION=v1.19.3
EXPECTED_MEDIAMTX_IMAGE=bluenviron/mediamtx:1.19.3@sha256:7797ed3df88df21e8c04ecd0aff08ce49a5232d1db453e51f5480ef36bc80865
EXPECTED_MEDIAMTX_REPO_DIGEST=bluenviron/mediamtx@sha256:7797ed3df88df21e8c04ecd0aff08ce49a5232d1db453e51f5480ef36bc80865

MODE="dry-run"
SNAPSHOT_DIR=""
WORKDIR=""
ACTIVE_CONFIG_TEMP=""
ACTIVE_COMPOSE_TEMP=""
MUTATION_STARTED=0
ROLLBACK_STARTED=0
GUEST_FIREWALL_GUEST_IP=""
GUEST_FIREWALL_KAMRUI_IP=""
GUEST_FIREWALL_PRESENT_BEFORE_CUTOVER=""
CURRENT_VERSION=""
CURRENT_IMAGE_ID=""
CURRENT_REPO_DIGEST=""
CURRENT_STARTED_AT=""
SNAPSHOT_KIND=""
EXPECTED_IMAGE_ID=""

usage() {
  cat <<'USAGE'
usage: deploy-live-sources-cutover.sh [--dry-run|--apply] [--snapshot-dir /home/peter/mbfd-backups/name]

Default mode is --dry-run: it verifies the KAMRUI identity, current MediaMTX
state, Anpviz path health, render inputs, and the committed pinned Compose
file. It does not create a snapshot, install files, pull images, recreate a
container, or change firewall state.

--apply is an approved-maintenance action only. It must be run as root and
requires MBFD_LIVE_SOURCES_CUTOVER_AUTHORIZATION=YES in its environment.
USAGE
}

die() {
  printf 'ERROR: %s\n' "$*" >&2
  return 1
}

cleanup() {
  if [[ -n "$ACTIVE_CONFIG_TEMP" ]]; then
    rm -f -- "$ACTIVE_CONFIG_TEMP" 2>/dev/null || true
  fi
  if [[ -n "$ACTIVE_COMPOSE_TEMP" ]]; then
    rm -f -- "$ACTIVE_COMPOSE_TEMP" 2>/dev/null || true
  fi
  if [[ -n "$WORKDIR" && "$WORKDIR" == /tmp/mbfd-live-sources-cutover.* ]]; then
    rm -rf -- "$WORKDIR" 2>/dev/null || true
  fi
}

rollback_after_failure() {
  local status="$1"
  local line="$2"
  trap - ERR INT TERM

  printf 'ERROR: cutover failed at line %s (exit %s).\n' "$line" "$status" >&2
  if (( MUTATION_STARTED == 1 && ROLLBACK_STARTED == 0 )); then
    ROLLBACK_STARTED=1
    if [[ -n "$SNAPSHOT_DIR" && -r "$FEATURE_ROLLBACK_SCRIPT" ]]; then
      printf 'Active MediaMTX files may have changed; invoking verified feature rollback.\n' >&2
      if ! bash "$FEATURE_ROLLBACK_SCRIPT" "$SNAPSHOT_DIR"; then
        printf 'CRITICAL: automatic rollback failed. Preserve %s and escalate.\n' "$SNAPSHOT_DIR" >&2
      fi
    else
      printf 'CRITICAL: no executable verified rollback script is available; preserve %s and escalate.\n' "$SNAPSHOT_DIR" >&2
    fi
  fi
  exit "$status"
}

on_signal() {
  rollback_after_failure 130 "$LINENO"
}

trap 'rollback_after_failure $? $LINENO' ERR
trap on_signal INT TERM
trap cleanup EXIT

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command is unavailable: $1"
}

is_ipv4() {
  local address="$1"
  local first second third fourth extra octet
  [[ "$address" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || return 1
  IFS=. read -r first second third fourth extra <<< "$address"
  [[ -z "${extra:-}" ]] || return 1
  for octet in "$first" "$second" "$third" "$fourth"; do
    [[ "$octet" =~ ^[0-9]{1,3}$ ]] || return 1
    (( 10#$octet <= 255 )) || return 1
  done
}

read_env_ipv4() {
  local key="$1"
  local value
  value="$(sed -n -E "s/^${key}=([0-9.]+)$/\\1/p" "$ENV_FILE" | tail -n 1 | tr -d '\r')"
  is_ipv4 "$value" || die "$key is missing or is not a valid IPv4 address"
  printf '%s\n' "$value"
}

observe_exact_guest_rtmp_rule() {
  local status_file observation rule_number fingerprint extra
  [[ -n "$WORKDIR" ]] || die "cannot observe numbered UFW state before the isolated work directory exists"
  status_file="$(mktemp "$WORKDIR/ufw-status-numbered.XXXXXX")"
  LC_ALL=C ufw status numbered >"$status_file" \
    || die "unable to read active numbered UFW status"
  observation="$(python3 "$SNAPSHOT_VALIDATOR" \
    --observe-ufw-status "$status_file" \
    --guest-ip "$GUEST_FIREWALL_GUEST_IP" \
    --kamrui-ip "$GUEST_FIREWALL_KAMRUI_IP" \
    --port 1935 \
    --protocol tcp \
    --action ALLOW \
    --direction IN)" \
    || die "numbered UFW state is ambiguous or malformed for the Guest RTMP identity"
  IFS=$'\t' read -r rule_number fingerprint extra <<< "$observation"
  [[ -z "${extra:-}" && "$rule_number" =~ ^(0|[1-9][0-9]*)$ && "$fingerprint" =~ ^[a-f0-9]{64}$ ]] \
    || die "numbered UFW observer returned an invalid exact-rule identity"
  printf '%s\n' "$rule_number"
}

capture_guest_rtmp_firewall_baseline() {
  local before_status exact_rule
  GUEST_FIREWALL_GUEST_IP="$(read_env_ipv4 GUEST_RTMP_PUBLISHER_LAN_IP)"
  GUEST_FIREWALL_KAMRUI_IP="$(read_env_ipv4 KAMRUI_LAN_IP)"
  before_status="$WORKDIR/ufw-status-numbered-before.txt"
  LC_ALL=C ufw status numbered >"$before_status" \
    || die "unable to capture numbered UFW baseline"
  exact_rule="$(python3 "$SNAPSHOT_VALIDATOR" \
    --observe-ufw-status "$before_status" \
    --guest-ip "$GUEST_FIREWALL_GUEST_IP" \
    --kamrui-ip "$GUEST_FIREWALL_KAMRUI_IP" \
    --port 1935 \
    --protocol tcp \
    --action ALLOW \
    --direction IN)" \
    || die "numbered UFW baseline is ambiguous or malformed for the Guest RTMP identity"
  IFS=$'\t' read -r exact_rule _ <<< "$exact_rule"
  case "$exact_rule" in
    0) GUEST_FIREWALL_PRESENT_BEFORE_CUTOVER=false ;;
    [1-9][0-9]*) GUEST_FIREWALL_PRESENT_BEFORE_CUTOVER=true ;;
    *) die "numbered UFW baseline did not return a valid exact-rule state" ;;
  esac
  python3 - "$WORKDIR/guest-rtmp-firewall-before.json" \
    "$GUEST_FIREWALL_GUEST_IP" "$GUEST_FIREWALL_KAMRUI_IP" \
    "$GUEST_FIREWALL_PRESENT_BEFORE_CUTOVER" <<'PY'
import json
from pathlib import Path
import sys

destination = Path(sys.argv[1])
guest_ip, kamrui_ip, present = sys.argv[2:]
payload = {
    "action": "ALLOW",
    "direction": "IN",
    "guest_ip": guest_ip,
    "kamrui_ip": kamrui_ip,
    "port": 1935,
    "protocol": "tcp",
    "present_before_cutover": present == "true",
}
destination.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

require_exact_new_image() {
  [[ -f "$SOURCE_COMPOSE" ]] || die "committed MediaMTX Compose file is missing"
  grep -Fq "$EXPECTED_MEDIAMTX_IMAGE" "$SOURCE_COMPOSE" || die "committed Compose does not reference the expected immutable MediaMTX image"
  ! grep -Eq 'bluenviron/mediamtx:latest([^@[:alnum:]_.-]|$)' "$SOURCE_COMPOSE" || die "committed Compose contains a floating MediaMTX reference"
}

determine_snapshot_kind() {
  if grep -Eq '^[[:space:]]*image:[[:space:]]*bluenviron/mediamtx:latest([[:space:]]|$)' "$ACTIVE_COMPOSE"; then
    SNAPSHOT_KIND=verified-legacy
  elif grep -Fq "$EXPECTED_MEDIAMTX_IMAGE" "$ACTIVE_COMPOSE"; then
    SNAPSHOT_KIND=pinned-release
  else
    die "current Compose is neither the verified legacy baseline nor the expected pinned release"
  fi
}

verify_kamrui_identity() {
  local actual_hostname
  actual_hostname="$(hostnamectl --static 2>/dev/null || hostname)"
  [[ "$actual_hostname" == "$EXPECTED_HOSTNAME" ]] || die "refusing to run on unexpected host identity: $actual_hostname"
  [[ -d "$STACK" ]] || die "MediaMTX stack directory is missing"
  [[ -f "$ACTIVE_CONFIG" && -s "$ACTIVE_CONFIG" ]] || die "active MediaMTX configuration is missing"
  [[ -f "$ACTIVE_COMPOSE" && -s "$ACTIVE_COMPOSE" ]] || die "active MediaMTX Compose file is missing"
  [[ -f "$ENV_FILE" && -r "$ENV_FILE" ]] || die "protected render input is missing"
  docker inspect "$CONTAINER" >/dev/null 2>&1 || die "expected MediaMTX container is absent"
}

capture_current_runtime_identity() {
  CURRENT_VERSION="$(docker exec "$CONTAINER" /mediamtx --version)"
  [[ "$CURRENT_VERSION" == "$EXPECTED_MEDIAMTX_VERSION" ]] || die "current MediaMTX version is not $EXPECTED_MEDIAMTX_VERSION"

  CURRENT_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER")"
  [[ "$CURRENT_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || die "current MediaMTX image ID is malformed"
  CURRENT_REPO_DIGEST="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$CURRENT_IMAGE_ID" | awk '/^bluenviron\/mediamtx@sha256:[a-f0-9]{64}$/ { print; exit }')"
  [[ "$CURRENT_REPO_DIGEST" == "$EXPECTED_MEDIAMTX_REPO_DIGEST" ]] || die "current MediaMTX immutable digest does not match the verified baseline"
  CURRENT_STARTED_AT="$(docker inspect --format '{{.State.StartedAt}}' "$CONTAINER")"
  [[ "$CURRENT_STARTED_AT" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T ]] || die "current MediaMTX start timestamp is malformed"
}

verify_path_contract() {
  local phase="$1"
  local payload
  payload="$(curl -fsS --max-time 5 http://127.0.0.1:9997/v3/paths/list)" || die "MediaMTX local path API is unavailable"
  printf '%s' "$payload" | python3 -c '
import json
import sys

phase = sys.argv[1]
try:
    payload = json.load(sys.stdin)
except json.JSONDecodeError as error:
    raise SystemExit(f"MediaMTX path API returned invalid JSON: {error}")

items = {item.get("name"): item for item in payload.get("items", [])}
for name in ("anpviz-video", "anpviz-main"):
    if name not in items:
        raise SystemExit(f"required Anpviz path is absent: {name}")
    if items[name].get("ready") is not True:
        raise SystemExit(f"required Anpviz path is not ready: {name}")

guest = items.get("guest-computer")
if guest is not None and guest.get("ready") is True:
    raise SystemExit("guest-computer already has an unexpected publisher")

if phase == "post":
    if "podium-computer" not in items:
        raise SystemExit("podium-computer path is absent after cutover")
    if guest is None:
        raise SystemExit("guest-computer publisher path is absent after cutover")

print(f"{phase}: Anpviz paths ready; guest publisher idle")
' "$phase"
}

preflight() {
  for command in awk bash curl docker grep hostnamectl install mktemp python3 realpath sed sha256sum ufw; do
    require_command "$command"
  done
  (( EUID == 0 )) || die "run with sudo only during an approved maintenance window"
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is unavailable"
  verify_kamrui_identity
  capture_current_runtime_identity
  determine_snapshot_kind
  require_exact_new_image
  verify_path_contract preflight
  [[ -f "$RENDERER" && -r "$RENDERER" && -r "$TEMPLATE" ]] || die "rendering inputs are unavailable"
  [[ -d "$SNAPSHOT_ROOT" ]] || die "approved snapshot root is unavailable"
  [[ -r "$ROLLBACK_SCRIPT" ]] || die "verified rollback script is unavailable"
  [[ -r "$FEATURE_ROLLBACK_SCRIPT" ]] || die "verified feature rollback script is unavailable"
  [[ -r "$SNAPSHOT_VALIDATOR" ]] || die "rollback snapshot validator is unavailable"
}

set_snapshot_directory() {
  local requested="$1"
  if [[ -z "$requested" ]]; then
    requested="$SNAPSHOT_ROOT/live-sources-cutover-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  SNAPSHOT_DIR="$(realpath -m "$requested")"
  case "$SNAPSHOT_DIR" in
    "$SNAPSHOT_ROOT"/*) ;;
    *) die "snapshot destination is outside the approved backup root" ;;
  esac
  [[ "$SNAPSHOT_DIR" != "$SNAPSHOT_ROOT" ]] || die "snapshot destination cannot be the backup root"
  [[ ! -e "$SNAPSHOT_DIR" ]] || die "snapshot destination already exists"
}

create_rollback_ready_snapshot() {
  local plan plan_kind plan_image plan_version plan_image_id plan_repo_digest
  local firewall_plan plan_guest_ip plan_kamrui_ip plan_port plan_protocol plan_present plan_action plan_direction
  set_snapshot_directory "$SNAPSHOT_DIR"
  capture_guest_rtmp_firewall_baseline
  install -d -m 0700 "$SNAPSHOT_DIR/opt/media-stack" "$SNAPSHOT_DIR/etc/media-stack" "$SNAPSHOT_DIR/runtime"
  install -m 0600 "$ACTIVE_CONFIG" "$SNAPSHOT_DIR/opt/media-stack/mediamtx.yml"
  install -m 0600 "$ACTIVE_COMPOSE" "$SNAPSHOT_DIR/opt/media-stack/docker-compose.mediamtx.yml"
  install -m 0600 "$ENV_FILE" "$SNAPSHOT_DIR/etc/media-stack/camera.env"
  docker inspect "$CONTAINER" >"$WORKDIR/mediamtx-inspect.json"
  install -m 0600 "$WORKDIR/mediamtx-inspect.json" "$SNAPSHOT_DIR/runtime/mediamtx-inspect.json"
  install -m 0600 "$WORKDIR/guest-rtmp-firewall-before.json" "$SNAPSHOT_DIR/runtime/guest-rtmp-firewall-before.json"
  install -m 0600 "$WORKDIR/ufw-status-numbered-before.txt" "$SNAPSHOT_DIR/runtime/ufw-status-numbered.txt"
  (
    cd "$SNAPSHOT_DIR"
    sha256sum \
      opt/media-stack/mediamtx.yml \
      opt/media-stack/docker-compose.mediamtx.yml \
      etc/media-stack/camera.env \
      runtime/mediamtx-inspect.json \
      runtime/guest-rtmp-firewall-before.json \
      runtime/ufw-status-numbered.txt >SHA256SUMS
  )
  python3 - "$SNAPSHOT_DIR" "$WORKDIR/rollback-manifest.json" "$SNAPSHOT_KIND" "$CURRENT_VERSION" "$CURRENT_IMAGE_ID" "$CURRENT_REPO_DIGEST" "$CURRENT_STARTED_AT" <<'PY'
import hashlib
import json
from pathlib import Path
import sys

snapshot = Path(sys.argv[1])
manifest_path = Path(sys.argv[2])
snapshot_kind, version, image_id, repo_digest, started_at = sys.argv[3:]
relative_paths = (
    "opt/media-stack/mediamtx.yml",
    "opt/media-stack/docker-compose.mediamtx.yml",
    "etc/media-stack/camera.env",
    "runtime/mediamtx-inspect.json",
    "runtime/guest-rtmp-firewall-before.json",
    "runtime/ufw-status-numbered.txt",
)
hashes = {
    relative_path: hashlib.sha256((snapshot / relative_path).read_bytes()).hexdigest()
    for relative_path in relative_paths
}
firewall = json.loads(
    (snapshot / "runtime/guest-rtmp-firewall-before.json").read_text(encoding="utf-8")
)
manifest = {
    "schema_version": 2,
    "snapshot_kind": snapshot_kind,
    "artifacts": list(relative_paths),
    "sha256": hashes,
    "runtime": {
        "mediamtx": {
            "version": version,
            "image_id": image_id,
            "repo_digest": repo_digest,
            "started_at": started_at,
            "inspect_sha256": hashes["runtime/mediamtx-inspect.json"],
        }
    },
    "firewall": {
        "guest_rtmp": {
            **firewall,
            "artifact": "runtime/guest-rtmp-firewall-before.json",
            "status_artifact": "runtime/ufw-status-numbered.txt",
        }
    },
}
manifest_path.write_text(
    json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
)
PY
  install -m 0600 "$WORKDIR/rollback-manifest.json" "$SNAPSHOT_DIR/rollback-manifest.json"
  ( cd "$SNAPSHOT_DIR" && sha256sum -c SHA256SUMS >/dev/null ) || die "fresh snapshot checksum verification failed"
  plan="$(python3 "$SNAPSHOT_VALIDATOR" "$SNAPSHOT_DIR" --approved-root "$SNAPSHOT_ROOT" --print-plan)"
  IFS=$'\t' read -r plan_kind plan_image plan_version plan_image_id plan_repo_digest <<< "$plan"
  [[ "$plan_kind" == "$SNAPSHOT_KIND" ]] || die "fresh snapshot validator returned an unexpected kind"
  [[ "$plan_version" == "$CURRENT_VERSION" ]] || die "fresh snapshot validator returned an unexpected version"
  [[ "$plan_image_id" == "$CURRENT_IMAGE_ID" ]] || die "fresh snapshot validator returned an unexpected image ID"
  [[ "$plan_repo_digest" == "$CURRENT_REPO_DIGEST" ]] || die "fresh snapshot validator returned an unexpected repo digest"
  if [[ "$SNAPSHOT_KIND" == "verified-legacy" ]]; then
    [[ "$plan_image" == "$CURRENT_REPO_DIGEST" ]] || die "legacy snapshot did not resolve to its captured immutable digest"
  else
    [[ "$plan_image" == "$EXPECTED_MEDIAMTX_IMAGE" ]] || die "pinned snapshot did not preserve the expected immutable image"
  fi
  firewall_plan="$(python3 "$SNAPSHOT_VALIDATOR" "$SNAPSHOT_DIR" --approved-root "$SNAPSHOT_ROOT" --print-firewall-plan)"
  IFS=$'\t' read -r plan_guest_ip plan_kamrui_ip plan_port plan_protocol plan_present plan_action plan_direction <<< "$firewall_plan"
  [[ "$plan_guest_ip" == "$GUEST_FIREWALL_GUEST_IP" && "$plan_kamrui_ip" == "$GUEST_FIREWALL_KAMRUI_IP" ]] \
    || die "fresh snapshot firewall identity does not match the captured baseline"
  [[ "$plan_port" == 1935 && "$plan_protocol" == tcp && "$plan_present" == "$GUEST_FIREWALL_PRESENT_BEFORE_CUTOVER" && "$plan_action" == ALLOW && "$plan_direction" == IN ]] \
    || die "fresh snapshot firewall baseline is invalid"
  printf 'Created verified rollback snapshot at %s\n' "$SNAPSHOT_DIR"
}

create_workdir() {
  WORKDIR="$(mktemp -d /tmp/mbfd-live-sources-cutover.XXXXXX)"
  [[ "$WORKDIR" == /tmp/mbfd-live-sources-cutover.* ]] || die "temporary directory is outside the expected root"
}

render_to_temporary_location() {
  local rendered="$WORKDIR/mediamtx.yml"
  python3 "$RENDERER" "$ENV_FILE" "$TEMPLATE" "$rendered"
  [[ -s "$rendered" ]] || die "rendered MediaMTX configuration is empty"
  install -m 0644 "$SOURCE_COMPOSE" "$WORKDIR/docker-compose.mediamtx.yml"
  docker compose -f "$WORKDIR/docker-compose.mediamtx.yml" config --quiet
}

validate_rendered_contract() {
  python3 - "$WORKDIR/mediamtx.yml" <<'PY'
from pathlib import Path
import sys

configuration = Path(sys.argv[1]).read_text(encoding="utf-8")
required = (
    "anpviz-video:",
    "anpviz-main:",
    "podium-computer:",
    "guest-computer:",
    "source: publisher",
    "overridePublisher: false",
    "authMethod: internal",
    "path: anpviz-main",
    "path: guest-computer",
    "rtspTransport: tcp",
)
for item in required:
    if item not in configuration:
        raise SystemExit(f"rendered configuration is missing required topology/auth item: {item}")
if "bluenviron/mediamtx:latest" in configuration:
    raise SystemExit("unexpected image reference in rendered configuration")
PY
}

prepare_isolated_parser_config() {
  python3 - "$WORKDIR/mediamtx.yml" "$WORKDIR/isolated-mediamtx.yml" <<'PY'
from pathlib import Path
import re
import sys

source = Path(sys.argv[1])
destination = Path(sys.argv[2])
configuration = source.read_text(encoding="utf-8")
replacements = (
    (r"(?m)^apiAddress: .+$", "apiAddress: 127.0.0.1:19997"),
    (r"(?m)^rtmpAddress: .+$", 'rtmpAddress: "127.0.0.1:11935"'),
    (r"(?m)^rtspAddress: .+$", "rtspAddress: 127.0.0.1:18554"),
    (r"(?m)^hlsAddress: .+$", "hlsAddress: 127.0.0.1:18888"),
    (r"(?m)^webrtcAddress: .+$", "webrtcAddress: 127.0.0.1:18889"),
    (r"(?m)^webrtcLocalUDPAddress: .+$", "webrtcLocalUDPAddress: 127.0.0.1:18189"),
    (r"(?m)^webrtcAdditionalHosts: .+$", "webrtcAdditionalHosts: [127.0.0.1]"),
)
for pattern, replacement in replacements:
    configuration, count = re.subn(pattern, replacement, configuration, count=1)
    if count != 1:
        raise SystemExit(f"isolated parser rewrite target is missing: {pattern}")
configuration, count = re.subn(
    r'(?m)^    source: "rtsp://[^"\r\n]+"$',
    '    source: "rtsp://127.0.0.1:1/isolated"',
    configuration,
)
if count != 2:
    raise SystemExit("isolated parser did not replace both protected RTSP source URLs")
destination.write_text(configuration, encoding="utf-8")
PY
}

validate_with_exact_mediamtx() {
  local staging_container="mbfd-live-sources-v1193-$$"
  if [[ "$MODE" == "dry-run" ]]; then
    printf 'dry-run: exact parser container validation is deferred until approved --apply.\n'
    return
  fi
  docker compose -f "$WORKDIR/docker-compose.mediamtx.yml" pull mediamtx
  EXPECTED_IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$EXPECTED_MEDIAMTX_IMAGE")"
  [[ "$EXPECTED_IMAGE_ID" =~ ^sha256:[a-f0-9]{64}$ ]] || die "pinned MediaMTX image is unavailable after pull"
  docker run -d --rm --name "$staging_container" --network none \
    -v "$WORKDIR/isolated-mediamtx.yml:/mediamtx.yml:ro" \
    "$EXPECTED_MEDIAMTX_IMAGE" >/dev/null
  sleep 3
  if [[ "$(docker inspect --format '{{.State.Running}}' "$staging_container" 2>/dev/null || true)" != "true" ]]; then
    docker rm -f "$staging_container" >/dev/null 2>&1 || true
    die "isolated MediaMTX v1.19.3 parser did not remain running"
  fi
  docker rm -f "$staging_container" >/dev/null
  printf 'Exact MediaMTX v1.19.3 isolated parser validation passed.\n'
}

install_active_mediamtx_files() {
  ACTIVE_CONFIG_TEMP="$(mktemp "$STACK/.mediamtx.yml.live-sources.XXXXXX")"
  ACTIVE_COMPOSE_TEMP="$(mktemp "$STACK/.docker-compose.mediamtx.yml.live-sources.XXXXXX")"
  install -m 0600 "$WORKDIR/mediamtx.yml" "$ACTIVE_CONFIG_TEMP"
  install -m 0644 "$SOURCE_COMPOSE" "$ACTIVE_COMPOSE_TEMP"
  MUTATION_STARTED=1
  mv -f "$ACTIVE_CONFIG_TEMP" "$ACTIVE_CONFIG"
  ACTIVE_CONFIG_TEMP=""
  mv -f "$ACTIVE_COMPOSE_TEMP" "$ACTIVE_COMPOSE"
  ACTIVE_COMPOSE_TEMP=""
}

recreate_mediamtx() {
  docker compose -f "$ACTIVE_COMPOSE" config --quiet
  docker compose -f "$ACTIVE_COMPOSE" up -d --no-deps --force-recreate mediamtx
}

verify_post_cutover() {
  sleep 4
  [[ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER")" == "true" ]] || die "MediaMTX container is not running after recreation"
  [[ "$(docker inspect --format '{{.State.Restarting}}' "$CONTAINER")" != "true" ]] || die "MediaMTX container is restart-looping"
  [[ "$(docker inspect --format '{{.Image}}' "$CONTAINER")" == "$EXPECTED_IMAGE_ID" ]] || die "MediaMTX is not running the pinned image ID"
  [[ "$(docker exec "$CONTAINER" /mediamtx --version)" == "$EXPECTED_MEDIAMTX_VERSION" ]] || die "MediaMTX version is not $EXPECTED_MEDIAMTX_VERSION"
  verify_path_contract post
}

allow_guest_rtmp_firewall() {
  local exact_rule
  [[ -n "$GUEST_FIREWALL_GUEST_IP" && -n "$GUEST_FIREWALL_KAMRUI_IP" ]] \
    || die "Guest RTMP firewall identity was not captured in the verified snapshot"
  exact_rule="$(observe_exact_guest_rtmp_rule)"
  [[ "$exact_rule" == 0 ]] \
    || die "the exact guest RTMP firewall rule already exists; stop for review"
  ufw allow in from "$GUEST_FIREWALL_GUEST_IP" to "$GUEST_FIREWALL_KAMRUI_IP" port 1935 proto tcp
  exact_rule="$(observe_exact_guest_rtmp_rule)"
  [[ "$exact_rule" != 0 ]] \
    || die "the exact guest RTMP firewall rule was not observable after insertion"
  printf 'Added the exact Guest-to-KAMRUI RTMP firewall rule after MediaMTX verification.\n'
}

run_dry_run() {
  create_workdir
  render_to_temporary_location
  validate_rendered_contract
  prepare_isolated_parser_config
  validate_with_exact_mediamtx
  printf 'DRY RUN PASSED: no snapshot, active file, container, or firewall state was changed.\n'
}

run_apply() {
  create_workdir
  create_rollback_ready_snapshot
  [[ "$GUEST_FIREWALL_PRESENT_BEFORE_CUTOVER" == false ]] \
    || die "the exact Guest RTMP firewall rule predates cutover; snapshot retained and no mutation was attempted"
  render_to_temporary_location
  validate_rendered_contract
  prepare_isolated_parser_config
  validate_with_exact_mediamtx
  install_active_mediamtx_files
  recreate_mediamtx
  verify_post_cutover
  allow_guest_rtmp_firewall
  printf 'LIVE-SOURCE CUTOVER PASSED. Snapshot retained at %s\n' "$SNAPSHOT_DIR"
}

while (( $# > 0 )); do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --snapshot-dir)
      shift
      (( $# > 0 )) || { usage >&2; exit 2; }
      SNAPSHOT_DIR="$1"
      ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$MODE" == "apply" && "${MBFD_LIVE_SOURCES_CUTOVER_AUTHORIZATION:-}" != "YES" ]]; then
  die "--apply requires MBFD_LIVE_SOURCES_CUTOVER_AUTHORIZATION=YES"
fi

preflight
if [[ "$MODE" == "dry-run" ]]; then
  run_dry_run
else
  run_apply
fi
