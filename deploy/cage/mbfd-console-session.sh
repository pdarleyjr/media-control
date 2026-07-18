#!/usr/bin/env bash
set -euo pipefail

export XDG_SESSION_TYPE=wayland
export ELECTRON_OZONE_PLATFORM_HINT="${ELECTRON_OZONE_PLATFORM_HINT:-auto}"
export ELECTRON_ENABLE_LOGGING="${ELECTRON_ENABLE_LOGGING:-1}"
export MALLOC_ARENA_MAX="${MALLOC_ARENA_MAX:-2}"

disconnect_grace="${MBFD_DISPLAY_DISCONNECT_GRACE_SECONDS:-15}"
cage_pid=""

display_connected() {
  grep -qs '^connected$' /sys/class/drm/card*-*/status
}

cage_running() {
  [[ -n "${cage_pid}" ]] || return 1
  kill -0 "${cage_pid}" 2>/dev/null || return 1
  # kill -0 also succeeds for zombies. Without this check, a dead Cage child
  # leaves the wrapper and systemd looking healthy forever while the screen is
  # no longer running the console.
  [[ "$(awk '{print $3}' "/proc/${cage_pid}/stat" 2>/dev/null || true)" != "Z" ]]
}

stop_cage() {
  if cage_running; then
    kill -TERM "${cage_pid}" 2>/dev/null || true
    wait "${cage_pid}" 2>/dev/null || true
  fi
  cage_pid=""
}

trap 'stop_cage; exit 0' TERM INT EXIT

while true; do
  until display_connected; do
    sleep 2
  done

  nice -n 5 ionice -c 2 -n 7 cage -d -- /opt/mbfd/media-control-console/mbfd-media-control-console &
  cage_pid="$!"
  disconnected_at=0

  while cage_running; do
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
