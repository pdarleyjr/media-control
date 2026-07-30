# Anpviz, TONOR, and ZowieBox production release

Evidence date: 2026-07-30

Release version: 1.8.0

Baseline production commit: `ab87e5cc8da012bec69c0c54e86f856ccdf38fc0`

Release branch: `fix/anpviz-tonor-zowiebox-20260730`

This document is the discovery report, implementation record, controlled
cutover runbook, and acceptance ledger for the Classroom 1 live-source change.
It never treats a source test or emulated browser as proof of a physical TV,
audible speaker, touch panel, HDMI audio signal, or measured clap test.

## Release status

At the time this record was created, the complete source change and isolated
hardware candidate were green. Production had not yet been cut over because
the KAMRUI host requires one interactive `sudo` action to replace its
root-owned fixed-command helper. The working production stack remains intact.

The final production gate must record:

- the exact release commit, tree, image, and runtime provenance;
- removal of the two obsolete KAMRUI relay units and the P3 `MBFD_Camera1`
  task;
- the two and only two `live_sources` database identities;
- canonical Anpviz and Guest Computer media probes;
- camera API and UI status;
- cameras.mbfdhub.com playback;
- display delivery acknowledgements and restoration;
- restart tests and a one-hour observed sync test.

## Source-of-truth inventory

| Component | Current location or identity | Responsibility |
|---|---|---|
| Media Control source | This repository/worktree | Node API, SQLite, SPA, players, display routing, recording/livestream orchestration |
| Media Control production | GMKtec `/home/mbfd/media-control`, Compose port `8096:3001` | Authenticated operator UI and canonical same-origin player/proxy |
| Camera edge | KAMRUI `/opt/mbfd/media-stack` | MediaMTX, camera API, recording, livestream push, live-source health |
| P3 live publisher | `C:\MBFD\anpviz-tonor` | Pull Anpviz video, capture TONOR, sync/mux, publish `anpviz-main` |
| P3 display/cache runtime | `C:\MBFD\RoomAgent` and `C:\MBFD\FiveDisplayKiosk` | Five classroom outputs and local media cache |
| Camera public UI | `cameras-proxy/` deployed on GMKtec/Tunnel route | Authenticated Anpviz preview using the canonical stream |
| OBS compositor | GMKtec `mbfd-fixed-compositor.service` | Optional camera/content program compositor |
| PeerTube | GMKtec protected ingest at `videos.mbfdhub.com` | Livestream/recording derivative destination |
| Cloudflare | Existing Access and Tunnel configuration | HTTPS/public protection; raw RTSP remains private |

Other Media Control worktrees were inventoried and left unchanged. The
authoritative change is isolated in
`D:\CodexWorktrees\media-control-anpviz-zowiebox-20260730`; no dirty worktree
was reset, cleaned, rebased, or overwritten.

## Last-night change reconciliation

The inspected production baseline includes the 2026-07-29 Media Library
program and subsequent repairs:

| Commit | Change retained by this release |
|---|---|
| `5f9a06e` through `e0e95a8` | Production media pipeline, durable jobs, security boundaries, tablet/library UI, classroom preparation, P3 cache, and deployment provenance |
| `4f23bc7` / merge `d67fb22` | Background wall-window render confirmation |
| `221eebe` / merge `ab87e5c` | Invalid empty transcode-recovery path guard |

The baseline delta added the canonical media pipeline, additive database
migrations, content readiness/preflight, Poster Studio, captions, source
security controls, P3 caching, typed display targets, and extensive tests.
This release preserves those changes. It changes only live-source identity,
camera/guest media plumbing, related UI/player paths, and obsolete-camera
retirement.

## Confirmed physical and logical topology

```text
Anpviz I51HP 192.168.1.226
  H.264 video (camera microphone is never selected)
              \
               \  TP-Link Ethernet switch / Classroom LAN
                \
P3 CLASSROOM 192.168.1.101
  TONOR G11 USB (VID_0D8C, PID_0134)
  FFmpeg: video copy + TONOR AAC 48 kHz mono
  drift correction + configurable delay
                  |
                  | RTSP publish: anpviz-main
                  v
KAMRUI 192.168.1.122
  MediaMTX 8554 / 8888 / 8889
  camera API 8200
  recording + livestream consume only anpviz-main
                  |
                  +--> GMKtec Media Control / cameras.mbfdhub.com
                  +--> P3 display players / walls / canvas / multiview
```

