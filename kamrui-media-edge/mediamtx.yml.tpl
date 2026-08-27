# MediaMTX v1.19.3 configuration — MBFD KAMRUI media edge
#
# This committed template is rendered into a root-owned, mode-0600 file. Never
# put physical-source URLs or guest publisher credentials into this file.
#
# Topology:
#   anpviz-video    -> unchanged Anpviz RTSP pull
#   anpviz-main     -> unchanged P3 publisher
#   podium-computer -> ZowieBox RTSP pull
#   guest-computer  -> OBS RTMP publisher

logLevel: info
logDestinations: [stdout]

# The Camera API consumes this only from the same host.
api: true
apiAddress: 127.0.0.1:9997
metrics: false
pprof: false
playback: false
srt: false

# Host networking is intentional for the existing RTSP/HLS/WebRTC topology.
# Bind plaintext RTMP only to the verified wired KAMRUI LAN interface. The
# companion firewall helper permits only the reserved guest computer IPv4.
rtmp: true
rtmpAddress: __KAMRUI_RTMP_ADDRESS__

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
webrtcAdditionalHosts: [__KAMRUI_LAN_IP__, __KAMRUI_TAILSCALE_IP__]
webrtcICEServers2: []

# Authentication applies to every protocol. Preserve existing anonymous reads,
# but never grant an anonymous, unrestricted publish permission.
authMethod: internal
authInternalUsers:
  # Existing HLS/RTSP/WebRTC readers continue to use the protected host route.
  - user: any
    pass:
    ips: []
    permissions:
      - action: read
        path:

  # Existing P3 Anpviz + TONOR publisher, with its established exact peers.
  - user: any
    pass:
    ips: [__P3_PUBLISHER_LAN_IP__, __P3_PUBLISHER_TAILSCALE_IP__]
    permissions:
      - action: publish
        path: anpviz-main

  # New guest OBS publisher. The supplied password is an Argon2/SHA-256 hash,
  # not the password entered into OBS. It cannot publish any other path.
  - user: __GUEST_RTMP_PUBLISHER_USER__
    pass: __GUEST_RTMP_PUBLISHER_PASSWORD_HASH__
    ips: [__GUEST_RTMP_PUBLISHER_LAN_IP__]
    permissions:
      - action: publish
        path: guest-computer

  # The local Camera API keeps its existing path-health access.
  - user: any
    pass:
    ips: ["127.0.0.1", "::1"]
    permissions:
      - action: api

paths:
  # Video-only camera ingest. Never expose this path in a player because the
  # camera's built-in audio is not authoritative.
  anpviz-video:
    source: __ANPVIZ_RTSP_URL__
    rtspTransport: tcp

  # Canonical P3-published stream: Anpviz H.264 video + TONOR AAC audio.
  anpviz-main:
    source: publisher

  # ZowieBox HDMI encoder. MediaMTX must receive a standards-valid AAC SDP;
  # malformed source metadata is repaired at the encoder, not in Media Control.
  podium-computer:
    source: __ZOWIEBOX_RTSP_URL__
    rtspTransport: tcp

  # Guest computer OBS publisher over the LAN-only RTMP listener.
  guest-computer:
    source: publisher
    overridePublisher: false
