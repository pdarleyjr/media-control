[CmdletBinding()]
param(
  # Emit a single `-Wirefire:<endpointName>` line for the watchdog to parse.
  # When the eARC endpoint cannot be found this script exits non-zero so the
  # watchdog applies backoff before trying again.
  [switch]$Wirefire
)

# Idempotent audio enforcement for the classroom P3 (Windows 11).
# Goal: keep the Ultimea/eARC audio endpoint as the Default + Communications
# playback device so the Video Wall-1 / TV1 player window is the only one that
# actually emits sound. Non-TV1 player windows are started muted by the
# kiosk-launcher (`--mute`), so this script only needs to fix the default device.
#
# DOES NOT depend on the optional `AudioDeviceCmdlets` PowerShell module — it
# detects it and degrades gracefully (logs only) when missing so the watchdog
# keeps running without crashing the whole appliance.
# Constraint: NEVER disables the Windows Firewall. Only Tailnet traffic rides.

$ErrorActionPreference = 'Stop'
$logDir = Join-Path $PSScriptRoot '..\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir 'audio-enforce.log'
function Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -LiteralPath $logPath -Value $line -ErrorAction SilentlyContinue
  if (-not $Wirefire) { Write-Host $line }
}

# Acceptable eARC / Ultimea endpoint name fragments. Match any present, OK
# AudioEndpoint whose friendly name contains one of these tokens.
$nameFragments = @('eARC','Ultimea','HDMI','ARC')
try {
  $endpoints = Get-PnpDevice -Class AudioEndpoint -PresentOnly -ErrorAction Stop |
    Where-Object { $_.Status -eq 'OK' }
} catch {
  Log "ERROR: Get-PnpDevice failed: $($_.Exception.Message)"
  exit 3
}

# Prefer an endpoint whose friendly name matches eARC/Ultimea first; fall back to
# any present OK audio endpoint so a missing eARC label does not brick audio.
$target = $endpoints | Where-Object {
  $n = $_.FriendlyName
  $nameFragments | Where-Object { $n -like "*$_*" } | Select-Object -First 1
} | Select-Object -First 1

if (-not $target) {
  $target = $endpoints | Select-Object -First 1
  if (-not $target) {
    Log "ERROR: eARC/ulTimea endpoint not found and no fallback audio device present"
    if ($Wirefire) { Write-Host "-Wirefire:none" }
    exit 1  # non-zero: watchdog backs off (up to 5 min)
  }
  Log "WARN: eARC/Ultimea by name not found; falling back to first OK endpoint: $($target.FriendlyName)"
}

# Persist the chosen endpoint durable id for rollback (audio-restore.ps1 reads
# the prior default out of last-display-mode-backup.cfg).
$backupCfg = Join-Path $PSScriptRoot '..\backups\last-display-mode-backup.cfg'
try {
  New-Item -ItemType Directory -Path (Join-Path $PSScriptRoot '..\backups') -Force | Out-Null
  $prior = ''
  try {
    $current = & powershell -NoProfile -Command "(Get-CimInstance -Namespace root/cimv2 Win32_SoundDevice -ErrorAction SilentlyContinue | Select-Object -First 1).Name" 2>$null
    $prior = ($current | Out-String).Trim()
  } catch { }
  if ($prior -and -not (Test-Path $backupCfg)) {
    Set-Content -LiteralPath $backupCfg -Value "prior_default=$prior" -ErrorAction SilentlyContinue
  }
} catch { Log "WARN: could not persist prior-default backup: $($_.Exception.Message)" }

# Try the AudioDeviceCmdlets module first. Detection only — never hard-require.
$haveModule = $false
try { $haveModule = $null -ne (Get-Module -ListAvailable -Name AudioDeviceCmdlets -ErrorAction SilentlyContinue) } catch { }
if ($haveModule) {
  try {
    Import-Module AudioDeviceCmdlets -ErrorAction Stop
    $dev = Get-AudioDevice -List | Where-Object { $_.Name -eq $target.FriendlyName } | Select-Object -First 1
    if (-not $dev) { $dev = Get-AudioDevice -List | Where-Object { $_.Name -like "*$($target.FriendlyName)*" } | Select-Object -First 1 }
    if ($dev) {
      Set-AudioDevice -Index $dev.Index
      Log "OK (AudioDeviceCmdlets): set default to $($dev.Name)"
      if ($Wirefire) { Write-Host "-Wirefire:$($dev.Name)" }
      exit 0
    }
    Log "WARN: AudioDeviceCmdlets present but no matching device; continuing"
  } catch { Log "WARN: AudioDeviceCmdlets failed: $($_.Exception.Message) — degrading" }
} else {
  Log "INFO: AudioDeviceCmdlets module not installed; logging-only (install via: Install-Module AudioDeviceCmdlets -Scope CurrentUser)"
}

# Without the module we cannot change the default device from PowerShell without
# elevated nircmd/SoundVolumeView. Surface the chosen endpoint name so an external
# tool can act, but do NOT fail the appliance — the watchdog will keep trying.
if ($Wirefire) { Write-Host "-Wirefire:$($target.FriendlyName)" }
Log "selected_default=$($target.FriendlyName)"
exit 0