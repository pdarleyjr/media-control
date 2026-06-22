[CmdletBinding()]
# Best-effort rollback helper used by ROLLBACK_PLAN.md. Restores the prior
# default audio device from backups/last-display-mode-backup.cfg if present.
# No-op (exit 0) if no backup exists so rollback scripts stay idempotent.
$ErrorActionPreference = 'Continue'
$backupCfg = Join-Path $PSScriptRoot '..\backups\last-display-mode-backup.cfg'
$logDir = Join-Path $PSScriptRoot '..\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir 'audio-restore.log'
function Log([string]$msg) { Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $msg" -ErrorAction SilentlyContinue; Write-Host $msg }

if (-not (Test-Path $backupCfg)) { Log 'no prior-default backup present; nothing to restore'; exit 0 }
$prior = ''
foreach ($line in Get-Content -LiteralPath $backupCfg -ErrorAction SilentlyContinue) {
  if ($line -match '^prior_default=(.+)$') { $prior = $Matches[1] }
}
if (-not $prior) { Log 'backup file present but no prior_default key; skipping'; exit 0 }

$haveModule = $false
try { $haveModule = $null -ne (Get-Module -ListAvailable -Name AudioDeviceCmdlets -ErrorAction SilentlyContinue) } catch { }
if (-not $haveModule) { Log "AudioDeviceCmdlets not installed; cannot restore '$prior' programmatically (manual restore required)"; exit 0 }

try {
  Import-Module AudioDeviceCmdlets -ErrorAction Stop
  $dev = Get-AudioDevice -List | Where-Object { $_.Name -eq $prior -or $_.Name -like "*$prior*" } | Select-Object -First 1
  if ($dev) { Set-AudioDevice -Index $dev.Index; Log "restored default audio device to '$($dev.Name)'" }
  else { Log "prior default '$prior' not found among current endpoints; cannot restore" }
} catch { Log "restore failed: $($_.Exception.Message)" }
exit 0