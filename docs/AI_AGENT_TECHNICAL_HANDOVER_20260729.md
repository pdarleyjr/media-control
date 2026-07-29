# Media Control ecosystem — AI coding agent technical handover

Snapshot date: 2026-07-29

Primary production URL: `https://media.mbfdhub.com`

Primary implementation worktree: `D:\CodexWorktrees\media-control-media-library-prod-20260729`
Primary branch: `fix/media-library-production-20260729`

This is the authoritative continuation document for the 2026-07-29 Media
Library production-readiness program. It records observed facts separately from
source implementation, automated verification, deployment, and physical
acceptance.

> **Current release state:** the new Media Library implementation is **not in
> production**. Production is still serving embedded commit
> `17bda4dec197e658b2cc81379af0322bcf7f10bc`. The implementation worktree contains
> a large, intentional, uncommitted change set. Do not reset, clean, rebase, or
> overwrite it. The immediate blocker is a focused Lenovo/browser Poster Studio
> test that currently fails in Chromium and WebKit because the application
> unexpectedly leaves `#/content` for `#/operator-console`.

## 1. System architecture and technical stack

### 1.1 End-to-end topology

```text
Operator browser / Lenovo Tab One
        |
        | HTTPS + Cloudflare Access
        v
Cloudflare DNS / Access / Tunnel
        |
        v
GMKtec EVO-X2, Tailscale 100.81.154.123
  media-control container, host port 8096 -> container 3001
        |
        +-- Express REST API -> SQLite + uploaded/canonical media
        |
        +-- Socket.IO dashboard namespace -> operator state/events
        |
        +-- Socket.IO device namespace -> authenticated display commands
        |
        +-- manifest/checksum API -> P3 room cache agent
        |
        +-- PeerTube adapter -> local replay derivative
        |
        +-- Nextcloud / YouTube / remote URL ingest adapters
        |
        +-- camera control / live stream adapters
        |
        v
Lenovo ThinkStation P3, Tailscale 100.123.92.37
  room cache agent on 127.0.0.1:8097
  five managed Electron/browser player windows
        |
        v
Five classroom TVs; Front Left is the sole eARC audio authority
```

The server is authoritative for content metadata, master assets, derivatives,
checksums, target topology, layout revisions, broadcast requests, and delivery
state. The P3 is a read-through local cache and display host. PeerTube is a
bounded replay/distribution derivative, not the source of truth. An HTTP `202`
or a Socket.IO emit only proves request acceptance; success requires the
broadcast request to reach `confirmed` for every intended typed target and then
requires render/content confirmation.

### 1.2 Repositories and release lines

| Repository | Local authoritative path | Active branch / HEAD | Responsibility | Release state |
|---|---|---|---|---|
| `pdarleyjr/media-control` | `D:\CodexWorktrees\media-control-media-library-prod-20260729` | `fix/media-library-production-20260729` / `6a4fcacd00a89ab29e4dd50773a7b793a1bcb2b9` plus intentional dirty changes | Main Node server, SPA, player, Android client, P3 room agent, media pipeline, camera adapters | Core work uncommitted; not pushed or deployed |
| `pdarleyjr/mbfd-hub` | `D:\CodexWorktrees\mbfd-hub-media-security-20260729` | `fix/media-security-20260729` / `df4c95ad9d5b67e270e301978173153c45c8f5af` | Laravel/Filament/React portal and adjacent Worker integrations | One clean local commit; not pushed or deployed |
| `pdarleyjr/mbfd-five-display-kiosk` | `D:\CodexWorktrees\mbfd-five-display-kiosk-security-ci-20260729` | `fix/security-ci-20260729` / `4f5afe4a164367b4e831a8dd42496b78573c9e54` | Electron five-window launcher, watchdog, runtime health, P3 display mapping | One clean local commit; not pushed or deployed |
| `pdarleyjr/mbfd-media-peertube` | `D:\CodexWorktrees\mbfd-media-peertube-security-ci-20260729` | `fix/retention-policy-20260729` / `134121ffb57d06ab09b8c10cca83ce5fa1743644` | PeerTube Docker deployment, policy, retention, backup/recovery tests | One clean local commit; not pushed or deployed |

`media-control` preserves upstream ScreenTinker history. `origin` is the private
MBFD repository; the ScreenTinker remote is reference-only. Never push MBFD
changes to the upstream ScreenTinker repository.

`SOURCE_BASELINE.md` describes the historical isolation/staging phase. Its
instruction not to alter `media.mbfdhub.com` has been superseded by the current
explicit production task. Its source-history and upstream-safety information
remain valid; its old deployment assumptions do not.

### 1.3 Media Control stack

- Runtime: pinned Node 22 Alpine container, Express 4, Socket.IO 4.
- Database: SQLite through `better-sqlite3`; additive boot-time migrations.
- Frontend: vanilla JavaScript SPA with ES modules, CSS design tokens, no
  bundler, and a Service Worker for offline player resilience.
- Authentication: JWT operator sessions, bcrypt passwords, six-level
  organization/workspace role hierarchy, long-lived per-device tokens, and
  per-node P3 tokens.
- Media tools: FFmpeg/ffprobe, Sharp/libvips, yt-dlp, Poppler, headless
  LibreOffice, Chromium, libheif/libde265.
- Ingest: multipart upload, TUS resumable upload, YouTube, remote URL,
  Nextcloud/Cloud Files, and PeerTube localization.
