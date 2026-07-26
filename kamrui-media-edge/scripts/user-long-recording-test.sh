#!/usr/bin/env bash
# User-run only. Codex/automation must not invoke this long-duration harness.
set -euo pipefail

fail() { echo "ERROR: $*" >&2; exit 2; }

[[ "${MBFD_USER_AUTHORIZED_LONG_TEST:-}" == "YES" ]] \
  || fail "Set MBFD_USER_AUTHORIZED_LONG_TEST=YES after confirming the room is idle."
[[ "${LONG_TEST_DURATION_SECONDS:-}" =~ ^[0-9]+$ ]] \
  || fail "Set LONG_TEST_DURATION_SECONDS explicitly (for example 3600)."
(( LONG_TEST_DURATION_SECONDS >= 60 && LONG_TEST_DURATION_SECONDS <= 14400 )) \
  || fail "LONG_TEST_DURATION_SECONDS must be between 60 and 14400."

sample_interval="${LONG_TEST_SAMPLE_INTERVAL_SECONDS:-10}"
[[ "$sample_interval" =~ ^[0-9]+$ ]] && (( sample_interval >= 2 && sample_interval <= 60 )) \
  || fail "LONG_TEST_SAMPLE_INTERVAL_SECONDS must be between 2 and 60."

# The bearer is read from a protected file and copied into a mode-0600 curl
# config. It is never put in curl's argv or printed. Provision this file with:
#   install -m 0600 /dev/stdin /run/user/$UID/mbfd-camera-api.token
: "${CAMERA_API_TOKEN_FILE:?Set CAMERA_API_TOKEN_FILE to a protected token file}"
[[ -f "$CAMERA_API_TOKEN_FILE" ]] || fail "CAMERA_API_TOKEN_FILE does not exist."
token_mode="$(stat -c '%a' "$CAMERA_API_TOKEN_FILE")"
(( (8#$token_mode & 077) == 0 )) || fail "CAMERA_API_TOKEN_FILE must not be group/world accessible."

api_base="${CAMERA_API_BASE_URL:-http://127.0.0.1:8200}"
report_root="${LONG_TEST_REPORT_DIR:-$PWD/long-test-reports}"
started_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
run_dir="$report_root/recording-long-test-${started_utc//:/-}-$$"
mkdir -p "$run_dir"
chmod 0700 "$run_dir"
samples="$run_dir/samples.jsonl"
json_report="$run_dir/report.json"
markdown_report="$run_dir/report.md"
: >"$samples"
chmod 0600 "$samples"

curl_config="$(mktemp)"
cleanup() {
  rm -f -- "$curl_config"
}
trap cleanup EXIT
token="$(<"$CAMERA_API_TOKEN_FILE")"
[[ -n "$token" ]] || fail "CAMERA_API_TOKEN_FILE is empty."
printf 'header = "X-Api-Token: %s"\nheader = "Content-Type: application/json"\n' "$token" >"$curl_config"
chmod 0600 "$curl_config"
unset token

curl_api() {
  curl --config "$curl_config" --fail --silent --show-error \
    --connect-timeout 5 --max-time 120 "$@"
}
json_field() {
  local expression="$1"
  node -e "const x=JSON.parse(require('fs').readFileSync(0,'utf8')); ${expression}"
}

status_before="$(curl_api "$api_base/api/status")"
active="$(json_field "process.stdout.write(String(Boolean(x.recording||x.livestreaming)))" <<<"$status_before")"
[[ "$active" == "false" ]] || fail "A recording or livestream is already active."

start_json="$(curl_api -X POST -H "X-Idempotency-Key: long-test-start-${started_utc}-$$" "$api_base/api/record/start")"
session_id="$(json_field "if(!x.session_id)process.exit(1); process.stdout.write(x.session_id)" <<<"$start_json")"
[[ "$session_id" =~ ^ses_[A-Za-z0-9_-]+$ ]] || fail "Camera API returned an invalid session ID."

start_epoch="$(date +%s)"
deadline=$((start_epoch + LONG_TEST_DURATION_SECONDS))
previous_size=0
api_restart_observed=false
api_outages=0
supervisor_failures=0
stop_requested=0
stopped=0
trap 'stop_requested=1' INT TERM

stop_if_needed() {
  if (( stopped == 0 )); then
    curl_api -X POST -H "X-Idempotency-Key: long-test-stop-$session_id" \
      "$api_base/api/record/stop" >/dev/null 2>&1 || true
  fi
}
trap 'stop_if_needed; cleanup' EXIT

echo "Session ID: $session_id"
echo "Recording for up to $LONG_TEST_DURATION_SECONDS seconds; Ctrl+C requests a safe stop."
echo "Samples: $samples"

while (( $(date +%s) < deadline && stop_requested == 0 )); do
  now_epoch="$(date +%s)"
  elapsed_seconds=$((now_epoch - start_epoch))
  sample_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

  status_json=''
  if status_json="$(curl_api "$api_base/api/status" 2>/dev/null)"; then
    camera_source_healthy="$(json_field "process.stdout.write(String(x.camera_online===true))" <<<"$status_json" 2>/dev/null || echo false)"
    api_available=true
  else
    api_available=false
    camera_source_healthy=false
    api_restart_observed=true
    api_outages=$((api_outages + 1))
  fi

  active_dir="/mnt/data/recordings/active/$session_id"
  current_segment="$(find "$active_dir" -maxdepth 1 -type f -name '*.mp4' -printf '%T@ %p\n' 2>/dev/null \
    | sort -n | tail -1 | cut -d' ' -f2- || true)"
  file_size_bytes="$(find "$active_dir" -maxdepth 1 -type f -name '*.mp4' -printf '%s\n' 2>/dev/null \
    | awk '{total += $1} END {print total + 0}')"
  video_track_healthy=false
  audio_track_healthy=false
  if [[ -n "$current_segment" && -f "$current_segment" ]]; then
    track_probe="$(ffprobe -v error -show_entries stream=codec_type,codec_name -of json "$current_segment" 2>/dev/null || echo '{}')"
    video_track_healthy="$(json_field "process.stdout.write(String((x.streams||[]).some(s=>s.codec_type==='video'&&s.codec_name==='h264')))" <<<"$track_probe" 2>/dev/null || echo false)"
    audio_track_healthy="$(json_field "process.stdout.write(String((x.streams||[]).some(s=>s.codec_type==='audio'&&s.codec_name==='aac')))" <<<"$track_probe" 2>/dev/null || echo false)"
  fi
  growth_bytes=$((file_size_bytes - previous_size))
  previous_size=$file_size_bytes
  free_space_bytes="$(df -PB1 /mnt/data/recordings | awk 'NR==2 {print $4}')"

  supervisor_status="$(sudo -n /usr/local/sbin/mbfd-recording-admin status "$session_id" 2>/dev/null || true)"
  supervisor_validated=false
  ffmpeg_pid=''
  if grep -Fqx 'Validated=yes' <<<"$supervisor_status"; then
    supervisor_validated=true
    ffmpeg_pid="$(awk -F= '$1=="MainPID" {print $2}' <<<"$supervisor_status")"
  else
    supervisor_failures=$((supervisor_failures + 1))
  fi
  supervisor_state="$(awk -F= '
    $1=="ActiveState" {active=$2}
    $1=="SubState" {sub=$2}
    $1=="MainPID" {pid=$2}
    END {printf "%s/%s/%s", active, sub, pid}
  ' <<<"$supervisor_status")"
  [[ -n "$supervisor_state" && "$supervisor_state" != "//" ]] || supervisor_state="unvalidated"
  cpu_percent=0
  ram_bytes=0
  if [[ "$ffmpeg_pid" =~ ^[0-9]+$ ]]; then
    cpu_percent="$(ps -p "$ffmpeg_pid" -o %cpu= | xargs || echo 0)"
    rss_kib="$(ps -p "$ffmpeg_pid" -o rss= | xargs || echo 0)"
    ram_bytes=$(( ${rss_kib:-0} * 1024 ))
  fi
  temperature_c=null
  if [[ -r /sys/class/thermal/thermal_zone0/temp ]]; then
    raw_temp="$(< /sys/class/thermal/thermal_zone0/temp)"
    [[ "$raw_temp" =~ ^[0-9]+$ ]] && temperature_c="$(awk "BEGIN {printf \"%.1f\", $raw_temp/1000}")"
  fi

  SAMPLE_UTC="$sample_utc" SESSION_ID="$session_id" ELAPSED_SECONDS="$elapsed_seconds" \
  CURRENT_SEGMENT="$current_segment" SUPERVISOR_STATE="$supervisor_state" \
  SUPERVISOR_VALIDATED="$supervisor_validated" FFMPEG_PID="$ffmpeg_pid" \
  VIDEO_TRACK_HEALTHY="$video_track_healthy" AUDIO_TRACK_HEALTHY="$audio_track_healthy" \
  FILE_SIZE_BYTES="$file_size_bytes" GROWTH_BYTES="$growth_bytes" FREE_SPACE_BYTES="$free_space_bytes" \
  CAMERA_SOURCE_HEALTHY="$camera_source_healthy" CPU_PERCENT="$cpu_percent" RAM_BYTES="$ram_bytes" \
  TEMPERATURE_C="$temperature_c" API_AVAILABLE="$api_available" API_RESTART_OBSERVED="$api_restart_observed" \
    node -e '
      const e=process.env;
      const number=(v)=>Number.isFinite(Number(v))?Number(v):null;
      process.stdout.write(JSON.stringify({
        sampled_at:e.SAMPLE_UTC, session_id:e.SESSION_ID,
        elapsed_seconds:number(e.ELAPSED_SECONDS), current_segment:e.CURRENT_SEGMENT||null,
        supervisor_state:e.SUPERVISOR_STATE,
        supervisor_validated:e.SUPERVISOR_VALIDATED==="true",
        ffmpeg_pid:number(e.FFMPEG_PID),
        video_track_healthy:e.VIDEO_TRACK_HEALTHY==="true",
        audio_track_healthy:e.AUDIO_TRACK_HEALTHY==="true",
        file_size_bytes:number(e.FILE_SIZE_BYTES), growth_bytes:number(e.GROWTH_BYTES),
        free_space_bytes:number(e.FREE_SPACE_BYTES),
        camera_source_healthy:e.CAMERA_SOURCE_HEALTHY==="true",
        cpu_percent:number(e.CPU_PERCENT), ram_bytes:number(e.RAM_BYTES),
        temperature_c:number(e.TEMPERATURE_C),
        api_available:e.API_AVAILABLE==="true",
        api_restart_observed:e.API_RESTART_OBSERVED==="true"
      })+"\\n");
    ' >>"$samples"

  printf 'elapsed=%ss segment=%s supervisor=%s tracks(video=%s audio=%s) growth=%sB free=%sB camera=%s cpu=%s%% ram=%sB temp=%sC api=%s\n' \
    "$elapsed_seconds" "${current_segment:-none}" "$supervisor_state" "$video_track_healthy" \
    "$audio_track_healthy" "$growth_bytes" "$free_space_bytes" "$camera_source_healthy" \
    "$cpu_percent" "$ram_bytes" "$temperature_c" "$api_available"
  # SIGINT sets stop_requested; do not let an interrupted sleep bypass the
  # normal stop/finalize/report path under set -e.
  sleep "$sample_interval" || true
done

echo "Stopping $session_id safely and waiting for finalization..."
stop_json=''
for _attempt in $(seq 1 30); do
  if stop_json="$(curl_api -X POST -H "X-Idempotency-Key: long-test-stop-$session_id" \
      "$api_base/api/record/stop" 2>/dev/null)"; then
    break
  fi
  api_restart_observed=true
  api_outages=$((api_outages + 1))
  sleep 2
done
[[ -n "$stop_json" ]] || fail "failure_code=stop_or_finalization_unavailable session_id=$session_id"
stopped=1

metadata=''
for _attempt in $(seq 1 30); do
  if metadata="$(curl_api "$api_base/api/recordings/$session_id" 2>/dev/null)"; then break; fi
  sleep 2
done
[[ -n "$metadata" ]] || fail "failure_code=metadata_unavailable session_id=$session_id"
file_path="$(json_field "if(!x.filePath)process.exit(1); process.stdout.write(x.filePath)" <<<"$metadata")"

probe_json="$(ffprobe -v error -show_entries format=duration,size \
  -show_entries stream=codec_type,codec_name,width,height -of json "$file_path" 2>/dev/null || echo '{}')"
actual_sha="$(sha256sum "$file_path" | awk '{print $1}')"
metadata_sha="$(json_field "process.stdout.write(x.sha256||'')" <<<"$metadata")"
failure_code=''
if [[ -z "$metadata_sha" || "$actual_sha" != "$metadata_sha" ]]; then
  failure_code='checksum_mismatch'
fi
probe_healthy="$(json_field "const s=x.streams||[]; const ok=Number(x.format?.duration)>0&&Number(x.format?.size)>0&&s.some(v=>v.codec_type==='video'&&v.codec_name==='h264')&&s.some(a=>a.codec_type==='audio'&&a.codec_name==='aac'); process.stdout.write(String(ok))" <<<"$probe_json" 2>/dev/null || echo false)"
if [[ "$probe_healthy" != "true" && -z "$failure_code" ]]; then
  failure_code='probe_invalid'
fi
if (( supervisor_failures > 0 )) && [[ -z "$failure_code" ]]; then
  failure_code='supervisor_unvalidated'
fi

sync_json='{"not_run":true}'
if [[ "${RUN_SYNC_AFTER_TEST:-false}" == "true" ]]; then
  sync_json="$(curl_api -X POST "$api_base/api/recordings/$session_id/sync")"
fi

completed_utc="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
REPORT_SESSION_ID="$session_id" REPORT_STARTED_UTC="$started_utc" REPORT_COMPLETED_UTC="$completed_utc" \
REPORT_DURATION="$LONG_TEST_DURATION_SECONDS" REPORT_FILE_PATH="$file_path" REPORT_SHA="$actual_sha" \
REPORT_METADATA_SHA="$metadata_sha" REPORT_FAILURE_CODE="$failure_code" REPORT_API_RESTART="$api_restart_observed" \
REPORT_API_OUTAGES="$api_outages" REPORT_SUPERVISOR_FAILURES="$supervisor_failures" \
REPORT_METADATA="$metadata" REPORT_PROBE="$probe_json" REPORT_STOP="$stop_json" \
REPORT_SYNC="$sync_json" REPORT_SAMPLES="$samples" REPORT_JSON="$json_report" REPORT_MD="$markdown_report" \
  node <<'NODE'
const fs = require('fs');
const e = process.env;
const samples = fs.readFileSync(e.REPORT_SAMPLES, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const report = {
  schema_version: 1,
  session_id: e.REPORT_SESSION_ID,
  started_utc: e.REPORT_STARTED_UTC,
  completed_utc: e.REPORT_COMPLETED_UTC,
  requested_duration_seconds: Number(e.REPORT_DURATION),
  file_path: e.REPORT_FILE_PATH,
  sha256: e.REPORT_SHA,
  metadata_sha256: e.REPORT_METADATA_SHA,
  checksum_match: e.REPORT_SHA === e.REPORT_METADATA_SHA,
  failure_code: e.REPORT_FAILURE_CODE || null,
  api_restart_observed: e.REPORT_API_RESTART === 'true',
  api_outage_samples: Number(e.REPORT_API_OUTAGES),
  supervisor_unvalidated_samples: Number(e.REPORT_SUPERVISOR_FAILURES),
  stop_response: JSON.parse(e.REPORT_STOP),
  metadata: JSON.parse(e.REPORT_METADATA),
  ffprobe: JSON.parse(e.REPORT_PROBE),
  sync_result: JSON.parse(e.REPORT_SYNC),
  samples,
};
fs.writeFileSync(e.REPORT_JSON, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o400 });
const md = `# MBFD user-run long recording report

- Session: ${report.session_id}
- Started UTC: ${report.started_utc}
- Completed UTC: ${report.completed_utc}
- Requested duration seconds: ${report.requested_duration_seconds}
- File: ${report.file_path}
- SHA-256: ${report.sha256}
- Metadata checksum match: ${report.checksum_match}
- API restart/outage observed: ${report.api_restart_observed}
- Failure code: ${report.failure_code || 'none'}
- Health samples: ${report.samples.length}

The immutable JSON report contains every continuous sample, stop response,
metadata, ffprobe output, and optional sync result. This report is evidence,
not physical classroom audio/video acceptance.
`;
fs.writeFileSync(e.REPORT_MD, md, { flag: 'wx', mode: 0o400 });
NODE
chmod 0444 "$samples" "$json_report" "$markdown_report"

trap - EXIT INT TERM
cleanup
echo "Immutable JSON report: $json_report"
echo "Immutable Markdown report: $markdown_report"
echo "Physically inspect continuous video and intelligible audio before acceptance."
if [[ -n "$failure_code" ]]; then
  echo "failure_code=$failure_code session_id=$session_id" >&2
  exit 10
fi
