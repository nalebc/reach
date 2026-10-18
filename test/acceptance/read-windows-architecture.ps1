param(
    [Parameter(Mandatory=$true)][int]$NodeProcessId,
    [int]$VendorProcessId = 0,
    [string]$CodexHelperDirectory = ''
)
$ErrorActionPreference = 'Stop'
# Use Windows PowerShell's own CIM module when invoked by a PowerShell 7 job.
$env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\(\d+([.-][\w.-]+)?\\)?Modules\\?$' }) -join ';'
Add-Type -Path (Join-Path $PSScriptRoot 'windows-architecture.cs')
$report = [ordered]@{ node = [ReachAcceptanceArchitecture]::Inspect($NodeProcessId) }
if ($VendorProcessId -gt 0) {
    $report.codexDaemon = [ReachAcceptanceArchitecture]::Inspect($VendorProcessId)
}
if ($CodexHelperDirectory) {
    # Inspect only the live production helper directly spawned by this Node
    # worker, in its own protected directory. Never serialize process inventory.
    $directory = [IO.Path]::GetFullPath($CodexHelperDirectory)
    $helpers = @()
    foreach ($child in Get-CimInstance Win32_Process -Filter ('ParentProcessId = ' + $NodeProcessId)) {
        if ($child.Name -notmatch '^reach-codex-socket-[0-9a-f]{12}-[0-9a-f]{8}\.exe$') { continue }
        $actual = [ReachAcceptanceArchitecture]::Inspect([int]$child.ProcessId)
        if (-not [string]::Equals([IO.Path]::GetDirectoryName($actual.executable), $directory, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The live Codex helper is outside the expected protected directory.'
        }
        $helpers += $actual
    }
    if ($helpers.Count -ne 1) { throw 'Expected exactly one live production Codex socket helper.' }
    $report.codexHelpers = $helpers
}
$report | ConvertTo-Json -Depth 8 -Compress
