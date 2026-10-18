$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This installs machine software only on a disposable GitHub-hosted Windows runner.'
}
$reportDir = Join-Path $env:GITHUB_WORKSPACE 'reports\real-windows-acceptance'
$vendorRoot = Join-Path $env:RUNNER_TEMP 'reach-real-windows-vendors'
New-Item -ItemType Directory -Force $reportDir, $vendorRoot | Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'windows-architecture.cs')
$actualHost = [ReachAcceptanceArchitecture]::Inspect($PID)
$nativeArchitecture = $actualHost.nativeArchitecture
if ($nativeArchitecture -notin @('x64', 'arm64')) { throw 'The real vendor lane requires native x64 or ARM64 Windows.' }
$msiArchitecture = if ($nativeArchitecture -eq 'arm64') { 'arm64' } else { 'amd64' }
$os = Get-CimInstance Win32_OperatingSystem
$report = [ordered]@{
    host = [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; nativeArchitecture = $nativeArchitecture; installerProcess = $actualHost }
    codex = $null; tailscale = $null
}
function Assert-TailscaleSignature([string]$file) {
    $signature = Get-AuthenticodeSignature -LiteralPath $file
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '\bTailscale Inc\b') {
        throw "Official Tailscale signature verification failed: $($signature.Status)"
    }
    return [ordered]@{
        status = [string]$signature.Status
        subject = $signature.SignerCertificate.Subject
        thumbprint = $signature.SignerCertificate.Thumbprint
        sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()
    }
}
$codexStage = 'resolve'
$codexArchitecture = $null
try {
    # https://learn.chatgpt.com/docs/codex/cli documents @openai/codex.
    # Resolve latest once, then install that exact release from the npm registry.
    $metadataText = & npm.cmd view '@openai/codex@latest' version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org
    if ($LASTEXITCODE) { throw 'npm could not resolve the official Codex release.' }
    $metadata = ($metadataText -join "`n") | ConvertFrom-Json
    if ($metadata.version -notmatch '^\d+\.\d+\.\d+([+-][\w.-]+)?$' -or $metadata.'dist.tarball' -notlike 'https://registry.npmjs.org/@openai/codex/*') {
        throw 'The official Codex package metadata was unexpected.'
    }
    $codexStage = 'install'
    & npm.cmd install --prefix $vendorRoot --no-save --package-lock=false --no-audit --no-fund --registry=https://registry.npmjs.org "@openai/codex@$($metadata.version)" # zizmor: ignore[adhoc-packages] resolved vendor canary recorded below
    if ($LASTEXITCODE) { throw 'The official Codex npm installation failed.' }
    $codexStage = 'discovery'
    $binary = @(Get-ChildItem (Join-Path $vendorRoot 'node_modules') -Filter codex.exe -File -Recurse)
    if ($binary.Count -ne 1) { throw 'Expected exactly one official native codex.exe.' }
    $codexStage = 'architecture'
    $codexArchitecture = [ReachAcceptanceArchitecture]::FileArchitecture($binary[0].FullName)
    if ($codexArchitecture.peMachine -ne $nativeArchitecture) { throw 'The official Codex package does not match the actual Windows CPU.' }
    $report.codex = [ordered]@{
        status = 'PASS'; package = '@openai/codex'; version = $metadata.version
        registry = 'https://registry.npmjs.org'; integrity = $metadata.'dist.integrity'
        tarball = $metadata.'dist.tarball'; executable = $binary[0].FullName
        sha256 = (Get-FileHash -LiteralPath $binary[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        architecture = $codexArchitecture
    }
    (Join-Path $vendorRoot 'node_modules\.bin') | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
} catch {
    # Do not serialize an arbitrary vendor exception/command line into artifacts.
    $report.codex = [ordered]@{ status = 'FAIL'; stage = $codexStage; expectedArchitecture = $nativeArchitecture; architecture = $codexArchitecture; reason = 'Official Codex installation did not complete; see the vendor installation step.' }
    Write-Warning 'Official Codex installation failed.'
}
$tailscaleStage = 'download'
try {
    # Official MSI and supported silent properties:
    # https://tailscale.com/kb/1189/install-windows-msi
    # This fixed stable release is intentionally separate from Codex's canary.
    # MSI packages must match the native OS CPU, not the current shell's
    # emulated architecture: https://pkgs.tailscale.com/stable/
    $installerName = 'tailscale-setup-1.104.1-' + $msiArchitecture + '.msi'
    $url = 'https://pkgs.tailscale.com/stable/' + $installerName
    $msi = Join-Path $vendorRoot $installerName
    Invoke-WebRequest -Uri $url -OutFile $msi -TimeoutSec 180
    $tailscaleStage = 'installer-signature'
    $installerSignature = Assert-TailscaleSignature $msi
    $tailscaleStage = 'install'
    $installed = Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart', 'TS_NOLAUNCH=1', 'TS_INSTALLUPDATES=never') -Wait -PassThru
    if ($installed.ExitCode -notin @(0, 3010)) { throw "Tailscale MSI exit $($installed.ExitCode)" }
    $cli = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    $daemon = Join-Path $env:ProgramFiles 'Tailscale\tailscaled.exe'
    $tailscaleStage = 'binary-signatures-and-architecture'
    $cliSignature = Assert-TailscaleSignature $cli
    $daemonSignature = Assert-TailscaleSignature $daemon
    $cliArchitecture = [ReachAcceptanceArchitecture]::FileArchitecture($cli)
    $daemonArchitecture = [ReachAcceptanceArchitecture]::FileArchitecture($daemon)
    if ($cliArchitecture.peMachine -ne $nativeArchitecture -or $daemonArchitecture.peMachine -ne $nativeArchitecture) {
        throw 'The signed Tailscale binaries do not match the actual Windows CPU.'
    }
    $tailscaleStage = 'actual-service'
    Start-Service -Name Tailscale
    $service = Get-Service -Name Tailscale
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    $serviceProcess = Get-CimInstance Win32_Service -Filter "Name = 'Tailscale'"
    $serviceArchitecture = [ReachAcceptanceArchitecture]::Inspect([int]$serviceProcess.ProcessId)
    if ($serviceArchitecture.runtimeArchitecture -ne $nativeArchitecture -or $serviceArchitecture.emulated) {
        throw 'The actual Tailscale service must run natively on this CPU.'
    }
    $report.tailscale = [ordered]@{
        status = 'PASS'; source = $url; executable = $cli
        installer = $installerSignature; cli = $cliSignature; daemon = $daemonSignature
        architecture = [ordered]@{ msi = $msiArchitecture; cli = $cliArchitecture; daemon = $daemonArchitecture; serviceProcess = $serviceArchitecture }
        service = $service.Name; serviceStatus = [string]$service.Status
        restartRequested = ($installed.ExitCode -eq 3010)
        authenticated = $false; enrollmentAttempted = $false
    }
} catch {
    $report.tailscale = [ordered]@{ status = 'FAIL'; stage = $tailscaleStage; expectedArchitecture = $nativeArchitecture; reason = 'Signed official Tailscale installation/service did not complete; see the vendor installation step.' }
    Write-Warning 'Official Tailscale installation/service failed.'
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $reportDir 'vendors.json') -Encoding utf8
if ($report.codex.status -ne 'PASS' -or $report.tailscale.status -ne 'PASS') { exit 1 }
