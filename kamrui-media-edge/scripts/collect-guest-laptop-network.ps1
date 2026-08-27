<#
.SYNOPSIS
Collects read-only wired-LAN acceptance evidence for the Guest Laptop.

.DESCRIPTION
This script does not change adapters, routes, power policy, firewall rules,
OBS, or MediaMTX. It only reads Windows configuration/counters/events, sends
ICMP echo requests to the supplied KAMRUI address, and makes one TCP connect
attempt to the intended RTMP listener. It never publishes RTMP media.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^((25[0-5]|2[0-4][0-9]|1?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|1?[0-9][0-9]?)$')]
    [string]$KamruiIp = '192.168.1.122',

    [ValidateRange(1, 65535)]
    [int]$RtmpPort = 1935,

    [ValidateRange(5, 45)]
    [int]$PingCount = 45,

    [string]$AdapterName,

    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'guest-network-adapter-policy.ps1')

function Invoke-ReadOnly {
    param([scriptblock]$ScriptBlock)

    try {
        & $ScriptBlock
    }
    catch {
        [pscustomobject]@{ error = $_.Exception.Message }
    }
}

function Convert-AdapterStatistics {
    param($Statistics)

    $result = [ordered]@{}
    if ($null -eq $Statistics) {
        return $result
    }
    foreach ($property in $Statistics.PSObject.Properties) {
        if ($property.Name -match 'Error|Discard|Drop') {
            $result[$property.Name] = $property.Value
        }
    }
    return $result
}

function Get-StatisticsDelta {
    param($Before, $After)

    $result = [ordered]@{}
    foreach ($name in @($Before.Keys + $After.Keys | Select-Object -Unique)) {
        $beforeValue = if ($null -eq $Before[$name]) { 0 } else { [int64]$Before[$name] }
        $afterValue = if ($null -eq $After[$name]) { 0 } else { [int64]$After[$name] }
        $result[$name] = $afterValue - $beforeValue
    }
    return $result
}

function Get-LinkMegabits {
    param([string]$LinkSpeed)

    if ($LinkSpeed -match '^([0-9]+(?:\.[0-9]+)?)\s*Gbps$') {
        return [double]$matches[1] * 1000
    }
    if ($LinkSpeed -match '^([0-9]+(?:\.[0-9]+)?)\s*Mbps$') {
        return [double]$matches[1]
    }
    return $null
}

function Get-AcPowerIndex {
    param([string[]]$PowerCfgOutput)

    $match = @($PowerCfgOutput | Select-String -Pattern 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)' | Select-Object -Last 1)
    if ($match.Count -ne 1) {
        return $null
    }
    return [Convert]::ToInt32($match[0].Matches[0].Groups[1].Value, 16)
}

function Get-DevicePowerManagement {
    param([string]$Name)

    return Invoke-ReadOnly { Get-NetAdapterPowerManagement -Name $Name | Select-Object * }
}

$allAdapters = @(Get-NetAdapter -IncludeHidden)
$adapter = Select-GuestWiredEthernetAdapter -Adapters $allAdapters -AdapterName $AdapterName

$ipInterface = Get-NetIPInterface -InterfaceIndex $adapter.ifIndex -AddressFamily IPv4
$ipConfiguration = Get-NetIPConfiguration -InterfaceIndex $adapter.ifIndex
$ipv4 = @(
    $ipConfiguration.IPv4Address |
        Select-Object IPAddress, PrefixLength, AddressState, PrefixOrigin, SuffixOrigin
)
$selectedIpv4Addresses = @(
    $ipv4 |
        ForEach-Object { [string]$_.IPAddress } |
        Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and $_ -notmatch '^169\.254\.' }
)
$gateway = @($ipConfiguration.IPv4DefaultGateway | ForEach-Object NextHop)
$dns = @($ipConfiguration.DNSServer.ServerAddresses)
$pnpDeviceId = $adapter.PnPDeviceID
$driver = @(
    Get-CimInstance Win32_PnPSignedDriver |
        Where-Object { $_.DeviceID -eq $pnpDeviceId } |
        Select-Object DeviceName, Manufacturer, DriverVersion, DriverDate, InfName, DeviceID
)
$pnpDevice = Invoke-ReadOnly { Get-PnpDevice -InstanceId $pnpDeviceId | Select-Object Class, FriendlyName, Manufacturer, Status, Problem, InstanceId }
$powerManagement = Get-DevicePowerManagement -Name $adapter.Name
$advancedProperties = Invoke-ReadOnly {
    Get-NetAdapterAdvancedProperty -Name $adapter.Name |
        Where-Object { $_.DisplayName -match 'Duplex|Speed|Energy|Green|Power|EEE|Suspend' } |
        Select-Object DisplayName, DisplayValue, RegistryKeyword, RegistryValue
}

