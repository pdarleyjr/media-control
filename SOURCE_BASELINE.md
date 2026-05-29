# SOURCE_BASELINE.md

Authoritative record of where Media Control was baselined from, and the rules that
keep it isolated from the live Screen Tinker deployment.

## What this is
Media Control is a **private, history-preserving** derivative of Screen Tinker,
created to build a touch-first media-control platform **without affecting the live
Screen Tinker** deployment at `media.mbfdhub.com`.

## Exact source of truth
| Field | Value |
|---|---|
| Source repo | https://github.com/pdarleyjr/screentinker (public) |
| Parent of source | https://github.com/screentinker/screentinker |
| Baseline branch | `screen-share` |
| Baseline commit | `addd08db2643ac9817d5f579c30496cb851425ae` |
| Baseline date | 2026-05-28T16:48:43Z |
| License | **MIT** (LICENSE retained; see NOTICE) |
| Method | Full-history clone; local `main` reset to the `screen-share` tip. Upstream kept as a read-only `upstream` remote. **Not** a GitHub fork. New independent **private** repo `pdarleyjr/media-control`. |

Reference SHAs (upstream):
- `main` = `159a36ed9932cdc7d8e59b4fe433c0122711133a` (2026-05-17, no screen-share)
- `screen-share` = `addd08db2643ac9817d5f579c30496cb851425ae` (+17/-0 vs main) ← **baseline**
- `mbfd-integration` = `657d5cd30018acdc1f5bb7a8c8814c7434ac7c32` (+1/-0 vs main)

## Why `screen-share` (not `main`)
`screen-share` is a clean superset of `main` (0 behind) that also contains the
`mbfd-integration` commit. It adds the hardened WebRTC screen-share, OpenRelay TURN
fallback, screen-share-to-walls, native Android WebRTC receive, PDF/Office + yt-dlp
transcode, fullscreen/wall-canvas override, device-auth fix, and the FK-crash fix.
The live container `mbfd-screentinker` on the GMKtec (image
`screentinker-screentinker`, built 2026-05-28T16:46:16Z, compose at
`/home/mbfd/screentinker/docker-compose.yml`, `127.0.0.1:8095->3001`) was built from
this branch, so it is the true deployed state.

## Why full history was preserved (not clean-history)
MIT imposes no copyleft constraint, so preserving authorship history is both safe and
valuable. A full-history secret scan was performed **before** the first push:
- No secret files ever committed (`.env`, keys, certs are git-ignored upstream).
- No real tokens/keys across 196 commits — the only pattern hit was a README
  documentation placeholder `sk_live_...` (literal ellipsis).
- `server/lib/turn-credentials.js` is env-based; OpenRelay TURN creds are
  intentionally public (Metered.ca).
- TODO (Phase 0): run a full `gitleaks` pass once installed for completeness.

## Superseded artifact — reference only, DO NOT use as source
`D:\screentinker-scratch` is an **older** snapshot of the screen-share feature
(`turn-credentials.js` 2892B vs canonical 4573B; `screen-share-signaling.js` 9264B vs
12226B; `frontend/js/views/screen-share.js` 19652B vs 34297B). Its `deploy.sh` targets
a stale `/home/peter/...` path from the retired Kamrui box. Kept only as history.

## Verified baseline file state (at addd08db)
- `server/ws/`: dashboardSocket.js, deviceSocket.js, index.js, screen-share-signaling.js
- `server/lib/`: command-queue, permissions, socket-permissions, socket-rooms, tenancy, turn-credentials
- `server/routes/screen-share.js`, `server/player/screen-share-receiver.js`
- `frontend/js/views/screen-share.js`, `frontend/css/screen-share.css`, `docs/SCREEN_SHARE.md`
- `LICENSE` (MIT), `README.md`, `VERSION`
- No docker-compose in the repo; deployment compose is host-side (`/home/mbfd/screentinker`).

## Hard constraints (do not violate)
- DO NOT modify the live Screen Tinker app, `media.mbfdhub.com`, or the
  `mbfd-screentinker` container / `/home/mbfd/screentinker` stack.
- DO NOT push to `upstream` (pdarleyjr/screentinker). Push only to `origin`
  (pdarleyjr/media-control, **private**).
- DO NOT touch Cloudflare until production-test readiness is explicitly approved.
- DO NOT commit secrets, tokens, keys, or infrastructure topology. Planning files,
  `.ai_plans/`, and logs are git-ignored.
- OpenBoard (GPL-3.0) = inspiration/reference only; **no OpenBoard code copied or
  embedded**. The smartboard is a **web-native whiteboard** module unless a later
  feasibility review proves another approach is better.

## Planned staging (NOT yet provisioned)
- Subdomain: `media-control.mbfdhub.com` (CF Access OTP @miamibeachfl.gov)
- Host port candidate: **8096** (8095 is the live Screen Tinker; verify free at deploy)
- Isolated Docker project `media-control`, data under `/mnt/mbfd-storage/media-control/`
- Cloudflare tunnel `mbfdhub-gmktec`: **append-only** ingress rule (never edit the
  `media.mbfdhub.com` rule). Deferred until production-test readiness.
