# Media Control deterministic live-preview repair

Status: deployed exact tested artifact; final authenticated human UI acceptance is pending.

This report does not claim the task is fully complete while any production UI, physical-display, or long-soak row below remains pending.

## Starting state and isolation

- Repository: `pdarleyjr/media-control`
- Starting authoritative `origin/main`: `0c9c96ef63ec28e77aa88ec23ecc79003ae91099`
- Starting tree: `ef03974b61077cc511f546ea0069fbe13f69341a`
- Starting production image: `media-control:release-0c9c96e`
- Starting production image ID: `sha256:207166187b4bfe404cdd03cd37aabf487b94f2537147c5cd4e3001a99060c9d9`
- Product worktree: `D:\CodexWorktrees\media-control-durable-live-previews-20260823`
- Product branch: `fix/durable-live-display-previews-20260823`
- CI worktree: `D:\CodexWorktrees\media-control-ci-feedback-20260823`
- CI branch: `ci/parallel-release-feedback-20260823`
- Responsive corrective worktree: `D:\CodexWorktrees\media-control-live-previews-responsive-20260824`
- Responsive corrective branch: `fix/live-previews-responsive-hotfix-20260824`
- Completion-report branch: `docs/live-preview-repair-report-20260824`

All implementation, tests, releases, and this report were kept out of the concurrent Command Center Content Library/bottom-shelf worktree and branch. No foreign worktree was modified, staged, cleaned, reset, merged, or deployed.

## Root cause

There were two product defects and one independent source-state observation.

1. The Command Center intentionally selected one `activePreviewDeviceId` and allowed a real live renderer only for that selected display/member/leader. Selection and transport-control state also participated in the structural stage signature. Selecting another target therefore removed or recreated unrelated iframe/video browsing contexts and stopped the previous preview.
2. After the lifecycle repair, top-level overview surfaces used `grid-column: auto` inside an auto-fit grid. At 1366x768, the production three-screen wall occupied only `0.3238002232142857` of the stage width, producing the compressed layout reported by the operator.
3. The Guest Computer player was advancing but visually black. Direct frame analysis proved that the configured ZowieBox RTSP origin itself was emitting uniform digital black (`YMIN=YAVG=YMAX=16`, neutral chroma, saturation zero) with near-silent audio. MediaMTX, the Media Control HLS proxy, and Chromium relayed the same frames. The operator later advised that the podium laptop may be asleep/off and authorized treating black as the correct current source picture.

## Changes delivered

### PR #83 - durable logical previews

- PR: `#83` - `fix(media-control): decouple live previews from control selection`
- Head: `e81e6af4064844078f2fce0aeaf2c82998cbdfa7`
- Merge: `300a640e1b18e59b936008120059e78f9ebfe713`
- Merge tree: `0be42b6603dffaf0918daa0e1aa1964ddb5c82cf`
- Result: program truth, player telemetry, and operator selection state are separated; visible logical programs receive durable passive/muted sessions; selection is patched in place.

Key source/test files:

- `frontend/js/views/media-control.js`
- `frontend/js/views/media-control/live-preview.js`
- `frontend/js/views/media-control/preview-targets.js`
- `frontend/js/views/media-control/stage.js`
- `frontend/css/media-control.css`
- `server/e2e/real-app/live-preview-lifecycle.spec.js`
- `server/test/live-preview-targets.test.js`
- `server/test/controller-sync-performance.test.js`
- `server/test/podium-command-center.test.js`
- `server/test/blank-command-wiring.test.js`

### PR #84 - CI feedback topology

- PR: `#84` - `ci: parallelize release feedback and preserve exhaustive gate`
- Head: `8ef52018bfa0b50b3828c287d807f56c5d6960ae`
- Merge: `cb55288c4506ec47b6399033ccb2e28e2f53d2b0`
- Merge tree: `c6a4a51bd49b2e43fda688c74f7481f4e2746f1f`
- Files: `.github/workflows/pr-fast-gate.yml`, `.github/workflows/release-gate.yml`
- Result: parallel fast feedback, parallel exhaustive browser/jobs, exact merge-candidate validation, and one retained tested production image.

### PR #85 - responsive corrective release

- PR: `#85` - `Fix full-width durable preview layout at classroom viewport`
- Head: `962d46a9bf30ca97c247ab254bfdd09fa6581c3b`
- Tested merge ref: `4f1823a7ca4c82c637f06551d35d17ec529ded12`
- Merge: `ab8e54f574afe9d8644ce68f603e1e9d6408a1a9`
- Tested and merged tree: `42c120303736f8ad77f88555a6a243201cae5156`
- Files: `frontend/css/media-control.css`, `server/e2e/real-app/live-preview-lifecycle.spec.js`
- Result: every top-level wall/display/group overview spans the full row; the regression runs at 1366x768 and requires the three-screen wall to occupy at least 90 percent of the stage.