- Clients: browser player, Android/Kotlin player, Electron kiosk windows, P3
  cache agent, and operator browsers including the Lenovo Tab One.
- Packaging: a two-stage Docker build with immutable provenance embedded in
  `/app/build-provenance.json`.

Required build arguments are `CACHEBUST`, `GIT_COMMIT`, `GIT_TREE`,
`GIT_BRANCH`, `BUILD_TIMESTAMP`, `BUILD_ID`, and `IMAGE_TAG`. The image build
fails when provenance is missing. Always set `CACHEBUST` to the release commit
because stale BuildKit COPY layers previously deployed old application code.

### 1.4 Core server and frontend modules

| Area | Primary modules | Function |
|---|---|---|
| Application/bootstrap | `server/server.js`, `server/config.js` | Express/Socket.IO startup, security middleware, routes, static SPA/player, services |
| Data model | `server/db/database.js`, `server/db/schema.sql`, `server/db/migrations/` | Tenant-scoped resources, jobs, captions, favorites, saved views, manifests, checksums |
| Content API | `server/routes/content.js`, `frontend/js/views/content-library.js`, `frontend/js/api.js` | Library browsing, cursor search, actions, metadata, upload, preview, Poster Studio |
| Durable processing | `server/lib/media-jobs.js`, `server/lib/media-pipeline.js` | SQLite-leased jobs, concurrency, retries, cancellation, restart recovery, progress and events |
| Canonicalization | `media-transcode.js`, `content-finalization.js`, `finalize-upload.js`, `finalize-download.js` | Probe, normalize, checksum, atomically promote master/derivative/poster, retain originals |
| Integrity and safety | `media-integrity.js`, `remote-media.js`, upload policies | Magic-byte validation, MIME safety, active-content controls, SSRF/redirect/size/time limits |
| Library performance | `content-pagination.js`, FTS migration, ETag routes | Stable ID-keyed cursor pagination, FTS where available, stale-response protection |
| Thumbnails | `thumbnail-studio.js`, `content-thumbnail-cache.js`, `doc-thumbnail.js` | Timestamp capture, crop/upload, guarded atomic poster versioning, PDF/Office/web thumbnails |
| Classroom readiness | `content-readiness.js`, `classroom-preparation.js`, `node-registry.js` | Manifest scope/generation, prepare-one/bulk, verified classroom readiness |
| Delivery | `broadcast-preflight.js`, `server/routes/broadcast.js`, `server/ws/deviceSocket.js` | Exact typed targets, layout revision/generation checks, transfer/readiness estimates, confirmation polling |
| Captions and search | `content-captions.js`, `server/routes/captions.js`, player `<track>` integration | Caption lifecycle, transcript search, accessible playback |
| Observability | `media-observability.js`, `server/routes/media-observability.js` | Queue depth/age/stuck jobs, latency, throughput, source failures, manifests, P3 hits/misses, alerts |
| PeerTube | `peertube-asset-adapter.js`, `peertube-replay.js`, replay/content routes | Download a private PeerTube asset once, localize it, then feed it into the canonical pipeline |
| P3 cache | `appliance/p3/room-agent/cache-agent.js`, `cache-server.js` | Atomic cache, Range support, checksum validation, singleflight fills, manifest prewarm, local playback |
| Device enrollment | `device-enrollment.js`, wall/layout routes, device socket | Idempotent stable identity, workspace scope, additional-display topology and revision handling |

The broader inherited platform also provides playlists, schedules, groups,
multi-zone layouts, video walls, widgets, kiosk mode, proof-of-play, telemetry,
remote input, white-labeling, activity logs, screen sharing, recording/camera
workflows, Android players, and offline web/Android playback. All resources must
remain scoped to `workspace_id`.

### 1.5 Canonical media lifecycle

1. Validate the source and establish a durable job.
2. Reserve bounded disk/concurrency capacity and record source provenance.
3. Download or receive the source without trusting a filename or supplied MIME.
4. Probe bytes and reject active/mismatched/oversized/unsafe content.
5. Normalize video to H.264 8-bit `yuv420p`, AAC stereo, `faststart`; apply HDR
   tone mapping when required and preserve documented ultrawide exceptions.
6. Generate a poster/thumbnail and retain its source hash, timestamp/crop
   provenance, version, path, and checksum.
7. Atomically promote files; never expose a partial output as ready.
8. Update content metadata, checksums, generation, derivative health, and job
   events.
9. Regenerate node manifests and allow P3 prewarm/read-through caching.
10. Permit broadcast only after preflight validates readiness, target revision,
    generation, cache status, audio authority, and transfer estimate.

The pipeline must never stream one private PeerTube source independently to five
TVs. It must localize once and broadcast the local canonical asset. The adapter
fails closed with `PEERTUBE_LOCALIZATION_REQUIRED` when localization is absent.

### 1.6 Adjacent systems and external integrations

- Cloudflare: public DNS, Access policy, Tunnel ingress, and Worker deployment.
  An unauthenticated `302` at `/app` proves Access protection, not application
  health.
- PeerTube: `videos.mbfdhub.com`; official app/nginx/PostgreSQL/Redis stack.
  Media Control owns masters; PeerTube supplies a replay/HLS derivative.
- Nextcloud: Cloud Files imports and user/write bridge services. Imports must go
  through the canonical pipeline and must never auto-broadcast.
- YouTube: yt-dlp ingestion with normalized video-ID deduplication and bounded
  processing.
