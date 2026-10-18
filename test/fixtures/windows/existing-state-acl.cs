// Actual NTFS fixture setup/snapshots, used only under a disposable CI root.
// Nothing in this program is injected into Reach's permission check.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;
using System.Runtime.InteropServices;

static class ExistingStateAcl {
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool MoveFileExW(string source, string destination, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateHardLinkW(string link, string existing, IntPtr security);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool LogonUserW(string user, string domain, string password, int type, int provider, out IntPtr token);
  static readonly SecurityIdentifier Me = WindowsIdentity.GetCurrent().User;
  static readonly InheritanceFlags Children = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static SecurityIdentifier Sid(string value) { return new SecurityIdentifier(value); }
  static FileSystemAccessRule Rule(SecurityIdentifier sid, FileSystemRights rights, bool folder, PropagationFlags propagation) {
    return new FileSystemAccessRule(sid, rights, folder ? Children : InheritanceFlags.None, propagation, AccessControlType.Allow);
  }
  static void Private(string target, bool folder) {
    FileSystemSecurity acl = folder ? (FileSystemSecurity)new DirectorySecurity() : new FileSecurity();
    acl.SetOwner(Me);
    acl.SetAccessRuleProtection(true, false);
    foreach (SecurityIdentifier sid in new SecurityIdentifier[] { Me, Sid("S-1-5-18"), Sid("S-1-5-32-544") })
      acl.AddAccessRule(Rule(sid, FileSystemRights.FullControl, folder, PropagationFlags.None));
    if (folder) Directory.SetAccessControl(target, (DirectorySecurity)acl);
    else File.SetAccessControl(target, (FileSecurity)acl);
  }
  static void Add(string target, bool folder, string sid, bool protect, PropagationFlags propagation) {
    FileSystemSecurity acl = folder ? (FileSystemSecurity)Directory.GetAccessControl(target) : File.GetAccessControl(target);
    if (protect) acl.SetAccessRuleProtection(true, true);
    acl.AddAccessRule(Rule(Sid(sid), FileSystemRights.ReadAndExecute | FileSystemRights.ReadPermissions, folder, propagation));
    if (folder) Directory.SetAccessControl(target, (DirectorySecurity)acl);
    else File.SetAccessControl(target, (FileSecurity)acl);
  }
  static void Owned(string target, bool folder) {
    // An elevated runner's default owner may be Administrators. Pin these
    // synthetic older entries to the actual user SID, as the scenario needs.
    FileSystemSecurity acl = folder ? (FileSystemSecurity)Directory.GetAccessControl(target, AccessControlSections.Owner) : File.GetAccessControl(target, AccessControlSections.Owner);
    acl.SetOwner(Me);
    if (folder) Directory.SetAccessControl(target, (DirectorySecurity)acl);
    else File.SetAccessControl(target, (FileSecurity)acl);
  }
  static void DenyWriteDac(string target, bool folder) {
    // Suppress the owner's implicit WRITE_DAC first. A deny to the ordinary
    // account SID by itself does not prove that owner-token access is denied.
    Add(target, folder, "S-1-3-4", false, PropagationFlags.None);
    FileSystemSecurity acl = folder ? (FileSystemSecurity)Directory.GetAccessControl(target) : File.GetAccessControl(target);
    acl.AddAccessRule(new FileSystemAccessRule(Me, FileSystemRights.ChangePermissions, AccessControlType.Deny));
    if (folder) Directory.SetAccessControl(target, (DirectorySecurity)acl);
    else File.SetAccessControl(target, (FileSecurity)acl);
  }
  static object Access(string path, uint wanted) {
    IntPtr file = CreateFileW(path, wanted, 7, IntPtr.Zero, 3, 0x02000000 | 0x00200000, IntPtr.Zero);
    if (file == new IntPtr(-1)) return new Dictionary<string, object> { { "ok", false }, { "error", Marshal.GetLastWin32Error() } };
    CloseHandle(file);
    return new Dictionary<string, object> { { "ok", true }, { "error", 0 } };
  }
  static object ForeignAttempt(string root, string expectedSid) {
    RequireRoot(root);
    string user = Environment.GetEnvironmentVariable("REACH_ACL_FIXTURE_USER"), password = Environment.GetEnvironmentVariable("REACH_ACL_FIXTURE_PASSWORD");
    if (String.IsNullOrEmpty(user) || !user.StartsWith("ReachAcl", StringComparison.Ordinal) || String.IsNullOrEmpty(password)) throw new Exception("Missing disposable actor.");
    IntPtr token;
    if (!LogonUserW(user, Environment.MachineName, password, 2, 0, out token)) throw new Exception("Disposable actor logon failed: " + Marshal.GetLastWin32Error());
    try {
      using (WindowsIdentity.Impersonate(token)) {
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        if (identity.User.Value != expectedSid || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new Exception("Unexpected disposable actor token.");
        string state = Path.Combine(root, "state"), file = Path.Combine(state, "history", "legacy.json");
        object read = Access(file, 1), write = Access(file, 2);
        bool moved = MoveFileExW(state, Path.Combine(root, "foreign-moved-state"), 0);
        int moveError = moved ? 0 : Marshal.GetLastWin32Error();
        return new Dictionary<string, object> { { "sid", identity.User.Value }, { "administratorToken", false },
          { "read", read }, { "write", write }, { "rename", new Dictionary<string, object> { { "ok", moved }, { "error", moveError } } } };
      }
    } finally { CloseHandle(token); }
  }
  static object ForeignLink(string root, string expectedSid, string label) {
    RequireRoot(root);
    if (label != "before" && label != "held") throw new Exception("Unknown disposable link phase.");
    string user = Environment.GetEnvironmentVariable("REACH_ACL_FIXTURE_USER"), password = Environment.GetEnvironmentVariable("REACH_ACL_FIXTURE_PASSWORD");
    if (String.IsNullOrEmpty(user) || !user.StartsWith("ReachAcl", StringComparison.Ordinal) || String.IsNullOrEmpty(password)) throw new Exception("Missing disposable actor.");
    IntPtr token;
    if (!LogonUserW(user, Environment.MachineName, password, 2, 0, out token)) throw new Exception("Disposable actor logon failed: " + Marshal.GetLastWin32Error());
    try {
      using (WindowsIdentity.Impersonate(token)) {
        WindowsIdentity identity = WindowsIdentity.GetCurrent();
        if (identity.User.Value != expectedSid || new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator)) throw new Exception("Unexpected disposable actor token.");
        // The destination is outside protected state. This real actor makes
        // and owns its own directory; no inability to write there can be
        // mistaken for a source-file hardlink or sharing restriction.
        string destination = Path.Combine(root, "foreign-output", "owned");
        Directory.CreateDirectory(destination);
        string owner = Directory.GetAccessControl(destination, AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier)).Value;
        if (owner != expectedSid) throw new Exception("Unexpected disposable destination owner.");
        string control = Path.Combine(destination, label + "-write-control");
        IntPtr writable = CreateFileW(control, 0x40000000, 0, IntPtr.Zero, 1, 0, IntPtr.Zero);
        bool canCreate = writable != new IntPtr(-1);
        int createError = canCreate ? 0 : Marshal.GetLastWin32Error();
        if (canCreate) { CloseHandle(writable); File.Delete(control); }
        string source = Path.Combine(root, "state", "history", "legacy.json");
        object read = Access(source, 1), write = Access(source, 2), delete = Access(source, 0x10000);
        string link = Path.Combine(destination, label + "-link");
        bool linked = CreateHardLinkW(link, source, IntPtr.Zero);
        int linkError = linked ? 0 : Marshal.GetLastWin32Error();
        return new Dictionary<string, object> {
          { "sid", identity.User.Value }, { "administratorToken", false }, { "destinationOwner", owner },
          { "destinationCreate", new Dictionary<string, object> { { "ok", canCreate }, { "error", createError } } },
          { "sourceRead", read }, { "sourceWrite", write }, { "sourceDelete", delete },
          { "link", new Dictionary<string, object> { { "ok", linked }, { "error", linkError } } }
        };
      }
    } finally { CloseHandle(token); }
  }
  static void RequireRoot(string root) {
    if (!Directory.Exists(root) || !Path.GetFileName(root).StartsWith("reach-existing-state-")) throw new Exception("Not a generated fixture root.");
  }
  static void Setup(string root, string mode, string foreign) {
    RequireRoot(root);
    Private(root, true);
    string outside = Path.Combine(root, "outside");
    Directory.CreateDirectory(outside);
    Private(outside, true);
    File.WriteAllText(Path.Combine(outside, "keep.txt"), "Outside disposable target.\n");
    if (mode == "fresh") return;
    string state = Path.Combine(root, "state");
    Directory.CreateDirectory(state);
    Owned(state, true);
    // Let ordinary descendants inherit, just as an older state tree does.
    if (mode == "inherited") Add(state, true, "S-1-1-0", false, PropagationFlags.None);
    string history = Path.Combine(state, "history");
    Directory.CreateDirectory(history);
    Owned(history, true);
    string file = Path.Combine(history, "legacy.json");
    File.WriteAllText(file, "Existing synthetic state. Keep exactly.\n");
    Owned(file, false);
    if (mode == "file-explicit" || mode == "file-protected") Add(file, false, "S-1-1-0", mode == "file-protected", PropagationFlags.None);
    else if (mode == "directory-explicit" || mode == "directory-protected") Add(history, true, "S-1-1-0", mode == "directory-protected", PropagationFlags.None);
    else if (mode == "owner-rights-file" || mode == "foreign-owner-rights") Add(file, false, "S-1-3-4", false, PropagationFlags.None);
    else if (mode == "owner-rights-directory") Add(history, true, "S-1-3-4", false, PropagationFlags.None);
    else if (mode == "creator-owner") Add(history, true, "S-1-3-0", false, PropagationFlags.InheritOnly);
    else if (mode == "creator-owner-materialized") Add(file, false, "S-1-3-0", false, PropagationFlags.None);
    else if (mode == "foreign-ace") Add(file, false, foreign, false, PropagationFlags.None);
    else if (mode == "broad-write") {
      FileSecurity acl = File.GetAccessControl(file);
      acl.AddAccessRule(Rule(Sid("S-1-1-0"), FileSystemRights.Modify, false, PropagationFlags.None));
      File.SetAccessControl(file, acl);
    }
    else if (mode == "private-deny") DenyWriteDac(file, false);
    else if (mode == "broad-deny") { Add(file, false, "S-1-1-0", false, PropagationFlags.None); DenyWriteDac(file, false); }
    else if (mode == "private-directory-deny") DenyWriteDac(state, true);
    else if (mode == "broad-directory-write") {
      DirectorySecurity acl = Directory.GetAccessControl(state);
      acl.AddAccessRule(Rule(Sid("S-1-1-0"), FileSystemRights.Modify, true, PropagationFlags.None));
      Directory.SetAccessControl(state, acl);
    }
  }
  static Dictionary<string, object> Entry(string target) {
    FileAttributes attributes = File.GetAttributes(target);
    bool folder = (attributes & FileAttributes.Directory) != 0;
    FileSystemSecurity acl = folder ? (FileSystemSecurity)Directory.GetAccessControl(target) : File.GetAccessControl(target);
    var rules = new List<object>();
    foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier)))
      rules.Add(new Dictionary<string, object> {
        { "sid", rule.IdentityReference.Value }, { "type", rule.AccessControlType.ToString() },
        { "rights", (int)rule.FileSystemRights }, { "inherited", rule.IsInherited },
        { "inheritance", rule.InheritanceFlags.ToString() }, { "propagation", rule.PropagationFlags.ToString() }
      });
    return new Dictionary<string, object> {
      { "path", target }, { "directory", folder }, { "reparse", (attributes & FileAttributes.ReparsePoint) != 0 },
      { "owner", acl.GetOwner(typeof(SecurityIdentifier)).Value }, { "protected", acl.AreAccessRulesProtected },
      { "sddl", acl.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access) }, { "rules", rules },
      { "readControlAccess", Access(target, 0x20000) }, { "writeDacAccess", Access(target, 0x40000) }
    };
  }
  static object Snapshot(string root) {
    var entries = new List<object>();
    var pending = new Stack<string>();
    pending.Push(root);
    while (pending.Count > 0) {
      string current = pending.Pop();
      if (entries.Count > 200) throw new Exception("Fixture unexpectedly large.");
      entries.Add(Entry(current));
      FileAttributes attributes = File.GetAttributes(current);
      if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) continue;
      foreach (string child in Directory.GetFileSystemEntries(current)) pending.Push(child);
    }
    return new Dictionary<string, object> {
      { "sid", Me.Value }, { "windows", Environment.OSVersion.ToString() },
      { "administratorToken", new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator) },
      { "entries", entries }
    };
  }
  static int Main(string[] args) {
    try {
      if (args.Length == 2 && args[0] == "sid") {
        Console.WriteLine(((SecurityIdentifier)new NTAccount(Environment.MachineName, args[1]).Translate(typeof(SecurityIdentifier))).Value);
        return 0;
      }
      if (args.Length < 2) throw new Exception("Missing fixture arguments.");
      if (args[0] == "foreign-attempt") {
        Console.WriteLine(Json.Serialize(ForeignAttempt(args[1], args[2])));
        return 0;
      }
      if (args[0] == "foreign-link") {
        Console.WriteLine(Json.Serialize(ForeignLink(args[1], args[2], args[3])));
        return 0;
      }
      if (args[0] == "foreign-link-destination") {
        RequireRoot(args[1]);
        string destination = Path.Combine(args[1], "foreign-output");
        Directory.CreateDirectory(destination);
        Private(destination, true);
        DirectorySecurity acl = Directory.GetAccessControl(destination);
        acl.AddAccessRule(Rule(Sid(args[2]), FileSystemRights.FullControl, true, PropagationFlags.None));
        Directory.SetAccessControl(destination, acl);
      }
      else if (args[0] == "setup") Setup(args[1], args[2], args.Length > 3 ? args[3] : "");
      else if (args[0] == "owner-rights") {
        RequireRoot(args[1]);
        Add(Path.Combine(args[1], "state", "history", "legacy.json"), false, "S-1-3-4", false, PropagationFlags.None);
      }
      else if (args[0] != "snapshot") throw new Exception("Unknown fixture operation.");
      Console.WriteLine(Json.Serialize(Snapshot(args[1])));
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.ToString());
      return 1;
    }
  }
}
