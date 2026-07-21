[CmdletBinding()]
# Wired-only watchdog: keeps the P3 on Ethernet when a wired uplink is present.
# When no Ethernet is available it backs off instead of silently reverting to
# Wi-Fi, so the box does not drift back onto wireless.
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir 'network-watchdog.log'
$enforce = Join-Path $PSScriptRoot 'network-enforce.ps1'
$intervalSec = 60
$maxBackoffSec = 300
$backoffSec = 30

function Log([string]$msg) {
  Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $msg" -ErrorAction SilentlyContinue
  Write-Host "$(Get-Date -Format o) $msg"
}

$running = $true
function Stop-Watchdog { if ($script:running) { Log 'stopping (Ctrl-C)'; $script:running = $false } }
[Console]::TreatControlCAsInput = $false
$null = Register-EngineEvent PowerShell.Exiting -Action { Stop-Watchdog } -SupportEvent
$null = Register-ObjectEvent ([Console]) ControlC -Action { Stop-Watchdog } -SupportEvent -ErrorAction SilentlyContinue

Log "network-watchdog started (interval ${intervalSec}s, max backoff ${maxBackoffSec}s)"

while ($running) {
  $ok = $false
  try {
    & powershell -NoProfile -ExecutionPolicy Bypass -File $enforce
    $ok = ($LASTEXITCODE -eq 0)
  } catch {
    Log "enforce threw: $($_.Exception.Message)"
  }

  if ($ok) {
    $backoffSec = 60
    Log 'enforce OK'
  } else {
    $backoffSec = [Math]::Min($maxBackoffSec, $backoffSec * 2)
    Log "enforce failed/non-zero; backing off ${backoffSec}s (cap ${maxBackoffSec}s)"
  }

  $slept = 0
  while ($running -and $slept -lt $backoffSec) {
    Start-Sleep -Seconds ([Math]::Min($intervalSec, $backoffSec - $slept))
    $slept += [Math]::Min($intervalSec, $backoffSec - $slept)
  }
}

Log 'network-watchdog exited'
