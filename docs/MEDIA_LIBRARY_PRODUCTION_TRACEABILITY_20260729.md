# Media Control production traceability — 2026-07-29

Release base: live embedded source `17bda4dec197e658b2cc81379af0322bcf7f10bc`.

This matrix records the post-fix local release evidence. It does not convert
unobserved production or physical checks into success. `Local verified; live
pending` is an explicit release blocker until the corresponding production
evidence is appended after deployment.

| ID | Contract area | Primary code path | Failing reproduction / baseline | Verification evidence and remaining gate | Status |
|---|---|---|---|---|---|
| A | Lenovo responsive Media Library | `frontend/js/views/content-library.js`, frontend CSS | Exact deployed-source UI contract tests fail; current 768px breakpoint misses 838×500 | 74/74 Chromium/WebKit responsive tests passed at Lenovo landscape/portrait, phone, desktop, touch, keyboard and 200% text. Physical Lenovo remains separate. | Local verified; physical pending |
| B | Post-pagination actions | `frontend/js/views/content-library.js` | Deployed-source test proves handlers close over page-local content instead of accumulated state | Responsive E2E exercises first/middle/final actions after loading all 73 items; UI contract and full release suites passed. | Local verified |
| C | P3 full-library manifest | `server/lib/node-registry.js` | Live node `classroom-1-p3` has `workspace_id=null`; live `/healthz` reports `manifest_count=0` | Workspace isolation, persisted assignment, manifest generation and reconciliation tests passed. A nonzero live P3 manifest still requires deployment/configuration. | Local verified; live pending |
| D | Prewarm authorization | node registry/content file authorization | Live cache reports last failure `origin_status_403`, followed by later successful fill | Same-workspace node access, cross-workspace denial, revocation and cache-agent tests passed. Live checksum/Range/cache-hit evidence remains. | Local verified; live pending |
| E | Audio compatibility | `server/lib/media-transcode.js` | Failing regression: incompatible/multichannel audio is classified safe | Codec/container/audio/channel/HDR classification and bounded command-plan regressions passed. Real TV/eARC playback remains physical. | Local verified; physical pending |
| F | Blocking/resource exhaustion | media job/finalization helpers, ingest routes | Durable job module absent; synchronous/unbounded paths reproduced in source | Persistence, leases, retries, concurrency, timeout, disk/pixel/file/duration bounds, cancellation and partial cleanup passed in the release suite. | Local verified; soak pending |
| G | YouTube ingestion | `server/routes/content.js`, media pipeline | Existing path lacks durable global job/deduped classroom profile | Normalized identity, bounded 1080p H.264/AAC preference, retry/finalization and cleanup tests passed. Controlled live ingest remains. | Local verified; live pending |
| H | MIME integrity/active content | content ingest/file serving | Technical MIME remains mutable/weakly tied to bytes | Byte-derived MIME, active-content rejection, authorization, `nosniff`, disposition and sandbox tests passed; changed-surface secret scan is clean. | Local verified |
| I | Thumbnail/poster correctness | canonical finalizer and thumbnail jobs | Live: 3 of 10 local video items lack usable thumbnails | Poster route regression failed before the auth-header fix and passed 2/2 afterward; hash/version/path guards and the full responsive suite passed. Live regeneration remains. | Local verified; live repair pending |
| J | Remote URL validation | remote-media helper/routes | Validation module absent in deployed source | SSRF, DNS, redirect, timeout, size, MIME, Range and health-classification regressions passed. Controlled live safe/blocked probes remain. | Local verified; live pending |
| K | Stale filter/search state | `frontend/js/views/content-library.js` | Deployed-source UI contract proves no request generation/abort guard | Slow stale-response E2E and full browser regression passed in Chromium/WebKit. | Local verified |
| L | PDF/Office/web preview | Media Library preview/details UI | Deployed generic preview lacks accessible document handling | Dialog, focus, Escape and safe preview contracts passed. One LibreOffice conversion test is explicitly environment-skipped locally because `soffice` is absent; image/live and physical checks remain. | Local verified except image test |
| M | Send-when-ready durability | content readiness and broadcast delivery | The requested browser-tab behavior is intentionally temporary | The UI explicitly warns that the tab must remain open and still requires preflight review; this temporary contract and server readiness enforcement passed. It is not represented as durable. | Explicit temporary contract |
| N | Pagination/search performance | content list API/database | Offset/tie and broad-search paths under review | Cursor stability, deterministic ordering, search migration/index use, ETag and usage-query regressions passed. Production latency sampling remains. | Local verified; live latency pending |
| O | Upload/errors/recovery | Media Library and ingest APIs | UI contract failures cover semantics, duplicate submits, raw errors, `formatFileSize(0)` | Keyboard/touch, idempotency, stage truth, friendly errors, restart and cleanup regressions passed. | Local verified |
| P | Organization/IA | Media Library | Live: 73 records, 3 folders, 5 foldered, 68 root | All/Unfiled, view, sort/filter, accessible bulk alternatives and permissions passed automated gates. Physical Lenovo usability remains. | Local verified; physical pending |
| Q | Canonical media model | DB/media pipeline/asset manifest | Existing content/checksum/variant model inventoried | Additive/idempotent migration, master/derivative provenance, job, manifest, cache and health consistency tests passed. Verified live backup/rehearsal remains. | Local verified; live backup pending |
| R | PeerTube integration | replay adapter and PeerTube deployment | Live services healthy; source checkout identity/config still reconciling | Adapter identity/auth, bounded localization, reconciliation, outage and path-containment tests passed. Live localization/reconcile remains. | Local verified; live pending |
| S | Nextcloud/Cloud Files | `server/routes/files.js`, media finalizer | Import path can bypass normalization | Cloud import now enters the canonical pipeline; codec/poster/manifest/generation and no-auto-broadcast regressions passed. Live import remains. | Local verified; live pending |
| T | Broadcast preflight/delivery | broadcast delivery/status APIs | Current five typed displays online; transport success alone is insufficient | Exact typed target, layout revision, generation, readiness and audio-authority preflight tests passed. Five live `confirmed` targets, render confirmation and restore remain. | Local verified; live pending |
| U | Prepare for class | asset manifest/node assets/cache agent | Live manifest empty; server has 56 generated checksums, `node_assets` empty | Queue/download/verify/fail/retry/cancel/reconcile and P3 cache tests passed. Live nonzero manifest, checksum and cache hit remain. | Local verified; live pending |
| V | Duplicates/health/captions/observability | media model/jobs/metrics | Current checksum coverage 56/73; metrics coverage under review | SHA-256, duplicate signal, caption validation, queue/age/failure/manifest/cache metrics and alert contracts passed. Live metric/alert verification remains. | Local verified; live pending |
| W | Hardware-assisted encoding | isolated canary only | Host exposes AMD `amdgpu` render node, but production has no device mapping; the release image could not initialize VAAPI even in a device-mapped isolated container | Six bounded SDR/HDR/audio/ultrawide H.264/HEVC/VP9/AV1 cases all failed before encoding; keep software fallback and do not map the GPU into production | Failed closed |
| X | Security/dependencies/CI | all four repositories/workflows | The first exact-head GitHub CodeQL gate surfaced 34 changed-code alerts despite its analysis jobs completing | Four npm audits report zero vulnerabilities; gitleaks reports zero findings; Semgrep and CodeQL drove regression-tested same-origin API/caption URL, standard rate-limit, stable file-inspection and path-containment hardening. The hardened exact head still requires a clean repeat CodeQL/release gate and image scan. | Local verified; hardened remote CI pending |
| Y | Additional display enrollment/topology | device registration, walls, kiosk mapping | Live DB has 196 device rows: 184 unscoped `Unnamed Display`; current five wall members are healthy | Idempotent stable enrollment, sixth logical display, dynamic count, revision and no-orphan source tests passed. No physical sixth TV was asserted, so kiosk expected count remains five. | Local verified; physical addition not asserted |

