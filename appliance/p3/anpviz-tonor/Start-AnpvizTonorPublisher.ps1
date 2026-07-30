[CmdletBinding()]
param(
  [string]$ConfigPath = 'C:\MBFD\anpviz-tonor\config.json'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Read-PublisherConfig {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "Publisher configuration not found: $Path"
  }
  $value = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json
  foreach ($name in @(
    'ffmpegPath', 'videoSourceUrl', 'publishUrl',
    'audioDeviceName', 'audioPnpInstancePrefix',
    'heartbeatUrl', 'heartbeatToken'
  )) {
    if (-not $value.$name) { throw "Publisher configuration is missing $name" }
  }
  if ($value.audioDeviceName -notmatch 'TONOR G11 USB microphone') {
    throw 'The configured audio endpoint is not the TONOR G11 USB microphone'
  }
  if ($value.audioPnpInstancePrefix -notmatch 'VID_0D8C&PID_0134') {
    throw 'The configured PnP identity is not the TONOR G11'
  }
  $defaults = @{
    microphoneGainDb = 0
    noiseReductionDb = 6
    noiseFloorDb = -35
    expanderThresholdDb = -50
    expanderRange = 0.5
  }
  foreach ($entry in $defaults.GetEnumerator()) {
    if ($value.PSObject.Properties.Name -notcontains $entry.Key) {
      $value | Add-Member -NotePropertyName $entry.Key -NotePropertyValue $entry.Value
    }
  }
  $audioDelay = [int]$value.audioDelayMs
  $videoDelay = [int]$value.videoDelayMs
  if ($audioDelay -lt 0 -or $audioDelay -gt 2000) { throw 'audioDelayMs must be between 0 and 2000' }
  if ($videoDelay -lt 0 -or $videoDelay -gt 2000) { throw 'videoDelayMs must be between 0 and 2000' }
  if ($audioDelay -gt 0 -and $videoDelay -gt 0) {
    throw 'Configure audioDelayMs or videoDelayMs, not both'
  }
  if ([double]$value.microphoneGainDb -lt -12 -or [double]$value.microphoneGainDb -gt 12) {
    throw 'microphoneGainDb must be between -12 and 12'
  }
  if ([double]$value.noiseReductionDb -lt 0.01 -or [double]$value.noiseReductionDb -gt 12) {
    throw 'noiseReductionDb must be between 0.01 and 12'
  }
  if ([double]$value.noiseFloorDb -lt -80 -or [double]$value.noiseFloorDb -gt -20) {
    throw 'noiseFloorDb must be between -80 and -20'
  }
  if ([double]$value.expanderThresholdDb -lt -70 -or [double]$value.expanderThresholdDb -gt -20) {
    throw 'expanderThresholdDb must be between -70 and -20'
  }
  if ([double]$value.expanderRange -lt 0.25 -or [double]$value.expanderRange -gt 1) {
    throw 'expanderRange must be between 0.25 and 1'
  }
  return $value
}

function Test-TonorConnected {
  param([string]$PnpPrefix)
  $device = Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |
    Where-Object {
      $_.PNPDeviceID -and
      $_.PNPDeviceID.StartsWith($PnpPrefix, [StringComparison]::OrdinalIgnoreCase) -and
      $_.Status -eq 'OK'
    } |
    Select-Object -First 1
  return $null -ne $device
}

function Resolve-TonorAudioEndpoint {
  param(
    [string]$FfmpegPath,
    [string]$DeviceName
  )
  # DirectShow endpoint GUIDs can be re-enumerated by Windows after a USB
  # reconnect. The PnP VID/PID check establishes the physical device; this
  # fresh FFmpeg enumeration resolves its current capture endpoint.
  $listing = (& $FfmpegPath -hide_banner -list_devices true -f dshow -i dummy 2>&1 | Out-String)
  $pattern = '"' + [Regex]::Escape($DeviceName) +
    '"\s+\(audio\).*?Alternative name "(?<endpoint>@device_cm_[^"]+)"'
  $match = [Regex]::Match(
    [string]$listing,
    $pattern,
    [Text.RegularExpressions.RegexOptions]::IgnoreCase -bor
      [Text.RegularExpressions.RegexOptions]::Singleline
  )
  if (-not $match.Success) {
    throw 'TONOR DirectShow capture endpoint is not currently available'
  }
  return $match.Groups['endpoint'].Value
}