## Behavior and resource model

- Two distinct programs remain live simultaneously through selection changes.
- A control-only selection changes zero renders, iframe creates/removes/navigations, live-session creates/destroys, and route commands.
- A real source change replaces only the affected logical surface: one iframe removal, one create, one navigation, one live-session destroy, and one live-session create.
- The topology regression creates seven distinct logical sessions: standalone Multiview, one three-panel span wall, two wall groups, two independent split members, and one Mosaic logical surface.
- The three-panel span wall uses one session, not three duplicate HLS sessions.
- Passive previews remain muted, control-free, non-interactive, and do not send classroom commands merely by rendering.

## Verification

### Focused red/green evidence

- Before the CSS correction, the new 1366x768 readability assertion failed with wall/stage ratio `0.3238002232142857`.
- After the one-line correction, durable-preview lifecycle tests passed `2/2`.
- Focused live-preview/controller/podium/five-display/security contracts passed `96/96`.
- `git diff --check` passed.

### Frozen local release candidate

- Node: `1508` passed, `0` failed, `1` expected skip (`1509` assertions total).
- P3: `37/37` passed.
- UI contracts: `29/29` passed.
- Enterprise UI: `51/51` passed.
- Real app: `30/30` passed.
- Durable live preview: `2/2` passed.
- Feature rollback: `16/16` passed.
- Service worker: `13/13` passed.
- Browser console: `14/14` passed in Chromium and Firefox, including 1366x768 and stable keyed-render checks.
- Responsive/mobile matrix: `102/102` passed in Chromium and WebKit, including phones, tablets, orientation changes, breakpoints, 1366x768, visual baselines, overflow, overlap, and touch-hit testing.

The first frozen full command stopped before browser assertions because the isolated enterprise Playwright harness dependencies were absent locally. Its locked dependencies were installed, and validation resumed at the failed browser stage without changing the candidate. All remaining release stages passed.

### GitHub Actions

Architecture/CI merge candidate:

- Release Gate `32675699619`: success, about 6 minutes 6 seconds.
- PR Fast Gate `32675699569`: success, about 2 minutes 48 seconds.
- CodeQL `32675697498`: success, about 1 minute 35 seconds.
- Tested merge ref: `2fef15b1f47100e479d3208bf4e104ca2459a62f`
- Tested tree: `c6a4a51bd49b2e43fda688c74f7481f4e2746f1f`

Responsive corrective candidate:

- Release Gate `32679434611`: success, about 6 minutes 54 seconds.
- PR Fast Gate `32679420549`: success, about 2 minutes 32 seconds.
- CodeQL `32679418701`: success, about 1 minute 31 seconds.
- Tested merge ref: `4f1823a7ca4c82c637f06551d35d17ec529ded12`
- Tested and merged tree: `42c120303736f8ad77f88555a6a243201cae5156`

Measured comparison: the pre-optimization PR #83 exhaustive workflow `32673253671` took about 18 minutes 10 seconds. The final topology produced a useful fast result in about 2 minutes 32 seconds while retaining the full release result in about 6 minutes 54 seconds.

## Deployment and rollback evidence

### Initial candidate and rollback

- The first architecture/CI candidate used retained archive SHA-256 `47c4628d3d0140f6da87dd426a239d522e2a0115c0774d8a740d1b78fd9f4cef` (`860570651` bytes).
- It was deployed exactly, then immediately failed human responsive acceptance because the walls were compressed at 1366x768.
- Production was restored to `media-control:release-0c9c96e`, image ID `sha256:207166187b4bfe404cdd03cd37aabf487b94f2537147c5cd4e3001a99060c9d9`.
- The failed candidate Compose file was preserved at `/home/mbfd/releases/media-control-cb55288-20260824T002101Z/docker-compose.override.yml.failed-human-acceptance`.
- WAL-safe backup `/var/lib/mbfd/media-control-db/backups/remote_display.pre-live-preview-20260824T002101Z.db` passed integrity and foreign-key checks.

### Final exact deployment

