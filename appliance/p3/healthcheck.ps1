[CmdletBinding()]
# Healthcheck for the P3 classroom: verifies the managed player windows are still
# alive + the eARC audio endpoint is present + the room-agent is reachable on
# its localhost control port. Prints a single JSON line `{players,audio,agent}`
# to stdout for the install/update watchdog + the admin-sync heartbeat probe.
$ErrorActionPreference = 'Continue'
$logDir = Join-Path $PSScriptRoot 'logs'
$agentPort = [int]($env:MC_AGENT_PORT ?? 8097)
$stateJson = Join-Path $logDir 'kiosk-pids.json'

# Players: count launched PIDs that are still alive.
$players = @{ launched = 0; live = 0 }
if (Test-Path $stateJson) {
  try {
    $pids = Get-Content -LiteralPath $stateJson -Raw | ConvertFrom-Json
    if ($pids) { $players.launched = @($pids).Count; foreach ($p in $pids) { if (Get-Process -Id $p -ErrorAction SilentlyContinue) { $players.live++ } } }
  } catch { }
}

# Audio: run audio-enforce in -Wirefire probe mode (no side effects) and parse.
$audio = @{ ok = $false; endpoint = $null }
try {
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'audio\audio-enforce.ps1') -Wirefire 2>$null
  if ($LASTEXITCODE -eq 0 -and $out) {
    $line = ($out | Where-Object { $_ -like '-Wirefire:*' } | Select-Object -First 1)
    if ($line -like '-Wirefire:*') {
      $name = ($line -replace '-Wirefire:','').Trim()
      if ($name -and $name -ne 'none') { $audio.ok = $true; $audio.endpoint = $name }
    }
  }
} catch { }

# Agent: TCP probe on the room-agent control port (best-effort).
$agent = @{ ok = $false; port = $agentPort }
try {
  $tcp = New-Object System.Net.Sockets.TcpClient
  $iar = $tcp.BeginConnect('127.0.0.1', $agentPort, $null, $null)
  $ok = $iar.AsyncWaitHandle.WaitOne(1500)
  if ($ok -and $tcp.Connected) { $agent.ok = $true }
  $tcp.Close()
} catch { }

[PSCustomObject]@{
  players = $players
  audio   = $audio
  agent   = $agent
} | ConvertTo-Json -Compress -Depth 5