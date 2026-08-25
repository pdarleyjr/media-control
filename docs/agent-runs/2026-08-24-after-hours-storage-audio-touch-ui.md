# After-hours storage, audio, touch, and shelf repair — 2026-08-24

## Result summary

The maintenance window completed the safe storage cleanup/prevention work, replaced static P3 audio enforcement with revision-fenced dynamic ownership, fixed a production-discovered span playlist-revision race, and refined the existing Command Center touch/shelf implementation without changing stage geometry or routing semantics.

Software acceptance is complete. Physical soundbar, TV pixel, Lenovo touch, and Mac/Zowie embedded-audio acceptance remain morning human-observation gates and are not represented as verified here.

## Golden production baseline

- Root filesystem: 1,056,281,419,776 B total; approximately 48% used after the earlier LVM grow.
- Containers: 78 running / 90 total / zero unhealthy.
- Media Control compose hashes:
  - `docker-compose.yml`: `a92b312f4de2522d664b4ddd03d0b7c28151b09852c35118d476c4d8452d5e1b`
  - `docker-compose.override.yml`: `656dbe96846dcc3e79d1fdb8b9ad9d09aa113d30cfa4ad273fcf0226a3694290`
- Media Control live DB: `/var/lib/mbfd/media-control-db/remote_display.db`, mounted at `/app/data/db`.
- Primary wall: split, revision 204, Front Left / Center / Right.
- Secondary wall: span, revision 18, Side Left / Right.
- Five managed P3 players were online; Windows Default and Preferred playback endpoints were `TOSHIBA-TV (NVIDIA High Definition Audio)` on the TV1/eARC path.
- P3 cache: 256 files (128 content plus 128 metadata), 1,645,675,421 B. The known-good video/audio asset `ffb23883-616f-4506-be79-2e394402d783` was 76,266,431 B with cached SHA-256 `8d0f127...`.
- The exact pre-test display, wall, playlist, mute/volume, and Live Program state was captured in the release evidence before live routing.

## Storage cleanup and prevention

The measured root used-block decrease was 54,980,722,688 B (approximately 51.2 GiB), ending at 432,005,857,280 B used, 580,214,853,632 B available, and 43% use. Detailed category accounting, protected material, retention schedules, and backup proof are in `docs/audits/2026-08-24-post-cleanup-storage-audit.md`.

Storage prevention shipped in PR #90, merge `0aa5c9dc886db5af9763d171b1ea4f02b203d46d`. It adds bounded weekly BuildKit GC, verified DB keep-two/offload retention, audit-only image retention, 80/85/90 root-capacity monitoring, journald and origin-log bounds, and live-DB ecosystem-backup coverage.

After loading and retaining the exact audio, hotfix, and UI release/rollback artifacts, the final broad gate measured root use at 441,058,066,432 B used, 571,162,644,480 B available, and 44%. This remains far below the first 80% alert threshold; the cleanup audit's 43% figure is the end-of-cleanup measurement before those release artifacts were retained.

## Media Control audio architecture

### Before

Media Control emitted playback state while the P3 Electron shell statically muted every window except Front Left. This made TV1 effectively the only renderer able to produce audio even though all five Electron sessions shared the same Windows TV1/eARC output endpoint. Static shell policy also could not safely follow wall, duplicate, playlist, reconnect, or ownership transitions.

### After

Media Control now supplies an authoritative audio policy with content instance, owner device, output device, revision/epoch, playlist revision, render generation, and transaction identity. The transition algorithm is:

1. Determine every renderer of the same content instance.
2. Select one deterministic owner for the requested route.
3. Fence all participants and require renderer plus host-process mute acknowledgments.
4. Grant the new owner only after the mute barrier succeeds.
5. Reject stale revisions/generations and same-revision conflicting state.
6. Fail muted when ownership is absent or ambiguous.
7. Restore or reassert policy through playlist changes, reconnects, heartbeats, and recovery.

Playback source identity, video routing, wall geometry, position/transport, cache, uploads, previews, and Live Program selection were not coupled to ownership.

### Source, CI, and deployments