```text
Laptop HDMI
   |
   v
ZowieBox 192.168.1.186
  main/av: H.264 1920x1080 60 fps + its own AAC HDMI/line audio
   |
   | one MediaMTX pull
   v
guest-computer
   |
   +--> dynamic Guest Computer UI tile
   +--> normal tap, mouse drag, touch drag, display/wall/region routing
   +--> Advanced Canvas and Multiview through the same player contract
```

The ZowieBox currently reports HDMI video present but no HDMI audio from the
connected laptop. Its saved Line In audio configuration was restored after a
bounded HDMI-audio experiment proved the missing laptop signal would otherwise
produce malformed AAC. The Guest Computer video remains valid; embedded HDMI
audio will be reported automatically when the source laptop supplies it.

## Network identities and private paths

| Device | Identity | Observed private service |
|---|---|---|
| GMKtec EVO-X2 | `mbfdhub`, LAN `192.168.1.116`, Tailscale `100.81.154.123` | Media Control `8096`, OBS WebSocket `4455`, PeerTube RTMP `19350` |
| Lenovo P3 | `CLASSROOM`, LAN `192.168.1.101`, Tailscale `100.123.92.37` | Publisher scheduled task and five-display runtime |
| KAMRUI | `peter-Default-string`, LAN `192.168.1.122`, Tailscale `100.82.185.48` | RTSP `8554`, HLS `8888`, WebRTC `8889`, camera API `8200` |
| Anpviz | `192.168.1.226` | RTSP channel 101/102; only channel 101 feeds the canonical publisher |
| ZowieBox | `192.168.1.186` | RTSP `/main/av`; management API restricted to the LAN service |

Credentials, raw credential-bearing RTSP URLs, device passwords, signing keys,
heartbeats, and camera API tokens are deliberately omitted.

The Anpviz currently reports `addressingType=dynamic`; a router-side DHCP
reservation was not software-verifiable. The ZowieBox reservation was also not
verified. Do not claim power-cycle address stability until both reservations
are confirmed in the router. The TP-Link switch did not expose a management
plane. KAMRUI negotiated `1000 Mb/s`, full duplex, with zero interface errors;
this proves that host link only, not each hidden switch port or PoE budget.

## Implemented source contract

### Canonical identities

The additive, idempotent `live_sources_schema_v1` migration creates exactly:

- `anpviz`, type `camera`, always visible so failures remain diagnosable;
- `guest-computer`, type `guest_computer`, stable identity but visible only
  after the debounced ZowieBox signal becomes available.

The migration transactionally removes every noncanonical live-source row and
every obsolete camera row. UI catalogs, old players, obsolete Ozolio
resolution, the dead Advanced Canvas camera-frame socket, podium Logitech
camera Compose, ANNKE relay source, and legacy camera labels are removed.
Live News remains available as media, not as camera hardware.

Availability polling persists only stable state changes and one last-seen
refresh per minute. Volatile audio levels and heartbeat timestamps are returned
live but excluded from SQLite, preventing a five-second UI poll from causing
continuous WAL churn.

### Anpviz plus TONOR

`Start-AnpvizTonorPublisher.ps1`:

- verifies the TONOR PnP VID/PID and Windows status;
- re-enumerates the current DirectShow endpoint at each acquisition, so a USB
  disconnect/reconnect does not depend on device order or a stale endpoint
  GUID;
- pulls `anpviz-video` over RTSP/TCP;
- copies H.264 video without transcoding;
- selects only TONOR audio, converts it to AAC-LC 48 kHz mono at 128 kb/s;
- normalizes both inputs to zero-based monotonic timelines;
- applies `aresample=async=1000` for USB/camera clock-drift correction;
- exposes independent `audioDelayMs` and `videoDelayMs` settings, allowing only
  one positive delay at a time;
- applies an 80 Hz high-pass, configurable 6 dB adaptive noise reduction, a
  downward expander limited to 6 dB attenuation, configurable gain, gentle
  compressor, and limiter, with no speech-cutting hard gate;
- publishes `anpviz-main`, writes bounded logs/progress, sends a dedicated
  token-scoped heartbeat, and retries with bounded exponential backoff.

The edge probes one second of the already-muxed AAC track every ten seconds for
level, silence, and clipping status. This does not open the TONOR twice and
does not decode or transcode video.

Recording and livestream start fail closed unless the canonical path has H.26x
video, AAC audio, a fresh P3 heartbeat, the expected TONOR identity, and
advancing output. OBS and cameras.mbfdhub.com point to the same stream.

### Guest Computer

The ZowieBox client uses the device session UUID API, not browser scraping.
Signal visibility requires all of:

- device/API response;
- HDMI lock;
- input existence;
- MediaMTX H.26x path readiness.

