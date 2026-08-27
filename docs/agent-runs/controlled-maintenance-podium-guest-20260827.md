# Controlled maintenance: Podium and Guest sources — 2026-08-27

## Status

This is the rollback-first maintenance record for the authorized change window.
At creation, no source, MediaMTX, ZowieBox, OBS, Cloudflare, or production
Media Control setting has been changed by this maintenance run.

Do not proceed to a production mutation unless the corresponding local test,
candidate-artifact, and staged acceptance gates are recorded as passing.  If a
protected workload degrades, stop the candidate work and restore the exact
pre-maintenance artifacts described below.

## Captured production baseline

### Media Control / GMKtec

- Runtime container: `media-control`, healthy, zero restarts at capture.
- Runtime source identity: commit
  `6f7cf082c45fbd56bb341568861849e0955dac4f`, tree
  `294c09b763acb986949cde193ca244b48823e623`, build
  `gha-32809024327`.
- Runtime image: `media-control:release-6f7cf08-294c09b7`, image ID and
  repository digest `sha256:9315c0e976d709b4cd0a305bc4bbebb7c1a233e977e32d3adc36bf2348f809a0`.
- Protected rollback bundle:
  `/var/lib/mbfd/media-control-db/backups/controlled-maintenance-20260827T152628Z`
  (directory mode `0700`; contained files mode `0600`; tree SHA-256
  `ae4bb03eeddef7423f486d1d59b78a0eff60760c2c66598b5b99ddb7ef025a97`).
- WAL-safe SQLite recovery copy:
  `/app/data/db/backups/remote_display.pre-controlled-maintenance-20260827T152533Z.db`;
  SHA-256 `82794d45fa4c5f8a5121b36a928b2da631abbe853fa3dc963cc2b5d2789937f1`;
  `quick_check=ok`, `integrity_check=ok`, and zero foreign-key violations.

### KAMRUI / MediaMTX

- Runtime: MediaMTX `v1.19.3`, with zero restarts at capture.
- Runtime image: `bluenviron/mediamtx:latest`, resolved repository digest
  `sha256:7797ed3df88df21e8c04ecd0aff08ce49a5232d1db453e51f5480ef36bc80865`.
- Protected config/runtime bundle:
  `/home/peter/mbfd-media-maintenance-backups/20260827T152553Z`
  (directory mode `0700`; contained files mode `0600`; config SHA-256
  `14004dffaa42b2c92d00678c1abd4ea946fcd2a918c176aec85197243222014f`).
- At capture, `anpviz-main` continued to be read as H.264 plus MPEG-4 Audio.
  The legacy `guest-computer` RTSP pull repeatedly failed with `invalid AAC
  config: 1690`.  The initiating encoder/source condition remains unproven.

## Immediate rollback conditions

Immediately stop the candidate and restore the known-good state if Anpviz,
audio ownership, any P3 renderer, either wall, touch/drag routing, Screen
Share, MediaMTX, Media Control health, or Cloudflare authentication regresses.
Do not use this maintenance to upgrade MediaMTX, expose RTMP publicly, weaken
Access, or force an unhealthy source routable.

## Rollback order

1. Stop the candidate Guest publisher and keep the existing wired Screen Share
   workflow available.
2. Restore the captured KAMRUI MediaMTX configuration and recreate only the
   MediaMTX service using the captured image digest; verify Anpviz before any
   further action.
3. Recreate only the Media Control service from its captured release image.
4. Restore the WAL-safe SQLite copy only if migration/data evidence requires
   it; verify `quick_check`, `integrity_check`, and foreign keys afterwards.
5. Restore the captured Cloudflare configuration only if a separately tested
   Access change causes an authentication regression.
6. Verify Anpviz, five renderer processes, both walls, audio, touch, Screen
   Share, and the original login path before ending rollback.

This document intentionally contains no credentials, environment values,
tokens, or protected configuration contents.
