[CmdletBinding()]
# High-level replacement of the legacy FiveDisplayKiosk pattern: launches one
# isolated Edge/Chromium player window per managed display, pointing each at the
# existing `/player/managed` route on the Media Control server using per-display
# credentials sourced from a gitignored `config.local.json` (example-only
# `config.example.json` lives in this directory). Non-TV1 windows are started
# with `--mute`; only TV1 (Video Wall 1) passes audio through (audio-enforce.ps1
# keeps TV1 -> Ultimea/eARC as the Default device).
#
# Functional + simple, not a full reimplementation. Read secrets ONLY from
# config.local.json on-box; never commit a real one.
$ErrorActionPreference = 'Stop'

$cfgPath = Join-Path $PSScriptRoot 'config.local.json'
if (-not (Test-Path $cfgPath)) {
  Write-Error "Missing $cfgPath. Copy config.example.json -> config.local.json and populate on-box ONLY (never commit)."
  exit 2
}
$cfg = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
$serverUrl = $cfg.MC_SERVER_URL
if (-not $serverUrl) { Write-Error 'config.local.json missing MC_SERVER_URL'; exit 2 }

# Defaults per planning/command-center/P3_ROOM_AGENT.md: TV1/2/3 = Video Wall 1,
# TV4/5 = Video Wall 2. managedDisplays entries carry { deviceId, deviceToken,
# wall, label, display } -- `display` can name a target monitor by friendly name.
$displays = @($cfg.managedDisplays)
if ($displays.Count -eq 0) { Write-Error 'config.local.json has no managedDisplays'; exit 2 }

# Find a browser to drive. Prefer the system Edge (kiosk-friendly); fall back to
# any chrome. Kept loose -- the on-box install pins the real path in config.
$candidates = @(
  'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
  'C:\Program Files\Google\Chrome\Application\chrome.exe',
  'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe'
)
$browser = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($env:MBFD_PLAYER_BROWSER -and (Test-Path $env:MBFD_PLAYER_BROWSER)) { $browser = $env:MBFD_PLAYER_BROWSER }
if (-not $browser) { Write-Error 'No supported browser (Edge/Chrome) found'; exit 3 }
Write-Host "kiosk-launcher: browser=$browser"

$pids = @()
foreach ($d in $displays) {
  if (-not $d.deviceId -or -not $d.deviceToken) {
    Write-Warning "display '$($d.label)' missing deviceId/deviceToken -- skipping"
    continue
  }
  $playerUrl = "$serverUrl/player/managed?deviceId=$([uri]::EscapeDataString($d.deviceId))&deviceToken=$([uri]::EscapeDataString($d.deviceToken))"
  # --autoplay-policy=no-user-gesture-required: without this, Chrome blocks unmuted
  # video.play() in nested iframes (news HLS via grid.html → hls.html) even when the
  # top frame has the userHasInteracted flag set. This is a kiosk — the operator is
  # never going to tap the screen; media MUST autoplay with sound on TV1 and silently
  # on every other panel.
  # NOTE: pass --app=<url> WITHOUT inner quotes. Quoting it as `--app="https://..."`
  # makes Edge/Chrome treat the literal double-quotes as part of the URL, which breaks
  # the managed-player route. The URL is already a single token (no spaces) so it needs
  # no quoting. Start-Process -ArgumentList is passed the ARRAY directly (not joined)
  # so each element is one verbatim argv entry — this also preserves the & and ? in
  # the query string instead of letting the shell re-parse them.
  $launchArgs = @('--app=' + $playerUrl, '--no-default-browser-check', '--no-first-run', '--disable-features=Translate', '--kiosk', '--autoplay-policy=no-user-gesture-required')
  # Mute every player EXCEPT TV1 (wall 1 label TV1) so only the Ultimea path sounds.
  # --mute-audio is the correct Chromium command-line flag to start a window muted.
  $isTv1 = ($d.wall -eq 1 -and $d.label -eq 'TV1')
  if (-not $isTv1) { $launchArgs += '--mute-audio' }
  # Position the window on the target monitor. Chrome/Edge requires --window-position=X,Y
  # as a single flag (not two separate arguments).
  if ($d.display) { $launchArgs += "--window-position=$($d.display)" }
  try {
    $p = Start-Process -FilePath $browser -ArgumentList $launchArgs -PassThru
    $pids += $p.Id
    Write-Host "launched '$($d.label)' pid=$($p.Id) url=$playerUrl mute=$(-not $isTv1)"
  } catch {
    Write-Warning "failed to launch '$($d.label)': $($_.Exception.Message)"
  }
}

# Record the launched PIDs so healthcheck.ps1 can verify them.
$stateDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $stateDir -Force | Out-Null
Set-Content -LiteralPath (Join-Path $stateDir 'kiosk-pids.json') -Value ($pids | ConvertTo-Json) -ErrorAction SilentlyContinue
Write-Host "kiosk-launcher: $($pids.Count)/$($displays.Count) player windows launched"