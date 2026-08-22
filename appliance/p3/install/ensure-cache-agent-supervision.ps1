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

# Ensures the P3 room *cache* agent (`cache-agent.js`) is supervised by both its
# on-box launcher and Windows Task Scheduler so a fail-fast exit is recovered.
#
# WHY THIS EXISTS
# ---------------
# `room-agent/fatal-process.js` deliberately lets Node die on an uncaught
# exception / unhandled rejection (fail-fast). That is only correct when an
# external supervisor restarts the process. The live classroom task was found
# registered with RestartCount=0 and NO RestartInterval, plus the Task Scheduler
# default ExecutionTimeLimit of PT72H. A later live failure proof also showed
# that this Windows host records a child exit code of 1 but leaves the batch
# task Ready instead of invoking RestartOnFailure. The launcher therefore owns
# the proven one-minute child retry loop; Task Scheduler remains a second layer.
#
# SAFETY CONTRACT
# ---------------
# This script is deliberately NON-DESTRUCTIVE and idempotent:
#   * It NEVER unregisters or re-creates an existing task.
#   * It NEVER rewrites the task Action, Trigger, or Principal.
#   * It repairs only the cache-agent invocation inside the existing on-box
#     launcher, preserving every secret-bearing environment assignment unchanged
#     and creating a verified on-box rollback copy first.
#   * It rewrites the task SETTINGS block (restart policy, execution time limit,
#     instance policy, battery policy).
#   * It contains NO secret material and writes none.
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) { Write-Host "[cache-agent-supervision] $Message" }

function Ensure-CacheAgentLauncherSupervision(
  [string]$Path,
  [int]$IntervalSeconds
) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Trusted cache-agent launcher is missing at '$Path'."
  }

  $beginMarker = 'rem MBFD_CACHE_AGENT_SUPERVISION_BEGIN'
  $endMarker = 'rem MBFD_CACHE_AGENT_SUPERVISION_END'
  $lines = @([IO.File]::ReadAllLines($Path))
  $beginCount = @($lines | Where-Object { $_ -eq $beginMarker }).Count
  $endCount = @($lines | Where-Object { $_ -eq $endMarker }).Count
  $expectedDelay = "timeout /t $IntervalSeconds /nobreak >nul"

  if ($beginCount -eq 1 -and $endCount -eq 1) {
    if (-not ($lines -contains $expectedDelay) -or -not ($lines -contains 'goto MBFD_CACHE_AGENT_SUPERVISE')) {
      throw 'Existing cache-agent launcher supervision block is malformed or uses the wrong retry interval.'
    }
    Write-Step "launcher supervision is active (fixed ${IntervalSeconds}s child retry)"
    return $false
  }
  if ($beginCount -ne 0 -or $endCount -ne 0) {
    throw 'Partial cache-agent launcher supervision markers found; refusing to guess at a repair.'
  }

  $nodeIndexes = @()
  for ($index = 0; $index -lt $lines.Count; $index++) {
    if ($lines[$index] -match '(?i)cache-agent\.js') { $nodeIndexes += $index }
  }
  if ($nodeIndexes.Count -ne 1) {
    throw "Expected exactly one cache-agent.js command in launcher; found $($nodeIndexes.Count)."
  }

  $nodeIndex = $nodeIndexes[0]
  $trailing = if ($nodeIndex -lt ($lines.Count - 1)) {
    @($lines[($nodeIndex + 1)..($lines.Count - 1)] | Where-Object {
      -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch '(?i)^\s*exit\s+/b\s+%errorlevel%\s*$'
    })
  } else { @() }
  if ($trailing.Count -gt 0) {
    throw 'Unexpected commands follow cache-agent.js; refusing to rewrite the secret-bearing launcher.'
  }

  $backupDirectory = Join-Path (Split-Path -Parent (Split-Path -Parent $Path)) 'backups'
  New-Item -ItemType Directory -Path $backupDirectory -Force | Out-Null
  $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
  $backupPath = Join-Path $backupDirectory "run-agent.pre-supervision-$stamp.cmd"
  Copy-Item -LiteralPath $Path -Destination $backupPath
  $sourceHash = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
  $backupHash = (Get-FileHash -LiteralPath $backupPath -Algorithm SHA256).Hash
  if ($sourceHash -ne $backupHash) {
    throw 'Cache-agent launcher backup verification failed; refusing to edit the launcher.'
  }

  $prefix = if ($nodeIndex -gt 0) { @($lines[0..($nodeIndex - 1)]) } else { @() }
  $nodeCommand = $lines[$nodeIndex]
  $supervised = @(
    $beginMarker,
    ':MBFD_CACHE_AGENT_SUPERVISE',
    $nodeCommand,
    'set "MBFD_CACHE_AGENT_EXIT=%ERRORLEVEL%"',
    'if "%MBFD_CACHE_AGENT_EXIT%"=="0" exit /b 0',
    "timeout /t $IntervalSeconds /nobreak >nul",
    'goto MBFD_CACHE_AGENT_SUPERVISE',
    $endMarker
  )
  $temporaryPath = "$Path.supervision-new"
  [IO.File]::WriteAllLines($temporaryPath, @($prefix) + $supervised, [Text.Encoding]::Default)
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force

  $verified = @([IO.File]::ReadAllLines($Path))
  if (-not ($verified -contains $beginMarker) -or -not ($verified -contains $endMarker) -or
      -not ($verified -contains $expectedDelay) -or -not ($verified -contains 'goto MBFD_CACHE_AGENT_SUPERVISE')) {
    Copy-Item -LiteralPath $backupPath -Destination $Path -Force
    throw 'Cache-agent launcher supervision verification failed; the verified rollback copy was restored.'
  }
  Write-Step "launcher supervision is active (fixed ${IntervalSeconds}s child retry; verified rollback at '$backupPath')"
  return $true
}

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
  Write-Step "WhatIfOnly: would verify/repair the on-box launcher child retry at '$LauncherPath' without printing or replacing its secret assignments."
  if (-not $existing) { Write-Step "WhatIfOnly: task '$TaskName' does not exist; would create it from '$LauncherPath' as SYSTEM AtStartup." }
  return
}

