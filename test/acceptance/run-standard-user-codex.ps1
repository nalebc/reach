param(
    [Parameter(Mandatory=$true)][string]$RepoRoot,
    [Parameter(Mandatory=$true)][string]$NodeExecutable
)
$ErrorActionPreference = 'Stop'
# The elevated workflow shell is PowerShell 7; this instrumentation runs in
# Windows PowerShell and must load that edition's real local-account module.
$env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\(\d+([.-][\w.-]+)?\\)?Modules\\?$' }) -join ';'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'A real disposable GitHub-hosted Windows runner is required.'
}
# Microsoft credential/profile API reference:
# https://learn.microsoft.com/windows/win32/api/winbase/nf-winbase-createprocesswithlogonw
# New-LocalUser creates a real local account; no restricted/fabricated token is used.
$reportDir = Join-Path $RepoRoot 'reports\real-windows-acceptance'
$vendorRoot = Join-Path $env:RUNNER_TEMP 'reach-real-windows-vendors'
$scratch = Join-Path $env:RUNNER_TEMP ('reach-standard-codex-' + [Guid]::NewGuid().ToString('N'))
$account = 'reachcx' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$sid = $null
$created = $false
$grants = @()
$resultCode = 1
$harness = [ordered]@{ status = 'FAIL'; stage = 'account-create'; execution = 'real disposable standard local Windows account'; accountCreated = $false; profileLoadRequested = $true; passwordPersisted = $false; cleanup = 'pending' }
New-Item -ItemType Directory -Force $reportDir, $scratch | Out-Null
function Grant-AcceptancePath([string]$target, [string]$rights) {
    # Only the generated account SID receives these explicit grants.
    & icacls.exe $target /grant ('*' + $script:sid + ':(OI)(CI)(' + $rights + ')') /T /Q | Out-Null
    if ($LASTEXITCODE) { throw 'An acceptance path could not be granted to the disposable account.' }
    $script:grants += $target
}
try {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $accountPassword = [Convert]::ToBase64String($bytes) + 'Aa1!'
    [Array]::Clear($bytes, 0, $bytes.Length)
    $securePassword = ConvertTo-SecureString $accountPassword -AsPlainText -Force
    $localAccount = New-LocalUser -Name $account -Password $securePassword -AccountNeverExpires -UserMayNotChangePassword -Description 'Disposable Reach Codex acceptance account'
    $created = $true
    $sid = $localAccount.SID.Value
    if (-not @(Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object { $_.SID.Value -eq $sid }).Count) {
        Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $localAccount
    }
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }).Count) { throw 'The disposable account unexpectedly belongs to Administrators.' }
    $harness.accountCreated = $true
    $harness.userSid = $sid
    $harness.administratorMembership = $false
    $harness.stage = 'path-permissions'
    Grant-AcceptancePath $RepoRoot 'RX'
    Grant-AcceptancePath $vendorRoot 'RX'
    Grant-AcceptancePath $reportDir 'M'
    Grant-AcceptancePath $scratch 'M'
    $nodeDir = Split-Path $NodeExecutable -Parent
    $npm = Join-Path $nodeDir 'npm.cmd'
    $script = Join-Path $scratch 'run-worker.cmd'
    # No password, owner credentials, HOME/CODEX_HOME override or inherited
    # runner environment goes into this script or the credential API's env.
    $lines = @(
        '@echo off',
        ('set "PATH=' + (Join-Path $vendorRoot 'node_modules\.bin') + ';' + $nodeDir + ';%PATH%"'),
        'set "REACH_REAL_WINDOWS_CODEX_ACCEPTANCE=1"',
        ('set "REACH_ACCEPTANCE_EXPECTED_SID=' + $sid + '"'),
        ('set "REACH_ACCEPTANCE_CODEX_REPORT=' + (Join-Path $reportDir 'codex-standard-user.json') + '"'),
        ('set "REACH_ACCEPTANCE_VENDOR_REPORT=' + (Join-Path $reportDir 'vendors.json') + '"'),
        ('set "REACH_ACCEPTANCE_CHECKOUT_COMMIT=' + $env:GITHUB_SHA + '"'),
        ('set "REACH_ACCEPTANCE_PR_HEAD=' + $env:REACH_ACCEPTANCE_PR_HEAD + '"'),
        ('set "REACH_ACCEPTANCE_RUNNER_PROFILE=' + $env:USERPROFILE + '"'),
        ('call "' + $npm + '" run test:file -- --test-timeout=180000 --test-concurrency=1 test/acceptance/codex-standard-user.test.mjs'),
        'exit /b %errorlevel%'
    )
    foreach ($value in @($RepoRoot, $NodeExecutable, $vendorRoot, $reportDir, $scratch, $env:USERPROFILE)) {
        if ($value -match '[%"\r\n]') { throw 'An acceptance path has unsupported cmd metacharacters.' }
    }
    if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$' -or $env:REACH_ACCEPTANCE_PR_HEAD -notmatch '^[a-f0-9]{40}$') { throw 'Expected explicit checkout and PR-head commit hashes.' }
    $lines -join "`r`n" | Set-Content -LiteralPath $script -Encoding ascii
    Add-Type -Path (Join-Path $PSScriptRoot 'standard-user-process.cs')
    $application = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $command = '"' + $application + '" /d /s /c ""' + $script + '""'
    $harness.stage = 'credential-process-launch-and-wait'
    $started = [ReachAcceptanceUserProcess]::Run($account, $accountPassword, $sid, $application, $command, $RepoRoot, 210000)
    $harness.workerProcessId = $started.ProcessId
    $harness.desktop = $started.Desktop
    $harness.workerExitCode = $started.ExitCode
    $resultCode = $started.ExitCode
    # Successful account/process setup is distinct from the actual Codex
    # compatibility outcome. A failed worker still exits this script nonzero.
    $harness.status = 'PASS'
    $harness.stage = 'worker-finished'
    $harness.workerOutcome = if ($resultCode -eq 0) { 'PASS' } else { 'FAIL' }
} catch {
    # Arbitrary credential-API exceptions never enter an artifact or console.
    $harness.reason = 'The real standard-user harness or worker failed. Inspect the worker report when present; no credential details are retained.'
    $harness.errorType = $_.Exception.GetType().Name
    $harness.win32Error = $_.Exception.InnerException.NativeErrorCode
    $resultCode = 1
} finally {
    $accountPassword = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    $cleanupFailed = $false
    if ($sid) {
        try {
            # The new account owns no pre-existing process. End only processes
            # whose actual Windows owner SID is this exact disposable identity.
            foreach ($process in Get-CimInstance Win32_Process) {
                try {
                    $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
                    if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $sid) { Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop }
                } catch { }
            }
        } catch { $cleanupFailed = $true }
        foreach ($target in $grants) {
            try {
                & icacls.exe $target /remove:g ('*' + $sid) /T /Q | Out-Null
                if ($LASTEXITCODE) { throw 'An acceptance path grant could not be removed.' }
            } catch { $cleanupFailed = $true }
        }
    }
    if ($created) { try { Remove-LocalUser -Name $account } catch { $cleanupFailed = $true } }
    try { Remove-Item -LiteralPath $scratch -Recurse -Force } catch { $cleanupFailed = $true }
    if ($cleanupFailed) {
        $harness.cleanup = 'FAIL'
        $harness.status = 'FAIL'
        $harness.cleanupReason = 'The disposable standard-user resources did not completely clean up.'
        $resultCode = 1
    } else { $harness.cleanup = 'PASS' }
    $harness | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $reportDir 'codex-standard-user-harness.json') -Encoding utf8
}
exit $resultCode