## Post-fix local release evidence

- Poster Studio authentication regression: failed 2/2 before the fix, then
  passed 2/2 in Chromium and WebKit. Processing Center isolation also passed
  2/2.
- Responsive/mobile matrix: 74/74 passed in Chromium and WebKit with no skips.
- `npm run test:release`: Node 1,123 passed with one explicitly reported local
  environment skip (`soffice` absent); P3 16/16; UI contract 29/29; enterprise
  UI 51/51; real app 10/10; feature rollback 16/16; Service Worker 10/10; and
  browser console 14/14 across Chromium and Firefox.
- Additional path-containment regressions: 15/15 PeerTube, URL-download and
  YouTube tests passed after malformed job/content identities were made
  fail-closed.
- Syntax/diff: 78 changed JavaScript files passed `node --check`;
  `git diff --check` reported no whitespace errors.
- Dependencies: npm audit reported zero vulnerabilities in the server,
  enterprise UI E2E, real-app E2E and Electron dependency trees.
- Secrets: final whole-working-tree gitleaks scan reported zero findings.
- Static analysis: Semgrep parsed all 78 changed JavaScript files without
  errors. Its path-join and direct-response heuristics were manually reviewed;
  generated/basename-confined paths and sandboxed `text/vtt` responses are not
  HTML execution sinks. The two identifier-derived path gaps found during that
  review were fixed with failing-then-passing containment regressions.
- GitHub CodeQL's first pull-request gate reported 34 alerts on the large
  changed surface. The hardened follow-up constrains browser API requests and
  caption tracks to their intended origins, replaces the hand-built limiter
  with `express-rate-limit`, constrains inspection to the media root, and
  removes the stat/open race by inspecting one open file descriptor. The
  focused security regression suite passed 7/7 and the complete post-hardening
  release gate passed.

## Baseline production evidence

- Container: healthy, restart count 0, image `media-control-media-control:17bda4d`.
- Embedded runtime identity: commit `17bda4d`, tree `05f853697ca81eaf522704208c62f3e97d667b07`,
  build `gmktec-production-17bda4d`.
- SQLite `quick_check`: `ok`; DB 345,518,080 bytes; WAL 15,202,832 bytes at baseline.
- Media: 73 active records, 1,251,601,261 bytes, 53 local, 20 remote,
  no missing/size-mismatched local files, 3 missing local-video thumbnails.
- P3 cache: healthy, 72 files, 1,443,204,693 bytes, zero manifest items,
  29 hits, 6 misses, 5 fill failures, last failure HTTP 403.
- Classroom kiosk: expected/actual/window/healthy count all 5; watchdog healthy.
- KAMRUI: camera API is listening on port 8200.
- Public `media.mbfdhub.com/app`: Cloudflare Access returns the expected protected
  302 for an unauthenticated request.
- GPU canary: the host has `/dev/dri/renderD128` on AMD Strix Halo with the
  `amdgpu` driver; production intentionally maps no GPU device. An isolated
  release-image canary mapped `card0` and `renderD128`, but libva initialization
  failed for all six bounded codec/HDR/audio/ultrawide cases. No production GPU
  access was enabled; tested `libx264` remains the safe fallback.
