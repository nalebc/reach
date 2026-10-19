import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { windowsPath } from "./app-identity.mjs";

const exec = promisify(execFile);
const ACCOUNT = /^S-1-5-21-\d+-\d+-\d+-\d+$/;
const refuse = (stage = { phase: "validate", reason: "input" }) => Object.assign(Error("Reach couldn't prepare a private helper folder on this Windows PC."), { code: "EPRIVATESTAGE", stage });
const PHASES = "token|leaf|parent|path|volume|ancestors|descriptor-build|container|stage-create|stage-check|ancestor-recheck|output";
const REASONS = "account|leaf|path|reparse|descriptor|owner|ancestor-access|stage-acl|profile|volume|depth|exists|not-empty|changed|exception";
const diagnostic = new RegExp(`^reach-private-stage-refused (${PHASES}) (${REASONS}) ([A-Za-z][A-Za-z0-9_.-]{0,119}) ([A-Za-z][A-Za-z0-9_.-]{0,119}) ([A-Za-z][A-Za-z0-9_.-]{0,119}) ([0-9]{1,5})$`, "m");
function commandRefusal(error) {
  const match = diagnostic.exec(String(error?.stderr || ""));
  if (match) return refuse({ phase: match[1], reason: match[2], exception: match[3], innerException: match[4], id: match[5], line: Number(match[6]) });
  const reason = ["ABORT_ERR", "ETIMEDOUT", "ENOENT", "EACCES", "EPERM"].includes(error?.code) ? error.code : "unknown";
  return refuse({ phase: "command", reason });
}

