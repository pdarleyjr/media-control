[CmdletBinding()]
# Installs (or re-installs) the P3 room-agent as a Windows Scheduled Task so it
# survives logoff + auto-restarts every 60s (watchdog). Idempotent - safe to
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
#                          Instead `ensure-cache-agent-supervision.ps1` safely
#                          adds a fixed 60s child-retry loop to that launcher
#                          (preserving its secret assignments and a verified
#                          on-box backup) and repairs the task SETTINGS.
#
# Restart semantics: the cache launcher's proven child retry and Windows Task
# Scheduler's outer restart policy both use a FIXED interval. There is no
# exponential backoff at either layer.
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
if (-not $nodeExe) { Write-Error 'node.exe not on PATH - install Node LTS first'; exit 3 }

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
  $settings = New-ScheduledTaskSettingsSet -RestartCount 255 -RestartInterval (New-TimeSpan -Seconds $RestartSec) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
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
# That is only safe when Task Scheduler restarts it, so establish the
# supervision of the existing MBFD_RoomCacheAgent task WITHOUT replacing its
# secret-bearing launcher, principal, or trigger. The helper preserves the
# launcher's existing environment assignments and makes a verified on-box
# backup before adding the bounded child retry. A fail-fast agent with no working
# supervisor is a production defect, so any failure here MUST abort the update.
$cacheSupervision = Join-Path $PSScriptRoot 'ensure-cache-agent-supervision.ps1'
if (-not (Test-Path -LiteralPath $cacheSupervision)) {
  throw "MBFD_RoomCacheAgent supervision script is missing at '$cacheSupervision'. Refusing to install a fail-fast cache agent with no confirmed supervisor."
}
Write-Host 'establishing MBFD_RoomCacheAgent restart-on-failure supervision...'
& $cacheSupervision -TaskName 'MBFD_RoomCacheAgent' -RestartIntervalSeconds 60 -RestartCount 255
# If the line above returns, supervision is verified active. If it throws
# (missing+uncreatable task, invalid settings, or post-apply verification
# failure) the script terminates here with a non-zero exit and the later
# "install/update complete" message is never printed.

Write-Host 'install/update complete.'
Write-Host 'Firewall note: Windows Firewall is left ENABLED (constraint). The agent reaches GMKtec over the LAN URL when configured; no inbound rule is added.'
Write-Host 'Place credentials in room-agent/config.local.json (gitignored) or via on-box ENV for the scheduled task (setx / scheduled-task env). NEVER commit a real token.'