function Send-Heartbeat {
  param(
    [object]$Config,
    [bool]$MicrophoneConnected,
    [bool]$PublisherRunning,
    [string]$LastFrameAt,
    [string]$ErrorCode
  )
  $body = @{
    source_id = 'anpviz'
    publisher_running = $PublisherRunning
    microphone_connected = $MicrophoneConnected
    microphone_identity = 'TONOR_G11_USB_VID_0D8C_PID_0134'
    configured_delay_ms = if ([int]$Config.audioDelayMs -gt 0) {
      [int]$Config.audioDelayMs
    } else {
      -1 * [int]$Config.videoDelayMs
    }
    last_audio_frame_at = $LastFrameAt
    error_code = $ErrorCode
    sent_at = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Method Post -Uri $Config.heartbeatUrl -Headers @{
      'X-Source-Heartbeat-Token' = [string]$Config.heartbeatToken
    } -ContentType 'application/json' -Body $body -TimeoutSec 4 | Out-Null
  } catch {
    # The publisher remains authoritative even during a transient health API
    # outage. The next bounded heartbeat retries without logging credentials.
  }
}

function Rotate-Log {
  param([string]$Path)
  if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt 10MB) {
    $archive = "$Path.1"
    if (Test-Path -LiteralPath $archive) { Remove-Item -LiteralPath $archive -Force }
    Move-Item -LiteralPath $Path -Destination $archive
  }
}

$config = Read-PublisherConfig -Path $ConfigPath
if (-not (Test-Path -LiteralPath $config.ffmpegPath -PathType Leaf)) {
  throw 'Configured FFmpeg executable was not found'
}

$runtimeRoot = Join-Path (Split-Path -Parent $ConfigPath) 'runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null
$progressFile = Join-Path $runtimeRoot 'ffmpeg-progress.txt'
$stderrLog = Join-Path $runtimeRoot 'ffmpeg-stderr.log'

$createdNew = $false
$mutex = New-Object Threading.Mutex($true, 'Global\MBFD_AnpvizTonorPublisher', [ref]$createdNew)
if (-not $createdNew) { throw 'Anpviz TONOR publisher is already running' }

