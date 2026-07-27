#!/usr/bin/env bash
# cameras.mbfdhub.com nginx renderer — eliminates manual proxy drift.
#
# Renders the committed cameras-proxy/nginx.conf.tpl from a PROTECTED runtime
# credential, never from a committed secret. The token is read from, in order:
#   1. $CAMERA_API_TOKEN          (env, e.g. from a docker secret / systemd Env)
#   2. $CAMERA_API_TOKEN_FILE     (file path, mode 0600 root-owned recommended)
#   3. /etc/mbfd/cameras-api-token (default protected runtime file)
#
# The rendered config is written mode 0600 so the live token never sits in a
# world-readable file. The token is validated as hex so it cannot inject nginx
# directives (#, ;, {, }). Fail-closed: no token → no config written.
#
# Usage:
#   render-config.sh <template> <output> [nginx-test-command...]
# Example:
#   CAMERA_API_TOKEN_FILE=/etc/mbfd/cameras-api-token \
#     render-config.sh cameras-proxy/nginx.conf.tpl /opt/mbfd/cameras/nginx.conf
set -euo pipefail

TEMPLATE="${1:-}"
OUTPUT="${2:-}"

if [ -z "$TEMPLATE" ] || [ -z "$OUTPUT" ]; then
  echo "usage: $0 <template> <output>" >&2
  exit 64
fi
if [ ! -r "$TEMPLATE" ]; then
  echo "render-config: template not readable: $TEMPLATE" >&2
  exit 66
fi

TOKEN=""
TOKEN_SRC=""
if [ -n "${CAMERA_API_TOKEN:-}" ]; then
  TOKEN="$CAMERA_API_TOKEN"; TOKEN_SRC="env"
elif [ -n "${CAMERA_API_TOKEN_FILE:-}" ] && [ -r "${CAMERA_API_TOKEN_FILE:-}" ]; then
  TOKEN="$(tr -d '[:space:]' < "$CAMERA_API_TOKEN_FILE")"; TOKEN_SRC="file:$CAMERA_API_TOKEN_FILE"
elif [ -r /etc/mbfd/cameras-api-token ]; then
  TOKEN="$(tr -d '[:space:]' < /etc/mbfd/cameras-api-token)"; TOKEN_SRC="file:/etc/mbfd/cameras-api-token"
fi

# Fail-closed: no token, no config. Never write a template with the placeholder
# or an empty token to a live path.
if [ -z "$TOKEN" ]; then
  echo "render-config: no camera API token found (set CAMERA_API_TOKEN or CAMERA_API_TOKEN_FILE)" >&2
  exit 78
fi

# Validate format: 32-128 hex chars only. Prevents nginx directive injection
# (a token containing ;, #, {, }, whitespace, or quotes would break or mutate
# the rendered config).
if ! printf '%s' "$TOKEN" | grep -Eq '^[a-fA-F0-9]{32,128}$'; then
  echo "render-config: token has invalid format (expected 32-128 hex chars); refusing to render" >&2
  exit 65
fi

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
# Replace the placeholder; awk avoids sed escaping issues with special chars.
awk -v tok="$TOKEN" '{ gsub(/__CAMERA_API_TOKEN__/, tok); print }' "$TEMPLATE" > "$tmp"

# Guard: the rendered file must contain the token (render succeeded) and must
# NOT still contain the placeholder.
if grep -q '__CAMERA_API_TOKEN__' "$tmp"; then
  echo "render-config: placeholder remained after render (template bug)" >&2
  exit 70
fi

install -m 0600 "$tmp" "$OUTPUT"
echo "render-config: wrote $OUTPUT (source=$TOKEN_SRC, mode 0600)"

# Optional nginx -t if extra args passed (e.g. "docker exec mbfd-cameras nginx -t")
shift 2 || true
if [ "$#" -gt 0 ]; then
  echo "render-config: running validation: $*"
  "$@" || { echo "render-config: validation failed" >&2; exit 1; }
fi