$route = @(Invoke-ReadOnly {
    Find-NetRoute -RemoteIPAddress $KamruiIp |
        Select-Object DestinationPrefix, NextHop, InterfaceAlias, ifIndex, RouteMetric, PolicyStore
})
$routeLookupFailed = @($route | Where-Object { $_.PSObject.Properties.Name -contains 'error' }).Count -gt 0
$routeUsesSelectedEthernet = @(
    $route | Where-Object { Test-GuestNetworkRouteUsesSelectedAdapter -Route $_ -Adapter $adapter }
).Count -gt 0
if ($routeLookupFailed) {
    throw "RED: The route to KAMRUI $KamruiIp could not be determined. No ICMP or TCP acceptance test was run."
}
if (-not $routeUsesSelectedEthernet) {
    throw "RED: The route to KAMRUI $KamruiIp does not select wired adapter '$($adapter.Name)'. No ICMP or TCP acceptance test was run."
}
$wifi = @(
    $allAdapters | Where-Object {
        $_.InterfaceDescription -match 'Wireless|Wi-Fi|802\.11|WLAN' -or
        $_.Name -match 'Wi-?Fi|Wireless|WLAN'
    } | Select-Object Name, InterfaceDescription, Status, LinkSpeed, ifIndex
)

$statisticsBefore = Convert-AdapterStatistics (Get-NetAdapterStatistics -Name $adapter.Name)
$pingOutput = @(& ping.exe -4 -n $PingCount -w 500 $KamruiIp 2>&1)
$pingExitCode = $LASTEXITCODE
$pingReplies = @($pingOutput | Where-Object { $_ -match '^Reply from ' }).Count
$pingTimeouts = @($pingOutput | Where-Object { $_ -match 'Request timed out|Destination host unreachable|General failure' }).Count
$tcp = Invoke-ReadOnly {
    Test-NetConnection -ComputerName $KamruiIp -Port $RtmpPort -InformationLevel Detailed -WarningAction SilentlyContinue |
        Select-Object ComputerName, RemoteAddress, RemotePort, NameResolutionSucceeded, InterfaceAlias, SourceAddress, TcpTestSucceeded, PingSucceeded
}
$testNetConnectionInterfaceAlias = $null
$testNetConnectionSourceAddress = $null
$testNetConnectionUsesSelectedEthernet = $null
$testNetConnectionSourceMatchesSelectedEthernet = $null
if ($tcp -and -not ($tcp.PSObject.Properties.Name -contains 'error')) {
    if ($tcp.PSObject.Properties.Name -contains 'InterfaceAlias') {
        $candidateInterfaceAlias = [string]$tcp.InterfaceAlias
        if (-not [string]::IsNullOrWhiteSpace($candidateInterfaceAlias)) {
            $testNetConnectionInterfaceAlias = $candidateInterfaceAlias
            $testNetConnectionUsesSelectedEthernet = $candidateInterfaceAlias -ieq $adapter.Name
        }
    }
    if ($tcp.PSObject.Properties.Name -contains 'SourceAddress') {
        $candidateSourceAddress = [string]$tcp.SourceAddress
        if (-not [string]::IsNullOrWhiteSpace($candidateSourceAddress) -and $candidateSourceAddress -ne '0.0.0.0') {
            $testNetConnectionSourceAddress = $candidateSourceAddress
            $testNetConnectionSourceMatchesSelectedEthernet = $selectedIpv4Addresses -contains $candidateSourceAddress
        }
    }
}
$statisticsAfter = Convert-AdapterStatistics (Get-NetAdapterStatistics -Name $adapter.Name)
$statisticsDelta = Get-StatisticsDelta $statisticsBefore $statisticsAfter