$retrySeconds = 2
try {
  while ($true) {
    $microphoneConnected = Test-TonorConnected -PnpPrefix ([string]$config.audioPnpInstancePrefix)
    if (-not $microphoneConnected) {
      Send-Heartbeat -Config $config -MicrophoneConnected $false -PublisherRunning $false -LastFrameAt $null -ErrorCode 'TONOR_DISCONNECTED'
      Start-Sleep -Seconds ([Math]::Min($retrySeconds, [int]$config.restartMaximumSeconds))
      $retrySeconds = [Math]::Min($retrySeconds * 2, [int]$config.restartMaximumSeconds)
      continue
    }
    try {
      $audioEndpoint = Resolve-TonorAudioEndpoint -FfmpegPath ([string]$config.ffmpegPath) `
        -DeviceName ([string]$config.audioDeviceName)
    } catch {
      Send-Heartbeat -Config $config -MicrophoneConnected $true -PublisherRunning $false `
        -LastFrameAt $null -ErrorCode 'TONOR_ENDPOINT_UNAVAILABLE'
      Start-Sleep -Seconds ([Math]::Min($retrySeconds, [int]$config.restartMaximumSeconds))
      $retrySeconds = [Math]::Min($retrySeconds * 2, [int]$config.restartMaximumSeconds)
      continue
    }

    Rotate-Log -Path $stderrLog
    Remove-Item -LiteralPath $progressFile -Force -ErrorAction SilentlyContinue
    $arguments = @(
      '-nostdin', '-hide_banner', '-loglevel', 'warning',
      '-fflags', '+genpts+discardcorrupt',
      '-thread_queue_size', '1024',
      '-rtsp_transport', 'tcp'
    )
    if ([int]$config.videoDelayMs -gt 0) {
      $arguments += @('-itsoffset', ([int]$config.videoDelayMs / 1000).ToString('0.000', [Globalization.CultureInfo]::InvariantCulture))
    }
    $arguments += @(
      '-i', [string]$config.videoSourceUrl,
      '-thread_queue_size', '2048',
      '-f', 'dshow',
      '-audio_buffer_size', '50',
      '-i', ('audio="' + $audioEndpoint + '"'),
      '-map', '0:v:0',
      '-map', '1:a:0',
      '-c:v', 'copy',
      '-c:a', 'aac',
      '-ar', '48000',
      '-ac', '1',
      '-b:a', '128k'
    )
    # Both capture inputs begin from FFmpeg's normalized zero-based timeline.
    # async continuously corrects USB clock drift without forcing the RTSP
    # source into an incompatible epoch or transcoding the camera video.
    $audioFilter = 'highpass=f=80,aresample=async=1000:min_hard_comp=0.100:first_pts=0'
    if ([int]$config.audioDelayMs -gt 0) {
      $audioFilter += ',adelay=' + [int]$config.audioDelayMs + ':all=1'
    }
    $format = [Globalization.CultureInfo]::InvariantCulture
    $noiseReduction = ([double]$config.noiseReductionDb).ToString('0.##', $format)
    $noiseFloor = ([double]$config.noiseFloorDb).ToString('0.##', $format)
    $expanderThreshold = ([Math]::Pow(10, [double]$config.expanderThresholdDb / 20)
      ).ToString('0.######', $format)
    $expanderRange = ([double]$config.expanderRange).ToString('0.###', $format)
    $gain = ([double]$config.microphoneGainDb).ToString('0.##', $format)
    $audioFilter += ',afftdn=nr=' + $noiseReduction + ':nf=' + $noiseFloor + ':tn=1'
    # At the default range=0.5 the downward expander attenuates at most 6 dB;
    # it is deliberately not a hard gate and will not chop speech beginnings.
    $audioFilter += ',agate=threshold=' + $expanderThreshold +
      ':ratio=1.5:attack=20:release=300:range=' + $expanderRange
    $audioFilter += ',volume=' + $gain + 'dB'
    $audioFilter += ',acompressor=threshold=-18dB:ratio=3:attack=20:release=250:makeup=2,alimiter=limit=0.95'
    $arguments += @(
      '-af', $audioFilter,
      '-max_interleave_delta', '1000000',
      '-muxdelay', '0.1',
      '-stats_period', '2',
      '-progress', $progressFile,
      '-f', 'rtsp',
      '-rtsp_transport', 'tcp',
      [string]$config.publishUrl
    )

    $process = Start-Process -FilePath $config.ffmpegPath -ArgumentList $arguments `
      -RedirectStandardError $stderrLog -PassThru -WindowStyle Hidden
    $retrySeconds = 2
    $lastProgress = ''
    $lastFrameAt = $null

    while (-not $process.HasExited) {
      Start-Sleep -Seconds ([Math]::Max(2, [int]$config.heartbeatIntervalSeconds))
      $microphoneConnected = Test-TonorConnected -PnpPrefix ([string]$config.audioPnpInstancePrefix)
      if (Test-Path -LiteralPath $progressFile) {
        $progress = Get-Content -LiteralPath $progressFile -Raw -ErrorAction SilentlyContinue
        $outTime = [regex]::Match([string]$progress, '(?m)^out_time_us=(\d+)$').Groups[1].Value
        if ($outTime -and $outTime -ne $lastProgress) {
          $lastProgress = $outTime
          $lastFrameAt = [DateTime]::UtcNow.ToString('o')
        }
      }
      Send-Heartbeat -Config $config -MicrophoneConnected $microphoneConnected `
        -PublisherRunning (-not $process.HasExited) -LastFrameAt $lastFrameAt `
        -ErrorCode $(if ($microphoneConnected) { $null } else { 'TONOR_DISCONNECTED' })
      if (-not $microphoneConnected -and -not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
      }
    }

    Send-Heartbeat -Config $config -MicrophoneConnected $microphoneConnected `
      -PublisherRunning $false -LastFrameAt $lastFrameAt -ErrorCode ('PUBLISHER_EXIT_' + $process.ExitCode)
    Start-Sleep -Seconds ([Math]::Min($retrySeconds, [int]$config.restartMaximumSeconds))
    $retrySeconds = [Math]::Min($retrySeconds * 2, [int]$config.restartMaximumSeconds)
  }
} finally {
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
