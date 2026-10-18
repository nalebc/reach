param([Parameter(Mandatory=$true)][int]$TargetProcessId)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'standard-user-process.cs')
$state = [ReachAcceptanceUserProcess]::Inspect($TargetProcessId)
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
$hive = [Microsoft.Win32.Registry]::Users.OpenSubKey($identity.User.Value)
$profileKey = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $state.UserSid)
try {
    [ordered]@{
        processId = $state.ProcessId
        elevated = $state.Elevated
        userSid = $state.UserSid
        integritySid = $state.IntegritySid
        inspectingUserSid = $identity.User.Value
        administratorRole = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        profileHiveLoaded = ($null -ne $hive)
        userProfile = $env:USERPROFILE
        nativeProfileDirectory = $state.ProfileDirectory
        profileListDirectory = if ($profileKey) { [Environment]::ExpandEnvironmentVariables([string]$profileKey.GetValue('ProfileImagePath')) } else { $null }
    } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $hive) { $hive.Close() }
    if ($null -ne $profileKey) { $profileKey.Close() }
}
