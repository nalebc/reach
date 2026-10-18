$ErrorActionPreference = 'Stop'
$reportDir = Join-Path $env:GITHUB_WORKSPACE 'reports\real-windows-acceptance'
New-Item -ItemType Directory -Force $reportDir | Out-Null
if (-not (Test-Path (Join-Path $reportDir 'acceptance.json'))) {
  $report = @{ overall = 'FAIL'; fullDeviceQualification = $false; qualification = 'INCOMPLETE: real Windows probes did not reach their reporter'; cases = @(
    @{ id = 'windows-probe-prerequisites'; status = 'FAIL'; reason = 'Inspect the installation/build/test steps.' },
    @{ id = 'private-tailscale-funnel-and-recovery'; status = 'BLOCKED'; reason = 'Approved real Tailscale identities and credentials are absent; no enrollment attempted.' },
    @{ id = 'provider-inference'; status = 'BLOCKED'; reason = 'No signed-in provider account.' },
    @{ id = 'physical-iphone-ipad-android'; status = 'BLOCKED'; reason = 'No authorized physical clients.' }
  ) }
  $report | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $reportDir 'acceptance.json')
  '## Real Windows acceptance: FAIL' | Out-File $env:GITHUB_STEP_SUMMARY -Append
  '**Overall real-device qualification is incomplete.** Windows probes did not complete. Authenticated Tailscale/Funnel/recovery, provider inference, and physical iPhone/iPad/Android remain BLOCKED.' | Out-File $env:GITHUB_STEP_SUMMARY -Append
} elseif ($env:PROBE_OUTCOME -ne 'success' -or $env:NATIVE_SOCKET_OUTCOME -ne 'success') {
  $report = Get-Content (Join-Path $reportDir 'acceptance.json') -Raw | ConvertFrom-Json
  $report.overall = 'FAIL'
  foreach ($case in $report.cases) {
    if ($case.status -eq 'RUNNING') { $case.status = 'FAIL' }
  }
  $report | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $reportDir 'acceptance.json')
  'A Windows native-security or acceptance probe failed or was interrupted. The acceptance artifact is marked FAIL; overall real-device qualification remains incomplete.' | Out-File $env:GITHUB_STEP_SUMMARY -Append
}
$report = Get-Content (Join-Path $reportDir 'acceptance.json') -Raw | ConvertFrom-Json
$nativeStatus = if ($env:NATIVE_SOCKET_OUTCOME -eq 'success') { 'PASS' } else { 'FAIL' }
$nativeEvidence = if ($nativeStatus -eq 'PASS') {
  'All six actual native NTFS ACL/junction assertions passed; see the dedicated step. Connected-peer success is the separate real Codex case.'
} else {
  'Native security step failed or was interrupted. See the dedicated step for actual setup, assertion and cleanup results.'
}
$report.cases = @($report.cases) + @(@{ id = 'real-windows-socket-directory-security'; status = $nativeStatus; evidence = $nativeEvidence })
$report | ConvertTo-Json -Depth 20 | Set-Content (Join-Path $reportDir 'acceptance.json')
@(
  ('## Final Windows acceptance: ' + $report.overall),
  '',
  'This final result includes the separate native security step. Full device qualification remains incomplete.',
  '',
  '| Case | Result | Evidence |',
  '| --- | --- | --- |',
  ('| Native socket directory security | ' + $nativeStatus + ' | ' + $nativeEvidence + ' |'),
  '| Authenticated Tailscale/recovery and physical clients | BLOCKED | Required identities and devices are unavailable. |'
) | Out-File $env:GITHUB_STEP_SUMMARY -Append
