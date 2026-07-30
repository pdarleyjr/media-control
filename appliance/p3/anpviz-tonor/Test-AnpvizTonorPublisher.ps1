[CmdletBinding()]
param(
  [string]$ConfigPath = 'C:\MBFD\anpviz-tonor\config.json'
)

$ErrorActionPreference = 'Stop'
$config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$task = Get-ScheduledTask -TaskName 'MBFD_AnpvizTonorPublisher' -ErrorAction SilentlyContinue
$taskInfo = if ($task) { Get-ScheduledTaskInfo -TaskName $task.TaskName } else { $null }
$microphone = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
  Where-Object {
    $_.PNPDeviceID -and
    $_.PNPDeviceID.StartsWith([string]$config.audioPnpInstancePrefix, [StringComparison]::OrdinalIgnoreCase)
  } |
  Select-Object -First 1
$progressPath = Join-Path (Split-Path -Parent $ConfigPath) 'runtime\ffmpeg-progress.txt'
$progressAge = if (Test-Path -LiteralPath $progressPath) {
  [Math]::Round(((Get-Date) - (Get-Item -LiteralPath $progressPath).LastWriteTime).TotalSeconds, 1)
} else { $null }

[pscustomobject]@{
  task_present = $null -ne $task
  task_state = if ($task) { [string]$task.State } else { 'Missing' }
  last_task_result = if ($taskInfo) { $taskInfo.LastTaskResult } else { $null }
  microphone_present = $null -ne $microphone
  microphone_status = if ($microphone) { $microphone.Status } else { 'Missing' }
  progress_age_seconds = $progressAge
  configured_audio_delay_ms = [int]$config.audioDelayMs
  configured_video_delay_ms = [int]$config.videoDelayMs
} | ConvertTo-Json -Compress
