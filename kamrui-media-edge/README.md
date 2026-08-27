# MBFD Kamrui Media Edge

Dedicated MBFD media edge for the canonical Anpviz + TONOR classroom source,
the ZowieBox podium source, and a separate OBS-published guest source. It
provides HLS/RTSP, records segmented fMP4, livestreams to PeerTube, syncs
recordings to the GMKtec over LAN (Tailscale fallback), and uploads recordings
privately to PeerTube for review.

The podium/guest topology below is staged source only. It must be deployed only
with Agent 1's matching Media Control source-contract migration; this edge
branch deliberately does not change application, player, or camera API files.

## Architecture

```
Anpviz camera (RTSP H.264)
  -> MediaMTX credential-isolated ingest: anpviz-video
     -> P3 publisher copies H.264 video + captures only TONOR G11
        -> drift-corrected AAC mono, 48 kHz -> anpviz-main
           -> HLS (:8888) + RTSP (:8554) + RTMP (:1935) + WebRTC (:8889)

ZowieBox (HDMI H.264/AAC)
  -> MediaMTX direct pull: podium-computer

Guest computer (OBS H.264/AAC)
  -> RTMP, LAN-only: guest-computer

Camera API and Media Control source identity migration
  -> coordinated application release owned outside this edge branch

Camera Control API (Node.js, :8200)
  -> /api/sources/anpviz/heartbeat  authenticated P3 publisher health
  -> /api/status                    canonical source and signal health
  -> /api/record/start|stop      independent FFmpeg segment recorder
  -> /api/stream/start|stop      independent FFmpeg -> PeerTube RTMP push
  -> /api/emergency-stop
  -> /api/recordings/:id/sync   rsync -> GMKtec LAN-primary, SHA-256 verify
  -> /api/recordings/:id/upload PeerTube private upload (privacy=3)
  -> /api/recordings/:id/publish privacy change (private->unlisted->public)
```

## Podium and guest staging contract

`docker-compose.mediamtx.yml` pins the read-only-observed MediaMTX v1.19.3 OCI
index digest. The running container is not changed by this source update; a
future approved deployment recreates only the `mediamtx` service from that exact
digest.

The rendered MediaMTX configuration keeps the existing anonymous `read` access
for HLS/RTSP/WebRTC readers, keeps the P3 Anpviz publisher only on
`anpviz-main` and only from its established LAN/Tailscale identities, and gives
the guest OBS publisher only `publish` permission on `guest-computer`. There is
no anonymous, unrestricted `publish` permission. The rendered guest password is
an Argon2id (preferred) or SHA-256 hash; it is not the plaintext entered into
OBS.

RTMP stays plaintext by design only inside the LAN: MediaMTX binds `1935` to
`KAMRUI_LAN_IP`, never `0.0.0.0` or the Tailscale interface. The future upgrade
adds only the exact `GUEST_RTMP_PUBLISHER_LAN_IP -> KAMRUI_LAN_IP:1935/tcp` UFW
rule. Do not use the older `ufw-apply` helper for this operation: it resets the
host firewall and is outside this narrowly scoped rollout.

### Mandatory Guest Laptop wired-LAN acceptance

The intended physical topology is fixed: **Guest Laptop -> USB/USB-C Ethernet
dongle -> Ethernet cable -> TRENDnet 10 Gb switch -> KAMRUI**. The same switch
also connects GMKtec and the P3. Do not replace it with a direct laptop link
unless evidence identifies a physical-network fault.

Before configuring the actual OBS profile or sending any Guest RTMP media, run
the read-only collector on the Guest Laptop while its wired dongle is connected:

The collector has a required companion policy file. From a checkout of this
branch, both files are already present under `scripts`. If transferring them to
the laptop manually, copy both `collect-guest-laptop-network.ps1` and
`guest-network-adapter-policy.ps1` into the same folder. Do not copy only the
collector.

```powershell
.\scripts\collect-guest-laptop-network.ps1 -AdapterName '<wired adapter name>' -KamruiIp 192.168.1.122 -OutputPath .\guest-network-acceptance.json
```

`192.168.1.122` was the read-only-observed KAMRUI Ethernet IPv4 on 2026-08-27;
it is DHCP-derived, so confirm it again in the approved maintenance window.
The collector reads the NIC/dongle identity and driver, link speed, duplex
setting, IPv4/prefix/gateway/DNS, MTU, interface metric and route, Wi-Fi state,
adapter counters, power policy, sleep/hibernate policy, and relevant recent
Windows events. It sends only ICMP echo and a TCP connect to `:1935`; it does
not publish RTMP or alter any Windows setting.