- Remote URLs/websites: SSRF-safe fetch/probe and Chromium screenshots for safe
  wall rendering when a site cannot be framed.
- Microsoft Graph/Azure MSAL: optional email notifications.
- Google OAuth and Stripe: inherited optional authentication/billing
  integrations; not part of the current classroom acceptance path.
- Camera/live stream: KAMRUI camera API and MediaMTX/RTSP/RTMP paths. The
  KAMRUI API is listening on port `8200`; obsolete port `8755` must not be used.
- MBFD Hub Worker: Workers AI/Vectorize and loopback-only Ollama bridge for
  support/AI features adjacent to Media Control.

### 1.7 Current production identity

Observed on 2026-07-29:

- Container `media-control` is healthy and runs image
  `media-control-media-control:17bda4d`.
- `/api/system/version` reports commit
  `17bda4dec197e658b2cc81379af0322bcf7f10bc`, tree
  `05f853697ca81eaf522704208c62f3e97d667b07`, build
  `gmktec-production-17bda4d`, Node `22.23.1`, and schema migration count `26`.
- Active Compose labels identify `/home/mbfd/media-control/docker-compose.yml`
  plus `/home/mbfd/media-control/docker-compose.override.yml`. Ignore the many
  historical overrides unless performing an explicitly validated rollback.
- Port mappings are Tailscale/LAN/loopback `8096` to container `3001`.
- Database volume:
  `/mnt/mbfd-storage/docker-data/volumes/media-control_media_control_db/_data`
  mounted at `/app/data/db`.
- Uploads: `/home/mbfd/media-control/data/uploads` mounted at
  `/app/server/uploads`.
- Baseline database size was `345,518,080` bytes with a `15,202,832` byte WAL.
  A previous `PRAGMA quick_check` returned `ok`; re-run it before deployment.

## 2. Project status report

### 2.1 Completed source implementation

The following exists in the current dirty Media Control worktree:

- Lenovo/tablet responsive Media Library with 48 px touch targets, keyboard and
  tap alternatives, an accessible Add Media sheet, grid/list views, folders,
  filters, sort, bulk actions, preview/details dialogs, and six translated
  locale files.
- Stable accumulated cursor pagination and stale-request generation guards.
  Actions are keyed by content ID and cover first, middle, and final items in a
  73-item library.
- Durable SQLite-leased processing jobs with bounded concurrency, reservation,
  retry, cancellation, restart recovery, event history, progress, and cleanup.
- One canonical normalization path for multipart, TUS, YouTube, Nextcloud,
  remote URL, and localized PeerTube sources.
- Magic-byte/MIME validation, active-content policy, download limits, redirect
  and SSRF controls, atomic finalization, original retention, checksums, and
  canonical H.264/AAC output.
- Cursor/FTS/ETag content APIs, favorites, saved views, tags, archive,
  lifecycle, details, duplicates, and richer codec/dimension/source/health
  filters.
- P3 explicit workspace scope, node registry isolation, manifest generation and
  revocation, same-workspace authorized fetch, stable device enrollment, and
  source-level sixth-display tests.
- Broadcast preflight and UI for typed physical/wall-region targets, layout
  revision, generation, readiness, checksum, P3 cache, audio authority, cold
  transfer estimates, and per-target confirmation polling.
- Prepare for Class for one or many assets, including queued, downloading,
  verified, ready, failed, retry, cancel, and reconciliation states.
- Captions, transcript search, `<track>` player integration, operational media
  metrics, and actionable alert states.
- PeerTube one-time local private-asset download and canonicalization with
  retries, redirect/size controls, and remote fanout prevention.
- Poster Studio timestamp/crop/custom poster generation with a guarded atomic
  commit and provenance manifest.
- Processing Center job ETA/progress/retry/cancel and a direct Recent scope.

The additive migrations create `media_jobs`, `media_job_events`,
`content_media_metadata`, optional FTS5 structures, `content_captions`,
`content_favorites`, and `content_saved_views`. They are invoked at boot and
must remain idempotent.

### 2.2 Automated verification already achieved

Before the most recent Poster Studio/Processing Center UI change, this branch
passed:

| Gate | Result |
|---|---:|
| Full Node suite | 1,114 passed, 0 failed, 1 deliberate skip across 195 files |
| P3 agent/cache | 16/16 |
| UI contracts | 29/29 |
| Enterprise Playwright | 51/51 |
| Real application Playwright | 10/10 |
| Feature-flag rollback | 16/16 |
| Service Worker | 10/10 |
| Browser console, Chromium + Firefox | 14/14 |
| Responsive/mobile, Chromium + WebKit | 70/70 |
| npm audit for tested Media packages | 0 known vulnerabilities |

After the most recent change:

- `node --check` passed for Content Library, Thumbnail Studio, pipeline, and
  content route files.
- `server/test/thumbnail-studio.test.js` passed 3/3.
- The focused thumbnail/library/operations/pipeline/captions/observability Node
  suite passed 40/40.
- The full release suite has **not** been rerun.

### 2.3 Current blocker

Command:

```powershell
cd D:\CodexWorktrees\media-control-media-library-prod-20260729\server\e2e\real-app
npx playwright test --config=playwright.mobile.config.js --grep "Poster Studio"
```

Current result: two failures, one Chromium and one WebKit. The Recent and
Processing Center assertions pass, including retry/cancel. The Poster Studio
preview assertion then fails:

