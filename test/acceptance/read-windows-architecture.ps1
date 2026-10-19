param(
    [Parameter(Mandatory=$true)][int]$NodeProcessId,
    [int]$VendorProcessId = 0,
    [switch]$InspectCodexHelper
)
$ErrorActionPreference = 'Stop'
# Use Windows PowerShell's own CIM module when invoked by a PowerShell 7 job.
$env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\(\d+([.-][\w.-]+)?\\)?Modules\\?$' }) -join ';'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-architecture.cs')
$report = [ordered]@{ node = [ReachAcceptanceArchitecture]::Inspect($NodeProcessId) }
if ($VendorProcessId -gt 0) {
    $report.codexDaemon = [ReachAcceptanceArchitecture]::Inspect($VendorProcessId)
}
if ($InspectCodexHelper) {
    # Inspect only the live production helper directly spawned by this Node
    # worker. Its fresh stage must be directly under this actual account's
    # reserved KnownFolder container, never a caller-selected/cache directory.
    # Never serialize process inventory or supply a path to production.
    $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
    if ([string]::IsNullOrEmpty($localAppData) -or $localAppData -notmatch '\A[A-Za-z]:\\') {
        throw 'The actual account has no local application data folder.'
    }
    $container = [IO.Path]::GetFullPath([IO.Path]::Combine($localAppData, 'Reach'))
    $helperName = '\Areach-codex-socket-[0-9a-f]{12}-[0-9a-f]{8}\.exe\z'
    $helpers = @()
    foreach ($child in Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $NodeProcessId)) {
        if ($child.Name -cnotmatch $helperName) { continue }
        if ([int]$child.ParentProcessId -ne $NodeProcessId) { throw 'The live Codex helper has an unexpected parent.' }
        $actual = [ReachAcceptanceArchitecture]::Inspect([int]$child.ProcessId)
        $image = [IO.Path]::GetFullPath($actual.executable)
        $stage = [IO.Path]::GetDirectoryName($image)
        if ([IO.Path]::GetFileName($image) -cnotmatch $helperName -or
            [IO.Path]::GetFileName($image) -cne $child.Name -or
            [IO.Path]::GetFileName($stage) -cnotmatch '\Areach-private-stage-[0-9a-f]{32}\z' -or
            -not [string]::Equals([IO.Path]::GetDirectoryName($stage), $container, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The live Codex helper is outside its actual KnownFolder private stage.'
        }
        $actual['parentProcessId'] = [int]$child.ParentProcessId
        $helpers += $actual
    }
    if ($helpers.Count -ne 1) { throw 'Expected exactly one live production Codex socket helper.' }
    $report.codexHelpers = $helpers
}
$report | ConvertTo-Json -Depth 8 -Compress
