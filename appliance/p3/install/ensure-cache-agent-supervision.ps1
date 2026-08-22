[CmdletBinding()]
param(
  [string]$TaskName = 'MBFD_RoomCacheAgent',
  # Windows Task Scheduler restarts a failed task on a FIXED interval. The
  # minimum accepted interval is one minute; 60s is the proven value already
  # used by the other MBFD watchdog tasks.
  [int]$RestartIntervalSeconds = 60,
  # Task Scheduler's RestartOnFailure Count is an unsigned byte: valid range is
  # 1..255. 255 (the schema maximum) is more than enough to ride out realistic
  # transient faults (e.g. the observed `uv_interface_addresses` Windows quirk)
  # across a multi-day classroom run without ever silently ending local caching.
  [int]$RestartCount = 255,
  # Fall back to creating the task only when the trusted launcher exists.
  [string]$LauncherPath = 'C:\MBFD\RoomAgent\run-agent.cmd',
  [switch]$WhatIfOnly
)

# Ensures the P3 room *cache* agent (`cache-agent.js`) is supervised by Windows
# Task Scheduler so that a fail-fast fatal exit is automatically recovered.
#
# WHY THIS EXISTS
# ---------------
# `room-agent/fatal-process.js` deliberately lets Node die on an uncaught
# exception / unhandled rejection (fail-fast). That is only correct when an
# external supervisor restarts the process. The live classroom task was found
# registered with RestartCount=0 and NO RestartInterval, plus the Task Scheduler
#   default ExecutionTimeLimit of PT72H - meaning a fatal exit was never recovered
# and a healthy agent would be force-terminated after 72 hours of uptime.
#
# SAFETY CONTRACT
# ---------------
# This script is deliberately NON-DESTRUCTIVE and idempotent:
#   * It NEVER unregisters or re-creates an existing task.
#   * It NEVER rewrites the task Action, Trigger, or Principal. The live
#     launcher (`run-agent.cmd`) carries the per-node secret in on-box ENV and
#     must not be touched by repo automation.
#   * It only rewrites the task SETTINGS block (restart policy, execution time
#     limit, instance policy, battery policy).
#   * It contains NO secret material and writes none.
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "[cache-agent-supervision] $Message" }

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Warning 'Not running elevated: updating a SYSTEM scheduled task requires Administrator. Re-run as Administrator.'
}

if ($RestartIntervalSeconds -lt 60) {
  throw "RestartIntervalSeconds must be >= 60 (Windows Task Scheduler rejects a restart interval below one minute); got $RestartIntervalSeconds."
}
if ($RestartCount -lt 1) {
  throw "RestartCount must be >= 1 so a fatal cache-agent exit is actually recovered; got $RestartCount."
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

# The settings we require for a long-running, fail-fast, boot-started agent.
#   RestartCount/RestartInterval -> recover a nonzero (fatal) exit.
#   ExecutionTimeLimit 0         -> PT0S, i.e. never force-terminate a healthy
#                                   long-running agent (default is PT72H).
#   MultipleInstances IgnoreNew   -> a late/duplicate trigger cannot double-run
#                                   the agent and fight over port 8097.
#   StartWhenAvailable            -> run a missed boot trigger.
#   Battery flags                 -> a classroom appliance must not stop when
#                                   Windows misreports a UPS/battery transition.
$settings = New-ScheduledTaskSettingsSet `
  -RestartCount $RestartCount `
  -RestartInterval (New-TimeSpan -Seconds $RestartIntervalSeconds) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -MultipleInstances IgnoreNew `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries

if ($WhatIfOnly) {
  Write-Step "WhatIfOnly: would apply RestartCount=$RestartCount RestartInterval=${RestartIntervalSeconds}s ExecutionTimeLimit=PT0S MultipleInstances=IgnoreNew StartWhenAvailable=True to '$TaskName'."
  if (-not $existing) { Write-Step "WhatIfOnly: task '$TaskName' does not exist; would create it from '$LauncherPath' as SYSTEM AtStartup." }
  return
}

if ($existing) {
  $before = Get-ScheduledTask -TaskName $TaskName
  $beforeAction = ($before.Actions | ForEach-Object { "$($_.Execute)|$($_.Arguments)|$($_.WorkingDirectory)" }) -join ';'
  $beforePrincipal = "$($before.Principal.UserId)|$($before.Principal.LogonType)|$($before.Principal.RunLevel)"
  $beforeTriggers = ($before.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ';'

  Write-Step "updating SETTINGS only for existing task '$TaskName' (action/trigger/principal preserved)"
  Set-ScheduledTask -TaskName $TaskName -Settings $settings | Out-Null

  # Prove we preserved the trusted launcher + identity. If any of these drifted
  # the on-box secret loading would silently break, so fail loudly instead.
  $after = Get-ScheduledTask -TaskName $TaskName
  $afterAction = ($after.Actions | ForEach-Object { "$($_.Execute)|$($_.Arguments)|$($_.WorkingDirectory)" }) -join ';'
  $afterPrincipal = "$($after.Principal.UserId)|$($after.Principal.LogonType)|$($after.Principal.RunLevel)"
  $afterTriggers = ($after.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ';'
  if ($afterAction -ne $beforeAction) { throw "Refusing to continue: task action changed from '$beforeAction' to '$afterAction'." }
  if ($afterPrincipal -ne $beforePrincipal) { throw "Refusing to continue: task principal changed from '$beforePrincipal' to '$afterPrincipal'." }
  if ($afterTriggers -ne $beforeTriggers) { throw "Refusing to continue: task triggers changed from '$beforeTriggers' to '$afterTriggers'." }
} else {
  if (-not (Test-Path -LiteralPath $LauncherPath)) {
    throw "Task '$TaskName' does not exist and the trusted launcher '$LauncherPath' is missing. Create the launcher on-box (it holds MC_NODE_TOKEN in ENV and must never be committed), then re-run."
  }
  Write-Step "task '$TaskName' missing - creating it as SYSTEM AtStartup from '$LauncherPath'"
  $action = New-ScheduledTaskAction -Execute $LauncherPath
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal | Out-Null
}

$info = Get-ScheduledTask -TaskName $TaskName
Write-Step ("verified: RestartCount={0} RestartInterval={1} ExecutionTimeLimit={2} MultipleInstances={3} StartWhenAvailable={4} State={5}" -f `
  $info.Settings.RestartCount, $info.Settings.RestartInterval, $info.Settings.ExecutionTimeLimit, `
  $info.Settings.MultipleInstances, $info.Settings.StartWhenAvailable, $info.State)

if ($info.Settings.RestartCount -lt 1 -or -not $info.Settings.RestartInterval) {
  throw "Supervision NOT applied: '$TaskName' still has RestartCount=$($info.Settings.RestartCount) RestartInterval=$($info.Settings.RestartInterval)."
}
Write-Step 'restart-on-failure supervision is active; a fatal cache-agent exit will now be recovered automatically.'
