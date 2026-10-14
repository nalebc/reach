// What Windows gives the account that runs this for each call of the peer
// check, for the real-Windows peer check test only
// (test/windows-tailscaled-peer.test.mjs; docs/parity/D-public-door.md §8).
// It makes scripts/native/tailscaled-peer.cs's calls (the same declarations,
// service name, access masks and table classes) one at a time and says how
// each went, so a refusal names its call; and this process's token.
//
//   peer-probe.exe [<out file>]
//
// Lines: "<call> ok …" or "<call> error <Win32 code>" (NT calls: status in
// hex). Reads only, like the helper. C# 5; mscorlib and System.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;

static class PeerProbe {
  const string ServiceName = "Tailscale";
  const int AF_INET = 2;
  const int MIB_TCP_STATE_ESTAB = 5;
  const int RowSize = 160;
  const int Loopback = 0x0100007F;
  const uint SC_MANAGER_CONNECT = 0x1;
  const uint SERVICE_QUERY_CONFIG = 0x1;
  const uint SERVICE_QUERY_STATUS = 0x4;
  const uint READ_CONTROL = 0x20000;
  const int SC_STATUS_PROCESS_INFO = 0;
  const int DACL_SECURITY_INFORMATION = 4;
  const int SystemProcessInformation = 5;
  const int SystemProcessIdInformation = 88;
  const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
  const uint TOKEN_QUERY = 0x8;
  static readonly List<string> lines = new List<string>();
  static long servicePid;
  static string serviceBinary;

