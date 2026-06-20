#!/usr/bin/env bash
set -euo pipefail

export XDG_SESSION_TYPE=wayland
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"
export ELECTRON_ENABLE_LOGGING="${ELECTRON_ENABLE_LOGGING:-1}"

disconnect_grace="${MBFD_DISPLAY_DISCONNECT_GRACE_SECONDS:-15}"
cage_pid=""

display_connected() {
  grep -qs '^connected$' /sys/class/drm/card*-*/status
}

stop_cage() {
  if [[ -n "${cage_pid}" ]] && kill -0 "${cage_pid}" 2>/dev/null; then
    kill -TERM "${cage_pid}" 2>/dev/null || true
    wait "${cage_pid}" 2>/dev/null || true
  fi
  cage_pid=""
}

trap 'stop_cage; exit 0' TERM INT EXIT

while true; do
  until display_connected; do sleep 2; done

  cage -d -- /opt/mbfd/media-control-console/mbfd-media-control-console &
  cage_pid="$!"
  disconnected_at=0

  while kill -0 "${cage_pid}" 2>/dev/null; do
    if display_connected; then
      disconnected_at=0
    else
      now="$(date +%s)"
      if (( disconnected_at == 0 )); then
        disconnected_at="${now}"
      elif (( now - disconnected_at >= disconnect_grace )); then
        stop_cage
        break
      fi
    fi
    sleep 2
  done

  wait "${cage_pid}" 2>/dev/null || true
  cage_pid=""
  sleep 2
done