// No script file, execution-policy change, Add-Type or compilation is needed
// to establish the first private build directory. In particular, neither an
// EXE nor a digest from Reach's previously writable state establishes trust.
// Only data travels through the overwritten child environment, never source.
// Named ACL/attribute reads are used only to establish an immutable ancestor
// chain; the later native repair must retain handles for mutable state.
const bootstrap = String.raw`
$ErrorActionPreference = 'Stop'
$PSModuleAutoLoadingPreference = 'None'
Set-StrictMode -Version 2.0
$phase = 'token'
try {
  $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($account -notmatch '\AS-1-5-21-\d+-\d+-\d+-\d+\z' -or $account -cne $env:REACH_PRIVATE_STAGE_SID) { throw 'account' }
  $phase = 'leaf'
  $leaf = $env:REACH_PRIVATE_STAGE_LEAF
  if ($leaf -cnotmatch '\Areach-private-stage-[0-9a-f]{32}\z') { throw 'leaf' }
  $phase = 'parent'
  $stageParent = $env:REACH_PRIVATE_STAGE_PARENT
  $defaultParent = [string]::IsNullOrEmpty($stageParent)
  if ($defaultParent) {
    $stageParent = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  }
  $trusted = @{}
  foreach ($value in @($account, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')) { $trusted[$value] = $true }

  function AssertLocalPath([string]$value) {
    if ([string]::IsNullOrEmpty($value) -or $value.Length -gt 4096 -or $value -notmatch '\A[A-Za-z]:\\' -or $value -match '[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]') { throw 'path' }
    if ($value.Substring(2) -match '[/<>:"|?*]' -or [IO.Path]::GetFullPath($value) -cne $value) { throw 'path' }
    if ($value.Length -eq 3) { return }
    foreach ($part in $value.Substring(3).Split([char]92)) {
      if ([string]::IsNullOrEmpty($part) -or $part -eq '.' -or $part -eq '..' -or $part -match '\A\s|[. ]\z|~\d') { throw 'path' }
      if ($part -match '\A(?i:con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3]|conin\$|conout\$)(?:\.|\z)') { throw 'path' }
      for ($i = 0; $i -lt $part.Length; $i++) {
        if ([char]::IsHighSurrogate($part[$i])) {
          if ($i + 1 -ge $part.Length -or -not [char]::IsLowSurrogate($part[$i + 1])) { throw 'path' }
          $i++
        } elseif ([char]::IsLowSurrogate($part[$i])) { throw 'path' }
      }
    }
  }
  function Descriptor([string]$folder) {
    $attributes = [IO.File]::GetAttributes($folder)
    if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    $security = [IO.Directory]::GetAccessControl($folder, ([System.Security.AccessControl.AccessControlSections]::Access -bor [System.Security.AccessControl.AccessControlSections]::Owner))
    $bytes = $security.GetSecurityDescriptorBinaryForm()
    $raw = [System.Security.AccessControl.RawSecurityDescriptor]::new($bytes, 0)
    if ($null -eq $raw.Owner -or $null -eq $raw.DiscretionaryAcl -or ($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclPresent) -eq 0) { throw 'descriptor' }
    if (-not $trusted.ContainsKey($raw.Owner.Value)) { throw 'owner' }
    # A second attribute read rejects ordinary replacement during the query.
    # An already granted hostile handle is not revoked by ACL normalization.
    $again = [IO.File]::GetAttributes($folder)
    if (($again -band [IO.FileAttributes]::Directory) -eq 0 -or ($again -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse' }
    return $raw
  }
  function AssertAncestor([string]$folder, [bool]$last) {
    $raw = Descriptor $folder
    foreach ($ace in $raw.DiscretionaryAcl) {
      # Windows PowerShell 5's byte-backed enum bitwise operators can throw;
      # inspect the same exact flag masks as integers (224, InheritOnly=8).
      if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback -or (([int]$ace.AceFlags) -band 224) -ne 0) { throw 'descriptor' }
      if ($ace.AceQualifier -eq [System.Security.AccessControl.AceQualifier]::AccessDenied) { continue }
      if ($ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed) { throw 'descriptor' }
      if ((([int]$ace.AceFlags) -band 8) -ne 0) { continue }
      $who = $ace.SecurityIdentifier.Value
      if ($trusted.ContainsKey($who) -or $who -eq 'S-1-3-4') { continue }
      # READ/list/traverse and creation-only grants on a higher ancestor do
      # not let another account replace an existing checked child. DELETE
      # (child) and DELETE_CHILD (parent) must both be refused. The actual
      # staging parent also excludes creation rights for untrusted accounts.
      $mask = [long]$ace.AccessMask -band 4294967295
      $permitted = 1 -bor 8 -bor 32 -bor 128 -bor 131072 -bor 1048576 -bor 2147483648 -bor 536870912
      if (-not $last) { $permitted = $permitted -bor 2 -bor 4 }
      if (($mask -band (-bnot $permitted)) -ne 0) { throw 'ancestor-access' }
    }
    $snapshot = [byte[]]::new($raw.BinaryLength)
    $raw.GetBinaryForm($snapshot, 0)
    return [Convert]::ToBase64String($snapshot)
  }
  function AssertPrivateStage([string]$folder) {
    $raw = Descriptor $folder
    if ($raw.Owner.Value -cne $account -or ($raw.ControlFlags -band [System.Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or $raw.DiscretionaryAcl.Count -ne 3) { throw 'stage-acl' }
    $wanted = @{}
    foreach ($value in @($account, 'S-1-5-18', 'S-1-5-32-544')) { $wanted[$value] = $true }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [System.Security.AccessControl.CommonAce] -or $ace.IsCallback -or $ace.AceQualifier -ne [System.Security.AccessControl.AceQualifier]::AccessAllowed -or [int]$ace.AceFlags -ne 3 -or $ace.AccessMask -ne 2032127) { throw 'stage-acl' }
      $who = $ace.SecurityIdentifier.Value
      if (-not $wanted.ContainsKey($who)) { throw 'stage-acl' }
      $wanted.Remove($who)
    }
    if ($wanted.Count -ne 0) { throw 'stage-acl' }
  }

  $phase = 'path'
  AssertLocalPath $stageParent
  if ($stageParent.Length -le 3) { throw 'profile' }
  $phase = 'volume'
  $driveRoot = [IO.Path]::GetPathRoot($stageParent)
  $drive = [IO.DriveInfo]::new($driveRoot)
  if ($drive.DriveType -ne [IO.DriveType]::Fixed -or $drive.DriveFormat -cne 'NTFS') { throw 'volume' }
  $chain = [System.Collections.Generic.List[string]]::new()
  $chain.Add($driveRoot)
  $current = $driveRoot
  foreach ($part in $stageParent.Substring($driveRoot.Length).Split([char]92)) {
    $current = [IO.Path]::Combine($current, $part)
    $chain.Add($current)
    if ($chain.Count -gt 128) { throw 'depth' }
  }
  $phase = 'ancestors'
  $before = @{}
  foreach ($component in $chain) { $before[$component] = AssertAncestor $component ($component -ceq $stageParent) }
  $phase = 'descriptor-build'
  $private = [System.Security.AccessControl.DirectorySecurity]::new()
  $private.SetOwner([System.Security.Principal.SecurityIdentifier]::new($account))
  $private.SetAccessRuleProtection($true, $false)
  $children = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
  foreach ($value in @($account, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = [System.Security.Principal.SecurityIdentifier]::new($value)
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($identity, [System.Security.AccessControl.FileSystemRights]::FullControl, $children, [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $private.AddAccessRule($rule)
  }
  if ($defaultParent) {
    $phase = 'container'
    # A static reserved container lets every restricted Reach job protect
    # stages belonging to other hook processes as well as its own launch.
    # Never normalize an existing container or trust creation as freshness.
    $container = [IO.Path]::Combine($stageParent, 'Reach')
    AssertLocalPath $container
    if (-not [IO.Directory]::Exists($container) -and -not [IO.File]::Exists($container)) {
      [void][IO.Directory]::CreateDirectory($container, $private)
      AssertPrivateStage $container
    }
    $before[$container] = AssertAncestor $container $true
    $chain.Add($container)
    $stageParent = $container
  }
  $phase = 'stage-create'
  $stage = [IO.Path]::Combine($stageParent, $leaf)
  AssertLocalPath $stage
  # CreateDirectory returns an existing directory too. Do not rely on its
  # success as proof of freshness, or ever reuse an old directory/cache.
  if ([IO.Directory]::Exists($stage) -or [IO.File]::Exists($stage)) { throw 'exists' }
  [void][IO.Directory]::CreateDirectory($stage, $private)
  $phase = 'stage-check'
  AssertPrivateStage $stage
  if ([IO.Directory]::GetFileSystemEntries($stage).Length -ne 0) { throw 'not-empty' }
  $phase = 'ancestor-recheck'
  foreach ($component in $chain) {
    $after = AssertAncestor $component ($component -ceq $stageParent)
    if ($after -cne $before[$component]) { throw 'changed' }
  }
  AssertPrivateStage $stage
  $phase = 'output'
  [Console]::Out.WriteLine('reach-private-stage ' + $account + ' ' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($stage)))
  exit 0
} catch {
  # Diagnostics identify only the fixed phase/category and exception class,
  # never its message, stack, descriptor, token, profile or path contents.
  $reason = 'exception'
  if (@('account', 'leaf', 'path', 'reparse', 'descriptor', 'owner', 'ancestor-access', 'stage-acl', 'profile', 'volume', 'depth', 'exists', 'not-empty', 'changed') -ccontains $_.Exception.Message) { $reason = $_.Exception.Message }
  $kind = $_.Exception.GetType().FullName
  $inner = 'none'
  if ($null -ne $_.Exception.InnerException) { $inner = $_.Exception.InnerException.GetType().FullName }
  $id = [string]$_.FullyQualifiedErrorId
  if ($kind -cnotmatch '\A[A-Za-z][A-Za-z0-9_.-]{0,119}\z') { $kind = 'unknown' }
  if ($inner -cnotmatch '\A[A-Za-z][A-Za-z0-9_.-]{0,119}\z') { $inner = 'unknown' }
  if ($id -cnotmatch '\A[A-Za-z][A-Za-z0-9_.-]{0,119}\z') { $id = 'unknown' }
  $line = 0
  if ($null -ne $_.InvocationInfo -and $_.InvocationInfo.ScriptLineNumber -ge 0 -and $_.InvocationInfo.ScriptLineNumber -le 99999) { $line = $_.InvocationInfo.ScriptLineNumber }
  [Console]::Error.WriteLine('reach-private-stage-refused ' + $phase + ' ' + $reason + ' ' + $kind + ' ' + $inner + ' ' + $id + ' ' + $line)
  exit 1
}
`;