- Chromium ends at `#/operator-console` with no visible preview.
- WebKit ends at `#/operator-console`; a preview is present but the Poster
  Studio panel is not visible.
- Both runs had been at `#/content` before the transition.

Artifacts are under
`server/e2e/real-app/test-results/mobile-defect-Mobile-opera-...` and include
`error-context.md`, screenshot PNGs, and `trace.zip`; `.last-run.json` records
the failing projects. The prior apparent “hang” was an interrupted wait after
the runner had already completed red.

Do not paper over this by forcing the hash in the test. Split the combined test
into independently diagnosable Recent/Processing and Poster Studio tests, log
URL changes plus `pageerror`/console events, inspect app state restoration and
the 15-second version polling path in `frontend/js/app.js`, and fix the
production route transition.

### 2.4 Requirements A–Y

| ID | Requirement | Source state | Remaining evidence |
|---|---|---|---|
| A | Lenovo responsive UI | Implemented | Rerun post-change responsive suite and physical tablet |
| B | Actions after pagination | Implemented/tested before latest UI change | Full regression |
| C | Non-empty P3 manifest | Implemented in source | Deploy configured workspace; prove nonzero manifest/generation |
| D | Eliminate prewarm 403 | Implemented in source | Live same-workspace prewarm and `X-MC-Cache: hit` |
| E | Audio compatibility | Implemented/tested | Real TV/eARC/video/audio fixtures |
| F | Durable bounded processing | Implemented/tested | Restart/soak and production metrics |
| G | YouTube ingestion | Implemented/tested | Live bounded ingest |
| H | MIME and active-content safety | Implemented/tested | Release security gate |
| I | Poster/thumbnail correctness | Implemented; focused browser red | Fix route failure; regenerate three live missing posters |
| J | Remote URL validation | Implemented/tested | Live safe URL and blocked-SSRF checks |
| K | Stale search/filter | Implemented/tested | Full browser regression |
| L | PDF/Office/web preview | Implemented | Live document/browser and physical display |
| M | Send when ready durability | Temporary browser-tab implementation with explicit warning | Move to durable server state or retain as explicitly temporary per contract |
| N | Cursor/search performance | Implemented/tested | Query-plan/production-latency evidence |
| O | Upload/errors/recovery | Implemented | Full E2E, restart, partial-file cleanup |
| P | Organization/IA | Implemented | Physical Lenovo usability acceptance |
| Q | Canonical media model | Implemented/additive migration | Backup, migration rehearsal, production consistency |
| R | PeerTube | Adapter implemented/tested | Live auth/localize/reconcile; no five-way remote fanout |
| S | Nextcloud | Import routed through pipeline | Live import; confirm no auto-broadcast |
| T | Broadcast preflight/confirmation | Implemented/tested in source | Safe live five-target request to five `confirmed`, render and restore |
| U | Prepare for Class | Implemented/tested | Live manifest/prewarm/readiness/cache hit |
| V | Duplicates/health/captions/observability | Implemented/tested | Production metric/alert verification |
| W | GPU canary | Failed closed safely | Stay on tested software `libx264`; do not map GPU |
| X | Security/dependencies/CI | Four local branch commits plus scans | Push, CI, branch-delta alert review; unresolved alerts remain |
| Y | Additional displays | Stable enrollment/sixth-display source tests implemented | Live sixth enrollment/topology and physical mapping; kiosk count change only if adding a physical sixth TV |

### 2.5 Live defects that remain until this source is deployed

- P3 cache reports `manifest_count=0`.
- Cache health reports 29 hits, 6 misses, 5 fill failures, with the last failed
  origin request returning HTTP `403`.
- The current production container does not have
  `CLASSROOM_LOCAL_CACHE_WORKSPACE_ID` in its environment.
- Three of ten live local-video items lack a usable thumbnail.
- Current live source does not include this task’s durable pipeline, IA,
  preflight, readiness, Poster Studio, or additional-display repairs.

The live baseline had 73 active content items totaling 1,251,601,261 bytes:
53 local and 20 remote, with no observed missing or size-mismatched local files.
The classroom workspace is `dd3e4549-7c7b-441e-b515-ef39a5096402`. Primary and
secondary walls contain three and two members with observed layout revisions
135 and 6.

There are 184 unscoped rows named `Unnamed Display`, produced by web-player
provisioning churn. Do not bulk-delete them. Repair stable enrollment and prove
which identities are obsolete before any cleanup proposal.

### 2.6 Security and CI status

- Media Control security commit `6a4fcac` updates podium Electron to the
  lockfile-resolved `42.8.0` and adds a CI audit. Current default-branch GitHub
  counts were 17 Dependabot, 422 CodeQL, and 0 secret-scanning alerts. A critical
  request-forgery finding around same-origin `fetch('/api' + url)` was manually
  verified as a false positive but not dismissed. Many rate-limit/path findings
  remain.
- MBFD Hub commit `df4c95a` fixes eight actionable CodeQL findings, constrains
  the Ollama bridge, corrects a build race/service-worker origin behavior, and
  updates Worker tooling. Current default-branch counts were 9 Dependabot, 8
  CodeQL, and 2 secret-scanning alerts. Full-history gitleaks still reports
  legacy hits and DOCX text-conversion errors; the changed Worker surface was
  clean.
- Kiosk commit `4f5afe4` adds the production gate; 66 tests, 18 PowerShell
  syntax checks, npm audit, and full-history gitleaks passed.
