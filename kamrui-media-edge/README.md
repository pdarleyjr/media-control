# MBFD Kamrui Media Edge

Dedicated MBFD media-edge server: ingests the ANNKE ceiling camera via MediaMTX,
provides HLS/RTSP, records (segmented fMP4), livestreams to PeerTube, syncs
recordings to the GMKtec over LAN (Tailscale fallback), and uploads recordings
privately to PeerTube for review.

## Architecture

```
ANNKE camera (RTSP, G.711 audio)
  -> MediaMTX pulls RTSP (credentials in mode-0600 mediamtx.yml) into annke-raw-*
     -> FFmpeg relay reads credential-free local rtsp://127.0.0.1:8554/annke-raw-*
        (no camera credential in any process argument)
        -> republishes AAC-converted stream to annke-main / annke-preview
           -> HLS (:8888)  +  RTSP (:8554)  +  RTMP (:1935)  +  WebRTC (:8889)

Camera Control API (Node.js, :8200)
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

- Camera RTSP credentials live ONLY in `/etc/mbfd/media-stack/mediamtx.yml`
  (mode 0600). No camera credential appears in any FFmpeg process argument,
  systemd status, or log.
- API token + PeerTube token + RTMP stream key live in
  `/etc/mbfd/media-stack/camera.env` (mode 0600). Never committed.
- UFW: deny incoming by default; SSH from Tailscale + LAN; media ports 8200/8888
  only from the GMKtec LAN address.
- Least-privilege sudo via `/usr/local/sbin/mbfd-media-admin` (root-owned,
  allowlisted subcommands only).
- The Docker recording backend is optional because Docker daemon access is
  privileged. Its FFmpeg container drops all capabilities, uses a read-only
  root filesystem and `no-new-privileges`, and bind-mounts only the recording
  root read-write.

## Provisioning

See `scripts/install.sh`. Runtime secrets are provisioned into
`/etc/mbfd/media-stack/camera.env` (see `.env.example`); `mediamtx.yml` is
generated from `mediamtx.yml.tpl` with the ANNKE RTSP URLs substituted at
install time and set to mode 0600.

## Rollback / upgrade

See `scripts/upgrade.sh` and `scripts/rollback.sh`.

## Owner

Reconciled into the authoritative Media Control repository (branch
`camera-reconcile-085c938-20260725`). Media Control proxies camera operations to
this edge via `server/lib/camera-control-client.js`.
