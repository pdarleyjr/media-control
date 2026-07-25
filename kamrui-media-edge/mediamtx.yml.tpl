# MediaMTX configuration — MBFD Kamrui media edge (corrective 2026-07-25)
#
# SECURITY: camera RTSP credentials live ONLY in this file (mode 0600, owner
# peter). MediaMTX pulls the ANNKE RTSP sources into local "raw" paths; the
# FFmpeg audio-conversion relays then read the credential-free local raw paths
# (rtsp://127.0.0.1:8554/annke-raw-*) and republish converted AAC streams to
# annke-main / annke-preview. No camera credential appears in any FFmpeg
# process argument, systemd status, or log.
#
# The committed (GitHub) template replaces credentials with placeholders; the
# live values are provisioned at deploy time and never committed.

logLevel: info
logDestinations: [stdout]

api: true
metrics: false
pprof: false
playback: false
srt: false

rtmp: true
rtmpAddress: :1935

rtsp: true
rtspAddress: :8554
rtspTransports: [tcp]

hls: true
hlsAddress: :8888
hlsVariant: lowLatency
hlsSegmentDuration: 1s
hlsPartDuration: 200ms
hlsAlwaysRemux: false

webrtc: true
webrtcAddress: :8889
webrtcLocalUDPAddress: :8189
webrtcIPsFromInterfaces: false
webrtcAdditionalHosts: [192.168.1.122, 100.82.185.48]
webrtcICEServers2: []

paths:
  # Raw pulls from the ANNKE camera (credentials here only; mode 0600 file).
  annke-raw-main:
    source: __ANNKE_MAIN_RTSP_URL__
    sourceProtocol: tcp
  annke-raw-preview:
    source: __ANNKE_PREVIEW_RTSP_URL__
    sourceProtocol: tcp
  # Credential-free local republished paths (AAC-converted) for HLS/API/MC.
  annke-main:
    source: publisher
  annke-preview:
    source: publisher
