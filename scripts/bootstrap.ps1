$ErrorActionPreference = 'Stop'
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
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
    throw 'The automatic Windows installer currently supports x64. Install Node.js 22+ and rerun on other architectures.'
}
$version = '22.23.3'
$cache = Join-Path $root '.reach\runtime'
$runtime = Join-Path $cache "node-v$version-win-x64"
$exe = Join-Path $runtime 'node.exe'
if (-not (Test-Path $exe)) {
    $stage = Join-Path $cache ([Guid]::NewGuid().ToString())
    New-Item -ItemType Directory -Force $stage | Out-Null
    try {
        Write-Host 'Reach: preparing a private Node.js runtime (first run only)…'
        $archive = Join-Path $stage 'node.zip'
        [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
        Invoke-WebRequest "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip" -OutFile $archive -UseBasicParsing
        if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71') {
            throw 'Node.js checksum mismatch; stopping.'
        }
        Expand-Archive $archive $stage
        Move-Item (Join-Path $stage "node-v$version-win-x64") $runtime
    } finally { Remove-Item -Recurse -Force $stage }
}
$env:PATH = "$runtime;$env:PATH"
& $exe $entry @args
exit $LASTEXITCODE
