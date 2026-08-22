[CmdletBinding()]
# Installs (or re-installs) the P3 room-agent as a Windows Scheduled Task so it
# survives logoff + auto-restarts every 60s (watchdog). Idempotent — safe to
# re-run after a `git pull` to pick up new agent.js / sync-worker.js.
#
# Tasks created / managed by this script:
#   MBFD_RoomAgent   -> `node agent.js` at logon, restart every 60s on failure
#   MBFD_AudioEnforce-> the audio watchdog at logon (60s loop inside the script)
#   MBFD_NetworkEnforce -> the wired-first watchdog at logon (disables Wi-Fi
#                          when Ethernet is up and keeps the box on the wire)
#   MBFD_RoomCacheAgent -> the read-through content cache agent
#                          (`cache-agent.js`). This script does NOT create or
#                          re-register it, because the on-box launcher
#                          `run-agent.cmd` carries the per-node secret in ENV.
#                          Instead `ensure-cache-agent-supervision.ps1` fixes
#                          only its SETTINGS so a fail-fast fatal exit is
#                          recovered on a fixed 60s restart interval.
#
# Restart semantics: Windows Task Scheduler restarts a failed task on a FIXED
# interval (RestartInterval) for up to RestartCount attempts. There is no
# exponential backoff at the Task Scheduler layer.
#
# Constraint: does NOT disable the Windows Firewall. Room-agent <-> GMKtec comms
#  use the LAN path when configured; the on-box SSH inbound rule, if any, is
#  left exactly as-is. Run from an elevated prompt.
$ErrorActionPreference = 'Stop'

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warning 'Not running elevated: scheduled-task creation may fail. Re-run as Administrator.'
}

$agentDir = Split-Path -Parent $PSScriptRoot | Join-Path -ChildPath 'room-agent'
$agentDir = (Resolve-Path $agentDir -ErrorAction SilentlyContinue).Path
if (-not $agentDir) { $agentDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'room-agent' }
$agentJs = Join-Path $agentDir 'agent.js'
$audioWatchdog = Join-Path (Split-Path -Parent $PSScriptRoot) 'audio\audio-watchdog.ps1'
$networkWatchdog = Join-Path (Split-Path -Parent $PSScriptRoot) 'network-watchdog.ps1'

$nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $nodeExe) { Write-Error 'node.exe not on PATH — install Node LTS first'; exit 3 }

# Install node deps for the agent (socket.io-client + better-sqlite3).
if (Test-Path (Join-Path $agentDir 'package.json')) {
  Write-Host 'installing agent npm deps...'
  Push-Location $agentDir
  try { & npm install --omit=dev --no-audit --no-fund } finally { Pop-Location }
}

function New-ManagedTask([string]$Name, [string]$Cmd, [string[]]$Args, [int]$RestartSec = 60, [string]$RunLevel = 'Limited') {
  $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "updating existing task $Name"
    Unregister-ScheduledTask -TaskName $Name -Confirm:$false
  }
  $action = New-ScheduledTaskAction -Execute $Cmd -Argument ($Args -join ' ')
  $trig = New-ScheduledTaskTrigger -AtLogOn
  # ExecutionTimeLimit 0 (PT0S) so a healthy long-running watchdog is never
  # force-terminated; the Task Scheduler default is PT72H.
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Seconds $RestartSec) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel $RunLevel
  Register-ScheduledTask -TaskName $Name -Action $action -Trigger $trig -Settings $settings -Principal $principal -Force | Out-Null
  Start-ScheduledTask -TaskName $Name
  Write-Host "task $Name registered + started"
}

New-ManagedTask -Name 'MBFD_RoomAgent' -Cmd $nodeExe -Args @("agent.js") -RestartSec 60
New-ManagedTask -Name 'MBFD_AudioEnforce' -Cmd 'powershell.exe' -Args @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$audioWatchdog`"") -RestartSec 60
New-ManagedTask -Name 'MBFD_NetworkEnforce' -Cmd 'powershell.exe' -Args @('-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$networkWatchdog`"") -RestartSec 60 -RunLevel Highest

# The cache agent runs fail-fast (see room-agent/fatal-process.js): a fatal
# uncaught exception intentionally terminates Node with a nonzero exit code.
# That is only safe when Task Scheduler restarts it, so repair the supervision
# settings of the existing MBFD_RoomCacheAgent task without touching its
# secret-bearing launcher, principal, or trigger.
$cacheSupervision = Join-Path $PSScriptRoot 'ensure-cache-agent-supervision.ps1'
if (Test-Path -LiteralPath $cacheSupervision) {
  Write-Host 'ensuring MBFD_RoomCacheAgent restart-on-failure supervision...'
  try {
    & $cacheSupervision -TaskName 'MBFD_RoomCacheAgent' -RestartIntervalSeconds 60 -RestartCount 999
  } catch {
    Write-Warning "MBFD_RoomCacheAgent supervision could not be applied: $($_.Exception.Message)"
    Write-Warning 'Fix this before relying on the fail-fast cache agent — an unsupervised fatal exit will NOT be recovered.'
  }
} else {
  Write-Warning "missing $cacheSupervision — MBFD_RoomCacheAgent supervision was NOT verified."
}

Write-Host 'install/update complete.'
Write-Host 'Firewall note: Windows Firewall is left ENABLED (constraint). The agent reaches GMKtec over the LAN URL when configured; no inbound rule is added.'
Write-Host 'Place credentials in room-agent/config.local.json (gitignored) or via on-box ENV for the scheduled task (setx / scheduled-task env). NEVER commit a real token.'
