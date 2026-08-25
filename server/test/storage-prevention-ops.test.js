'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..', '..');
const ops = path.join(root, 'ops', 'storage-prevention');

function read(name) {
  return fs.readFileSync(path.join(ops, name), 'utf8');
}

test('BuildKit GC is age-bounded, space-bounded, locked, and never broad-prunes Docker', () => {
  const script = read('mbfd-buildkit-gc');
  assert.match(script, /set -Eeuo pipefail/);
  assert.match(script, /flock -n/);
  assert.match(script, /docker buildx prune/);
  assert.match(script, /--builder default/);
  assert.match(script, /--filter ['"]until=168h['"]/);
  assert.match(script, /--reserved-space ['"]16GB['"]/);
  assert.match(script, /--max-used-space ['"]32GB['"]/);
  assert.match(script, /active build process detected/);
  assert.doesNotMatch(script, /docker (system|image|volume|container) prune/);
  assert.doesNotMatch(script, /--all/);
  assert.doesNotMatch(script, /^\s*docker .*prune.*\s-a(?:\s|$)/m);
});

test('root capacity monitor has stateful 80/85/90 bands and recovery rearming', () => {
  const script = read('mbfd-root-capacity-monitor');
  assert.match(script, /WARN_THRESHOLD=80/);
  assert.match(script, /ERROR_THRESHOLD=85/);
  assert.match(script, /CRITICAL_THRESHOLD=90/);
  assert.match(script, /df -P \/ \|/);
  assert.match(script, /mbfd-root-capacity/);
  assert.match(script, /RECOVERY/);
  assert.match(script, /STATE_FILE=/);
  assert.doesNotMatch(script, /webhook|https?:\/\//i);
});

test('systemd timers bound BuildKit weekly and root monitoring every five minutes', () => {
  const gcService = read('mbfd-buildkit-gc.service');
  const gcTimer = read('mbfd-buildkit-gc.timer');
  const monitorService = read('mbfd-root-capacity-monitor.service');
  const monitorTimer = read('mbfd-root-capacity-monitor.timer');
  const retentionService = read('mbfd-media-control-retention.service');
  const retentionTimer = read('mbfd-media-control-retention.timer');
  assert.match(gcService, /ExecStart=\/usr\/local\/sbin\/mbfd-buildkit-gc/);
  assert.match(gcService, /Nice=10/);
  assert.match(gcTimer, /OnCalendar=Sun \*-\*-\* 04:45:00/);
  assert.match(gcTimer, /Persistent=true/);
  assert.match(monitorService, /ExecStart=\/usr\/local\/sbin\/mbfd-root-capacity-monitor/);
  assert.match(monitorTimer, /OnUnitActiveSec=5min/);
  assert.match(monitorTimer, /Persistent=true/);
  assert.match(retentionService, /ExecStart=\/usr\/local\/sbin\/mbfd-media-control-db-retention/);
  assert.match(retentionService, /ExecStart=\/usr\/local\/sbin\/mbfd-media-control-release-retention-audit/);
  assert.match(retentionTimer, /OnCalendar=Sun \*-\*-\* 05:30:00/);
  assert.match(retentionTimer, /Persistent=true/);
});

test('journald and origin-monitor logs have explicit bounded retention', () => {
  const journal = read('20-mbfd-retention.conf');
  const logrotate = read('mbfd-origin-monitor.logrotate');
  assert.match(journal, /SystemMaxUse=2G/);
  assert.match(journal, /SystemKeepFree=10G/);
  assert.match(journal, /MaxRetentionSec=14day/);
  assert.match(journal, /MaxFileSec=1day/);
  assert.match(logrotate, /\/var\/log\/mbfd-origin-monitor\/events\.jsonl/);
  assert.match(logrotate, /daily/);
  assert.match(logrotate, /maxsize 25M/);
  assert.match(logrotate, /rotate 14/);
  assert.match(logrotate, /compress/);
  assert.doesNotMatch(logrotate, /copytruncate/);
});

test('Media Control DB retention keeps two NVMe snapshots and verifies off-root copies before removal', () => {
  const script = read('mbfd-media-control-db-retention');
  assert.match(script, /KEEP_COUNT=2/);
  assert.match(script, /remote_display\.pre-/);
  assert.match(script, /PRAGMA quick_check/);
  assert.match(script, /PRAGMA integrity_check/);
  assert.match(script, /PRAGMA foreign_key_check/);
  assert.match(script, /sha256sum/);
  assert.match(script, /\/mnt\/mbfd-backup-local\/media-control\/db-snapshots\/retention/);
  assert.match(script, /findmnt/);
  assert.match(script, /rm -f --/);
  assert.match(script, /-name ['"]remote_display\.pre-\*\.db['"]/);
  assert.doesNotMatch(script, /rm -f --[^\n]*remote_display\.db(?:\s|['"]|$)/);
});

test('release retention is audited as current plus two distinct rollbacks without deleting images', () => {
  const script = read('mbfd-media-control-release-retention-audit');
  assert.match(script, /media-control/);
  assert.match(script, /required_rollbacks=2/);
  assert.match(script, /container=media-control/);
  assert.match(script, /docker inspect "\$container"/);
  assert.match(script, /rollback/);
  assert.doesNotMatch(script, /docker rmi|docker image prune|docker system prune/);
});

test('ecosystem backup patch replaces the stale volume with the live NVMe WAL-safe snapshot', () => {
  const patch = read('mbfd-ecosystem-backup-live-db.patch');
  assert.match(patch, /sqlite_backup_path\(\)/);
  assert.match(patch, /\/var\/lib\/mbfd\/media-control-db\/remote_display\.db/);
  assert.match(patch, /\.backup/);
  assert.match(patch, /PRAGMA quick_check/);
  assert.match(patch, /PRAGMA integrity_check/);
  assert.match(patch, /PRAGMA foreign_key_check/);
  assert.match(patch, /^-sqlite_backup media-control_media_control_db remote_display\.db media-control$/m);
  assert.match(patch, /^\+sqlite_backup_path \/var\/lib\/mbfd\/media-control-db\/remote_display\.db media-control$/m);
});
