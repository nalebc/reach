// Narrow repair of older Reach state ACLs. This is separate from the read-only
// private-folder check: only simple allow-only descriptors may lose one of
// Windows' five known broad grants. Owners, bytes, unknown grants and code are
// never changed. The whole bounded forest is preflighted before its first ACL
// change. All inspection and changes use the same retained no-follow handles.
//
// private-state.exe <current account SID> <state directory>...
// One line: ok, or open <root-index> <reason> <base64 UTF-8 exact path>.
// .NET Framework's C# 5 compiler; mscorlib and System only.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;

static class PrivateState {
  const string SystemSid = "S-1-5-18", AdminSid = "S-1-5-32-544";
  const string InstallerSid = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";
  const string OwnerRights = "S-1-3-4", CreatorOwner = "S-1-3-0";
  const uint ReadControl = 0x20000, WriteDac = 0x40000, Synchronize = 0x100000;
  const uint ReadAttributes = 0x80, ListDirectory = 1, Traverse = 0x20;
  const uint DirectoryOption = 1, NonDirectoryOption = 0x40;
  const uint OwnerInfo = 1, DaclInfo = 4, ProtectedDacl = 0x80000000;
  const int FullControl = 0x1f01ff, EntryLimit = 20000, DepthLimit = 128;
  static readonly Regex Account = new Regex("^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$");
  static readonly HashSet<string> Broad = new HashSet<string>(new string[] {
    "S-1-1-0", "S-1-5-11", "S-1-5-32-545", "S-1-15-2-1", "S-1-15-2-2"
  }, StringComparer.Ordinal);
  static readonly List<Entry> Held = new List<Entry>();
  static readonly List<IntPtr> Ancestors = new List<IntPtr>();
  static readonly Dictionary<string, Entry> Identities = new Dictionary<string, Entry>(StringComparer.Ordinal);
  static readonly Dictionary<string, Entry> Paths = new Dictionary<string, Entry>(StringComparer.OrdinalIgnoreCase);
  static readonly Stopwatch Clock = Stopwatch.StartNew();
  static string Me;
  static int RootIndex;
  static string CurrentPath;