- Media Control audio PR #91: tested head `57824ef...`; merge `e3cec97b55b8cb73d2762c68f934b8717ee4fb0c`; tree `60d43f52...`; release run `32802321219`.
- Production-discovered span revision fix PR #93: head `20c2f55a6d78c43e3b9a07605007c9f23889bb54`; merge `77df746eac0abf0360a8cf3396e27c4facac6ed9`; tree `5f1a541fb046c8ac6573f957a4ee2fec453e3bd6`; release run `32807223550`.
- Hotfix production image: archive SHA-256 `cf0b7397bafcca613d8f088d5ef8a1571cb2f56572a247b55ceb1a6472722b02`, 860,259,120 B; runtime daemon image `sha256:bff4f447f40bc590d8421dcd9de21e70a0a236331ea5f3d80d193ec97ab783cf`; container `a7194707001fd1751ff56fe6a3868cc5b76ab882fe46aa7e33a966a9039aaba5`.

The live direct-TV4 test exposed a fail-safe, not an audible race: all participants muted after Media Control generated a different span playlist signature under the same audio revision while stale display state caught up. PR #93 changed the span payload signature to prefer the selected authoritative layout assignment over stale restored display state, with a regression that proves stable revision before and after state convergence. No video/topology/cache behavior changed.

### Automated and production acceptance

- Focused secure audio: 23/23.
- Audio/reconnect and paired P3: 74/74.
- Full Node contract: 1,572 total, 1,571 pass, one expected skip, zero failures for the audio release; hosted hotfix and final release Node/P3/UI contracts passed.
- Hosted real app, browser console, service worker, production container, enterprise UI, CodeQL, gitleaks, Chromium mobile, and WebKit mobile passed for the exact release heads.
- Live TV1, TV2, and TV3 direct routes passed on the audio release before the span race was found.
- After PR #93: TV4 direct, TV5 direct, Primary wall, and Secondary wall passed durable request/result confirmation, exact P3 transaction/revision correlation, all-participant mute barriers, and repeated stability checks.
- When all five displayed the known-good video, Primary selected TV1 as the only unmuted process and Secondary selected TV4 as the only unmuted process. Every non-owner remained process-muted.
- No `audio_policy_revision_conflict` remained after the fix.

## P3 Electron audio bridge

- P3 kiosk PR #8: tested head `c785c7...`; merge `4e90ff5c013fc8d23355a398157f78e1d5c34076`; tree `1b1338...`; CI run `32800285715`.
- Tests: 117/117 real Electron tests, 18/18 PowerShell tests, gitleaks clean, dependency audit zero findings.
- Exact Electron executable: 232,360,960 B, SHA-256 `329dd0...`.
- Deployment bundle: 152,953,600 B, SHA-256 `ff1da6...`.
- Pre-change rollback bundle: `C:\MBFD\FiveDisplayKiosk\backups\20260825T0222Z-pre-4e90ff5c\live-app.tar.gz`, 148,250,280 B, SHA-256 `7977414...`.
- Deployment completed without rebooting the P3. Three failed candidate starts rolled back automatically before the final exact bundle reached healthy 5/5 state.
- Startup and watchdog remained enabled/running; the Windows Default/Preferred output remained the exact TV1/eARC endpoint.
- Final read-only evidence at `2026-08-25T05:00:15Z` retained the original `2026-08-25T03:09:56.352Z` kiosk start time, confirmed five ready/connected/healthy windows, and found exactly one safe process owner in each restored same-content group: TV1 for Front Left/Right, TV2 for its unique image, and TV5 for Side Left/Right.
- The complete 256-file, 1,645,675,421 B RoomAgent content cache and known-good asset were unchanged. The recent log tails contained zero cache misses and zero cache errors since this kiosk build started; the newest historical cache error predated the kiosk start at `2026-08-25T02:56:34.632Z`.

Electron consumes Media Control's renderer policy, applies process mute/unmute through the kiosk bridge, correlates transaction/revision/generation, rejects stale/conflicting commands, and fails muted when authority is missing. It does not select or change the Windows playback endpoint.

## Touch drag/drop refinement

PR #92 merged exact tested head `6501fed4eff53f216ea5b170c5259d7b1ed4836b` as `6f7cf082c45fbd56bb341568861849e0955dac4f` (tree `294c09b763acb986949cde193ca244b48823e623`). The implementation preserves the custom pointer-driven architecture and existing `mc:source-drop` route semantics.

