[CmdletBinding()]
param(
  [switch]$Probe
)

# Enforces a wired-first policy on the Lenovo P3 classroom box.
# When an active Ethernet uplink is present, Wi-Fi adapters are disabled and
# Ethernet interface metrics are set low so the server, cache, and player
# traffic stay on the wire. In Probe mode the script only reports state.
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$logPath = Join-Path $logDir 'network-enforce.log'

function Log([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -LiteralPath $logPath -Value $line -ErrorAction SilentlyContinue
  if (-not $Probe) { Write-Host $line }
}

function Get-AdapterState {
  $adapters = @()
  try {
    $adapters = Get-NetAdapter -Physical -ErrorAction Stop
  } catch {
    throw "Get-NetAdapter failed: $($_.Exception.Message)"
  }

  foreach ($adapter in $adapters) {
    $name = if ($null -ne $adapter.Name) { [string]$adapter.Name } else { '' }
    $description = if ($null -ne $adapter.InterfaceDescription) { [string]$adapter.InterfaceDescription } else { '' }
    $label = ("$name $description").ToLowerInvariant()
    $kind = 'other'
    if ($label -match 'wi[- ]?fi|wireless|wlan|802\.11') { $kind = 'wifi' }
    elseif ($label -match 'ethernet|lan|gigabit|gbe|eth') { $kind = 'ethernet' }

    $ipv4Metric = $null
    $ipv6Metric = $null
    try {
      $ipv4Metric = (Get-NetIPInterface -InterfaceAlias $adapter.Name -AddressFamily IPv4 -ErrorAction Stop | Select-Object -First 1).InterfaceMetric
    } catch { }
    try {
      $ipv6Metric = (Get-NetIPInterface -InterfaceAlias $adapter.Name -AddressFamily IPv6 -ErrorAction Stop | Select-Object -First 1).InterfaceMetric
    } catch { }

    [PSCustomObject]@{
      name = $adapter.Name
      description = $adapter.InterfaceDescription
      kind = $kind
      admin_status = $adapter.AdminStatus
      status = $adapter.Status
      media_state = $adapter.MediaConnectionState
      link_speed = $adapter.LinkSpeed
      interface_metric_v4 = $ipv4Metric
      interface_metric_v6 = $ipv6Metric
      active = ($adapter.Status -eq 'Up' -or $adapter.MediaConnectionState -eq 'Connected')
    }
  }
}

function Get-NetworkSummary {
  $adapters = @(Get-AdapterState)
  $ethernet = @($adapters | Where-Object { $_.kind -eq 'ethernet' })
  $wifi = @($adapters | Where-Object { $_.kind -eq 'wifi' })
  $ethernetActive = @($ethernet | Where-Object { $_.active })
  $wifiActive = @($wifi | Where-Object { $_.active -and $_.admin_status -ne 'Disabled' })
  $wifiDisabled = @($wifi | Where-Object { $_.admin_status -eq 'Disabled' })
  [PSCustomObject]@{
    wired_preferred = $ethernetActive.Count -gt 0
    primary_transport = if ($ethernetActive.Count -gt 0) { 'ethernet' } elseif ($wifiActive.Count -gt 0) { 'wifi' } else { 'offline' }
    ethernet = [PSCustomObject]@{
      present = $ethernet.Count -gt 0
      active = $ethernetActive.Count -gt 0
      active_adapters = @($ethernetActive | ForEach-Object { $_.name })
      adapters = @($ethernet | ForEach-Object { $_.name })
    }
    wifi = [PSCustomObject]@{
      present = $wifi.Count -gt 0
      active = $wifiActive.Count -gt 0
      disabled = $wifiDisabled.Count -gt 0
      active_adapters = @($wifiActive | ForEach-Object { $_.name })
      adapters = @($wifi | ForEach-Object { $_.name })
    }
    adapters = $adapters
  }
}

function Emit-State([object]$state) {
  $state | ConvertTo-Json -Compress -Depth 6
}

try {
  if ($Probe) {
    Emit-State (Get-NetworkSummary)
    exit 0
  }

  $before = Get-NetworkSummary
  if (-not $before.ethernet.active) {
    Log 'No active Ethernet uplink detected; leaving Wi-Fi untouched and retrying later.'
    Emit-State $before
    exit 1
  }

  foreach ($adapter in @($before.ethernet.adapters)) {
    try {
      Set-NetIPInterface -InterfaceAlias $adapter -AddressFamily IPv4 -InterfaceMetric 5 -ErrorAction Stop | Out-Null
    } catch {
      Log "WARN: unable to set IPv4 metric on '$adapter': $($_.Exception.Message)"
    }
    try {
      Set-NetIPInterface -InterfaceAlias $adapter -AddressFamily IPv6 -InterfaceMetric 5 -ErrorAction Stop | Out-Null
    } catch {
      Log "WARN: unable to set IPv6 metric on '$adapter': $($_.Exception.Message)"
    }
  }

  foreach ($adapter in @($before.wifi.adapters)) {
    try {
      $current = Get-NetAdapter -Name $adapter -ErrorAction Stop
      if ($current.AdminStatus -ne 'Disabled') {
        Disable-NetAdapter -Name $adapter -Confirm:$false -ErrorAction Stop | Out-Null
        Log "disabled Wi-Fi adapter '$adapter'"
      }
    } catch {
      Log "WARN: unable to disable Wi-Fi adapter '$adapter': $($_.Exception.Message)"
    }
  }

  Start-Sleep -Seconds 1
  $after = Get-NetworkSummary
  Emit-State $after
  if (-not $after.ethernet.active) {
    Log 'Ethernet is still not active after enforcement.'
    exit 1
  }
  if ($after.wifi.active) {
    Log 'Wi-Fi is still active after enforcement.'
    exit 1
  }
  Log 'wired-first policy enforced'
  exit 0
} catch {
  Log "ERROR: $($_.Exception.Message)"
  if ($Probe) {
    try { Emit-State (Get-NetworkSummary) } catch { }
    exit 0
  }
  exit 2
}