$eventTerms = @(
    @($adapter.Name) + @($adapter.InterfaceDescription -split '[^A-Za-z0-9]+' | Where-Object { $_.Length -ge 5 })
) | Select-Object -Unique
$recentEvents = Invoke-ReadOnly {
    Get-WinEvent -FilterHashtable @{ LogName = 'System'; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 3000 |
        Where-Object {
            $event = $_
            $message = $event.Message
            $event.ProviderName -match 'Kernel-PnP|NDIS|USBHUB|USBXHCI|Tcpip' -and
            (@($eventTerms | Where-Object { $_ -and $message -match [regex]::Escape([string]$_) }).Count -gt 0)
        } |
        Select-Object -First 30 TimeCreated, Id, ProviderName, LevelDisplayName, Message
}

$powercfgAvailability = @(& powercfg /a 2>&1)
$powercfgPlan = @(& powercfg /getactivescheme 2>&1)
$powercfgSleep = @(& powercfg /q SCHEME_CURRENT SUB_SLEEP STANDBYIDLE 2>&1)
$powercfgHibernate = @(& powercfg /q SCHEME_CURRENT SUB_SLEEP HIBERNATEIDLE 2>&1)
$powercfgRequests = @(& powercfg /requests 2>&1)
$battery = Invoke-ReadOnly {
    Get-CimInstance Win32_Battery |
        Select-Object Name, BatteryStatus, EstimatedChargeRemaining, EstimatedRunTime, PowerManagementSupported
}

$linkMegabits = Get-LinkMegabits -LinkSpeed ([string]$adapter.LinkSpeed)
$hasUsableIpv4 = @($ipv4 | Where-Object { $_.IPAddress -notmatch '^169\.254\.' -and $_.AddressState -eq 'Preferred' }).Count -gt 0
$tcpSucceeded = $false
if ($tcp -and $tcp.PSObject.Properties.Name -contains 'TcpTestSucceeded') {
    $tcpSucceeded = $tcp.TcpTestSucceeded -eq $true
}
$counterIncreased = @($statisticsDelta.Values | Where-Object { $_ -gt 0 }).Count -gt 0
$powerCanTurnOff = $null
if ($powerManagement -and $powerManagement.PSObject.Properties.Name -contains 'AllowComputerToTurnOffDevice') {
    $powerCanTurnOff = [string]$powerManagement.AllowComputerToTurnOffDevice
}
$hasDisconnectEvents = @($recentEvents | Where-Object { $_.Message -match 'disconnect|removed|surprise|reset|failed|power' }).Count -gt 0
$standbyAcMinutes = Get-AcPowerIndex -PowerCfgOutput $powercfgSleep
$hibernateAcMinutes = Get-AcPowerIndex -PowerCfgOutput $powercfgHibernate
$hasDuplexEvidence = @($advancedProperties | Where-Object { $_.DisplayName -match 'Duplex' }).Count -gt 0
$hasExplicitNonFullDuplex = -not (Test-GuestNetworkFullDuplexWhereObservable -AdvancedProperties $advancedProperties)
$eventQueryFailed = $recentEvents -and $recentEvents.PSObject.Properties.Name -contains 'error'
$batteryReportsNotOnAc = $battery -and $battery.PSObject.Properties.Name -contains 'BatteryStatus' -and $battery.BatteryStatus -ne 2

$verdict = 'GREEN'
$reasons = New-Object System.Collections.Generic.List[string]
if ($linkMegabits -eq $null -or $linkMegabits -lt 100) {
    $verdict = 'RED'
    $reasons.Add('wired link is below 100 Mbps or link speed is not exposed')
}
elseif ($linkMegabits -lt 1000) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('100 Mbps can carry the stream but requires cable/dongle negotiation investigation before acceptance')
}
if (-not $hasUsableIpv4) {
    $verdict = 'RED'
    $reasons.Add('selected Ethernet adapter has no usable IPv4 address')
}
if (-not $routeUsesSelectedEthernet) {
    $verdict = 'RED'
    $reasons.Add('KAMRUI route does not select the specified Ethernet adapter')
}
if ($testNetConnectionUsesSelectedEthernet -eq $false) {
    $verdict = 'RED'
    $reasons.Add('Test-NetConnection reported a different interface than the selected Ethernet adapter')
}
if ($testNetConnectionSourceMatchesSelectedEthernet -eq $false) {
    $verdict = 'RED'
    $reasons.Add('Test-NetConnection reported a source address that is not assigned to the selected Ethernet adapter')
}
if ($pingExitCode -ne 0 -or $pingReplies -lt $PingCount -or $pingTimeouts -gt 0) {
    $verdict = 'RED'
    $reasons.Add('short wired ICMP stability sample was not loss-free')
}
if (-not $tcpSucceeded) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('TCP 1935 did not complete; confirm the scheduled MediaMTX listener and narrow firewall rule without starting OBS')
}
if ($counterIncreased) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('adapter error/discard/drop counters increased during the short test')
}
if ($wifi | Where-Object Status -eq 'Up') {
    if (-not $routeUsesSelectedEthernet -and $verdict -ne 'RED') { $verdict = 'RED' }
    $reasons.Add('Wi-Fi is enabled; the captured route must remain on Ethernet during guest publishing')
}
if ($powerCanTurnOff -eq 'Enabled') {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('Windows is permitted to power down the Ethernet adapter')
}
elseif ([string]::IsNullOrWhiteSpace($powerCanTurnOff) -or $powerCanTurnOff -eq 'Unsupported') {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('Windows Ethernet power-down state was not exposed and requires manual Device Manager confirmation')
}
if (-not $hasDuplexEvidence) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('the NIC did not expose a duplex setting; retain driver or switch evidence before acceptance')
}
if ($hasExplicitNonFullDuplex) {
    $verdict = 'RED'
    $reasons.Add('the NIC explicitly reports half duplex; correct link negotiation before acceptance')
}
if ($standbyAcMinutes -eq $null -or $hibernateAcMinutes -eq $null) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('effective AC sleep/hibernate timeout could not be parsed and requires manual review')
}
elseif ($standbyAcMinutes -ne 0 -or $hibernateAcMinutes -ne 0) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('the active AC power plan has a non-zero sleep or hibernate timeout')
}
if ($batteryReportsNotOnAc) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('the laptop battery state does not report AC power during this check')
}
if ($eventQueryFailed) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('the Windows System event query failed and must be rerun with sufficient read access')
}
if ($hasDisconnectEvents) {
    if ($verdict -ne 'RED') { $verdict = 'AMBER' }
    $reasons.Add('matching recent USB/NIC disconnect, reset, or power events require review')
}
if ($reasons.Count -eq 0) {
    $reasons.Add('all automated wired-network and power-policy gates passed; confirm DHCP reservation on the DHCP server')
}