Changes are limited to:

- `elementsFromPoint()` exact-hit resolution through nested preview/caption/footer DOM.
- Deterministic target priority: split cell, display card, wall region, whole wall, stage.
- Cached visible target rectangles and a 28 px near-hit tolerance.
- A 6 px ambiguity band that refuses to guess between neighboring targets.
- Full-logical-target blue overlay that is pointer-transparent and changes only with the logical target.
- 10 px intent threshold, 1.5 direction ratio, and 24 px cancellation bound to distinguish horizontal shelf swipes from upward routing drags.
- `requestAnimationFrame` pointer-visual throttling.
- Idempotent settle/cleanup on pointer up/cancel, blur, resize, orientation, visibility, lost capture, shelf close, tab load, stage rerender, and unmount.
- At most one `mc:source-drop` dispatch per pointer release.

Local focused tests passed 30/30 and Playwright acceptance passed 8/8. Exact-head hosted release acceptance included repeated target acquisition, edge/nested-child paths, ambiguous gaps, swipe-without-route, single-send behavior, responsive/mobile engines, and stage geometry assertions.

## Content shelf and search refinement

- Kept the Content Library at the bottom and preserved Videos, Images, Docs, Sources, Live Feeds, and Additional Controls.
- Changed content rows to non-wrapping horizontal tracks with touch momentum, overscroll containment, and proximity snapping.
- Increased card cells to 176 px with 160 px visual cards and retained thumbnail fallback, filename truncation, Load More, and download controls.
- Consolidated context/search/sort into one compact horizontal toolbar; search is clamped to 168–240 px.
- Increased touch download control size to 48 px.
- Preserved the stage DOM/layout and added cancellation hooks so rerenders cannot leave stale blue targets.

Immutable UI release and runtime:

- Release run: `32809024327` (all exact-head release jobs passed).
- Commit/tree: `6f7cf082c45fbd56bb341568861849e0955dac4f` / `294c09b763acb986949cde193ca244b48823e623`
- Archive: 860,282,375 B, SHA-256 `4a026a771eeec0d3821985791e5adb181d62b10bf5dfc603a262f84f17849801`.
- Runtime image/container: `sha256:9315c0e976d709b4cd0a305bc4bbebb7c1a233e977e32d3adc36bf2348f809a0` / `751bc3710585d94ef009aa925d0793f389c7757d71ff1dca333a0595617dde98`, configured as `media-control:release-6f7cf08-294c09b7`.
- Runtime identity: commit `6f7cf082c45fbd56bb341568861849e0955dac4f`, tree `294c09b763acb986949cde193ca244b48823e623`, build `gha-32809024327`, frontend hash `8838836f`, unchanged player hash `f3aa88ab3e92`.

## Production restoration and regression state

After audio acceptance, routing was frozen and the exact captured classroom state was restored:

- Front Center: original image / playlist, muted, volume 0.
- Front Left: original Guest Computer web source / playlist, unmuted, volume 1.
- Front Right: same Guest Computer source with its original playlist, muted, volume 0.
- Side Left and Side Right: original image and shared playlist, muted, volume 0.
- Primary wall: split revision 204 with original wall content/playlist.
- Secondary wall: span revision 18 with original shared playlist.
- Live Program: unchanged offline/paused document state.

The restored P3 state was healthy 5/5. For shared original content groups, TV1 alone owned the Front web source. The final Media Control restart recovery safely selected TV5 as the sole Side image process owner; TV4 remained process-muted. This owner choice is equivalent within the same-content Side group, and all policy applications were accepted. The display-level restored state still has both Side displays muted at volume zero.

The final broad production gate recorded 78 running / 90 total containers, zero unhealthy running containers, zero Media Control restarts, and byte-for-byte exact identities for every non-Media-Control container compared with the post-cutover inventory. Media Control SQLite quick/integrity checks returned `ok` with zero foreign-key findings. The five displays, both wall definitions, and Live Program were exact against the captured state; all five players were online and render errors were zero.

