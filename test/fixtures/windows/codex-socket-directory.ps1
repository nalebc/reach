param(
    [Parameter(Mandatory=$true)][string]$Target,
    [Parameter(Mandatory=$true)][string]$Sid,
    [Parameter(Mandatory=$true)][ValidateSet('private', 'broad', 'unprotected', 'noninheritable', 'readonly')][string]$Mode
)
$ErrorActionPreference = 'Stop'
# Controlled disposable-directory ACLs only. No Codex or owner directory is
# passed to this fixture. Production validation never changes a daemon ACL.
$identity = New-Object Security.Principal.SecurityIdentifier($Sid)
$descriptor = New-Object Security.AccessControl.DirectorySecurity
$descriptor.SetOwner($identity)
$descriptor.SetAccessRuleProtection(($Mode -ne 'unprotected'), $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
if ($Mode -eq 'noninheritable') { $inheritance = [Security.AccessControl.InheritanceFlags]::None }
$rights = [Security.AccessControl.FileSystemRights]::FullControl
if ($Mode -eq 'readonly') { $rights = [Security.AccessControl.FileSystemRights]::ReadAndExecute }
$rule = New-Object Security.AccessControl.FileSystemAccessRule($identity, $rights, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
$descriptor.AddAccessRule($rule)
if ($Mode -eq 'broad') {
    $everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
    $descriptor.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($everyone, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
}
[IO.Directory]::SetAccessControl($Target, $descriptor)
