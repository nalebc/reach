using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;

static class GrantChecks {
  static int Main(string[] args) {
    try {
      if (args[0] == "pin") {
        IntPtr root = NtFiles.OpenByPath(args[1], true, false);
        IntPtr folder = IntPtr.Zero, file = IntPtr.Zero;
        try {
          folder = NtFiles.OpenChild(root, "nested", true);
          file = NtFiles.CreateChildFile(folder, "safe.txt", false);
          bool rootMoved = Try(delegate { Directory.Move(args[1], args[1] + "-moved"); });
          bool folderMoved = Try(delegate { Directory.Move(Path.Combine(args[1], "nested"), Path.Combine(args[1], "renamed")); });
          bool fileMoved = Try(delegate { File.Move(Path.Combine(args[1], "nested", "safe.txt"), Path.Combine(args[1], "nested", "renamed.txt")); });
          bool written = Try(delegate { File.WriteAllText(Path.Combine(args[1], "nested", "safe.txt"), "raced"); });
          if (rootMoved || folderMoved || fileMoved || written) return 3;
          Console.WriteLine("pinned");
        } finally { NtFiles.Close(file); NtFiles.Close(folder); NtFiles.Close(root); }
      } else if (args[0] == "root") {
        IntPtr root = NtFiles.OpenByPath(args[1], true, false);
        NtFiles.Close(root);
      } else if (args[0] == "read") {
        var denied = new List<string>();
        for (int i = 2; i < args.Length; i++) denied.Add(args[i]);
        Grants.ApplyReadGrant(args[1], denied);
      } else if (args[0] == "grant") {
        Grants.ApplyGrant(args[1], true, new List<string>(), new List<string>());
      } else if (args[0] == "revoke") {
        Grants.Revoke(args[1], new List<string>());
      } else if (args[0] == "acl") {
        FileSystemSecurity security = Directory.Exists(args[1]) ? (FileSystemSecurity)Directory.GetAccessControl(args[1]) : File.GetAccessControl(args[1]);
        Console.WriteLine(security.GetSecurityDescriptorSddlForm(AccessControlSections.Access));
      } else if (args[0] == "allowed" || args[0] == "denied") {
        FileSystemSecurity security = Directory.Exists(args[1]) ? (FileSystemSecurity)Directory.GetAccessControl(args[1]) : File.GetAccessControl(args[1]);
        var cap = args[0] == "denied" ? Grants.DenyCapability() : Grants.RootCapability(args[2]);
        var access = args[0] == "denied" ? AccessControlType.Deny : AccessControlType.Allow;
        foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(System.Security.Principal.SecurityIdentifier)))
          if (rule.IdentityReference.Equals(cap) && rule.AccessControlType == access) { Console.WriteLine("yes"); return 0; }
        Console.WriteLine("no");
      } else return 2;
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.Message); return 1; }
  }
  static bool Try(Action action) {
    try { action(); return true; } catch (IOException) { return false; } catch (UnauthorizedAccessException) { return false; }
  }
}
