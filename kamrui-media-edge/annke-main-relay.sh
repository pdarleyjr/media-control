#!/usr/bin/env bash
# ANNKE main stream relay — reads the credential-free local raw path produced
# by MediaMTX and republishes an AAC-converted stream to annke-main.
# No camera credential appears in this process's command line.
set -euo pipefail
exec /usr/bin/ffmpeg \
  -nostdin -hide_banner -loglevel warning \
  -timeout 15000000 \
  -rtsp_transport tcp \
  -i "rtsp://127.0.0.1:8554/annke-raw-main" \
  -map 0:v:0 -map '0:a:0?' \
  -c:v copy \
  -c:a aac -ar 48000 -ac 1 -b:a 96k \
  -af aresample=async=1:first_pts=0 \
  -max_muxing_queue_size 1024 \
  -f rtsp -rtsp_transport tcp \
  rtsp://127.0.0.1:8554/annke-main
