[CmdletBinding()]
param(
  [string]$InstallRoot = 'C:\MBFD\anpviz-tonor',
  [switch]$RemoveLegacyCameraTask
)

$ErrorActionPreference = 'Stop'
$currentIdentity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $currentIdentity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Administrator privileges are required'
}
$resolvedRoot = [IO.Path]::GetFullPath($InstallRoot)
if (-not $resolvedRoot.StartsWith('C:\MBFD\', [StringComparison]::OrdinalIgnoreCase)) {
  throw 'InstallRoot must remain under C:\MBFD'
}

New-Item -ItemType Directory -Path $resolvedRoot -Force | Out-Null
$sourceRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Copy-Item -LiteralPath (Join-Path $sourceRoot 'Start-AnpvizTonorPublisher.ps1') `
  -Destination (Join-Path $resolvedRoot 'Start-AnpvizTonorPublisher.ps1') -Force
if (-not (Test-Path -LiteralPath (Join-Path $resolvedRoot 'config.json'))) {
  Copy-Item -LiteralPath (Join-Path $sourceRoot 'config.example.json') `
    -Destination (Join-Path $resolvedRoot 'config.json') -Force
  throw 'Provision heartbeatToken in config.json, restrict its ACL, then rerun the installer'
}

$configAcl = Get-Acl -LiteralPath (Join-Path $resolvedRoot 'config.json')
$configAcl.SetAccessRuleProtection($true, $false)
$configAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
  'SYSTEM', 'FullControl', 'Allow'
)))
$configAcl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule(
  'BUILTIN\Administrators', 'FullControl', 'Allow'
)))
Set-Acl -LiteralPath (Join-Path $resolvedRoot 'config.json') -AclObject $configAcl

$powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$publisher = Join-Path $resolvedRoot 'Start-AnpvizTonorPublisher.ps1'
$config = Join-Path $resolvedRoot 'config.json'
$action = New-ScheduledTaskAction -Execute $powerShell `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$publisher`" -ConfigPath `"$config`""
$trigger = New-ScheduledTaskTrigger -AtStartup
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
  -RestartCount 255 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
Register-ScheduledTask -TaskName 'MBFD_AnpvizTonorPublisher' -Action $action `
  -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null

if ($RemoveLegacyCameraTask) {
  $legacy = Get-ScheduledTask -TaskName 'MBFD_Camera1' -ErrorAction SilentlyContinue
  if ($legacy) {
    Stop-ScheduledTask -TaskName 'MBFD_Camera1' -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName 'MBFD_Camera1' -Confirm:$false
  }
}

Start-ScheduledTask -TaskName 'MBFD_AnpvizTonorPublisher'
Get-ScheduledTask -TaskName 'MBFD_AnpvizTonorPublisher' |
  Select-Object TaskName, State, TaskPath
