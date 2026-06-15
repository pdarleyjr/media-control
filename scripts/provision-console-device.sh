#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run with sudo: sudo ./scripts/provision-console-device.sh" >&2
  exit 1
fi

CONFIG_DIR="/etc/mbfd/media-control-console"
CONFIG_FILE="${CONFIG_DIR}/config.env"
install -d -m 0755 "${CONFIG_DIR}"

ROOM_ID="${ROOM_ID:-classroom-1}"
DEVICE_ID="${DEVICE_ID:-classroom-1-podium-console}"
CONSOLE_URL="${MBFD_CONSOLE_URL:-https://media-control.mbfdhub.com/console/${ROOM_ID}}"
ADMIN_PIN="${ADMIN_PIN:-$(openssl rand -hex 3 2>/dev/null || date +%H%M%S)}"
DEVICE_TOKEN="${DEVICE_TOKEN:-optional-internal-device-token}"

cat >"${CONFIG_FILE}" <<EOF
MBFD_CONSOLE_URL=${CONSOLE_URL}
MBFD_HUB_API_URL=${MBFD_HUB_API_URL:-https://hub.mbfdhub.com/api}
MBFD_HUB_WS_URL=${MBFD_HUB_WS_URL:-wss://hub.mbfdhub.com/reverb}
ROOM_ID=${ROOM_ID}
DEVICE_ID=${DEVICE_ID}
DEFAULT_PROFILE=${DEFAULT_PROFILE:-guest}
DEVICE_TOKEN=${DEVICE_TOKEN}
ALLOWED_HOSTS=${ALLOWED_HOSTS:-media-control.mbfdhub.com,hub.mbfdhub.com,localhost,127.0.0.1}
KIOSK_MODE=${KIOSK_MODE:-true}
ADMIN_PIN=${ADMIN_PIN}
ENABLE_DEVTOOLS=${ENABLE_DEVTOOLS:-false}
PODIUM_AGENT_PORT=${PODIUM_AGENT_PORT:-8755}
EOF

chgrp mbfdkiosk "${CONFIG_FILE}" 2>/dev/null || true
chmod 0640 "${CONFIG_FILE}"
echo "Wrote ${CONFIG_FILE}"
echo "Admin PIN: ${ADMIN_PIN}"