The signal-on delay defaults to 2 seconds and signal-off delay to 5 seconds.
Transient HDMI renegotiation resets the pending transition without creating or
deleting database identities. The tile uses the same `data-drag-source`,
tap-to-route, touch pointer drag, broadcast confirmation, player, canvas, and
Multiview contracts as normal sources.

## Security controls

- Browser routes accept only `anpviz` and `guest-computer`; no raw upstream URL
  is accepted.
- HLS child paths are rewritten through the authenticated same-origin proxy.
- Camera management credentials stay in protected host environment files.
- The P3 heartbeat credential can only update the fixed Anpviz identity.
- KAMRUI firewall rules allow camera API access only from the GMKtec and the
  P3's exact LAN/Tailscale identities.
- Media Control authentication and workspace tenancy guard `/api/live-sources`.
- Destructive recording/livestream actions retain the signed service request,
  nonce, operator, idempotency, storage, and rate-limit controls.
- No secret is embedded in the SPA, player URL, committed config, screenshot,
  or evidence log.

The ZowieBox firmware rejected its generic account-management API. Its current
administrative password therefore cannot be safely rotated through an
unverified endpoint; change it through the supported device UI during an
on-site maintenance window, then update the protected KAMRUI environment.

## Backups and rollback assets

Verified pre-change backups:

- GMKtec: `/home/mbfd/backups/anpviz-zowiebox-20260730T193331Z`
- KAMRUI: `/home/peter/mbfd-backups/anpviz-zowiebox-20260730T193331Z`
- P3: `C:\MBFD\backups\anpviz-zowiebox-20260730T193331Z`

The GMKtec set contains an online SQLite recovery copy, active Compose/env
copies, configuration, service metadata, and checksums. SQLite integrity was
`ok`; its recovery SHA-256 begins `10c284`. The KAMRUI set contains the media
stack, protected env, units, scripts, metadata, and ZowieBox before/after
snapshots. The P3 set contains task/config/script evidence. Hash manifests were
verified without stopping production.

Rollback is explicit and checksum-verified. It never silently chooses an old
backup or resurrects obsolete camera relay services.

## Measured candidate evidence

### Media/protocol

| Check | Measured result |
|---|---|
| Anpviz video | H.264 Main, `3072x1728`, average 20 fps, video stream copy |
| TONOR audio | AAC-LC, 48 kHz mono, continuously advancing |
| 15-second Anpviz video copy | 5,000 KiB, no invalid/error output |
| 15-second TONOR sample | 719,872 samples; quiet room peak `-78.6 dB`, RMS `-94 dB` |
| One-second level probe | AAC-LC 48 kHz mono; peak `-80.8 dBFS`, mean `-91.0 dBFS` |
| Publisher progress | approximately `19.76/20 fps`, speed `1.0x`, duplicate/drop `0` |
| MediaMTX backpressure | no new reader-too-slow warnings after timestamp normalization |
| Guest video | H.264 Main, `1920x1080`, average 60 fps |
| Guest audio track | AAC-LC 48 kHz stereo from the ZowieBox's restored input configuration |
| ZowieBox HDMI API | `input_exist=1`, `hdmi_signal=1`, `audio_signal=0` |

### Resource and network snapshot

| Host/component | Measurement |
|---|---|
| P3 total | CPU `1.8%`; memory `7.44/31.64 GiB`; Ethernet `1 Gb/s` |
| P3 candidate FFmpeg | `29.6 MiB` working set; one process; video copy |
| KAMRUI candidate MediaMTX | CPU `9.14%`; memory `23.12 MiB` while both sources were active |
| KAMRUI legacy path to retire | MediaMTX `8.63%` plus relays `6.8% + 5.3%` CPU |
| KAMRUI memory/storage | `1.23/11.73 GiB` used; root 16%; recordings disk 1% |
| KAMRUI Ethernet | `1000 Mb/s`, full duplex, zero RX/TX errors; historical drops recorded separately |
| LAN RTT from KAMRUI | Anpviz `0.311 ms`, ZowieBox `0.260 ms`, GMKtec `0.237 ms` average; zero reported loss |
| GM Media Control | CPU `1.83%`; memory `88.89 MiB`; healthy before cutover |

The optional existing OBS fixed compositor was output-inactive but consuming
approximately `508%` CPU and `3 GiB` after its old camera RTSP socket reached
EOF. That is a real pre-release bottleneck, not caused by the candidate.
Production cutover must regenerate/restart it against `anpviz-main`, confirm
output remains inactive, and demonstrate idle CPU recovery before calling the
system optimized.