/** Internal bootstrap; parent is a code-only disposable-fixture override. */
export async function createWindowsPrivateStage({ sid, env = process.env, run = exec, parent } = {}) {
  const system = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir ?? env.WINDIR;
  if (!ACCOUNT.test(sid || "") || !windowsPath(system) || (parent !== undefined && !windowsPath(parent))) throw refuse();
  const leaf = `reach-private-stage-${crypto.randomBytes(16).toString("hex")}`;
  let stdout;
  try {
    ({ stdout } = await run(path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", bootstrap], {
        timeout: 15000, maxBuffer: 65536, windowsHide: true,
        env: { ...env, REACH_PRIVATE_STAGE_SID: sid, REACH_PRIVATE_STAGE_PARENT: parent ?? "", REACH_PRIVATE_STAGE_LEAF: leaf },
      }));
  } catch (error) { throw commandRefusal(error); }
  const match = /^reach-private-stage (S-1-5-21-\d+-\d+-\d+-\d+) ([A-Za-z0-9+/]+={0,2})$/.exec(String(stdout || "").trim());
  if (!match || match[1] !== sid) throw refuse();
  let dir;
  try {
    const bytes = Buffer.from(match[2], "base64");
    if (bytes.toString("base64") !== match[2]) throw refuse();
    dir = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch { throw refuse(); }
  if (!windowsPath(dir) || path.win32.basename(dir) !== leaf || (parent !== undefined && path.win32.dirname(dir) !== parent)) throw refuse();
  // Only the default, verified reserved container protects sibling hook and
  // Codex stages. An explicit test parent must never privatize all of Home.
  const privateRoot = path.win32.dirname(dir);
  if (parent === undefined && path.win32.basename(privateRoot) !== "Reach") throw refuse();
  return { dir, sid, ...(parent === undefined ? { privateRoot } : {}) };
}