- PeerTube commit `134121f` codifies retention/recovery policy; policy,
  resource, recovery, documentation, shell syntax, and full-history gitleaks
  checks passed.
- GitHub security features could not be enabled/queried for some kiosk and
  PeerTube settings with the available plan/permissions. Never translate this
  into “no alerts.”

No branch is pushed or merged. None of these changes has green remote CI or
deployment evidence yet.

### 2.7 Remaining backlog in execution order

1. Reproduce and fix the real `#/content` to `#/operator-console` transition.
2. Split the combined focused E2E for diagnostic isolation; preserve a
   regression for the root cause.
3. Rerun Node, P3, UI contract, enterprise UI, real-app, rollback, Service
   Worker, browser-console, and responsive/mobile suites.
4. Rerun all relevant npm audits, changed-surface secret scans, syntax checks,
   and `git diff --check`; review every intentional dirty file.
5. Update `docs/MEDIA_LIBRARY_PRODUCTION_TRACEABILITY_20260729.md` from
   implementation-time labels to exact final evidence.
6. Commit the Media Control core coherently. Push all four branches, open/merge
   reviewed PRs as appropriate, and wait for green CI.
7. Take a verified online SQLite backup, uploads backup, active Compose/override
   copy, PeerTube state backup where affected, and record the current image ID
   and tag.
8. Build an immutable Media Control image with complete provenance and verify
   the embedded source/tree independently before deployment.
9. Add the classroom workspace configuration to the active Media service and
   deploy through the exact active Compose pair. Do not enable the failed GPU
   path.
10. Update the P3 cache agent/config safely; prove a nonzero manifest, generation
    coverage, successful prewarm, checksum, Range behavior, and local cache hit.
11. Validate PeerTube localization/reconciliation, Nextcloud and YouTube ingest,
    safe URL handling, and processing metrics.
12. Use a controlled same-content classroom broadcast; poll
    `/api/broadcast/<request_id>` until all five typed targets are `confirmed`;
    verify rendered state and restore the pre-test content.
13. Enroll an additional display idempotently and prove no duplicate/orphan
    growth. If the requirement is an actual sixth TV on the P3, update the kiosk
    display mapping and expected count as a separate reversible change.
14. Complete physical Lenovo touch/keyboard, five-TV pixels, eARC audio,
    document/video, camera, native Safari, and long-duration acceptance with a
    human observer. These gates cannot be inferred from emulation.

## 3. Development log and troubleshooting

### 3.1 Authoritative checkout and dirty-worktree safety

The supplied workspace can be a wrapper or another repository. This task’s
authoritative implementation is the dedicated Media worktree named at the top.
Run `git worktree list --porcelain`, `git status --short --branch`, and
`git rev-parse --show-toplevel` before editing. The current dirty state belongs
to this task. Never use `git reset --hard`, `git clean`, or checkout-overwrite
commands here.

The three adjacent repository worktrees are clean and one commit ahead of their
respective `origin/main`; they are not substitutes for the uncommitted Media
Control implementation.

### 3.2 Release identity must be independently proved

A local branch, remote-tracking reference, successful image build, and healthy
container are different claims. Record and compare:

- canonical repository and release ref;
- commit and tree;
- reviewed/green CI SHA;
- immutable image tag and image ID/digest;
- OCI labels and `/app/build-provenance.json`;
- `/api/system/version`;
- browser-loaded frontend/player hashes.

BuildKit previously reused stale COPY layers. `CACHEBUST=<release SHA>` is
mandatory. Do not report production complete from a container name or a
successful HTTP response alone.

### 3.3 SQLite and deployment safety

The database is live, large, and uses a WAL. Do not copy only the `.db` file
while the application is writing. Use the application’s `better-sqlite3`
online-backup path or a verified coordinated volume snapshot, then run
`PRAGMA quick_check` on the backup. Preserve the database, WAL context, uploads,
Compose files, and prior immutable image.

The new migrations are additive and idempotent, but rehearse them against a
production-copy database and test application rollback. If a rollback needs
data rollback, use the verified predeployment backup, not an ad hoc copy.

### 3.4 P3 manifest and authorization defects

Root cause of the empty manifest: the live node `classroom-1-p3` was not bound
to a workspace, so periodic manifest generation produced no scoped content.
The source repair introduces explicit server workspace configuration and
workspace-isolated registry behavior.

The prewarm `403` is not proof that the entire cache is broken; the cache later
filled some content through another path. Test same-workspace unassigned fetch,
cross-workspace denial, archive/revocation, checksum mismatch, Range requests,
restart reconciliation, and `X-MC-Cache: hit`.

The P3 cache health endpoint is `http://127.0.0.1:8097/healthz`. A healthy agent
with `manifest_count=0` is still functionally incomplete.

### 3.5 Five-display health versus physical acceptance

P3 kiosk health on 2026-07-29 reported expected/actual/window/healthy counts all
equal to five, with five visible always-on-top 1280×720 windows. That proves
software window/watchdog state only. It does not prove that all TVs show the
right pixels, that the correct TV is mapped to each target, or that the
soundbar receives correct audio.

Front Left is the only audio authority. Unknown or missing display names must
fail muted. Preserve Windows Firewall; the room agent needs outbound LAN/Tailnet
access, not a disabled firewall.

### 3.6 Additional-display rules

Use a stable device identity and idempotent enrollment. Reconnects must update
the same row, not create another `Unnamed Display`. Model physical split-wall
members separately from logical Mosaic regions, bind commands to the current
layout revision, and invalidate preflight when topology changes.