  sealed class Refused : Exception {
    internal readonly string Reason, Path;
    internal Refused(string reason, string path) { Reason = reason; Path = path; }
  }
  sealed class Entry {
    internal IntPtr Handle;
    internal string Path, Identity;
    internal bool Directory, CanWrite, ProtectedRoot;
    internal int Root;
    internal byte[] Before, After;
    internal readonly Dictionary<string, string> Children = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  }
  sealed class Child {
    internal string Name;
    internal bool Directory;
    internal ulong Id;
  }
  [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes {
    internal int Length; internal IntPtr Root, Name; internal uint Attributes;
    internal IntPtr Security, Quality;
  }
  [StructLayout(LayoutKind.Sequential)] struct UnicodeString {
    internal ushort Length, MaximumLength; internal IntPtr Buffer;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoStatus { internal IntPtr Status, Information; }
  [StructLayout(LayoutKind.Sequential)] struct FileInfo {
    internal uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh;
    internal uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr handle, uint access, ref ObjectAttributes attrs, out IoStatus status, IntPtr allocation, uint attributes, uint sharing, uint disposition, uint options, IntPtr ea, uint eaLength);
  [DllImport("ntdll.dll")] static extern int RtlNtStatusToDosError(int status);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandle(IntPtr handle, out FileInfo info);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetFileInformationByHandleEx(IntPtr handle, int kind, IntPtr data, uint size);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern uint GetFinalPathNameByHandleW(IntPtr handle, StringBuilder path, uint size, uint flags);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool GetVolumeInformationW(string root, StringBuilder volume, uint volumeSize, out uint serial, out uint maximum, out uint flags, StringBuilder filesystem, uint filesystemSize);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern uint GetDriveTypeW(string root);
  [DllImport("advapi32.dll")] static extern uint GetSecurityInfo(IntPtr handle, int type, uint wanted, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern uint GetSecurityDescriptorLength(IntPtr descriptor);
  [DllImport("advapi32.dll")] static extern bool GetSecurityDescriptorDacl(IntPtr descriptor, out bool present, out IntPtr dacl, out bool defaulted);
  [DllImport("advapi32.dll")] static extern uint SetSecurityInfo(IntPtr handle, int type, uint wanted, IntPtr owner, IntPtr group, IntPtr dacl, IntPtr sacl);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  static void Fail(string reason, string path) { throw new Refused(reason, path); }
  // The retained-handle budget includes roots, not only descendants.
  static void Budget() { if (Held.Count > EntryLimit || Clock.ElapsedMilliseconds > 90000) Fail("limit", CurrentPath); }
  static bool Trusted(string sid, bool ancestor) { return sid == Me || sid == SystemSid || sid == AdminSid || (ancestor && sid == InstallerSid); }
  static byte[] Bytes(RawSecurityDescriptor descriptor) {
    byte[] result = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(result, 0); return result;
  }
  static bool Equal(byte[] left, byte[] right) {
    if (left.Length != right.Length) return false;
    for (int i = 0; i < left.Length; i++) if (left[i] != right[i]) return false;
    return true;
  }
  static byte[] AclBytes(RawAcl acl) { byte[] result = new byte[acl.BinaryLength]; acl.GetBinaryForm(result, 0); return result; }
  static RawSecurityDescriptor Security(IntPtr handle, string path) {
    IntPtr owner, group, dacl, sacl, descriptor;
    if (GetSecurityInfo(handle, 1, OwnerInfo | DaclInfo, out owner, out group, out dacl, out sacl, out descriptor) != 0) { Fail("error", path); return null; }
    try {
      uint size = GetSecurityDescriptorLength(descriptor);
      if (size < 20 || size > 65536) Fail("complex", path);
      byte[] data = new byte[(int)size]; Marshal.Copy(descriptor, data, 0, data.Length);
      var raw = new RawSecurityDescriptor(data, 0);
      if (raw.Owner == null || raw.DiscretionaryAcl == null || (raw.ControlFlags & ControlFlags.DiscretionaryAclPresent) == 0) Fail("complex", path);
      return raw;
    } finally { LocalFree(descriptor); }
  }
  static CommonAce Basic(GenericAce value, string path) {
    var ace = value as CommonAce;
    if (ace == null || ace.IsCallback || ((int)ace.AceFlags & ~31) != 0 ||
        (ace.AceQualifier != AceQualifier.AccessAllowed && ace.AceQualifier != AceQualifier.AccessDenied)) Fail("complex", path);
    return ace;
  }
  static void AncestorSecurity(IntPtr handle, string path) {
    var security = Security(handle, path);
    if (!Trusted(security.Owner.Value, true)) Fail("owner", path);
    // Higher ancestors may let other users read or create a new sibling.
    // They must not let them mutate/replace this existing path component.
    const uint permitted = 1 | 2 | 4 | 8 | 32 | 128 | 0x20000 | 0x100000 | 0x80000000 | 0x20000000;
    foreach (GenericAce value in security.DiscretionaryAcl) {
      CommonAce ace = Basic(value, path);
      if (ace.AceQualifier == AceQualifier.AccessDenied || (ace.AceFlags & AceFlags.InheritOnly) != 0) continue;
      if (Trusted(ace.SecurityIdentifier.Value, true) || ace.SecurityIdentifier.Value == OwnerRights) continue;
      if (((uint)ace.AccessMask & ~permitted) != 0) Fail("ancestor", path);
    }
  }
  static byte[] Plan(RawSecurityDescriptor raw, string path, bool root) {
    if (!Trusted(raw.Owner.Value, false)) Fail("owner", path);
    bool broad = false, deny = false, ownFull = false;
    foreach (GenericAce value in raw.DiscretionaryAcl) {
      CommonAce ace = Basic(value, path);
      if (ace.AceQualifier == AceQualifier.AccessDenied) { deny = true; continue; }
      string sid = ace.SecurityIdentifier.Value;
      bool inheritOnly = (ace.AceFlags & AceFlags.InheritOnly) != 0;
      if (sid == Me && !inheritOnly && (ace.AccessMask & FullControl) == FullControl) ownFull = true;
      if (Trusted(sid, false) || sid == OwnerRights || (sid == CreatorOwner && inheritOnly) || ace.AccessMask == 0) continue;
      if (Broad.Contains(sid)) {
        // The proven legacy case is broad READ/EXECUTE. Existing sharing
        // that permits writes, deletion or security changes needs an owner
        // decision; it is never silently normalized by this narrow repair.
        const uint readOnly = 0x1200a9 | 0x80000000 | 0x20000000;
        if (((uint)ace.AccessMask & ~readOnly) != 0) Fail("write", path);
        broad = true;
      }
      else Fail("ace", path);
    }
    bool barrier = root && (raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0;
    // Simple ordinary roots keep their old inheritance barrier. An already
    // private restrictive/DENY root is left untouched; its retained ancestor
    // chain must pass the no-untrusted-mutation rule instead.
    if (!broad && !(barrier && !deny && ownFull)) return null;
    if (deny) Fail("deny", path);
    if (!ownFull) Fail("access", path);
    // Subtract only recognized broad grants. Do not add FullControl or
    // change the owner; freeze the remaining grants exactly as they exist.
    var next = new RawAcl(raw.DiscretionaryAcl.Revision, raw.DiscretionaryAcl.Count);
    foreach (GenericAce value in raw.DiscretionaryAcl) {
      CommonAce ace = (CommonAce)value;
      if (Broad.Contains(ace.SecurityIdentifier.Value)) continue;
      byte[] bytes = new byte[ace.BinaryLength]; ace.GetBinaryForm(bytes, 0);
      GenericAce copy = GenericAce.CreateFromBinaryForm(bytes, 0);
      copy.AceFlags &= ~AceFlags.Inherited;
      next.InsertAce(next.Count, copy);
    }
    raw.DiscretionaryAcl = next;
    raw.SetFlags(raw.ControlFlags | ControlFlags.DiscretionaryAclProtected);
    return Bytes(raw);
  }
  static string Canonical(string path) {
    if (String.IsNullOrEmpty(path) || path.Length > 4096 || !Regex.IsMatch(path, "^[A-Za-z]:\\\\") || Path.GetFullPath(path) != path || path.IndexOf('/') >= 0) Fail("path", path);
    if (path.Length > 3 && path.EndsWith("\\", StringComparison.Ordinal)) Fail("path", path);
    string rest = path.Substring(3);
    if (rest.Length > 0) foreach (string part in rest.Split('\\')) {
      if (part.Length == 0 || part == "." || part == ".." || part.EndsWith(".", StringComparison.Ordinal) || part.EndsWith(" ", StringComparison.Ordinal) || part.IndexOf(':') >= 0 || Regex.IsMatch(part, "~[0-9]")) Fail("path", path);
      foreach (char c in part) if (Char.IsControl(c) || c == '"' || c == '<' || c == '>' || c == '|' || c == '?' || c == '*') Fail("path", path);
    }
    string drive = path.Substring(0, 3);
    var filesystem = new StringBuilder(64); uint serial, maximum, flags;
    if (GetDriveTypeW(drive) != 3 || !GetVolumeInformationW(drive, null, 0, out serial, out maximum, out flags, filesystem, (uint)filesystem.Capacity) || filesystem.ToString() != "NTFS") Fail("path", path);
    return path;
  }
  static string FinalPath(IntPtr handle, string expected) {
    var buffer = new StringBuilder(32768);
    uint length = GetFinalPathNameByHandleW(handle, buffer, (uint)buffer.Capacity, 0);
    if (length == 0 || length >= buffer.Capacity) Fail("path", expected);
    string found = buffer.ToString();
    if (!found.StartsWith("\\\\?\\", StringComparison.Ordinal) || found.StartsWith("\\\\?\\UNC\\", StringComparison.OrdinalIgnoreCase)) Fail("path", expected);
    found = found.Substring(4);
    if (!String.Equals(found.TrimEnd('\\'), expected.TrimEnd('\\'), StringComparison.OrdinalIgnoreCase)) Fail("path", expected);
    return found;
  }
  static FileInfo Information(IntPtr handle, string path, bool directory) {
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info)) { Fail("error", path); return new FileInfo(); }
    if ((info.Attributes & 0x400) != 0) Fail("reparse", path);
    if (((info.Attributes & 0x10) != 0) != directory) Fail("changed", path);
    if (!directory && info.Links != 1) Fail("hardlink", path);
    FinalPath(handle, path);
    return info;
  }
  static string Identity(FileInfo info) { return info.Volume.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8"); }
  static ulong FileId(FileInfo info) { return ((ulong)info.IndexHigh << 32) | info.IndexLow; }
  static IntPtr Open(IntPtr parent, string name, bool directory, bool write, bool ancestor, byte[] create, bool exclusiveFile = false) {
    IntPtr nameMemory = Marshal.StringToHGlobalUni(name), stringMemory = IntPtr.Zero;
    GCHandle pinned = new GCHandle();
    try {
      if (name.Length > 16000) Fail("path", CurrentPath);
      var unicode = new UnicodeString(); unicode.Length = (ushort)(name.Length * 2); unicode.MaximumLength = unicode.Length; unicode.Buffer = nameMemory;
      stringMemory = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeString))); Marshal.StructureToPtr(unicode, stringMemory, false);
      var attrs = new ObjectAttributes(); attrs.Length = Marshal.SizeOf(typeof(ObjectAttributes)); attrs.Root = parent; attrs.Name = stringMemory; attrs.Attributes = 0x40 | 0x1000; // OBJ_DONT_REPARSE, in every component.
      if (create != null) { pinned = GCHandle.Alloc(create, GCHandleType.Pinned); attrs.Security = pinned.AddrOfPinnedObject(); }
      uint access = ReadControl | ReadAttributes | Synchronize | (directory ? ListDirectory | Traverse : 0) | (write ? WriteDac : 0);
      // Exclusive directories suppress SetSecurityInfo's automatic descendant
      // propagation. Ancestors are retained against rename, without requiring
      // an exclusive volume/profile handle. Unchanged files may coexist
      // with Reach's log writers. A file needing repair is re-opened with
      // NO sharing and revalidated before its descriptor may be changed.
      uint sharing = ancestor || (!directory && !exclusiveFile) ? 3U : 0U;
      IntPtr handle; IoStatus io;
      int status = NtCreateFile(out handle, access, ref attrs, out io, IntPtr.Zero, 0, sharing, create == null ? 1U : 2U,
        (directory ? DirectoryOption : NonDirectoryOption) | 0x20, IntPtr.Zero, 0);
      if (status != 0) throw new Win32Exception(RtlNtStatusToDosError(status));
      return handle;
    } finally { if (pinned.IsAllocated) pinned.Free(); if (stringMemory != IntPtr.Zero) Marshal.FreeHGlobal(stringMemory); Marshal.FreeHGlobal(nameMemory); }
  }
  static byte[] NewDirectorySecurity() {
    var security = new DirectorySecurity(); security.SetOwner(new SecurityIdentifier(Me)); security.SetAccessRuleProtection(true, false);
    foreach (string sid in new string[] { Me, SystemSid, AdminSid }) security.AddAccessRule(new FileSystemAccessRule(new SecurityIdentifier(sid), FileSystemRights.FullControl,
      InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    return security.GetSecurityDescriptorBinaryForm();
  }
  static Entry Retain(IntPtr parent, string name, string path, bool directory, bool root) {
    Entry held;
    if (Paths.TryGetValue(path, out held)) {
      if (held.Directory != directory) Fail("changed", path);
      if (root && !held.ProtectedRoot) {
        held.ProtectedRoot = true;
        held.After = Plan(new RawSecurityDescriptor(held.Before, 0), path, true);
        if (held.After != null && !held.CanWrite) Fail("access", path);
      }
      return held;
    }
    Budget(); CurrentPath = path; if (Held.Count >= EntryLimit) Fail("limit", path);
    IntPtr handle = IntPtr.Zero; bool writable = true;
    try {
      try { handle = Open(parent, name, directory, true, false, null); }
      catch (Win32Exception error) {
        if ((error.NativeErrorCode == 2 || error.NativeErrorCode == 3) && root) handle = Open(parent, name, true, true, false, NewDirectorySecurity());
        else if (error.NativeErrorCode == 5) { writable = false; handle = Open(parent, name, directory, false, false, null); }
        else throw;
      }
      FileInfo info = Information(handle, path, directory);
      string identity = Identity(info);
      if (Identities.ContainsKey(identity)) Fail("changed", path);
      var raw = Security(handle, path);
      byte[] before = Bytes(raw), after = Plan(raw, path, root);
      if (after != null && !writable) Fail("access", path);
      if (after != null && !directory) {
        CloseHandle(handle); handle = IntPtr.Zero;
        handle = Open(parent, name, false, true, false, null, true);
        if (Identity(Information(handle, path, false)) != identity || !Equal(Bytes(Security(handle, path)), before)) Fail("changed", path);
      }
      var entry = new Entry { Handle = handle, Path = path, Identity = identity, Directory = directory, CanWrite = writable, ProtectedRoot = root, Before = before, After = after, Root = RootIndex };
      Held.Add(entry); Identities.Add(identity, entry); Paths.Add(path, entry); handle = IntPtr.Zero; return entry;
    } finally { if (handle != IntPtr.Zero) CloseHandle(handle); }
  }
  static List<Child> Children(Entry parent) {
    CurrentPath = parent.Path;
    const int capacity = 65536, header = 104;
    var result = new List<Child>(); var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    IntPtr memory = Marshal.AllocHGlobal(capacity);
    try {
      bool first = true;
      while (true) {
        Budget();
        if (!GetFileInformationByHandleEx(parent.Handle, first ? 11 : 10, memory, capacity)) {
          int error = Marshal.GetLastWin32Error(); if (error == 18) break; throw new Win32Exception(error);
        }
        first = false; int offset = 0;
        while (true) {
          if (offset < 0 || offset > capacity - header) Fail("changed", parent.Path);
          IntPtr record = IntPtr.Add(memory, offset);
          uint next = (uint)Marshal.ReadInt32(record, 0), length = (uint)Marshal.ReadInt32(record, 60);
          int available = next == 0 ? capacity - offset : (int)next;
          if (available < header || available > capacity - offset || (next != 0 && (next & 7) != 0) || length == 0 || (length & 1) != 0 || length > available - header) Fail("changed", parent.Path);
          string name = Marshal.PtrToStringUni(IntPtr.Add(record, header), (int)length / 2);
          if (name != "." && name != "..") {
            if (name.IndexOfAny(new char[] { '\\', '/', ':', '\0' }) >= 0 || name.EndsWith(".", StringComparison.Ordinal) || name.EndsWith(" ", StringComparison.Ordinal) || !names.Add(name)) Fail("path", parent.Path);
            uint attributes = (uint)Marshal.ReadInt32(record, 56);
            if ((attributes & 0x400) != 0) Fail("reparse", Path.Combine(parent.Path, name));
            result.Add(new Child { Name = name, Directory = (attributes & 0x10) != 0, Id = (ulong)Marshal.ReadInt64(record, 96) });
            // Retain enforces the forest's total handle cap. Verification
            // enumerates already-held children, so do not count them twice.
            if (result.Count > EntryLimit) Fail("limit", parent.Path);
          }
          if (next == 0) break;
          offset += (int)next;
        }
      }
      return result;
    } finally { Marshal.FreeHGlobal(memory); }
  }
  static void Walk(Entry directory, int depth) {
    if (depth > DepthLimit) Fail("limit", directory.Path);
    foreach (Child child in Children(directory)) {
      Entry entry = Retain(directory.Handle, child.Name, Path.Combine(directory.Path, child.Name), child.Directory, false);
      FileInfo info = Information(entry.Handle, entry.Path, entry.Directory);
      FileInfo parent = Information(directory.Handle, directory.Path, true);
      if (FileId(info) != child.Id || info.Volume != parent.Volume) Fail("changed", entry.Path);
      directory.Children.Add(child.Name, entry.Identity);
      if (entry.Directory) Walk(entry, depth + 1);
    }
  }
  static Entry Root(string path) {
    string drive = path.Substring(0, 3); CurrentPath = drive;
    IntPtr parent = Open(IntPtr.Zero, "\\??\\" + drive, true, false, true, null); Ancestors.Add(parent);
    Information(parent, drive, true); AncestorSecurity(parent, drive);
    string[] parts = path.Substring(3).Split('\\'); string current = drive;
    if (parts.Length > DepthLimit) Fail("limit", path);
    for (int i = 0; i < parts.Length - 1; i++) {
      current = Path.Combine(current, parts[i]); CurrentPath = current;
      parent = Open(parent, parts[i], true, false, true, null); Ancestors.Add(parent);
      Information(parent, current, true); AncestorSecurity(parent, current);
    }
    return Retain(parent, parts[parts.Length - 1], path, true, true);
  }
  static void Update(Entry entry) {
    Budget();
    if (entry.After == null) return;
    if (!Equal(Bytes(Security(entry.Handle, entry.Path)), entry.Before)) Fail("changed", entry.Path);
    GCHandle pinned = GCHandle.Alloc(entry.After, GCHandleType.Pinned);
    try {
      IntPtr dacl; bool present, defaulted;
      if (!GetSecurityDescriptorDacl(pinned.AddrOfPinnedObject(), out present, out dacl, out defaulted) || !present || dacl == IntPtr.Zero ||
          SetSecurityInfo(entry.Handle, 1, DaclInfo | ProtectedDacl, IntPtr.Zero, IntPtr.Zero, dacl, IntPtr.Zero) != 0) Fail("access", entry.Path);
    } finally { pinned.Free(); }
  }
  static void Verify(Entry entry, bool after) {
    Budget();
    CurrentPath = entry.Path; RootIndex = entry.Root;
    if (Identity(Information(entry.Handle, entry.Path, entry.Directory)) != entry.Identity) Fail("changed", entry.Path);
    var raw = Security(entry.Handle, entry.Path);
    var expected = new RawSecurityDescriptor(after ? entry.After ?? entry.Before : entry.Before, 0);
    if (raw.Owner.Value != expected.Owner.Value || !Equal(AclBytes(raw.DiscretionaryAcl), AclBytes(expected.DiscretionaryAcl)) ||
        (after && entry.After != null && (raw.ControlFlags & ControlFlags.DiscretionaryAclProtected) == 0) || (after && Plan(raw, entry.Path, entry.ProtectedRoot) != null)) Fail("changed", entry.Path);
    if (entry.Directory) {
      List<Child> children = Children(entry);
      if (children.Count != entry.Children.Count) Fail("changed", entry.Path);
      foreach (Child child in children) {
        string identity;
        if (!entry.Children.TryGetValue(child.Name, out identity) || !identity.EndsWith(":" + child.Id.ToString("x16"), StringComparison.Ordinal)) Fail("changed", Path.Combine(entry.Path, child.Name));
      }
    }
  }
  static int Main(string[] args) {
    if (args.Length < 2 || args.Length > 33 || !Account.IsMatch(args[0])) return 2;
    Me = args[0];
    try {
      if (WindowsIdentity.GetCurrent().User.Value != Me) return 2;
      var roots = new List<KeyValuePair<int, string>>();
      for (int i = 1; i < args.Length; i++) { RootIndex = i - 1; CurrentPath = args[i]; string path = Canonical(args[i]); if (path.Length <= 3) Fail("path", path); roots.Add(new KeyValuePair<int, string>(i - 1, path)); }
      roots.Sort(delegate(KeyValuePair<int, string> a, KeyValuePair<int, string> b) { return a.Value.Length.CompareTo(b.Value.Length); });
      var outerRoots = new List<Entry>();
      foreach (var root in roots) {
        RootIndex = root.Key; CurrentPath = root.Value; Entry outer = null;
        foreach (Entry candidate in outerRoots) if (String.Equals(candidate.Path, root.Value, StringComparison.OrdinalIgnoreCase) || root.Value.StartsWith(candidate.Path + "\\", StringComparison.OrdinalIgnoreCase)) { outer = candidate; break; }
        if (outer == null) { outerRoots.Add(Root(root.Value)); continue; }
        if (String.Equals(outer.Path, root.Value, StringComparison.OrdinalIgnoreCase)) continue;
        // Explicit nested roots (normally state\\quick) must exist too. Make
        // only their missing components, atomically private and relative to
        // the already retained state parent; never path-based recursive mkdir.
        Entry parent = outer;
        foreach (string part in root.Value.Substring(outer.Path.Length + 1).Split('\\'))
          parent = Retain(parent.Handle, part, Path.Combine(parent.Path, part), true, true);
      }
      foreach (Entry entry in outerRoots) { RootIndex = entry.Root; Walk(entry, 0); }
      // No existing descriptor is changed until every entry has passed.
      foreach (Entry entry in Held) Verify(entry, false);
      foreach (Entry entry in Held) { CurrentPath = entry.Path; RootIndex = entry.Root; Update(entry); }
      foreach (Entry entry in Held) Verify(entry, true);
      Console.WriteLine("ok"); return 0;
    } catch (Refused error) {
      Console.WriteLine("open " + RootIndex + " " + error.Reason + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(error.Path ?? CurrentPath ?? ""))); return 0;
    } catch (Win32Exception error) {
      string reason = error.NativeErrorCode == 2 || error.NativeErrorCode == 3 ? "missing" : error.NativeErrorCode == 32 || error.NativeErrorCode == 33 ? "sharing" : error.NativeErrorCode == 1920 || error.NativeErrorCode == 4390 || error.NativeErrorCode == 4393 || error.NativeErrorCode == 4395 ? "reparse" : "error";
      Console.WriteLine("open " + RootIndex + " " + reason + " " + Convert.ToBase64String(Encoding.UTF8.GetBytes(CurrentPath ?? ""))); return 0;
    } catch {
      Console.WriteLine("open " + RootIndex + " error " + Convert.ToBase64String(Encoding.UTF8.GetBytes(CurrentPath ?? ""))); return 0;
    } finally {
      for (int i = Held.Count - 1; i >= 0; i--) CloseHandle(Held[i].Handle);
      for (int i = Ancestors.Count - 1; i >= 0; i--) CloseHandle(Ancestors[i]);
    }
  }
}
