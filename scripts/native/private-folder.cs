// Reach's folder check on Windows (server/windows-private-folder.mjs,
// docs/parity/D-public-door.md §4.5): who besides this account may read or
// change Reach's state, its code and its helpers. It only reads permissions,
// owners and attributes: it opens no file, changes nothing and starts
// nothing. Compiled fresh each time it's needed, so a copy put in the folder
// earlier is never what runs. C# 5 (the .NET Framework 4.x compiler),
// mscorlib and System only.
//
//   private-folder.exe <account SID> state <dir>... code <dir>... file <path>...
//
// One line out: "ok", or "open <index> <kind>" for the first path that fails,
// <index> its place among the paths (the words state, code and file not
// counted), <kind> one of ace, owner, reparse, limit, missing, error. Exit 0;
// exit 2 with nothing said for arguments it doesn't understand.
//
// state: the folder and everything in it (up to 20,000 entries) owned by the
//   account, SYSTEM or Administrators; no allowed access for anyone else
//   (inherit-only CREATOR OWNER and rights for the checked owner aside);
//   no links/junctions.
// code: the folder, its bin, scripts, scripts\native, server, dist and
//   node_modules folders, and everything under bin, scripts and server (up to
//   5,000): nobody but the account, SYSTEM, Administrators or TrustedInstaller
//   may change them or own them. Reading is fine.
// file: as state, for one file.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

static class PrivateFolder {
  const string LocalSystem = "S-1-5-18";
  const string Administrators = "S-1-5-32-544";
  const string TrustedInstaller = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  const string CreatorOwner = "S-1-3-0";
  const string OwnerRights = "S-1-3-4";
  const int StateLimit = 20000;
  const int CodeLimit = 5000;
  // FILE_WRITE_DATA, FILE_APPEND_DATA, FILE_DELETE_CHILD, DELETE, WRITE_DAC,
  // WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE.
  const int WriteRights = 0x2 | 0x4 | 0x40 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
  static readonly string[] CodeFolders = { "bin", "scripts", "scripts\\native", "server", "dist", "node_modules" };
  static readonly string[] CodeTrees = { "bin", "scripts", "server" };
  static readonly Regex AccountSid = new Regex("^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$");

  class Open : Exception {
    public readonly string Kind;
    public Open(string kind) { Kind = kind; }
  }

  static int Main(string[] args) {
    if (args.Length < 1 || !AccountSid.IsMatch(args[0])) return 2;
    string account = args[0];
    string section = null;
    var paths = new List<KeyValuePair<string, string>>();
    for (int i = 1; i < args.Length; i++) {
      string arg = args[i];
      if (arg == "state" || arg == "code" || arg == "file") { section = arg; continue; }
      if (section == null || arg.Length == 0 || !Path.IsPathRooted(arg)) return 2;
      paths.Add(new KeyValuePair<string, string>(section, arg));
    }
    for (int index = 0; index < paths.Count; index++) {
      string kind = null;
      try {
        string path = paths[index].Value;
        if (paths[index].Key == "state") State(path, account);
        else if (paths[index].Key == "code") Code(path, account);
        else Helper(path, account);
      } catch (Open open) {
        kind = open.Kind;
      } catch (Exception) {
        kind = "error";
      }
      if (kind != null) {
        Say("open " + index + " " + kind);
        return 0;
      }
    }
    Say("ok");
    return 0;
  }

  static void Say(string line) {
    Console.Out.Write(line + "\n");
    Console.Out.Flush();
  }

  static bool Trusted(string sid, string account, bool code) {
    return sid == account || sid == LocalSystem || sid == Administrators || (code && sid == TrustedInstaller);
  }

  static FileSystemSecurity Security(string path, bool folder) {
    AccessControlSections sections = AccessControlSections.Access | AccessControlSections.Owner;
    if (folder) return Directory.GetAccessControl(path, sections);
    return File.GetAccessControl(path, sections);
  }

  static string Owner(FileSystemSecurity security) {
    IdentityReference owner = security.GetOwner(typeof(SecurityIdentifier));
    return owner == null ? "" : owner.Value;
  }

  // Allowed access for anyone untrusted: any (state) or a change (code).
  static void Check(string path, bool folder, string account, bool code) {
    FileSystemSecurity security = Security(path, folder);
    if (!Trusted(Owner(security), account, code)) throw new Open("owner");
    foreach (FileSystemAccessRule rule in security.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
      if (rule.AccessControlType != AccessControlType.Allow) continue;
      string sid = rule.IdentityReference.Value;
      if (Trusted(sid, account, code)) continue;
      // OWNER RIGHTS denotes this object's owner, already checked above.
      if (sid == OwnerRights) continue;
      if (sid == CreatorOwner && (rule.PropagationFlags & PropagationFlags.InheritOnly) != 0) continue;
      int rights = (int)rule.FileSystemRights;
      if (code ? (rights & WriteRights) != 0 : rights != 0) throw new Open("ace");
    }
  }

  static bool Linked(string path) {
    return (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0;
  }

  // Every entry under `top`, links refused, up to `limit` in all (`seen`).
  static void Walk(string top, string account, bool code, int limit, ref int seen) {
    var pending = new Stack<string>();
    pending.Push(top);
    while (pending.Count > 0) {
      string dir = pending.Pop();
      foreach (string entry in Directory.EnumerateFileSystemEntries(dir)) {
        if (++seen > limit) throw new Open("limit");
        FileAttributes attributes = File.GetAttributes(entry);
        if ((attributes & FileAttributes.ReparsePoint) != 0) throw new Open("reparse");
        bool folder = (attributes & FileAttributes.Directory) != 0;
        Check(entry, folder, account, code);
        if (folder) pending.Push(entry);
      }
    }
  }

  static void State(string root, string account) {
    if (!Directory.Exists(root)) throw new Open("missing");
    if (Linked(root)) throw new Open("reparse");
    Check(root, true, account, false);
    int seen = 0;
    Walk(root, account, false, StateLimit, ref seen);
  }

  static void Code(string root, string account) {
    if (!Directory.Exists(root)) throw new Open("missing");
    Check(root, true, account, true);
    foreach (string name in CodeFolders) {
      string dir = Path.Combine(root, name);
      if (Directory.Exists(dir)) Check(dir, true, account, true);
    }
    int seen = 0;
    foreach (string name in CodeTrees) {
      string top = Path.Combine(root, name);
      if (!Directory.Exists(top)) continue;
      if (Linked(top)) throw new Open("reparse");
      Walk(top, account, true, CodeLimit, ref seen);
    }
  }

  static void Helper(string file, string account) {
    if (!File.Exists(file)) throw new Open("missing");
    if (Linked(file)) throw new Open("reparse");
    Check(file, false, account, false);
  }
}