The current physical contract is five displays. A sixth logical/test display
must not silently change kiosk `expectedCount`. A real sixth television requires
an explicit P3 `config.local.json` display mapping, window placement, audio
policy, firewall/connectivity check, topology revision, watchdog expectation,
rollback copy, and human physical verification.

### 3.7 Media integrity and resource exhaustion

Do not trust extensions, browser MIME, remote `Content-Type`, or ffprobe alone.
Use magic bytes and enforce active-content policy. Bound request bytes, decoded
pixels, duration, redirects, DNS resolution, job concurrency, wall-clock
runtime, and reserved disk. Every failure/cancel/retry must remove partial
outputs without deleting the last known-good asset.

Poster commits must compare source hash/version before atomic promotion. A late
job must never overwrite a poster generated for a newer source. Office/PDF/web
thumbnail failures must be observable and retryable, not silently interpreted
as media readiness.

### 3.8 PeerTube and remote sources

Private PeerTube content must be fetched once server-side, validated, converted
to a local canonical asset, and then distributed through the P3/cache path.
Never leak PeerTube credentials into a player URL or logs, and never issue five
independent private remote streams.

The active PeerTube Compose release is identified by Docker labels at
`/opt/mbfd/releases/mbfd-media-peertube/ef979f98642fa4bfa2063cf6e47d1182eb732004/docker-compose.yml`;
the source/control checkout is `/opt/mbfd/mbfd-media-peertube`. Do not assume
that editing the control checkout changes the active release.

Remote URL validation must pin the resolved address through redirects and block
loopback, link-local, RFC1918, metadata, and other non-public destinations
unless an explicitly scoped trusted integration requires them.

### 3.9 Browser testing and the current Poster Studio failure

Playwright emulation is required but does not establish physical Lenovo or
native Safari acceptance. Keep the exact Lenovo landscape viewport, portrait,
phone, desktop, 200% text, keyboard, tap, and horizontal-overflow checks.

For the current failure:

1. Open each `trace.zip` in Playwright trace viewer.
2. Capture `page.url()` before/after Poster Studio click.
3. Attach `page.on('pageerror')`, error-level console, request failures, and
   navigation logging before the first application action.
4. Run Poster Studio in its own fresh authenticated page.
5. Inspect `frontend/js/app.js` version polling and state restoration, route
   teardown in Content Library, and any socket callback that calls navigation.
6. Fix the application cause and keep a regression that fails on the old
   behavior.

Do not increase the timeout as a substitute for diagnosis.

### 3.10 Security-scan interpretation

Scan the exact release tree and report tool coverage. A clean changed-surface
scan does not erase legacy full-history findings. A missing GitHub feature does
not mean zero alerts. A known false positive must be documented and dismissed
through the normal review path; it must not be silently counted as remediated.

The Hub previously exposed a Linux native dependency gap involving
`lightningcss`; verify every target-platform optional native dependency inside
the actual Linux build, not only on Windows. Preserve the loopback-only Ollama
bridge and same-origin Service Worker behavior from the Hub security branch.

### 3.11 Hardware encoding

The GMKtec exposes AMD `/dev/dri/renderD128`, but the current production
container deliberately maps no GPU. An isolated release-image canary with
mapped AMD devices failed libva initialization for six bounded
codec/HDR/audio/ultrawide cases. Leave production on tested software `libx264`.
Do not add GPU mapping until a separate canary passes every case and software
fallback is proven.

### 3.12 Machine-specific lessons

- KAMRUI camera API listens on `8200`, not obsolete `8755`. Its `/health` path
  returned `404`; current evidence is a listening socket, not an application
  health contract.
- Use short, bounded P3 probes. Do not recursively dump or parse large live logs;
  a prior broad diagnostic caused memory pressure.
- Tailscale in `NoState` cannot resolve/reach the tailnet. Run `tailscale up` and
  complete browser authentication before diagnosing SSH.
- A Cloudflare Access `302` is expected for an unauthenticated public probe.
- Do not select a deployment override by filename freshness. Docker Compose
  labels identify the active working directory and config files.

## 4. Credentials and authentication

Credential values must not be copied into this document, command output,
commits, issue comments, or logs. The following index gives the exact existing
credential source and the name under which each value must be supplied. This is
enough for an agent running on the authorized workstation/hosts to use the
current credentials without moving key material.

