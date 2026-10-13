$ErrorActionPreference = 'Stop'
# Started from a PowerShell 7 window, this Windows PowerShell inherits 7's
# module folders and can't load its own commands from them: dropped first,
# before any command loads (server/powershell.mjs does the same for Reach).
$env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\(\d+([.-][\w.-]+)?\\)?Modules\\?$' }) -join ';'
$root = Split-Path $PSScriptRoot -Parent
# Through bin\reach.mjs: Reach itself starts again in this window when it
# stopped by itself (scripts\supervise.mjs); other commands run once.
$entry = Join-Path $root 'bin\reach.mjs'
$node = Get-Command node -ErrorAction SilentlyContinue
$npm = Get-Command npm -ErrorAction SilentlyContinue
if ($node -and $npm) {
    & $node.Source -e 'process.exit(parseInt(process.versions.node)>=22?0:1)'
    if ($LASTEXITCODE -eq 0) {
        & $node.Source $entry @args
        exit $LASTEXITCODE
    }
}
# This PC's own architecture, also from a 32-bit or emulated PowerShell.
$arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
# Node.js's own builds and their published SHA-256 (nodejs.org SHASUMS256.txt).
$builds = @{
    'AMD64' = @('win-x64', '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71')
    'ARM64' = @('win-arm64', '33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535')
}
if (-not [Environment]::Is64BitOperatingSystem -or -not $builds.ContainsKey($arch)) {
    [Console]::Error.WriteLine("Reach sets itself up on 64-bit Windows (x64 or ARM64); this PC is $arch. Install Node.js 22 or newer from https://nodejs.org, then run .\reach.cmd again.")
    exit 1
}
$target, $sha = $builds[$arch]
$version = '22.23.3'
$cache = Join-Path $root '.reach\runtime'
$runtime = Join-Path $cache "node-v$version-$target"
$exe = Join-Path $runtime 'node.exe'
if (-not (Test-Path $exe)) {
    $stage = Join-Path $cache ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force $stage | Out-Null
    try {
        Write-Host 'Reach: preparing a private Node.js runtime (first run only)…'
        $archive = Join-Path $stage 'node.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        # Windows PowerShell's progress bar slows its own download many times over.
        $ProgressPreference = 'SilentlyContinue'
        $got = $false
        foreach ($try in 1..3) {
            try {
                Invoke-WebRequest "https://nodejs.org/dist/v$version/node-v$version-$target.zip" -OutFile $archive -UseBasicParsing -TimeoutSec 300
                $got = $true
                break
            } catch { if ($try -lt 3) { Start-Sleep -Seconds (5 * $try) } }
        }
        if (-not $got) {
            [Console]::Error.WriteLine("Reach couldn't download Node.js (no internet here?). Connect, then run .\reach.cmd again; or install Node.js 22 or newer from https://nodejs.org.")
            exit 1
        }
        if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $sha) {
            throw 'Node.js checksum mismatch; stopping.'
        }
        Expand-Archive $archive $stage
        Move-Item (Join-Path $stage "node-v$version-$target") $runtime
    } finally { Remove-Item -Recurse -Force $stage }
}
$env:PATH = "$runtime;$env:PATH"
& $exe $entry @args
exit $LASTEXITCODE