$report = [ordered]@{
    generatedAt = (Get-Date).ToString('o')
    target = [ordered]@{ kamruiIpv4 = $KamruiIp; rtmpPort = $RtmpPort; actualRtmpPublishing = $false }
    ethernetAdapter = [ordered]@{
        name = $adapter.Name
        interfaceDescription = $adapter.InterfaceDescription
        pnpDeviceId = $pnpDeviceId
        linkStatus = $adapter.Status
        negotiatedLinkSpeed = $adapter.LinkSpeed
        linkSpeedMegabits = $linkMegabits
        macAddress = $adapter.MacAddress
        driver = $driver
        pnp = $pnpDevice
        advancedSpeedDuplexAndPower = $advancedProperties
        powerManagement = $powerManagement
    }
    ipv4 = [ordered]@{
        addresses = $ipv4
        defaultGateway = $gateway
        dns = $dns
        mtu = $ipInterface.NlMtu
        interfaceMetric = $ipInterface.InterfaceMetric
        dhcp = $ipInterface.Dhcp
        dhcpReservationMustBeConfirmedOnDhcpServer = $true
    }
    routeToKamrui = [ordered]@{
        route = $route
        routeUsesSelectedEthernet = $routeUsesSelectedEthernet
        testNetConnectionInterfaceAlias = $testNetConnectionInterfaceAlias
        testNetConnectionSourceAddress = $testNetConnectionSourceAddress
        testNetConnectionUsesSelectedEthernet = $testNetConnectionUsesSelectedEthernet
        testNetConnectionSourceMatchesSelectedEthernet = $testNetConnectionSourceMatchesSelectedEthernet
        wifi = $wifi
    }
    pathTests = [ordered]@{
        icmp = [ordered]@{
            count = $PingCount
            replyCount = $pingReplies
            timeoutOrUnreachableCount = $pingTimeouts
            exitCode = $pingExitCode
            summary = @($pingOutput | Select-Object -Last 6)
        }
        tcpRtmp = $tcp
        adapterCountersBefore = $statisticsBefore
        adapterCountersAfter = $statisticsAfter
        adapterCounterDelta = $statisticsDelta
    }
    powerAndReliability = [ordered]@{
        battery = $battery
        powercfgAvailability = $powercfgAvailability
        powercfgActiveScheme = $powercfgPlan
        powercfgSleep = $powercfgSleep
        powercfgHibernate = $powercfgHibernate
        parsedAcSleepTimeoutMinutes = $standbyAcMinutes
        parsedAcHibernateTimeoutMinutes = $hibernateAcMinutes
        powercfgRequests = $powercfgRequests
        matchingSystemEventsLast7Days = $recentEvents
    }
    automatedNetworkVerdict = $verdict
    reasons = @($reasons)
    limitations = @(
        'A DHCP reservation cannot be proven from the laptop alone; verify it on the DHCP server before source-IP authorization is enabled.',
        'Duplex may be reported as an adapter setting rather than a separate negotiated state; retain the driver output with the link-speed evidence.',
        'This is a short non-destructive baseline, not a multi-hour presentation soak.',
        'Do not configure or publish from the actual OBS profile until all required acceptance evidence is GREEN.'
    )
}

$json = $report | ConvertTo-Json -Depth 10
if ($OutputPath) {
    $resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
    $parent = Split-Path -Parent $resolvedOutputPath
    if (-not (Test-Path -LiteralPath $parent)) {
        throw "Output directory does not exist: $parent"
    }
    if (Test-Path -LiteralPath $resolvedOutputPath) {
        throw "Refusing to overwrite an existing report: $resolvedOutputPath"
    }
    [System.IO.File]::WriteAllText($resolvedOutputPath, $json + [Environment]::NewLine)
}
else {
    $json
}
