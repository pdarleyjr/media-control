#!/usr/bin/env bash
set -euo pipefail

DURATION_SECONDS="${1:-300}"
OUTPUT_DIR="${2:-/tmp/mbfd-performance-$(date -u +%Y%m%dT%H%M%SZ)}"
INTERVAL_SECONDS=5

if ! [[ "${DURATION_SECONDS}" =~ ^[0-9]+$ ]] \
  || (( DURATION_SECONDS < 5 || DURATION_SECONDS > 300 )); then
  echo "Duration must be an integer from 5 through 300 seconds." >&2
  exit 2
fi

mkdir -p "${OUTPUT_DIR}"
SYSTEM_CSV="${OUTPUT_DIR}/system.csv"
CONTAINER_CSV="${OUTPUT_DIR}/containers.csv"
HTTP_CSV="${OUTPUT_DIR}/http.csv"

printf 'timestamp,load1,mem_available_kb,swap_free_kb,tcp_retrans_segs,wal_bytes,max_temp_millic\n' > "${SYSTEM_CSV}"
printf 'timestamp,name,cpu_percent,memory_usage,block_io,network_io,pids\n' > "${CONTAINER_CSV}"
printf 'timestamp,service,http_code,total_seconds\n' > "${HTTP_CSV}"

containers=(
  media-control
  mbfd-media-peertube-peertube-1
  mbfd-media-peertube-postgres-1
  mbfd-media-peertube-redis-1
  mbfd-hub-laravel
  mbfd-hub-pgsql
  mbfd-hub-redis
  mbfd-cameras
  open-webui
)

read_counter() {
  local key="$1"
  awk -v key="${key}" '$1 == key { print $2; found=1 } END { if (!found) print 0 }' /proc/meminfo
}

max_temperature() {
  local maximum=0 value
  for file in /sys/class/thermal/thermal_zone*/temp /sys/class/hwmon/hwmon*/temp*_input; do
    [[ -r "${file}" ]] || continue
    read -r value < "${file}" || continue
    [[ "${value}" =~ ^[0-9]+$ ]] || continue
    (( value > maximum )) && maximum="${value}"
  done
  printf '%s' "${maximum}"
}

http_sample() {
  local timestamp="$1" service="$2" url="$3" max_time="$4"
  local result
  if ! result="$(curl --silent --show-error --output /dev/null --max-time "${max_time}" \
    --write-out '%{http_code},%{time_total}' "${url}" 2>/dev/null)"; then
    [[ "${result}" =~ ^[0-9]{3},[0-9]+([.][0-9]+)?$ ]] || result='000,0.000000'
  fi
  printf '%s,%s,%s\n' "${timestamp}" "${service}" "${result}" >> "${HTTP_CSV}"
}

start_epoch="$(date +%s)"
end_epoch="$((start_epoch + DURATION_SECONDS))"

while (( $(date +%s) < end_epoch )); do
  timestamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  load1="$(awk '{print $1}' /proc/loadavg)"
  mem_available="$(read_counter MemAvailable:)"
  swap_free="$(read_counter SwapFree:)"
  retrans="$(nstat -az TcpRetransSegs 2>/dev/null | awk '$1 == "TcpRetransSegs" {print $2}' | tail -n 1)"
  retrans="${retrans:-0}"
  wal_bytes="$(stat -c %s \
    /mnt/mbfd-storage/docker-data/volumes/media-control_media_control_db/_data/remote_display.db-wal \
    2>/dev/null || printf '0')"
  temperature="$(max_temperature)"
  printf '%s,%s,%s,%s,%s,%s,%s\n' \
    "${timestamp}" "${load1}" "${mem_available}" "${swap_free}" \
    "${retrans}" "${wal_bytes}" "${temperature}" >> "${SYSTEM_CSV}"

  existing=()
  for container in "${containers[@]}"; do
    docker inspect "${container}" >/dev/null 2>&1 && existing+=("${container}")
  done
  if (( ${#existing[@]} > 0 )); then
    docker stats --no-stream \
      --format "${timestamp},{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.BlockIO}},{{.NetIO}},{{.PIDs}}" \
      "${existing[@]}" >> "${CONTAINER_CSV}"
  fi

  remaining="$((end_epoch - $(date +%s)))"
  (( remaining <= 0 )) && break
  probe_timeout=4
  (( remaining < probe_timeout )) && probe_timeout="${remaining}"

  probe_pids=()
  http_sample "${timestamp}" media-control http://127.0.0.1:8096/api/version "${probe_timeout}" &
  probe_pids+=("$!")
  http_sample "${timestamp}" peertube http://127.0.0.1:8098/api/v1/config "${probe_timeout}" &
  probe_pids+=("$!")
  http_sample "${timestamp}" mbfd-hub http://127.0.0.1:8080/up "${probe_timeout}" &
  probe_pids+=("$!")
  http_sample "${timestamp}" ollama http://127.0.0.1:11434/api/tags "${probe_timeout}" &
  probe_pids+=("$!")
  for probe_pid in "${probe_pids[@]}"; do
    wait "${probe_pid}"
  done

  remaining="$((end_epoch - $(date +%s)))"
  (( remaining <= 0 )) && break
  (( remaining < INTERVAL_SECONDS )) && sleep "${remaining}" || sleep "${INTERVAL_SECONDS}"
done

printf 'completed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "${OUTPUT_DIR}/COMPLETE"
printf '%s\n' "${OUTPUT_DIR}"
