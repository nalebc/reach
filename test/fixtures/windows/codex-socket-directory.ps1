param(
    [Parameter(Mandatory=$true)][string]$FixtureRoot,
    [Parameter(Mandatory=$true)][string]$Sid
)
$ErrorActionPreference = 'Stop'
# Controlled disposable-directory ACLs only. No Codex or owner directory is
# passed to this fixture. Production validation never changes a daemon ACL.
# One Windows PowerShell launch prepares every case, with explicit phase
# markers so a timeout distinguishes process startup from a filesystem call.
[Console]::Error.WriteLine('reach-codex-acl-fixture started')
$elapsed = [Diagnostics.Stopwatch]::StartNew()
$directories = [ordered]@{}
foreach ($name in @('broad', 'unprotected', 'noninheritable', 'readonly', 'private', 'valid')) {
    $mode = $name
    if ($mode -eq 'valid') { $mode = 'private' }
    [Console]::Error.WriteLine('reach-codex-acl-fixture preparing ' + $name)
    $target = [IO.Path]::Combine($FixtureRoot, $name)
    if (-not [IO.Directory]::Exists($target)) { throw 'A disposable fixture directory is missing.' }
    $identity = New-Object Security.Principal.SecurityIdentifier($Sid)
    $descriptor = New-Object Security.AccessControl.DirectorySecurity
    $descriptor.SetOwner($identity)
    $descriptor.SetAccessRuleProtection(($mode -ne 'unprotected'), $false)
    $inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
    if ($mode -eq 'noninheritable') { $inheritance = [Security.AccessControl.InheritanceFlags]::None }
    $rights = [Security.AccessControl.FileSystemRights]::FullControl
    if ($mode -eq 'readonly') { $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
    $descriptor.AddAccessRule($rule)
    if ($mode -eq 'broad') {
        $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
        $descriptor.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
    }
    [IO.Directory]::SetAccessControl($target, $descriptor)
    $readBack = [IO.Directory]::GetAccessControl($target)
    $directories[$name] = [ordered]@{
        mode = $mode
        owner = $readBack.GetOwner([Security.Principal.SecurityIdentifier]).Value
        protected = $readBack.AreAccessRulesProtected
        sddl = $readBack.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]'Owner, Access')
    }
    [Console]::Error.WriteLine('reach-codex-acl-fixture prepared ' + $name)
}
$elapsed.Stop()
[ordered]@{ schema = 1; elapsedMs = $elapsed.ElapsedMilliseconds; directories = $directories } | ConvertTo-Json -Depth 5 -Compress