| Integration | Credential source | How to use |
|---|---|---|
| GitHub API/HTTPS | Windows GitHub CLI keyring; active account `pdarleyjr` | Verify with `gh auth status`; use `gh` and normal HTTPS Git operations without printing the token |
| GitHub SSH for MBFD Hub | `C:\Users\Peter Darley\.ssh\mbfd_hub_deploy`, alias `github-mbfd` | Use the configured repository remote; never read or copy the private key |
| Cloudflare API/Wrangler | User-supplied Cloudflare API token in the secure task context | Set it only as process environment variable `CLOUDFLARE_API_TOKEN`; current Wrangler OAuth session is expired |
| GMKtec SSH | `C:\Users\Peter Darley\.ssh\id_ed25519_gmktec` via alias `gmktec` | `ssh gmktec`; public-key only and `IdentitiesOnly yes` |
| P3 SSH | `C:\Users\Peter Darley\.ssh\mbfd_p3_classroom_ed25519` via alias `mbfd-p3-classroom` | `ssh mbfd-p3-classroom`; use the existing SSH configuration |
| KAMRUI SSH | `C:\Users\Peter Darley\.ssh\id_ed25519_mbfd_ubuntu` via alias `mbfd-ubuntu` | `ssh mbfd-ubuntu`; use the existing SSH configuration |
| Media Control runtime | Active GMKtec Compose environment in `/home/mbfd/media-control/.env` and active override | Use through Compose; never print `docker inspect` environment values |
| Media operator/device auth | Media Control database plus host environment | Obtain a short-lived authorized operator session or existing test harness; keep JWT/device tokens out of traces |
| P3 node/cache auth | Server `CLASSROOM_LOCAL_CACHE_NODE_TOKEN`; matching on-box `MC_NODE_TOKEN` in gitignored P3 config/runtime | Values must match; add `CLASSROOM_LOCAL_CACHE_WORKSPACE_ID=dd3e4549-7c7b-441e-b515-ef39a5096402` to the server release |
| P3 display auth | `deviceId`/`deviceToken` in P3 `config.local.json` or scheduled-task runtime | Use the installed gitignored configuration; do not create new identities on reconnect |
| PeerTube admin/API | `/opt/mbfd/mbfd-media-peertube/.admin-credentials` and `.env` on GMKtec | Read only inside the required server-side command; use API auth server-side |
| Nextcloud bridges | Media runtime variables `NC_USERFS_TOKEN`, `NC_WRITE_TOKEN`, `NEXTCLOUD_SHARED_PASSWORD` | Consume through the active container/Compose environment |
| Camera control | `CAMERA_CONTROL_TOKEN`, `CAMERA_CONTROL_SIGNING_SECRET`, key ID/version in Media runtime; matching KAMRUI systemd environment | Use signed server-to-server requests; never expose them to the browser |
| Live/OBS | `OBS_WEBSOCKET_PASSWORD`, `CONSOLE_DEVICE_TOKEN`, stream keys in host/systemd runtime | Use only in server/edge processes; never embed in content/player URLs |
| Microsoft Graph | `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, sender configuration in the applicable host environment | Optional email integration; use client-credentials flow |
| MBFD Hub/Worker | Hub production `.env`; Worker secrets including `BRIDGE_TOKEN` and `INGEST_SECRET` | Use `wrangler secret put <NAME>` for Worker updates; do not put values in `wrangler.toml` |

Current Media container environment names also include
`CLASSROOM_LOCAL_CACHE_ENABLED`, `CLASSROOM_LOCAL_CACHE_BASE`,
`CLASSROOM_LOCAL_CACHE_ROOM_ID`, `CLASSROOM_LOCAL_CACHE_WALL_IDS`,
`CLASSROOM_AUDIO_AUTHORITY_DEVICE_ID`, `PEERTUBE_BASE_URL`,
`PEERTUBE_LIVE_WATCH_URL`, `CAMERA_CONTROL_BASE_URL`, `CAMERA_PREVIEW_URL`,
`LIVE_STREAM_*`, `AI_DIRECTOR_*`, `NEXTCLOUD_*`, `NC_*`, and build provenance
variables. Inspect names only when diagnosing; do not dump values.

Git identity for commits:

```text
name/account: pdarleyjr
email: pdarleyjr@gmail.com
```

## 5. Infrastructure and access control

### 5.1 Tailscale prerequisite

All three operational machine aliases use Tailscale IPs. Check the local client
before SSH:

```powershell
tailscale status
```

If it reports `NoState`, run `tailscale up` and complete the browser login to
the authorized tailnet. No application credential compensates for an
unauthenticated Tailscale client.

### 5.2 SSH aliases

The authoritative SSH configuration is
`C:\Users\Peter Darley\.ssh\config`.

| Machine | Command | User | Tailscale IP | Other observed identity |
|---|---|---|---|---|
| GMKtec EVO-X2 | `ssh gmktec` | `mbfd` | `100.81.154.123` | Hostname `mbfdhub`; password auth disabled |
| Lenovo ThinkStation P3 | `ssh mbfd-p3-classroom` | `pdarl` | `100.123.92.37` | Hostname `CLASSROOM`; LAN `192.168.1.101`; Windows 11 Pro |
| KAMRUI AK1 Plus | `ssh mbfd-ubuntu` | `peter` | `100.82.185.48` | Hostname `peter-Default-string`; Ethernet `192.168.1.122`; Wi-Fi `192.168.1.80`; Ubuntu 24.04 |

Use these aliases exactly. Do not replace them with raw IP/key flags in scripts,
and do not print, paste, move, or regenerate the existing private keys.

### 5.3 GMKtec production paths and ports

| Service | Active path / identity | Host exposure |
|---|---|---|
| Media Control | `/home/mbfd/media-control`; active `docker-compose.yml` plus `docker-compose.override.yml` | `8096 -> 3001` on loopback, Tailscale, and LAN |
| PeerTube | Active release Compose at `/opt/mbfd/releases/mbfd-media-peertube/ef979f98642fa4bfa2063cf6e47d1182eb732004`; control checkout `/opt/mbfd/mbfd-media-peertube` | nginx `127.0.0.1:8098 -> 80`; RTMP `100.81.154.123:19350 -> 1935` |
| MBFD Hub | `/opt/mbfd/mbfd-hub/compose.prod.yaml` | Laravel `127.0.0.1:8080 -> 80`, internal `8090 -> 8080` |
| Legacy ScreenTinker | `/home/mbfd/screentinker` | `127.0.0.1:8095 -> 3001`; do not modify as part of this release |

Cloudflare Tunnel fronts the public routes. Production deployment should use the
existing route and active Compose project; do not create a second Media Control
site/container or alter unrelated tunnel ingress.

### 5.4 P3 runtime

- P3 cache health: `http://127.0.0.1:8097/healthz`.
- Room-agent/cache runtime root: `C:\MBFD\RoomAgent`.
- Portable Node runtime is under `C:\MBFD\node`; `node-path.txt` records the
  selected executable.
