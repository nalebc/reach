// Actual NTFS fixture setup/snapshots, used only under a disposable CI root.
// Nothing in this program is injected into Reach's permission check.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Web.Script.Serialization;

static class ExistingStateAcl {
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
  static void Setup(string root, string mode, string foreign) {
    if (!Directory.Exists(root) || !Path.GetFileName(root).StartsWith("reach-existing-state-")) throw new Exception("Not a generated fixture root.");
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
    else if (mode == "owner-rights-file") Add(file, false, "S-1-3-4", false, PropagationFlags.None);
    else if (mode == "owner-rights-directory") Add(history, true, "S-1-3-4", false, PropagationFlags.None);
    else if (mode == "creator-owner") Add(history, true, "S-1-3-0", false, PropagationFlags.InheritOnly);
    else if (mode == "foreign-ace") Add(file, false, foreign, false, PropagationFlags.None);
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
      { "sddl", acl.GetSecurityDescriptorSddlForm(AccessControlSections.Owner | AccessControlSections.Access) }, { "rules", rules }
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
      if (args[0] == "setup") Setup(args[1], args[2], args.Length > 3 ? args[3] : "");
      else if (args[0] != "snapshot") throw new Exception("Unknown fixture operation.");
      Console.WriteLine(Json.Serialize(Snapshot(args[1])));
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.ToString());
      return 1;
    }
  }
}