Docker, containerd, Cloudflare Tunnel, and Tailscale were active with unchanged long-running tunnel/Tailscale processes. MBFD Hub, Media Control, PeerTube, Nextcloud, and ONLYOFFICE origin probes returned 200; the public MBFD Hub, Media Control, and PeerTube probes returned 200. PRM's origin returned 200 and its unauthenticated public probe correctly reached Cloudflare Access with 302. The camera HLS hostname likewise reached Cloudflare Access with 302; camera/LiveKit/PeerTube container identities and restart counts were unchanged. Nextcloud reported installed, not in maintenance, and no DB upgrade required; ONLYOFFICE returned `true` from its healthcheck.

Baserow was absent from the pre-audio baseline, has no GMKtec container/listener, and its retired hostname does not resolve; this maintenance did not remove or change it, so no current Baserow health claim is made. The legacy `mbfd-mediamtx` unit remains disabled/inactive because production is configured for `LIVE_PUBLISHER_MODE=direct_camera`; it was not started or altered. Authenticated browser visuals, camera pixels, livestream/recording behavior, upload/download user flows, physical audio, and Lenovo touch remain separate human-observation gates.

## Rollback points

### Storage

- Prevention preinstall capture: `/mnt/mbfd-backup-local/media-control/maintenance/20260824-after-hours/storage-prevention-preinstall-20260825T011323Z`.
- Restore-smoke and historical DB material were checksum-verified on the backup filesystem before root copies were removed.
- The root expansion is intentionally not part of rollback.

### Media Control audio/hotfix

- Pre-audio DB: `/mnt/mbfd-backup-local/media-control/db-snapshots/20260824-after-hours-pre-audio/remote_display.pre-e3cec97-20260825T025500Z.db`, SHA-256 `f795fb...`, 439,037,952 B.
- Pre-hotfix DB: `/mnt/mbfd-backup-local/media-control/db-snapshots/20260824-after-hours-pre-span-hotfix/remote_display.pre-77df746-20260825T041656Z.db`, SHA-256 `66d87a198ebeb7d11933bea831f2eebcf1b0e8f2991bb04dadca9ab4fd7dd6cf`, 439,037,952 B.
- Rollback image: `media-control:rollback-pre-span-hotfix-20260825T041656Z` (`sha256:5bae14ba630c91b4a974507b556752f05fb6a57a18b32f4ec69116c165b416e9`).
- Audio release/hotfix artifacts remain under `/home/mbfd/releases/media-control-e3cec97-60d43f52` and `/home/mbfd/releases/media-control-77df746-5f1a541f`.

### P3

- Restore the verified pre-change archive from `C:\MBFD\FiveDisplayKiosk\backups\20260825T0222Z-pre-4e90ff5c\live-app.tar.gz` using the kiosk deployment rollback procedure. A P3 reboot is not required.

### UI

- Pre-UI DB: `/mnt/mbfd-backup-local/media-control/db-snapshots/20260824-after-hours-pre-ui/remote_display.pre-6f7cf08-20260825T044134Z.db`, SHA-256 `3e08db03ce66dcbadb278b8cbade533c93af99454f72c8d3988de6f4e91cf2ff`, 439,037,952 B; quick/integrity checks `ok`, foreign-key findings zero.
- Rollback tag: `media-control:rollback-pre-ui-20260825T044134Z`, image `sha256:bff4f447f40bc590d8421dcd9de21e70a0a236331ea5f3d80d193ec97ab783cf` (the successful audio hotfix runtime).
- UI rollback recreates only the Media Control container from the preceding successful audio image; it does not revert the P3 or storage controls.

## Morning physical acceptance

1. Route the known-good video individually to TV1, TV2, TV3, TV4, and TV5; confirm each is heard through the Ultimea soundbar and not from duplicate TV sessions.
2. Route it to the Primary three-display wall; confirm one audible copy.
3. Route it to the Secondary two-display wall; confirm one audible copy.
4. On the Lenovo, drag several tiles to several displays from center and near-edge approaches; confirm immediate, stable blue acquisition.
5. Swipe the shelf horizontally and confirm no route occurs; then test search, sort, tap routing, and upward drag routing.
6. When a Mac is available, separately check macOS HDMI output, Zowie video, Zowie embedded audio, Media Control reception, and soundbar output.

Physical observation is the only remaining acceptance boundary. The absent instructor Mac was not treated as a software failure and no Zowie/Mac configuration was changed.
