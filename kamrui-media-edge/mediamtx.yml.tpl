# MediaMTX configuration — MBFD KAMRUI media edge
#
# SECURITY: physical-source RTSP credentials live only in the rendered mode-0600
# file. The P3 reads the credential-free anpviz-video path, combines that video
# with the locally attached TONOR microphone, and publishes anpviz-main.
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
  # Video-only camera ingest. Never expose this path in a player because the
  # camera's built-in audio is not authoritative.
  anpviz-video:
    source: __ANPVIZ_RTSP_URL__
    sourceProtocol: tcp

  # Canonical P3-published stream: Anpviz H.264 video + TONOR AAC audio.
  anpviz-main:
    source: publisher

  # ZowieBox encoder ingest preserves the HDMI source's embedded AAC audio.
  guest-computer:
    source: __ZOWIEBOX_RTSP_URL__
    sourceProtocol: tcp
