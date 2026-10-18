param(
    [Parameter(Mandatory=$true)][string]$RepoRoot,
    [Parameter(Mandatory=$true)][string]$NodeExecutable
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = (($env:PSModulePath -split ';') | Where-Object { $_ -and $_ -notmatch '\\PowerShell\\(\d+([.-][\w.-]+)?\\)?Modules\\?$' }) -join ';'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') {
    throw 'Only a disposable GitHub-hosted Windows runner may create this account and install these packages.'
}
$reportDir = Join-Path $RepoRoot 'reports\windows-upgrade-state'
$scratch = Join-Path $env:RUNNER_TEMP ('reach-upgrade-launcher-' + [Guid]::NewGuid().ToString('N'))
$account = 'reachup' + [Guid]::NewGuid().ToString('N').Substring(0, 10)
$sid = $null
$created = $false
$grants = @()
$resultCode = 1
$harness = [ordered]@{ status = 'FAIL'; stage = 'account-create'; execution = 'real standard Windows account, loaded default profile and private acceptance desktop'; accountCreated = $false; passwordPersisted = $false; cleanup = 'pending' }
New-Item -ItemType Directory -Force $reportDir, $scratch | Out-Null
function Grant-AcceptancePath([string]$target, [string]$rights) {
    & icacls.exe $target /grant ('*' + $script:sid + ':(OI)(CI)(' + $rights + ')') /T /Q | Out-Null
    if ($LASTEXITCODE) { throw 'An acceptance path grant failed.' }
    $script:grants += $target
}
try {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    $accountPassword = [Convert]::ToBase64String($bytes) + 'Aa1!'
    [Array]::Clear($bytes, 0, $bytes.Length)
    $securePassword = ConvertTo-SecureString $accountPassword -AsPlainText -Force
    $localAccount = New-LocalUser -Name $account -Password $securePassword -AccountNeverExpires -UserMayNotChangePassword -Description 'Disposable Reach upgrade acceptance account'
    $created = $true
    $sid = $localAccount.SID.Value
    if (-not @(Get-LocalGroupMember -SID 'S-1-5-32-545' | Where-Object { $_.SID.Value -eq $sid }).Count) { Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $localAccount }
    if (@(Get-LocalGroupMember -SID 'S-1-5-32-544' | Where-Object { $_.SID.Value -eq $sid }).Count) { throw 'The disposable account unexpectedly belongs to Administrators.' }
    $harness.accountCreated = $true
    $harness.userSid = $sid
    $harness.administratorMembership = $false
    $harness.stage = 'path-permissions'
    Grant-AcceptancePath $RepoRoot 'RX'
    Grant-AcceptancePath $reportDir 'M'
    Grant-AcceptancePath $scratch 'RX'
    $nodeDir = Split-Path $NodeExecutable -Parent
    $npm = Join-Path $nodeDir 'npm.cmd'
    $script = Join-Path $scratch 'run-worker.cmd'
    foreach ($value in @($RepoRoot, $NodeExecutable, $reportDir, $scratch, $env:USERPROFILE)) {
        if ($value -match '[%"\r\n]') { throw 'An acceptance path has unsupported cmd metacharacters.' }
    }
    if ($env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$' -or $env:GITHUB_RUN_ID -notmatch '^\d+$') { throw 'Explicit workflow source/run metadata are required.' }
    # CreateProcessWithLogonW(LOGON_WITH_PROFILE), null environment: genuine
    # target-user default environment. Only safe task metadata and executable
    # PATH are added here. No profile/state override or credential is serialized.
    @(
        '@echo off',
        ('set "PATH=' + $nodeDir + ';%PATH%"'),
        'set "GITHUB_ACTIONS=true"',
        'set "RUNNER_ENVIRONMENT=github-hosted"',
        'set "RUNNER_OS=Windows"',
        ('set "GITHUB_SHA=' + $env:GITHUB_SHA + '"'),
        ('set "GITHUB_RUN_ID=' + $env:GITHUB_RUN_ID + '"'),
        'set "REACH_ACCEPTANCE_UPGRADE_WORKER=1"',
        ('set "REACH_ACCEPTANCE_EXPECTED_SID=' + $sid + '"'),
        ('set "REACH_ACCEPTANCE_RUNNER_PROFILE=' + $env:USERPROFILE + '"'),
        ('call "' + $npm + '" run test:file -- --test-timeout=900000 --test-concurrency=1 test/acceptance/windows-upgrade-state.test.mjs'),
        'exit /b %errorlevel%'
    ) -join "`r`n" | Set-Content -LiteralPath $script -Encoding ascii
    Add-Type -Path (Join-Path $PSScriptRoot 'standard-user-process.cs')
    $application = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $command = '"' + $application + '" /d /s /c ""' + $script + '""'
    $harness.stage = 'credential-process-launch-and-wait'
    $started = [ReachAcceptanceUserProcess]::Run($account, $accountPassword, $sid, $application, $command, $RepoRoot, 930000)
    $harness.workerProcessId = $started.ProcessId
    $harness.desktop = $started.Desktop
    $harness.workerExitCode = $started.ExitCode
    $resultCode = $started.ExitCode
    $harness.status = 'PASS'
    $harness.stage = 'worker-finished'
    $harness.workerOutcome = if ($resultCode -eq 0) { 'PASS' } else { 'FAIL' }
} catch {
    $harness.reason = 'The real account/profile/process harness failed; inspect the separate upgrade report when present. Credential details are never retained.'
    $harness.errorType = $_.Exception.GetType().Name
    $harness.win32Error = $_.Exception.InnerException.NativeErrorCode
    $resultCode = 1
} finally {
    $accountPassword = $null
    if ($null -ne $securePassword) { $securePassword.Dispose() }
    $cleanupFailed = $false
    if ($sid) {
        try {
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
        try {
            # Only this generated account's real profile is disposable. Never
            # infer a profile path from caller-controlled environment variables.
            $unloadDeadline = [DateTime]::UtcNow.AddSeconds(30)
            do {
                $profile = Get-CimInstance Win32_UserProfile -Filter ("SID='" + $sid + "'")
                if (-not $profile -or -not $profile.Loaded) { break }
                Start-Sleep -Milliseconds 500
            } while ([DateTime]::UtcNow -lt $unloadDeadline)
            if ($profile) {
                if ($profile.Loaded) { throw 'The disposable profile remained loaded.' }
                $profile | Remove-CimInstance
            }
        } catch { $cleanupFailed = $true }
    }
    if ($created) { try { Remove-LocalUser -Name $account } catch { $cleanupFailed = $true } }
    try { Remove-Item -LiteralPath $scratch -Recurse -Force } catch { $cleanupFailed = $true }
    if ($cleanupFailed) {
        $harness.cleanup = 'FAIL'; $harness.status = 'FAIL'; $resultCode = 1
        $harness.cleanupReason = 'The owned disposable processes/account/profile/path grants did not all clean up.'
    } else { $harness.cleanup = 'PASS' }
    $harness | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $reportDir 'harness.json') -Encoding utf8
}
exit $resultCode