- Kiosk runtime: `C:\MBFD\FiveDisplayKiosk`.
- Local runtime configuration is gitignored (`config.local.json`, environment
  in launcher/scheduled task).
- Relevant tasks include room/cache agent, kiosk startup/watchdog, audio
  enforcement, and wired-first network enforcement.

Before and after an update, record service/task state, current config hash,
kiosk health JSON, five window mappings, cache health, and rollback copies.

### 5.5 KAMRUI runtime

Use `ssh mbfd-ubuntu`. Confirm the camera/control service at TCP `8200` and the
MediaMTX/RTSP/RTMP path before testing PeerTube live ingest. Do not infer an API
health endpoint from the listening socket. The AI Director was not observed as
active in the current baseline.

### 5.6 Public endpoints

| Endpoint | Baseline observation |
|---|---|
| `https://media.mbfdhub.com/app` | `302` to Cloudflare Access when unauthenticated |
| `https://media.mbfdhub.com/app#/content` | Same protected shell route |
| `https://videos.mbfdhub.com` | HTTP `200` |
| `https://www.mbfdhub.com` | HTTP `200` |

For authenticated browser verification, use an authorized short-lived session.
Never place bearer tokens in URLs, screenshots, Playwright artifacts, shell
history, or the document.

### 5.7 Deployment and rollback runbook

1. Freeze and record the reviewed release commit/tree and green CI runs.
2. Query active Compose labels again; paths can drift.
3. Run SQLite integrity checks and create a verified online backup. Back up
   uploads and the exact active Compose/env files without printing secrets.
4. Record current container image/tag/ID, runtime version response, P3 config and
   health, PeerTube active release, and classroom wall state.
5. Build the immutable image with all provenance arguments. Run the release
   suite and image-level smoke/security checks.
6. Deploy only the saved image through the active Compose project. Set the
   classroom workspace ID and required matching node token. Keep software
   encoding.
7. Verify container health, restart count, logs, listening sockets, migration
   state, database integrity, version/tree/image identity, and frontend hashes.
8. Update/restart the P3 agent only after the server is compatible. Verify
   manifest, prewarm, local cache, then five kiosk windows.
9. Exercise the live application and a safe broadcast. Restore the prior
   classroom state.
10. If rollback is required, restore the saved active Compose configuration and
    prior image `media-control-media-control:17bda4d`. Use the verified database
    backup only when data rollback is required and migration compatibility has
    been assessed.

## 6. Operational goal

The objective is a fully fixed, completed, secure, observable, and recoverable
Media Control ecosystem running at `media.mbfdhub.com`, with Media Control as
the authoritative media plane, P3 as a correct local classroom cache/display
host, PeerTube as a bounded derivative, and all target displays—including
newly enrolled displays—represented by stable identities and revision-bound
topology.

The release is complete only when all of the following are true:

- The implementation is reviewed, committed, pushed, merged as appropriate,
  and every required CI/security/regression workflow is green for the exact
  deployed SHA.
- The deployed immutable image independently proves commit, tree, build, tag,
  and runtime/frontend identity; source and runtime match.
- Safe, verified database/assets/configuration backups and a tested rollback
  route exist.
- Boot migrations complete idempotently and database integrity is clean.
- The full A–Y traceability matrix has direct evidence with no undocumented
  `Pending`, `Implementing`, or ambiguous status.
- The Media Library works at all required responsive sizes and with touch,
  mouse, and keyboard; pagination, filters, actions, dialogs, Poster Studio,
  Processing Center, errors, retry/cancel, and stale responses are correct.
- Every ingest source converges on the bounded canonical pipeline, with valid
  bytes/MIME, checksums, derivatives, posters, provenance, cleanup, and
  observable durable jobs.
- The P3 manifest is nonzero and workspace-correct; prewarm no longer fails
  authorization; local requests show verified cache hits and safe fallback.
- Exact typed targets, layout revision, generation, readiness, audio authority,
  and transfer state pass preflight.
- A controlled five-display broadcast reaches `confirmed` for every intended
  target, renders the intended content, and the previous classroom state is
  restored.
- Additional display enrollment is idempotent, topology updates do not create
  orphan rows, revisions invalidate stale commands, and any physical added
  screen has a verified kiosk mapping and watchdog expectation.
- Live PeerTube, Nextcloud, YouTube, URL, PDF/Office/web, captions, camera, and
  observability paths work without credential leakage or remote five-way
  fanout.
- Physical Lenovo touch/keyboard, all TV pixels/mapping, eARC audio, native
  Safari where required, camera/live input, restart behavior, and long-duration
  operation are witnessed and recorded separately from browser emulation.
- Production logs and browser consoles are error-free for the acceptance
  workflow, operational alerts are actionable, and no unresolved release
  blocker is represented as a false success.

Until every item above has evidence, the correct status is **not production
complete**. The next concrete action is to fix the Poster Studio route
transition, then rerun the complete local release gate before any commit,
push, or deployment.
