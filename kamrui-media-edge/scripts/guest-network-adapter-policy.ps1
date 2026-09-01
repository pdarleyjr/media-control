Set-StrictMode -Version Latest

$script:GuestNetworkRejectedAdapterIdentityPattern = 'Wi-Fi|Wireless|802\.11|WLAN|Bluetooth|Tailscale|TAP|VPN|Virtual|Hyper-V|WAN Miniport|Loopback|Kernel Debug'

function Get-GuestNetworkAdapterProperty {
    param(
        [Parameter(Mandatory)]
        [object]$Adapter,

        [Parameter(Mandatory)]
        [string]$Name
    )

    $property = $Adapter.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function Test-IsPhysicalWiredEthernetAdapter {
    <#
    .SYNOPSIS
    Returns true only for a connected physical wired Ethernet adapter.

    .DESCRIPTION
    This is the single policy predicate for both automatic candidate discovery
    and explicit -AdapterName selection in collect-guest-laptop-network.ps1.
    #>
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Adapter
    )

    $status = [string](Get-GuestNetworkAdapterProperty -Adapter $Adapter -Name 'Status')
    if ($status -ine 'Up') {
        return $false
    }

    $hardwareInterface = Get-GuestNetworkAdapterProperty -Adapter $Adapter -Name 'HardwareInterface'
    if ($hardwareInterface -is [bool]) {
        if (-not $hardwareInterface) {
            return $false
        }
    }
    elseif ([string]$hardwareInterface -ine 'True') {
        return $false
    }

    $identity = @(
        [string](Get-GuestNetworkAdapterProperty -Adapter $Adapter -Name 'Name')
        [string](Get-GuestNetworkAdapterProperty -Adapter $Adapter -Name 'InterfaceDescription')
    ) -join ' '
    if ($identity -match $script:GuestNetworkRejectedAdapterIdentityPattern) {
        return $false
    }

    return $true
}

function Select-GuestWiredEthernetAdapter {
    [OutputType([object])]
    param(
        [Parameter(Mandatory)]
        [object[]]$Adapters,

        [string]$AdapterName
    )

    if (-not [string]::IsNullOrWhiteSpace($AdapterName)) {
        $matches = @($Adapters | Where-Object { $_.Name -eq $AdapterName })
        if ($matches.Count -ne 1) {
            throw "RED: Adapter '$AdapterName' was not found exactly once. Run Get-NetAdapter and specify the connected wired adapter name. No ICMP or TCP acceptance test was run."
        }

        $selected = $matches[0]
        if (-not (Test-IsPhysicalWiredEthernetAdapter -Adapter $selected)) {
            throw "RED: Adapter '$AdapterName' is not a connected physical wired Ethernet adapter. It must be Status Up, HardwareInterface True, and must not be wireless, virtual, tunnel, Bluetooth, or WAN. No ICMP or TCP acceptance test was run."
        }

        return $selected
    }

    $candidates = @($Adapters | Where-Object { Test-IsPhysicalWiredEthernetAdapter -Adapter $_ })
    if ($candidates.Count -eq 1) {
        return $candidates[0]
    }
    if ($candidates.Count -eq 0) {
        throw 'RED: No connected physical wired Ethernet adapter was found. Connect the Guest Laptop wired dongle, then rerun with -AdapterName if necessary. No ICMP or TCP acceptance test was run.'
    }

    $names = ($candidates | ForEach-Object Name) -join ', '
    throw "RED: More than one connected physical wired Ethernet adapter was found ($names). Rerun with -AdapterName for the Guest USB/USB-C dongle. No ICMP or TCP acceptance test was run."
}

function Test-GuestNetworkRouteUsesSelectedAdapter {
    [OutputType([bool])]
    param(
        [Parameter(Mandatory)]
        [object]$Route,

        [Parameter(Mandatory)]
        [object]$Adapter
    )

    $routeIfIndex = Get-GuestNetworkAdapterProperty -Adapter $Route -Name 'ifIndex'
    $routeAlias = [string](Get-GuestNetworkAdapterProperty -Adapter $Route -Name 'InterfaceAlias')
    $adapterIfIndex = Get-GuestNetworkAdapterProperty -Adapter $Adapter -Name 'ifIndex'
    $adapterName = [string](Get-GuestNetworkAdapterProperty -Adapter $Adapter -Name 'Name')

    $hasIfIndex = -not [string]::IsNullOrWhiteSpace([string]$routeIfIndex)
    $hasAlias = -not [string]::IsNullOrWhiteSpace($routeAlias)
    if (-not $hasIfIndex -and -not $hasAlias) {
        return $false
    }

    $ifIndexMatches = -not $hasIfIndex -or ([string]$routeIfIndex -eq [string]$adapterIfIndex)
    $aliasMatches = -not $hasAlias -or ($routeAlias -ieq $adapterName)
    return $ifIndexMatches -and $aliasMatches
}

function Test-GuestNetworkFullDuplexWhereObservable {
    <#
    .SYNOPSIS
    Returns false only when the selected NIC explicitly reports half duplex.

    .DESCRIPTION
    Windows and USB Ethernet drivers do not consistently expose a duplex
    property.  Absence is handled by the collector as an AMBER evidence gap;
    an explicit half-duplex value is a RED reliability failure.
    #>
    [OutputType([bool])]
    param(
        [object[]]$AdvancedProperties
    )

    foreach ($property in @($AdvancedProperties)) {
        $displayName = [string](Get-GuestNetworkAdapterProperty -Adapter $property -Name 'DisplayName')
        $displayValue = [string](Get-GuestNetworkAdapterProperty -Adapter $property -Name 'DisplayValue')
        if ($displayName -match 'Duplex' -and $displayValue -match '(?i)half') {
            return $false
        }
    }

    return $true
}