Acceptance requires a route to KAMRUI through the selected Ethernet adapter,
stable loss-free baseline, at least 1 Gbps full duplex (or an investigated
exception), zero/near-zero counter errors, TCP/1935 reachability after the
scheduled MediaMTX/firewall change, no unsafe Wi-Fi route competition, and no
NIC/sleep power-down risk. Standard MTU is retained: a 10 Gb switch does not
justify jumbo frames. A 1 Gbps full-duplex dongle is more than sufficient for
the approximately 6 Mbps stream; a 100 Mbps result must be investigated.

Obtain a DHCP reservation before entering `GUEST_RTMP_PUBLISHER_LAN_IP`; do not
hard-code an address or create a conflict. The DHCP server, not the laptop,
authoritatively proves that reservation. If Wi-Fi remains enabled, retain the
captured Ethernet route and metric; for the dedicated presentation role,
disabling Wi-Fi before the presentation is preferred. Do not change routes while
a stream is active.

### OBS baseline for the guest computer

- Video: `1920x1080`, 30 FPS; H.264; CBR about `6000 Kbps`; keyframe interval
  `2 seconds`. Use a stable H.264 hardware encoder when it has been proven on
  that computer, otherwise use the OBS software H.264 encoder.
- Audio: `48 kHz`, stereo, AAC at `160 Kbps` (128 Kbps is the lower acceptable
  baseline).
- Stream service: **Custom**. Server:
  `rtmp://<KAMRUI_LAN_IP>:1935`; stream key:
  `guest-computer?user=<URL-encoded-user>&pass=<URL-encoded-plaintext-password>`.
  The plaintext is stored only in OBS; `camera.env` contains its one-way hash.
- Require a DHCP reservation for the guest computer before populating
  `GUEST_RTMP_PUBLISHER_LAN_IP`. A Tailscale address, a CIDR, or an arbitrary
  LAN host is not an acceptable substitute.

### ZowieBox AAC repair boundary

`config=1690` decodes as AAC-LC with sampling-frequency index 13, which is
reserved/invalid; it is not a Media Control compatibility issue. Historical
release evidence (not current-state proof) ties the condition to a laptop that
had HDMI video but no HDMI audio. The smallest safe source-side repair is to
retain/restore **Line In**, AAC, 48 kHz stereo, about 128 Kbps while HDMI carries
the podium video. Switch to HDMI audio only after the podium computer is known
to provide 48 kHz stereo LPCM and a direct protected RTSP SDP capture advertises
valid AAC-LC 48 kHz stereo (`config=1190`).

The installed ZowieBox model and firmware are not currently substantiated, so
this branch deliberately does not recommend a firmware update or change any
device setting. During an approved hardware window, capture the model, firmware,
audio-source selection, and redacted SDP before changing the source. If `1690`
persists, stop and preserve the evidence for the vendor rather than adding a
player/parser workaround.

Recordings are stored on the dedicated 1.7 TB data drive `/mnt/data/recordings`
(30-minute fMP4 segments), finalized, SHA-256 checksummed, validated with
ffprobe, and synchronized to the GMKtec over LAN (Tailscale fallback) with
checksum verification. A recording is marked `syncVerified=true` only when the
remote SHA-256 matches the local checksum.

Recording supervision defaults to the dedicated, least-privilege systemd unit.
The unit keeps a validated Bash runner as its main process and binds the exact
direct FFmpeg child through a session-scoped PID file, command line, parent PID,
and session nonce. On an intentional stop the runner forwards one SIGINT, waits
up to 40 seconds, and returns success only after ffprobe validates the final MP4;
systemd enforces a 45-second hard ceiling. Unexpected FFmpeg exit 255 remains a
failed unit rather than being globally allowlisted.
An optional Docker backend can be selected with `RECORDING_BACKEND=docker` and
an immutable `RECORDING_DOCKER_IMAGE` digest. Its durable identity binds the
full container and image IDs, command, session nonce, labels, non-root user,
host network, recording mount, and confinement settings. Startup re-adoption
and stop both fail closed if that identity changes or Docker is unavailable.

## Security

- Anpviz RTSP credentials live ONLY in `/etc/mbfd/media-stack/camera.env` and
  the generated mode-0600 `/opt/mbfd/media-stack/mediamtx.yml`
  (mode 0600). No camera credential appears in any FFmpeg process argument,
  systemd status, or log.