  // The helper's own declarations.
  [DllImport("iphlpapi.dll")]
  static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int tableClass, uint reserved);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool QueryServiceStatusEx(IntPtr service, int level, IntPtr buffer, int size, out int needed);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryServiceConfigW(IntPtr service, IntPtr buffer, int size, out int needed);
  [DllImport("advapi32.dll")]
  static extern bool CloseServiceHandle(IntPtr handle);
  [DllImport("ntdll.dll")]
  static extern int NtQuerySystemInformation(int infoClass, IntPtr info, int length, out int returned);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern int QueryDosDeviceW(string device, StringBuilder target, int max);
  // The probe's own: the service's and the manager's permissions, and the token.
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool QueryServiceObjectSecurity(IntPtr service, int information, IntPtr descriptor, int size, out int needed);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr descriptor, int revision, int information, out IntPtr text, out int length);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentProcessId();
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool GetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length, out int returned);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  [StructLayout(LayoutKind.Sequential)]
  struct QueryServiceConfig {
    public int ServiceType;
    public int StartType;
    public int ErrorControl;
    public IntPtr BinaryPathName;
    public IntPtr LoadOrderGroup;
    public int TagId;
    public IntPtr Dependencies;
    public IntPtr ServiceStartName;
    public IntPtr DisplayName;
  }

  static int Main(string[] args) {
    Say("probe pid " + GetCurrentProcessId() + " 64-bit " + (IntPtr.Size == 8));
    foreach (var part in new Action[] { Token, Manager, Tables, Processes }) {
      try {
        part();
      } catch (Exception error) {
        Say("exception " + error.GetType().Name + " " + error.Message);
      }
    }
    string text = string.Join("\r\n", lines.ToArray()) + "\r\n";
    if (args.Length == 1) File.WriteAllText(args[0], text);
    else Console.Out.Write(text);
    return 0;
  }

  static void Say(string line) {
    lines.Add(line);
  }

  static string Failed(int error) {
    return "error " + error;
  }

  // Who this is: user, session, elevation, integrity, and every group with
  // its attributes (4 enabled, 0x10 deny only, 0xc0000000 logon id).
  static void Token() {
    IntPtr token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, out token)) {
      Say("token " + Failed(Marshal.GetLastWin32Error()));
      return;
    }
    try {
      IntPtr user = TokenInfo(token, 1);
      if (user != IntPtr.Zero) {
        Say("token user " + new SecurityIdentifier(Marshal.ReadIntPtr(user, 0)).Value);
        Marshal.FreeHGlobal(user);
      }
      IntPtr session = TokenInfo(token, 12);
      if (session != IntPtr.Zero) {
        Say("token session " + Marshal.ReadInt32(session, 0));
        Marshal.FreeHGlobal(session);
      }
      IntPtr elevation = TokenInfo(token, 18);
      if (elevation != IntPtr.Zero) {
        Say("token elevation-type " + Marshal.ReadInt32(elevation, 0));
        Marshal.FreeHGlobal(elevation);
      }
      IntPtr label = TokenInfo(token, 25);
      if (label != IntPtr.Zero) {
        Say("token integrity " + new SecurityIdentifier(Marshal.ReadIntPtr(label, 0)).Value);
        Marshal.FreeHGlobal(label);
      }
      IntPtr groups = TokenInfo(token, 2);
      if (groups != IntPtr.Zero) {
        int count = Marshal.ReadInt32(groups, 0);
        var list = new StringBuilder("token groups");
        // TOKEN_GROUPS (64-bit): the count, then 16-byte SID_AND_ATTRIBUTES from 8.
        for (int i = 0; i < count && i < 256; i++) {
          IntPtr sid = Marshal.ReadIntPtr(groups, 8 + 16 * i);
          int attributes = Marshal.ReadInt32(groups, 8 + 16 * i + 8);
          list.Append(" " + new SecurityIdentifier(sid).Value + ":" + attributes.ToString("x"));
        }
        Say(list.ToString());
        Marshal.FreeHGlobal(groups);
      }
    } finally {
      CloseHandle(token);
    }
  }

  static IntPtr TokenInfo(IntPtr token, int infoClass) {
    int needed;
    GetTokenInformation(token, infoClass, IntPtr.Zero, 0, out needed);
    if (needed <= 0 || needed > 1 << 20) {
      Say("token class " + infoClass + " " + Failed(Marshal.GetLastWin32Error()));
      return IntPtr.Zero;
    }
    IntPtr buffer = Marshal.AllocHGlobal(needed);
    if (!GetTokenInformation(token, infoClass, buffer, needed, out needed)) {
      Say("token class " + infoClass + " " + Failed(Marshal.GetLastWin32Error()));
      Marshal.FreeHGlobal(buffer);
      return IntPtr.Zero;
    }
    return buffer;
  }

  // The service manager, then the service with each of the helper's rights
  // alone and together.
  static void Manager() {
    IntPtr manager = OpenSCManagerW(null, null, SC_MANAGER_CONNECT);
    int error = Marshal.GetLastWin32Error();
    Say("OpenSCManagerW CONNECT " + (manager != IntPtr.Zero ? "ok" : Failed(error)));
    IntPtr readable = OpenSCManagerW(null, null, SC_MANAGER_CONNECT | READ_CONTROL);
    error = Marshal.GetLastWin32Error();
    if (readable == IntPtr.Zero) Say("OpenSCManagerW CONNECT|READ_CONTROL " + Failed(error));
    else {
      Say("scmanager dacl " + Dacl(readable));
      CloseServiceHandle(readable);
    }
    if (manager == IntPtr.Zero) return;
    try {
      Service(manager, "QUERY_CONFIG|QUERY_STATUS", SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS);
      Service(manager, "QUERY_STATUS", SERVICE_QUERY_STATUS);
      Service(manager, "QUERY_CONFIG", SERVICE_QUERY_CONFIG);
      Service(manager, "READ_CONTROL", READ_CONTROL);
    } finally {
      CloseServiceHandle(manager);
    }
  }

  static void Service(IntPtr manager, string rights, uint access) {
    IntPtr handle = OpenServiceW(manager, ServiceName, access);
    int error = Marshal.GetLastWin32Error();
    Say("OpenServiceW " + rights + " " + (handle != IntPtr.Zero ? "ok" : Failed(error)));
    if (handle == IntPtr.Zero) return;
    try {
      if ((access & SERVICE_QUERY_STATUS) != 0) {
        IntPtr status = Marshal.AllocHGlobal(64);
        try {
          int needed;
          bool ok = QueryServiceStatusEx(handle, SC_STATUS_PROCESS_INFO, status, 64, out needed);
          error = Marshal.GetLastWin32Error();
          if (!ok) Say("  QueryServiceStatusEx " + Failed(error));
          else {
            // SERVICE_STATUS_PROCESS: type 0, state 4, process id 28.
            long pid = (uint)Marshal.ReadInt32(status, 28);
            Say("  QueryServiceStatusEx ok type 0x" + Marshal.ReadInt32(status, 0).ToString("x") + " state " + Marshal.ReadInt32(status, 4) + " pid " + pid);
            if (pid > 0) servicePid = pid;
          }
        } finally {
          Marshal.FreeHGlobal(status);
        }
      }
      if ((access & SERVICE_QUERY_CONFIG) != 0) {
        int size;
        bool sized = QueryServiceConfigW(handle, IntPtr.Zero, 0, out size);
        error = Marshal.GetLastWin32Error();
        Say("  QueryServiceConfigW size " + size + (sized ? " ok" : " " + Failed(error)));
        if (size > 0 && size <= 65536) {
          IntPtr config = Marshal.AllocHGlobal(size);
          try {
            bool ok = QueryServiceConfigW(handle, config, size, out size);
            error = Marshal.GetLastWin32Error();
            if (!ok) Say("  QueryServiceConfigW " + Failed(error));
            else {
              QueryServiceConfig value = (QueryServiceConfig)Marshal.PtrToStructure(config, typeof(QueryServiceConfig));
              string account = value.ServiceStartName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(value.ServiceStartName);
              string binary = value.BinaryPathName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(value.BinaryPathName);
              serviceBinary = binary;
              Say("  QueryServiceConfigW ok type 0x" + value.ServiceType.ToString("x") + " start " + value.StartType + " account " + account + " binary " + binary);
            }
          } finally {
            Marshal.FreeHGlobal(config);
          }
        }
      }
      if (access == READ_CONTROL) Say("  service dacl " + Dacl(handle));
    } finally {
      CloseServiceHandle(handle);
    }
  }

  static string Dacl(IntPtr handle) {
    int needed;
    QueryServiceObjectSecurity(handle, DACL_SECURITY_INFORMATION, IntPtr.Zero, 0, out needed);
    int error = Marshal.GetLastWin32Error();
    if (needed <= 0 || needed > 65536) return Failed(error);
    IntPtr descriptor = Marshal.AllocHGlobal(needed);
    try {
      if (!QueryServiceObjectSecurity(handle, DACL_SECURITY_INFORMATION, descriptor, needed, out needed)) return Failed(Marshal.GetLastWin32Error());
      IntPtr text;
      int length;
      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(descriptor, 1, DACL_SECURITY_INFORMATION, out text, out length)) return Failed(Marshal.GetLastWin32Error());
      string sddl = Marshal.PtrToStringUni(text);
      LocalFree(text);
      return sddl;
    } finally {
      Marshal.FreeHGlobal(descriptor);
    }
  }

  // The TCP table as the helper reads it (class 8), and with PIDs only (class
  // 5) to compare: rows, established ones, and those without a creation time.
  static void Tables() {
    foreach (int tableClass in new int[] { 8, 5 }) {
      int size = 0;
      uint first = GetExtendedTcpTable(IntPtr.Zero, ref size, false, AF_INET, tableClass, 0);
      string line = "GetExtendedTcpTable class " + tableClass + " sizing " + first + " size " + size;
      if (size > 0 && size <= 64 << 20) {
        size += 16384;
        IntPtr table = Marshal.AllocHGlobal(size);
        try {
          uint result = GetExtendedTcpTable(table, ref size, false, AF_INET, tableClass, 0);
          line += " result " + result;
          if (result == 0) {
            int count = Marshal.ReadInt32(table, 0);
            line += " rows " + count;
            if (tableClass == 8 && count >= 0 && 8L + (long)count * RowSize <= size) {
              int established = 0, loopback = 0, unstamped = 0;
              for (int i = 0; i < count; i++) {
                IntPtr row = new IntPtr(table.ToInt64() + 8 + (long)i * RowSize);
                if (Marshal.ReadInt32(row, 0) != MIB_TCP_STATE_ESTAB) continue;
                established++;
                if (Marshal.ReadInt32(row, 4) == Loopback && Marshal.ReadInt32(row, 12) == Loopback) loopback++;
                if (Marshal.ReadInt64(row, 24) == 0) unstamped++;
              }
              line += " established " + established + " loopback " + loopback + " unstamped " + unstamped;
            }
          }
        } finally {
          Marshal.FreeHGlobal(table);
        }
      }
      Say(line);
    }
  }

  // The process list (class 5) and the kernel's program path (class 88) of
  // the service's process and this one, compared with the service's file.
  static void Processes() {
    int size = 1 << 20;
    int status;
    int count = 0;
    string service = "absent";
    while (true) {
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int needed;
        status = NtQuerySystemInformation(SystemProcessInformation, buffer, size, out needed);
        if (status == STATUS_INFO_LENGTH_MISMATCH && size < 64 << 20) {
          size = Math.Min(64 << 20, Math.Max(size * 2, needed + 65536));
          continue;
        }
        if (status == 0) {
          long offset = 0;
          while (true) {
            IntPtr entry = new IntPtr(buffer.ToInt64() + offset);
            count++;
            long id = Marshal.ReadIntPtr(entry, 0x50).ToInt64();
            if (servicePid > 0 && id == servicePid) {
              int length = Marshal.ReadInt16(entry, 0x38) & 0xFFFF;
              IntPtr image = Marshal.ReadIntPtr(entry, 0x40);
              service = "image " + (image == IntPtr.Zero ? "" : Marshal.PtrToStringUni(image, length / 2)) +
                " parent " + Marshal.ReadIntPtr(entry, 0x58).ToInt64() + " session " + Marshal.ReadInt32(entry, 0x64) +
                " created " + Marshal.ReadInt64(entry, 0x20);
            }
            int next = Marshal.ReadInt32(entry, 0);
            if (next <= 0) break;
            offset += next;
            if (offset + 0x68 > size) break;
          }
        }
        break;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
    Say("NtQuerySystemInformation 5 status 0x" + status.ToString("x8") + " processes " + count + " service " + servicePid + " " + service);
    if (servicePid > 0) Say("NtQuerySystemInformation 88 service " + ImagePath(servicePid));
    Say("NtQuerySystemInformation 88 self " + ImagePath(GetCurrentProcessId()));
    string file = serviceBinary == null ? null : Executable(serviceBinary);
    if (file != null) {
      var device = new StringBuilder(1024);
      int got = QueryDosDeviceW(file.Substring(0, 2), device, device.Capacity);
      int error = Marshal.GetLastWin32Error();
      Say("QueryDosDeviceW " + file.Substring(0, 2) + " " + (got == 0 ? Failed(error) : "ok " + device + file.Substring(2)));
    }
  }

  static string ImagePath(long pid) {
    const int capacity = 65536;
    IntPtr name = Marshal.AllocHGlobal(capacity);
    IntPtr info = Marshal.AllocHGlobal(24);
    try {
      Marshal.WriteIntPtr(info, 0, new IntPtr(pid));
      Marshal.WriteInt16(info, 8, 0);
      Marshal.WriteInt16(info, 10, unchecked((short)(capacity - 2)));
      Marshal.WriteInt32(info, 12, 0);
      Marshal.WriteIntPtr(info, 16, name);
      int returned;
      int status = NtQuerySystemInformation(SystemProcessIdInformation, info, 24, out returned);
      if (status != 0) return "status 0x" + status.ToString("x8");
      int length = Marshal.ReadInt16(info, 8) & 0xFFFF;
      return "ok " + (length == 0 ? "(empty)" : Marshal.PtrToStringUni(name, length / 2));
    } finally {
      Marshal.FreeHGlobal(info);
      Marshal.FreeHGlobal(name);
    }
  }

  // The helper's reading of the service's command line.
  static string Executable(string binary) {
    string file;
    if (binary.StartsWith("\"")) {
      int end = binary.IndexOf('"', 1);
      if (end < 0) return null;
      file = binary.Substring(1, end - 1);
    } else {
      if (binary.IndexOf(' ') >= 0 || binary.IndexOf('\t') >= 0) return null;
      file = binary;
    }
    if (file.Length < 4 || !char.IsLetter(file[0]) || file[1] != ':' || file[2] != '\\') return null;
    return file;
  }
}