$launcherChanged = $false
if ($existing) {
  $before = Get-ScheduledTask -TaskName $TaskName
  $beforeAction = ($before.Actions | ForEach-Object { "$($_.Execute)|$($_.Arguments)|$($_.WorkingDirectory)" }) -join ';'
  $beforePrincipal = "$($before.Principal.UserId)|$($before.Principal.LogonType)|$($before.Principal.RunLevel)"
  $beforeTriggers = ($before.Triggers | ForEach-Object { $_.CimClass.CimClassName }) -join ';'

  $resolvedLauncher = (Resolve-Path -LiteralPath $LauncherPath).Path
  $usesLauncher = @($before.Actions | Where-Object {
    [string]::Equals([string]$_.Execute, $resolvedLauncher, [StringComparison]::OrdinalIgnoreCase) -or
    ([string]$_.Arguments).IndexOf($resolvedLauncher, [StringComparison]::OrdinalIgnoreCase) -ge 0
  }).Count -gt 0
  if (-not $usesLauncher) {
    throw "Task '$TaskName' does not invoke the trusted launcher '$resolvedLauncher'; refusing to patch unrelated files or settings."
  }

  $launcherChanged = Ensure-CacheAgentLauncherSupervision -Path $resolvedLauncher -IntervalSeconds $RestartIntervalSeconds

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
  $launcherChanged = Ensure-CacheAgentLauncherSupervision -Path (Resolve-Path -LiteralPath $LauncherPath).Path -IntervalSeconds $RestartIntervalSeconds
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

# A running cmd.exe has already parsed the old launcher. Activate a newly
# repaired retry loop by restarting only this cache task; the FiveDisplayKiosk,
# Electron players, and Windows itself are untouched.
if ($launcherChanged) {
  $current = Get-ScheduledTask -TaskName $TaskName
  if ($current.State -eq 'Running') {
    Stop-ScheduledTask -TaskName $TaskName
    $deadline = (Get-Date).AddSeconds(20)
    do {
      Start-Sleep -Milliseconds 250
      $current = Get-ScheduledTask -TaskName $TaskName
    } until ($current.State -ne 'Running' -or (Get-Date) -ge $deadline)
    if ($current.State -eq 'Running') { throw 'Cache-agent launcher repair activation failed: task did not stop.' }
  }
  Start-ScheduledTask -TaskName $TaskName
  $deadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 250
    $current = Get-ScheduledTask -TaskName $TaskName
  } until ($current.State -eq 'Running' -or (Get-Date) -ge $deadline)
  if ($current.State -ne 'Running') { throw 'Cache-agent launcher repair activation failed: task did not start.' }
  Write-Step 'activated the repaired launcher by restarting only MBFD_RoomCacheAgent'
}
Write-Step 'launcher + Task Scheduler supervision is active; a fatal cache-agent exit will now be recovered automatically.'
