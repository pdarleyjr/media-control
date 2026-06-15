#!/usr/bin/env bash
set -euo pipefail

export XDG_SESSION_TYPE=wayland
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"
export ELECTRON_ENABLE_LOGGING="${ELECTRON_ENABLE_LOGGING:-1}"

exec cage -d -- /opt/mbfd/media-control-console/mbfd-media-control-console
