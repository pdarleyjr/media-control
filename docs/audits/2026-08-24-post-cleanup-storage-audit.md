# Post-cleanup storage audit — 2026-08-24 after-hours window

## Scope and safety boundary

This audit records the bounded cleanup and prevention work performed on the GMKtec production host after the earlier, separately verified LVM expansion. The after-hours work did not expand or shrink the logical volume, relocate Docker/containerd, run a blanket Docker prune, remove a container/image/volume, or delete an unknown artifact.

Production mutation ownership remained serialized. Running-container identities were captured before and after each cleanup or deployment operation. The protected inventory included all running images, intentionally stopped containers, live databases and volumes, active configuration, Media Control uploads and SQLite data, P3 cache and kiosk artifacts, current releases, dirty worktrees, and at least two available Media Control rollback images.

## Capacity result

| Measurement | Before bounded cleanup | Final verified state |
| --- | ---: | ---: |
| Root filesystem total | 1,056,281,419,776 B | 1,056,281,419,776 B |
| Root filesystem used | 486,986,579,968 B | 432,005,857,280 B |
| Root filesystem available | — | 580,214,853,632 B |
| Root use percentage | approximately 48% | 43% |
| Measured decrease in used blocks | — | 54,980,722,688 B (approximately 51.2 GiB) |
| Running / total containers | 78 / 90 | 78 / 90 |
| Unhealthy containers | 0 | 0 |

The volume group retained approximately 904.68 GiB unallocated reserve. No additional LVM operation was performed in this window.

The later final regression gate measured 44% root use after the exact audio, hotfix, UI, and rollback release artifacts were loaded and intentionally retained. That post-release figure remained below the 80% warning threshold; it does not change the end-of-cleanup reclamation measurement above.

Category figures below describe tool-reported or logical artifact sizes and must not be added together as a second filesystem-reclamation total; Docker layers, filesystem allocation, compression, and offloaded-file accounting differ. The authoritative reclaimed result is the measured root used-block delta above.

## Cleanup by category

### BuildKit cache

- Confirmed there was no active Docker/BuildKit build.
- Used the installed builder's supported, bounded cache-prune controls; no `docker system prune`, `docker system prune -a`, or unbounded image prune was used.
- Docker reported 24.85 GB removed by the one-time bounded BuildKit cleanup.
- Running-container identities were unchanged after cleanup.

### Restore-smoke trees

- Classified 16,693,579,128 B of historical restore-smoke trees.
- Copied them to the backup filesystem first, generated checksums, verified the destination with `rsync`, and only then removed the verified root-resident sources.
- No live database, release, upload, or active configuration was included.

### Historical Media Control SQLite snapshots

- Validated 24 nonempty historical snapshots using SQLite quick check, integrity check, and foreign-key check.
- Offloaded 10,537,697,280 B to `/mnt/mbfd-backup-local/media-control/db-snapshots/20260824` with checksums and manifests.
- Retained the live NVMe database and two recent nonempty NVMe rollback databases.
- Left zero-byte files and uncertain/orphan sidecars in place for human review rather than guessing.
- Later release backups used the SQLite online backup API and passed quick/integrity/foreign-key validation.

### Journald and application logs

- Journald usage fell from approximately 3.9 GB to 422.3 MB after retaining current evidence.
- Installed a persistent 2 GB / 14 day / one-day-file journal policy with 10 GB free-space reserve.
- Rotated the origin monitor log without deleting the retained rotated evidence.
- Installed daily/max-25-MB log rotation with 14 compressed rotations for `/var/log/mbfd-origin-monitor/events.jsonl`.

### Docker images, containers, volumes, and releases

- Deleted no Docker image, container, or volume.
- Did not move containerd or Docker data roots.
- Protected the current application image and rollback tags.
- The release-retention job is audit-only. It reported 149 additional historical Media Control image IDs for explicit human review; it did not delete or retag them.
- Protected unrelated and unknown large artifacts, including the `anpviz` material.

## Prevention controls installed

The prevention source was merged in PR #90 (`0aa5c9dc886db5af9763d171b1ea4f02b203d46d`, tested head `e0027558942bd63d6dade581d4889d676e1b2f4d`). Installed controls were verified through their systemd units and scripts.

| Control | Schedule / bound | Safety behavior |
| --- | --- | --- |
| `mbfd-buildkit-gc.timer` | Sunday 04:45, persistent, randomized delay | Skips active builds; age 168h; 16 GB reserved; 32 GB maximum cache use; locks; verifies running identities unchanged |
| `mbfd-media-control-retention.timer` | Sunday 05:30, persistent, randomized delay | Keeps two verified nonempty NVMe rollback DBs; offloads older copies only to a separate mounted filesystem; validates before and after copy |
| Media Control release retention audit | Runs with Media Control retention | Requires two rollback images and reports extras for human review; never deletes or retags |
| `mbfd-root-capacity-monitor.timer` | Every five minutes | Journald/syslog state transitions at 80% warning, 85% error, 90% critical, plus recovery/rearm |
| Journald drop-in | Continuous | `SystemMaxUse=2G`, `SystemKeepFree=10G`, `MaxRetentionSec=14day`, `MaxFileSec=1day` |
| Origin monitor logrotate | Daily or 25 MB | 14 rotations, compression, delayed compression, bounded permissions |
| Ecosystem restic backup | Existing schedule, extended coverage | Includes the live Media Control DB path; a fresh backup/restore smoke was verified |

Timer enablement and clean service runs were verified. The only observed systemd warnings concerned unrelated XFS CPU-accounting settings and were not introduced or remediated by this task.

## Backup proof

- Ecosystem backup completed successfully.
- Restic snapshot: `ca225ce79d18cafad8f99373f1fbc0fb6dcf313e9cff271b82ca716deaf405e6` (60,022,410,952 bytes processed).
- Repository integrity check returned no errors.
- Exact-snapshot restore smoke recovered the Media Control SQLite database at 439,037,952 B with SHA-256 `0447...`; quick/integrity checks returned `ok` and foreign-key findings were zero.
- Restore evidence: `/mnt/mbfd-backup-local/media-control/maintenance/20260824-after-hours/restic-restore-smoke-ca225ce7.log`.

Release-specific online backups and rollback tags are recorded in the integrated after-hours report. Backup paths are root-protected; no credentials or tokens are recorded here.

## Deliberately retained or deferred

- All current and intentionally stopped container images.
- At least two known rollback images/releases where available.
- Live databases, active volumes, uploads, P3 cache, model files in use, and current configuration.
- Unknown or ambiguous artifacts.
- Historical image IDs pending human provenance review.
- Containerd relocation. Capacity, prevention, and monitoring made relocation unnecessary, and the high-I/O store was not moved to slow bulk storage.

## Audit conclusion

The after-hours retention problem is resolved without weakening rollback coverage: root use is 43%, approximately 51.2 GiB of used blocks were reclaimed, bounded recurring controls are active, alerts are stateful at 80/85/90%, and the full restic restore path was independently exercised.
