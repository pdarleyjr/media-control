# MBFD Kamrui Media Edge

Dedicated MBFD media edge for the canonical Anpviz + TONOR classroom source and
the signal-gated ZowieBox Guest Computer source. It provides HLS/RTSP, records
segmented fMP4, livestreams to PeerTube, syncs recordings to the GMKtec over LAN
(Tailscale fallback), and uploads recordings privately to PeerTube for review.

## Architecture

```
Anpviz camera (RTSP H.264)
  -> MediaMTX credential-isolated ingest: anpviz-video
     -> P3 publisher copies H.264 video + captures only TONOR G11
        -> drift-corrected AAC mono, 48 kHz -> anpviz-main
           -> HLS (:8888) + RTSP (:8554) + RTMP (:1935) + WebRTC (:8889)

ZowieBox (HDMI H.264/AAC)
  -> MediaMTX direct pull: guest-computer
  -> Camera API polls real HDMI input lock and debounces availability
  -> Media Control keeps one stable source identity and shows it only with signal

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

Recordings are stored on the dedicated 1.7 TB data drive `/mnt/data/recordings`
(30-minute fMP4 segments), finalized, SHA-256 checksummed, validated with
ffprobe, and synchronized to the GMKtec over LAN (Tailscale fallback) with
checksum verification. A recording is marked `syncVerified=true` only when the
remote SHA-256 matches the local checksum.

Recording supervision defaults to the dedicated, least-privilege systemd unit.
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
- UFW: deny incoming by default; SSH from Tailscale + LAN; media ports 8200/8888
  from the GMKtec only, plus port 8200 from the exact P3 LAN/Tailscale identities
  for authenticated publisher heartbeats.
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
generated from `mediamtx.yml.tpl` with the Anpviz and ZowieBox RTSP URLs
substituted at install time and set to mode 0600.

## Rollback / upgrade

See `scripts/upgrade.sh` and `scripts/rollback.sh`.

## Owner

Reconciled into the authoritative Media Control repository (branch
`camera-reconcile-085c938-20260725`). Media Control proxies camera operations to
this edge via `server/lib/camera-control-client.js`.