## Automated verification

Current completed gates:

- full Node regression: 1,142 pass, 0 fail, 1 intentional existing skip;
- focused live-source/edge regression: 22/22;
- P3 cache/runtime: 16/16;
- UI contract: 29/29;
- enterprise responsive/accessibility/workflow Playwright: 51/51;
- real application lifecycle and canonical Live Sources UI: 11/11;
- feature flag rollback: 16/16;
- service worker/cache transition: 10/10;
- Chromium/Firefox console and stable-render checks: 14/14;
- JavaScript, Python, PowerShell syntax and `git diff --check`: passed at the
  recorded checkpoints;
- complete local release command: 1,289 passing checks, 0 failures, 1
  intentional existing Node skip.

The exact final release SHA must pass CI. The
hardware candidate validates media/protocol behavior but does not replace the
physical checks below.

## Physical and human acceptance still required

Do not mark these passed without an observer:

- actual TONOR speech and clipping calibration;
- visible clap/slate offsets at 0, 15, 30, 45, and 60+ minutes, target within
  approximately 80 ms without progressive drift;
- glass-to-glass latency;
- audible TV/eARC output and no feedback/echo;
- physical single display, three-display wall, two-display wall, all-display,
  split-region, Advanced Canvas, and Multiview rendering;
- physical Lenovo tablet tap and touch drag;
- cameras.mbfdhub.com mobile/desktop audible playback;
- HDMI embedded audio after the laptop issue is corrected;
- switch/camera/ZowieBox power-cycle and DHCP-renewal recovery;
- native Safari where required.

## Staff operation

1. Open Media Control and select **Live Sources**.
2. **Anpviz Camera** is always listed so staff can see camera, TONOR, sync,
   delay, audio activity, and clipping status. It is routable only when the
   canonical video-plus-TONOR stream is healthy.
3. **Guest Computer** appears after the ZowieBox has a stable HDMI signal. A
   brief cable handshake does not flicker the tile.
4. Tap a source to choose a destination, or drag it to a display/wall. On a
   tablet, press and move the tile; a normal tap remains available.
5. If Guest Computer video is live but its card says HDMI audio is not
   detected, correct the laptop's HDMI audio output. Do not substitute TONOR.
6. If Anpviz says TONOR disconnected, reconnect the USB microphone and wait for
   automatic reacquisition. Do not select the camera's built-in microphone.
7. If clipping is shown, reduce physical/input gain; the limiter is protection,
   not a substitute for correct gain.

## Cutover and verification

1. Freeze a green release SHA and archive it on all three hosts.
2. Recheck the active GMkTec Compose labels and take a fresh WAL-safe SQLite
   recovery set.
3. Stage KAMRUI source and protected env changes; render the candidate config
   without printing values.
4. Install the current root-owned helper and run
   `retire-legacy-relays`; verify both old unit files and scripts are absent.
5. Deploy/restart MediaMTX and camera API; verify only `anpviz-video`,
   `anpviz-main`, and `guest-computer` are configured physical-source paths.
6. Install `MBFD_AnpvizTonorPublisher` as SYSTEM, verify health, then remove
   `MBFD_Camera1`.
7. Deploy the immutable GMKtec image with `CACHEBUST=<release SHA>`. Confirm
   commit/tree/build/image/runtime/frontend identity and zero restarts.
8. Run writable SQLite `quick_check`, `integrity_check`, and
   `foreign_key_check`; confirm exactly two `live_sources` rows.
9. Restart/regenerate the fixed compositor while output is inactive; verify
   canonical source name and bounded idle CPU.
10. Validate authenticated UI, camera proxy, HLS/WebRTC fallback behavior,
    display confirmations, current content restoration, and restart recovery.
11. Remove the temporary candidate container/task/ports only after production
    verification.

## Exact rollback procedure

1. Stop new routing, recording, and livestream requests.
2. Record current source/stream/task/service state.
3. Roll the GMKtec Compose image back to the recorded pre-release image and
   verify `/api/system/version`.
4. On P3, stop `MBFD_AnpvizTonorPublisher` and restore the saved task/config
   snapshot only if rollback explicitly requires the former runtime.
5. On KAMRUI, invoke the committed rollback script with the exact verified
   snapshot path. It validates checksums and restores only named files.
6. Restart MediaMTX and camera API, verify sockets and logs, then run database
   integrity checks if database restoration was required.
7. Restore prior classroom content and confirm every target independently.

Retired obsolete camera sources are not an automatic fallback. Reintroducing
one requires a separate, explicit incident decision because this installation
has one physical camera: the Anpviz.
