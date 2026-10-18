$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'This installs machine software only on a disposable GitHub-hosted Windows runner.'
}
$reportDir = Join-Path $env:GITHUB_WORKSPACE 'reports\real-windows-acceptance'
$vendorRoot = Join-Path $env:RUNNER_TEMP 'reach-real-windows-vendors'
New-Item -ItemType Directory -Force $reportDir, $vendorRoot | Out-Null
$report = [ordered]@{ codex = $null; tailscale = $null }
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
try {
    # https://learn.chatgpt.com/docs/codex/cli documents @openai/codex.
    # Resolve latest once, then install that exact release from the npm registry.
    $metadataText = & npm.cmd view '@openai/codex@latest' version dist.integrity dist.tarball --json --registry=https://registry.npmjs.org
    if ($LASTEXITCODE) { throw 'npm could not resolve the official Codex release.' }
    $metadata = ($metadataText -join "`n") | ConvertFrom-Json
    if ($metadata.version -notmatch '^\d+\.\d+\.\d+([+-][\w.-]+)?$' -or $metadata.'dist.tarball' -notlike 'https://registry.npmjs.org/@openai/codex/*') {
        throw 'The official Codex package metadata was unexpected.'
    }
    & npm.cmd install --prefix $vendorRoot --no-save --package-lock=false --no-audit --no-fund --registry=https://registry.npmjs.org "@openai/codex@$($metadata.version)" # zizmor: ignore[adhoc-packages] resolved vendor canary recorded below
    if ($LASTEXITCODE) { throw 'The official Codex npm installation failed.' }
    $binary = @(Get-ChildItem (Join-Path $vendorRoot 'node_modules') -Filter codex.exe -File -Recurse)
    if ($binary.Count -ne 1) { throw 'Expected exactly one official native codex.exe.' }
    $report.codex = [ordered]@{
        status = 'PASS'; package = '@openai/codex'; version = $metadata.version
        registry = 'https://registry.npmjs.org'; integrity = $metadata.'dist.integrity'
        tarball = $metadata.'dist.tarball'; executable = $binary[0].FullName
        sha256 = (Get-FileHash -LiteralPath $binary[0].FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }
    (Join-Path $vendorRoot 'node_modules\.bin') | Out-File -FilePath $env:GITHUB_PATH -Append -Encoding utf8
} catch {
    # Do not serialize an arbitrary vendor exception/command line into artifacts.
    $report.codex = [ordered]@{ status = 'FAIL'; reason = 'Official Codex installation did not complete; see the vendor installation step.' }
    Write-Warning 'Official Codex installation failed.'
}
try {
    # Official MSI and supported silent properties:
    # https://tailscale.com/kb/1189/install-windows-msi
    # This fixed stable release is intentionally separate from Codex's canary.
    $url = 'https://pkgs.tailscale.com/stable/tailscale-setup-1.104.1-amd64.msi'
    $msi = Join-Path $vendorRoot 'tailscale-setup-1.104.1-amd64.msi'
    Invoke-WebRequest -Uri $url -OutFile $msi -TimeoutSec 180
    $installerSignature = Assert-TailscaleSignature $msi
    $installed = Start-Process msiexec.exe -ArgumentList @('/i', ('"' + $msi + '"'), '/qn', '/norestart', 'TS_NOLAUNCH=1', 'TS_INSTALLUPDATES=never') -Wait -PassThru
    if ($installed.ExitCode -notin @(0, 3010)) { throw "Tailscale MSI exit $($installed.ExitCode)" }
    $cli = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
    $daemon = Join-Path $env:ProgramFiles 'Tailscale\tailscaled.exe'
    $cliSignature = Assert-TailscaleSignature $cli
    $daemonSignature = Assert-TailscaleSignature $daemon
    Start-Service -Name Tailscale
    $service = Get-Service -Name Tailscale
    $service.WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
    $report.tailscale = [ordered]@{
        status = 'PASS'; source = $url; executable = $cli
        installer = $installerSignature; cli = $cliSignature; daemon = $daemonSignature
        service = $service.Name; serviceStatus = [string]$service.Status
        restartRequested = ($installed.ExitCode -eq 3010)
        authenticated = $false; enrollmentAttempted = $false
    }
} catch {
    $report.tailscale = [ordered]@{ status = 'FAIL'; reason = 'Signed official Tailscale installation/service did not complete; see the vendor installation step.' }
    Write-Warning 'Official Tailscale installation/service failed.'
}
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $reportDir 'vendors.json') -Encoding utf8
if ($report.codex.status -ne 'PASS' -or $report.tailscale.status -ne 'PASS') { exit 1 }
