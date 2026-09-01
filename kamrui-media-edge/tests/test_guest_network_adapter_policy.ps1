Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot '..\scripts\guest-network-adapter-policy.ps1')

function New-TestAdapter {
    param(
        [string]$Name,
        [string]$InterfaceDescription,
        [bool]$HardwareInterface = $true,
        [string]$Status = 'Up',
        [int]$IfIndex = 7
    )

    [pscustomobject]@{
        Name = $Name
        InterfaceDescription = $InterfaceDescription
        HardwareInterface = $HardwareInterface
        Status = $Status
        ifIndex = $IfIndex
    }
}

function Assert-True {
    param([bool]$Condition, [string]$Message)

    if (-not $Condition) {
        throw "ASSERTION FAILED: $Message"
    }
}

function Assert-RedFailure {
    param([scriptblock]$Action, [string]$Message)

    try {
        & $Action
    }
    catch {
        Assert-True -Condition ($_.Exception.Message -match '^RED:') -Message "$Message (expected RED failure, got: $($_.Exception.Message))"
        return
    }

    throw "ASSERTION FAILED: $Message (expected failure)"
}

$wired = New-TestAdapter -Name 'USB Ethernet' -InterfaceDescription 'Realtek USB GbE Family Controller' -IfIndex 17
$wifi = New-TestAdapter -Name 'Wi-Fi' -InterfaceDescription 'Intel(R) Wi-Fi 6 AX201 160MHz' -IfIndex 8
$virtual = New-TestAdapter -Name 'vEthernet (Default Switch)' -InterfaceDescription 'Hyper-V Virtual Ethernet Adapter' -IfIndex 31
$disconnected = New-TestAdapter -Name 'Ethernet 2' -InterfaceDescription 'ASIX USB to Gigabit Ethernet Family Adapter' -Status 'Disconnected' -IfIndex 18
$secondWired = New-TestAdapter -Name 'Dock Ethernet' -InterfaceDescription 'Realtek USB 2.5GbE Family Controller' -IfIndex 19
$fullDuplex = [pscustomobject]@{ DisplayName = 'Speed & Duplex'; DisplayValue = '1.0 Gbps Full Duplex' }
$automaticDuplex = [pscustomobject]@{ DisplayName = 'Speed & Duplex'; DisplayValue = 'Auto Negotiation' }
$halfDuplex = [pscustomobject]@{ DisplayName = 'Speed & Duplex'; DisplayValue = '100 Mbps Half Duplex' }

# Connected physical Ethernet is accepted both automatically and explicitly.
Assert-True -Condition (Test-IsPhysicalWiredEthernetAdapter -Adapter $wired) -Message 'connected physical Ethernet must satisfy the wired predicate'
$auto = Select-GuestWiredEthernetAdapter -Adapters @($wired)
Assert-True -Condition ($auto.Name -eq 'USB Ethernet') -Message 'automatic selection must accept the single connected wired adapter'
$explicit = Select-GuestWiredEthernetAdapter -Adapters @($wired, $wifi) -AdapterName 'USB Ethernet'
Assert-True -Condition ($explicit.Name -eq 'USB Ethernet') -Message 'explicit selection must accept the connected wired adapter'

# Explicit names cannot bypass the same predicate used by automatic discovery.
Assert-RedFailure -Action { Select-GuestWiredEthernetAdapter -Adapters @($wired, $wifi) -AdapterName 'Wi-Fi' } -Message 'explicit Wi-Fi selection must be rejected'
Assert-RedFailure -Action { Select-GuestWiredEthernetAdapter -Adapters @($wired, $virtual) -AdapterName 'vEthernet (Default Switch)' } -Message 'explicit virtual adapter selection must be rejected'
Assert-RedFailure -Action { Select-GuestWiredEthernetAdapter -Adapters @($disconnected) -AdapterName 'Ethernet 2' } -Message 'explicit disconnected Ethernet selection must be rejected'
Assert-RedFailure -Action { Select-GuestWiredEthernetAdapter -Adapters @($wired, $secondWired) } -Message 'ambiguous wired adapters must require an explicit adapter name'

# The KAMRUI route must agree with the selected adapter by index and alias.
$matchingRoute = [pscustomobject]@{ ifIndex = 17; InterfaceAlias = 'USB Ethernet' }
$wrongRoute = [pscustomobject]@{ ifIndex = 8; InterfaceAlias = 'Wi-Fi' }
Assert-True -Condition (Test-GuestNetworkRouteUsesSelectedAdapter -Route $matchingRoute -Adapter $wired) -Message 'KAMRUI route must match the selected wired adapter'
Assert-True -Condition (-not (Test-GuestNetworkRouteUsesSelectedAdapter -Route $wrongRoute -Adapter $wired)) -Message 'KAMRUI route through Wi-Fi must not be accepted for the selected Ethernet adapter'

# Missing duplex evidence is an AMBER evidence gap; explicitly reported half duplex is never GREEN.
Assert-True -Condition (Test-GuestNetworkFullDuplexWhereObservable -AdvancedProperties @($fullDuplex)) -Message 'explicit full duplex must be accepted'
Assert-True -Condition (Test-GuestNetworkFullDuplexWhereObservable -AdvancedProperties @($automaticDuplex)) -Message 'automatic duplex setting must not be reported as half duplex'
Assert-True -Condition (-not (Test-GuestNetworkFullDuplexWhereObservable -AdvancedProperties @($halfDuplex))) -Message 'explicit half duplex must be rejected'

Write-Output 'guest-network adapter policy regression tests passed'