- API token + PeerTube token + RTMP stream key live in
  `/etc/mbfd/media-stack/camera.env` (mode 0600). Never committed.
- The guest publisher plaintext is held only in the guest OBS profile. KAMRUI
  stores only `GUEST_RTMP_PUBLISHER_PASSWORD_HASH`; MediaMTX verifies it using
  its internal Argon2/SHA-256 support.
- UFW: deny incoming by default; SSH from Tailscale + LAN; media ports 8200/8888
  from the GMKtec only, plus port 8200 from the exact P3 LAN/Tailscale identities
  for authenticated publisher heartbeats. TCP/1935 is a separate exact-source
  rule for the guest computer only, never a subnet-wide or Tailscale rule.
- Least-privilege sudo via `/usr/local/sbin/mbfd-media-admin` (root-owned,
  allowlisted subcommands only, operator use only).
- Recording administration uses a **root-owned recording broker** reached
  through a peer-verified Unix socket (`/run/mbfd-recording-broker/broker.sock`).
  systemd socket activation creates the socket with `SocketGroup=mbfd-camera-api`
  and `SocketMode=0660`; the broker verifies `SO_PEERCRED` on every connection
  and rejects any peer whose UID is not the dedicated `mbfd-camera-api` system
  user. The broker accepts a bounded JSON protocol with an exact allowlist of
  `start`, `stop`, `status`, `reconcile`, and `finalize` operations. No shell,
  no arbitrary executable, no arbitrary path, no arbitrary environment, no
  wildcard sudoers grant. The camera API service retains `NoNewPrivileges=true`.
- Stale recording state is reconciled through the broker's 7-way classification:
  `ACTIVE`, `FINALIZING`, `RECOVERABLE`, `ORPHANED_METADATA`,
  `FAILED_WITH_MEDIA`, `FAILED_WITHOUT_MEDIA`, `UNKNOWN`. Stale state is cleared
  only when all authoritative evidence (systemd unit, PID, executable, media
  fragments) proves no process or recoverable media exists.
- The Docker recording backend is optional because Docker daemon access is
  privileged. Its FFmpeg container drops all capabilities, uses a read-only
  root filesystem and `no-new-privileges`, and bind-mounts only the recording
  root read-write.
- Docker is not installed via curl-pipe-shell-as-root. The installer requires a
  pre-existing, verified Docker installation or fails closed.

## Provisioning

See `scripts/install.sh`. Runtime secrets are provisioned into
`/etc/mbfd/media-stack/camera.env` (see `.env.example`); `mediamtx.yml` is
generated from `mediamtx.yml.tpl` with physical RTSP URLs and protected publisher
policy values substituted at install time and set to mode 0600.

Before an approved podium/guest deployment, set the exact wired KAMRUI address,
the existing P3 addresses, and a DHCP-reserved guest LAN IPv4. Generate an
Argon2id hash without placing the OBS plaintext in `camera.env`, for example on
a secured administrator shell:

```bash
printf %s "$GUEST_OBS_PASSWORD" | argon2 "a-unique-random-salt" -id -l 32 -e
```

Prefix the output with `argon2:` in `GUEST_RTMP_PUBLISHER_PASSWORD_HASH`.
MediaMTX v1.19.3 parses the complete configuration only while starting listeners
and source pulls; Compose validation is not a semantic MediaMTX check. Validate
the rendered configuration with the pinned image in an isolated staging host or
network namespace before using the active deployment command.

## Podium / Guest live-source cutover

For this podium/Guest feature, use the dedicated
[`scripts/deploy-live-sources-cutover.sh`](scripts/deploy-live-sources-cutover.sh)
workflow and its [operator procedure](docs/live-sources-cutover.md). It creates
a fresh manifest-backed rollback snapshot, renders and validates privately,
replaces only MediaMTX's configuration and Compose definition, recreates only
MediaMTX, verifies the path contract, and only then adds the exact Guest RTMP
rule.

For this feature, **never use `scripts/upgrade.sh deploy`**. That general
workflow remains in the repository for separately authorized maintenance but
has a broader scope than this classroom source cutover. The dedicated workflow
does not deploy the Camera API, Media Control, recording components, or any
other service. It cannot substitute for Agent 3's application-release and
physical-acceptance gates.

## Owner

Reconciled into the authoritative Media Control repository (branch
`camera-reconcile-085c938-20260725`). Media Control proxies camera operations to
this edge via `server/lib/camera-control-client.js`.
