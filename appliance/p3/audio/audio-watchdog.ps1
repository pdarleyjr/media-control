[CmdletBinding()]
# Audio watchdog: re-runs audio-enforce.ps1 every 60s. Backs off up to 5 min
# when the eARC endpoint is not yet present (boot race / hot-plug). Stops cleanly
# on Ctrl-C. Never disables the Windows Firewall. Logs to logs/audio-watchdog.log.
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $PSScriptRoot '..\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir 'audio-watchdog.log'
$enforce = Join-Path $PSScriptRoot 'audio-enforce.ps1'
$intervalSec = 60
$maxBackoffSec = 300
$backoffSec = 30
$lastFailedAt = 0

function Log([string]$msg) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $msg" -ErrorAction SilentlyContinue
  Write-Host "$(Get-Date -Format o) $msg"
}

$running = $true
function Stop-Watchdog { if ($script:running) { Log 'stopping (Ctrl-C)'; $script:running = $false } }
[Console]::TreatControlCAsInput = $false
$null = Register-EngineEvent PowerShell.Exiting -Action { Stop-Watchdog } -SupportEvent
$null = Register-ObjectEvent ([Console]) ControlC -Action { Stop-Watchdog } -SupportEvent -ErrorAction SilentlyContinue

Log "audio-watchdog started (interval ${intervalSec}s, max backoff ${maxBackoffSec}s)"

while ($running) {
  $ok = $false
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $enforce -Wirefire
    $ok = ($LASTEXITCODE -eq 0)
  } catch {
    Log "enforce threw: $($_.Exception.Message)"
  }
  if ($ok) {
    $backoffSec = 30
    $lastFailedAt = 0
    Log 'enforce OK'
  } else {
    if ($lastFailedAt -eq 0) { $lastFailedAt = [int][double]::Parse((Get-Date -UFormat %s)) }
    $backoffSec = [Math]::Min($maxBackoffSec, $backoffSec * 2)
    Log "enforce failed/non-zero; backing off ${backoffSec}s (backoff capped @ ${maxBackoffSec}s)"
  }
  # Sleep in small slices so Ctrl-C responds quickly.
  $slept = 0
  while ($running -and $slept -lt $backoffSec) {
    Start-Sleep -Seconds ($intervalSec)
    $slept += $intervalSec
  }
}
Log 'audio-watchdog exited'