- Production merge: `ab8e54f574afe9d8644ce68f603e1e9d6408a1a9`
- Production tree: `42c120303736f8ad77f88555a6a243201cae5156`
- CI-tested image commit: `4f1823a7ca4c82c637f06551d35d17ec529ded12`
- Deployed tag: `media-control:release-ab8e54f-tested-42c1203`
- Loaded OCI/index image ID: `sha256:3957cd09958964235476931867947972524fba096433ee9b5f6570081a35486f`
- Archive config blob: `sha256:2fe37588ade1aa1e26b2f2d23f0e13485cafec0fe05728a89d868ed1d991ebc9`
- Retained archive: `media-control-image.tar.gz`
- Archive SHA-256: `75eefe0b799670259b02f0fb1ea68ba25d7130f8c5306c01962350278c304330`
- Archive bytes: `860596496`
- GitHub artifact: `image-provenance-4f1823a7ca4c82c637f06551d35d17ec529ded12`
- GitHub artifact digest: `sha256:69283068342620fc9817caa75271ce19f29cb4bcbd2b0d0900c939f8a9d5cbee`
- Release directory: `/home/mbfd/releases/media-control-ab8e54f-20260824T013102Z`
- Runtime after switch: healthy, restart count `0`, OOM false.
- Runtime version: commit `4f1823a...`, tree `42c1203...`, build `gha-32679434611`, frontend bundle `d5c0cfc0`, player bundle `6ee82f9d1e49`.
- Public `/api/system/version` returned the same provenance.
- Bounded post-deploy soak: six samples at 30-second intervals from `2026-08-24T01:51:48Z` through `2026-08-24T01:54:18Z`; every sample remained healthy with restart count `0`, OOM false, tree `42c120303736f8ad77f88555a6a243201cae5156`, and build `gha-32679434611`.
- Fresh WAL-safe backup: `/var/lib/mbfd/media-control-db/backups/remote_display.pre-ab8e54f-20260824T013102Z.db`
- Backup bytes: `439037952`
- Backup SHA-256: `2ae6605cd1f199bac789cd7836ff24f3a6b5dcd24b1cee1e3ec8a85b54aba036`
- Backup validation: `quick_check=ok`, `integrity_check=ok`, foreign-key rows `0`.
- Explicit rollback tag: `media-control:rollback-pre-ab8e54f-20260824T013102Z`
- Rollback Compose: `/home/mbfd/releases/media-control-ab8e54f-20260824T013102Z/docker-compose.override.yml.before`

The deployment recreated only the `media-control` service with `--no-build --no-deps`. No display route, wall layout, source configuration, camera/livestream service, MediaMTX path, ZowieBox setting, P3 process, or network topology was changed.

## Production evidence

### Control-plane and runtime

- Five classroom displays were online before and after deployment.
- Current content/asset IDs, content types, wall roles, pause/mute state, and screen-on state were identical before and after deployment.
- Primary Wall remained `groups`, revision `203`.
- Secondary Wall remained `span`, revision `18`.
- Main database after deployment: `quick_check=ok`, `integrity_check=ok`, foreign-key rows `0`.
- Guest direct player: 1920x1080, ready state `4`, unpaused, muted, no video error, no visible error, no failed request, advanced `10.004` seconds.
- MBTV direct player: 1280x720, ready state `4`, unpaused, muted, no video error, no visible error, no failed request, advanced `10.005` seconds; captured pixels showed a real Miami Beach city frame.

### Acceptance matrix

| Scenario | Control-plane/runtime | Operator web UI | Physical/human |
|---|---|---|---|
| Guest Computer | Pass under operator-approved laptop-off assumption; origin-to-browser stream advances and black is the current source picture | Pending authenticated Command Center check through target selection changes | Pending later podium-laptop-on observation |
| MBTV/live news | Pass for direct MBTV browser playback; prior WSVN and Local10 direct probes also advanced without errors | Pending authenticated off-selection continuity check | Pending |
| Simultaneous Guest + news | Automated real-renderer fixture pass; current production state has Guest and MBTV on different logical surfaces | Pending authenticated production observation | Pending |
| Uploaded MP4 transport | Full automated release contracts pass | Not exercised in production in this release window | Pending |
| Spanned wall | Automated one-session logical-wall regression pass; production topology unchanged | Pending authenticated production observation | Pending |
| Split/group wall | Automated independent-region/group lifecycle regression pass | Pending authenticated production observation | Pending |
| Multiview | Automated one-logical-grid-session regression pass | Not exercised in production in this release window | Pending |
| Soak | Six-sample 150-second container/provenance soak passed; zero restarts and no OOM | Long interactive soak pending | Pending |

## Unresolved issues and incident record

- Final authenticated operator acceptance at 1366x768 is pending. The operator was asked to verify readable full-width surfaces and that MBTV continues moving while selecting Guest and other targets.
- Guest pixels cannot be visually validated as a laptop desktop until the podium laptop is awake; black is accepted as the correct current picture for this release window.
- A read-only diagnostic accidentally requested unsupported `/player/live-source/mbtv/...`. `normalizeCamera()` rejected the unknown source asynchronously, exposing an unhandled-rejection bug and restarting Media Control once at `2026-08-24T01:02:32.767Z`. The server returned in roughly three seconds, all five displays and P3 reconnected, and no route/configuration state changed. The unsupported route crash is separate from this repair and remains unresolved.
- Physical TV pixels, classroom audio, native device touch behavior, and a long soak are not inferred from API, database, CI, or headless-browser success.

## Secret handling

No passwords, tokens, session UUIDs, signed service values, environment-file contents, or Cloudflare credentials are included in this report, commits, CI output, or retained evidence paths.
