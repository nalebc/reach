// Is this connection from Tailscale's own service? Windows' half of the check
// that keeps Reach's keyed route for tailscaled alone (server/tailscaled-peer.mjs,
// docs/parity/D-public-door.md §4.4 and §6). On a Mac a Unix socket only
// tailscaled can reach does this; Windows' Serve can only proxy to a loopback
// port, where any local user can connect.
//
// The rule: the socket's owner is the running Windows service named
// "Tailscale" (LocalSystem, its own process, tailscaled.exe), or that
// process's direct child (Tailscale's service starts its daemon as
// `tailscaled.exe /subproc`), created after it, in session 0, running the same
// file. A standard user can't make a child of a LocalSystem service, and a
// live process id is unique, so such a child is the service's own.
//
// Lines out:  ready 1  |  error <code>   (once, at start)
// Lines in:   q <id> <ingress port> <port>[,<port>]...   (up to 64 ports)
// Lines out:  a <id> <port>:<answer>...   answer t:<ms> | o | g | n | e
//   t:<ms>  Tailscale's, the connection created at <ms> (Unix time); Reach
//           accepts it only if that's no later than when it accepted it
//   o       another process owns it        g  no such connection
//   n       Tailscale's service isn't running as expected
//   e       Windows wouldn't say
// It reads Windows' TCP table, the service manager and the process list, and
// nothing else: it writes no file, logs nothing and opens no connection. The
// service and file names are fixed here; nothing passed to it changes them.
// It ends when its input does, or at a line it doesn't understand (exit 2).
// C# 5 (the .NET Framework 4.x compiler), mscorlib and System only; 64-bit.
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class TailscaledPeer {
  const string ServiceName = "Tailscale";
  const string ImageName = "tailscaled.exe";
  const int AF_INET = 2;
  const int TCP_TABLE_OWNER_MODULE_ALL = 8;
  const int MIB_TCP_STATE_ESTAB = 5;
  const int RowSize = 160;
  const int Loopback = 0x0100007F; // 127.0.0.1 as the table stores it
  const uint ERROR_INSUFFICIENT_BUFFER = 122;
  const int ERROR_ACCESS_DENIED = 5;
  const int ERROR_SERVICE_DOES_NOT_EXIST = 1060;
  const uint SC_MANAGER_CONNECT = 0x1;
  const uint SERVICE_QUERY_CONFIG = 0x1;
  const uint SERVICE_QUERY_STATUS = 0x4;
  const int SC_STATUS_PROCESS_INFO = 0;
  const int SERVICE_RUNNING = 4;
  const int SERVICE_WIN32_OWN_PROCESS = 0x10;
  const int SystemProcessInformation = 5;
  const int SystemProcessIdInformation = 88;
  const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);
  const int MaxSnapshot = 64 << 20;
  const int MaxTable = 64 << 20;
  const long UnixEpoch = 116444736000000000L; // 1970-01-01 as a FILETIME
  static readonly Regex QueryLine = new Regex("^q ([1-9][0-9]{0,8}) ([1-9][0-9]{0,4}) ([1-9][0-9]{0,4}(?:,[1-9][0-9]{0,4}){0,63})$");

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

  class Service {
    public long Pid;
    public string NtPath;
  }

  class Process {
    public long Parent;
    public long Created;
    public string Image;
    public int Session;
  }

  static int Main() {
    if (!Environment.Is64BitOperatingSystem) { Say("error arch"); return 1; }
    if (IntPtr.Size != 8) { Say("error arch32"); return 1; }
    Service service;
    string problem = ReadService(out service);
    if (problem == null) {
      // What every answer needs, tried once now: a PC where Windows won't
      // say falls back to pairing codes at once, with the reason.
      if (Connections(1) == null || Snapshot() == null) problem = "access";
      else if (!SamePath(NtImagePath(service.Pid), service.NtPath)) problem = "not-tailscaled";
    }
    if (problem != null) { Say("error " + problem); return 1; }
    Say("ready 1");
    while (true) {
      string line = Console.In.ReadLine();
      if (line == null) return 0;
      Match query = line.Length <= 4096 ? QueryLine.Match(line) : Match.Empty;
      if (!query.Success) return 2;
      int ingress = int.Parse(query.Groups[2].Value);
      string[] listed = query.Groups[3].Value.Split(',');
      int[] ports = new int[listed.Length];
      for (int i = 0; i < listed.Length; i++) ports[i] = int.Parse(listed[i]);
      if (ingress > 65535) return 2;
      foreach (int port in ports) if (port > 65535) return 2;
      Say(Answer(query.Groups[1].Value, ingress, ports));
    }
  }

  static void Say(string line) {
    Console.Out.Write(line + "\n");
    Console.Out.Flush();
  }

  static bool SamePath(string a, string b) {
    return a != null && b != null && a.Length > 0 && string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
  }

  static string Answer(string id, int ingress, int[] ports) {
    string[] answers = new string[ports.Length];
    long[] owners = new long[ports.Length];
    long[] created = new long[ports.Length];
    // 1. The connection Tailscale opened to Reach: its owner and its creation.
    List<long[]> before = Connections(ingress);
    for (int i = 0; i < ports.Length; i++)
      answers[i] = before == null ? "e" : Find(before, ports[i], out owners[i], out created[i]);
    // 2. Tailscale's Windows service, as the service manager has it now.
    Service service;
    string problem = ReadService(out service);
    if (problem != null) return Compose(id, ports, answers, problem == "access" ? "e" : "n");
    // 3. The service's process or its direct child, created after it, in
    // session 0, running the very file the service manager starts.
    Dictionary<long, Process> processes = Snapshot();
    if (processes == null) return Compose(id, ports, answers, "e");
    Process self;
    if (!processes.TryGetValue(service.Pid, out self)) return Compose(id, ports, answers, "n");
    if (!SamePath(NtImagePath(service.Pid), service.NtPath)) return Compose(id, ports, answers, "o");
    for (int i = 0; i < ports.Length; i++) {
      if (answers[i] != null) continue;
      Process owner = self;
      if (owners[i] != service.Pid) {
        if (!processes.TryGetValue(owners[i], out owner) ||
            owner.Parent != service.Pid ||
            owner.Created < self.Created ||
            !string.Equals(owner.Image, ImageName, StringComparison.OrdinalIgnoreCase) ||
            owner.Session != 0 ||
            !SamePath(NtImagePath(owners[i]), service.NtPath)) {
          answers[i] = "o";
          continue;
        }
      }
      // A connection older than its owner: the id was another process's then.
      if (created[i] < owner.Created) answers[i] = "o";
    }
    // 4. Again: the same connection, owner and creation, and the same running
    // service, so the owner lived through the check.
    List<long[]> after = Connections(ingress);
    Service again;
    string later = ReadService(out again);
    for (int i = 0; i < ports.Length; i++) {
      if (answers[i] != null) continue;
      long owner = 0, made = 0;
      string found = after == null ? "e" : Find(after, ports[i], out owner, out made);
      if (found != null) answers[i] = found;
      else if (owner != owners[i] || made != created[i]) answers[i] = "o";
      else if (later != null) answers[i] = later == "access" ? "e" : "n";
      else if (again.Pid != service.Pid) answers[i] = "n";
      else {
        long ms = (created[i] - UnixEpoch) / 10000;
        answers[i] = ms > 0 ? "t:" + ms : "e";
      }
    }
    return Compose(id, ports, answers, "e");
  }

  // Each port's answer; `rest` for those not answered yet.
  static string Compose(string id, int[] ports, string[] answers, string rest) {
    var line = new StringBuilder("a " + id);
    for (int i = 0; i < ports.Length; i++) line.Append(" " + ports[i] + ":" + (answers[i] ?? rest));
    return line.ToString();
  }

  // The one connection from 127.0.0.1:<port> to Reach's 127.0.0.1:<ingress>:
  // null when found (its owner and creation set), else g, o or e.
  static string Find(List<long[]> rows, int port, out long owner, out long created) {
    owner = 0;
    created = 0;
    int count = 0;
    foreach (long[] row in rows) {
      if (row[0] != port) continue;
      count++;
      owner = row[1];
      created = row[2];
    }
    if (count == 0 || owner == 0) return "g";
    if (count > 1) return "o";
    if (created == 0) return "e";
    return null;
  }

  static int Port(int value) {
    return ((value & 0xFF) << 8) | ((value >> 8) & 0xFF);
  }

  // Established IPv4 connections from 127.0.0.1 to 127.0.0.1:<ingress>:
  // { local port, owner's id, creation (FILETIME) }. null when Windows won't say.
  static List<long[]> Connections(int ingress) {
    int size = 0;
    GetExtendedTcpTable(IntPtr.Zero, ref size, false, AF_INET, TCP_TABLE_OWNER_MODULE_ALL, 0);
    for (int attempt = 0; attempt < 4; attempt++) {
      if (size <= 0 || size > MaxTable) return null;
      IntPtr table = Marshal.AllocHGlobal(size);
      try {
        uint result = GetExtendedTcpTable(table, ref size, false, AF_INET, TCP_TABLE_OWNER_MODULE_ALL, 0);
        if (result == ERROR_INSUFFICIENT_BUFFER) { size += 16384; continue; }
        if (result != 0) return null;
        int count = Marshal.ReadInt32(table, 0);
        // Rows start at 8: each holds a FILETIME, so they're 8-byte aligned.
        if (count < 0 || 8L + (long)count * RowSize > size) return null;
        var rows = new List<long[]>();
        for (int i = 0; i < count; i++) {
          IntPtr row = new IntPtr(table.ToInt64() + 8 + (long)i * RowSize);
          if (Marshal.ReadInt32(row, 0) != MIB_TCP_STATE_ESTAB) continue;
          if (Marshal.ReadInt32(row, 4) != Loopback || Marshal.ReadInt32(row, 12) != Loopback) continue;
          if (Port(Marshal.ReadInt32(row, 16)) != ingress) continue;
          rows.Add(new long[] { Port(Marshal.ReadInt32(row, 8)), (uint)Marshal.ReadInt32(row, 20), Marshal.ReadInt64(row, 24) });
        }
        return rows;
      } finally {
        Marshal.FreeHGlobal(table);
      }
    }
    return null;
  }

  // The service "Tailscale": running in its own process as LocalSystem, from
  // a file named tailscaled.exe. null, or the reason it isn't.
  static string ReadService(out Service service) {
    service = null;
    IntPtr manager = OpenSCManagerW(null, null, SC_MANAGER_CONNECT);
    if (manager == IntPtr.Zero) return Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED ? "access" : "no-service";
    try {
      IntPtr handle = OpenServiceW(manager, ServiceName, SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS);
      if (handle == IntPtr.Zero) {
        int error = Marshal.GetLastWin32Error();
        return error == ERROR_ACCESS_DENIED ? "access" : "no-service";
      }
      try {
        long pid;
        IntPtr status = Marshal.AllocHGlobal(64);
        try {
          int needed;
          if (!QueryServiceStatusEx(handle, SC_STATUS_PROCESS_INFO, status, 64, out needed))
            return Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED ? "access" : "not-running";
          // SERVICE_STATUS_PROCESS: type 0, state 4, process id 28.
          if (Marshal.ReadInt32(status, 4) != SERVICE_RUNNING) return "not-running";
          if (Marshal.ReadInt32(status, 0) != SERVICE_WIN32_OWN_PROCESS) return "not-own-process";
          pid = (uint)Marshal.ReadInt32(status, 28);
          if (pid <= 0) return "not-running";
        } finally {
          Marshal.FreeHGlobal(status);
        }
        int size;
        QueryServiceConfigW(handle, IntPtr.Zero, 0, out size);
        if (size <= 0 || size > 65536) return Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED ? "access" : "not-tailscaled";
        IntPtr config = Marshal.AllocHGlobal(size);
        try {
          if (!QueryServiceConfigW(handle, config, size, out size))
            return Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED ? "access" : "not-tailscaled";
          QueryServiceConfig value = (QueryServiceConfig)Marshal.PtrToStructure(config, typeof(QueryServiceConfig));
          string account = value.ServiceStartName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(value.ServiceStartName);
          if (!string.Equals(account, "LocalSystem", StringComparison.OrdinalIgnoreCase)) return "not-localsystem";
          string binary = value.BinaryPathName == IntPtr.Zero ? "" : Marshal.PtrToStringUni(value.BinaryPathName);
          string file = Executable(binary);
          if (file == null || !string.Equals(Path.GetFileName(file), ImageName, StringComparison.OrdinalIgnoreCase)) return "not-tailscaled";
          bool refused;
          string nt = NtPath(file, out refused);
          // Windows refusing to name the drive's device is Windows not
          // saying, not Tailscale set up otherwise.
          if (nt == null) return refused ? "access" : "not-tailscaled";
          service = new Service();
          service.Pid = pid;
          service.NtPath = nt;
          return null;
        } finally {
          Marshal.FreeHGlobal(config);
        }
      } finally {
        CloseServiceHandle(handle);
      }
    } finally {
      CloseServiceHandle(manager);
    }
  }

  // The service's program: quoted, or a path with no spaces (an unquoted one
  // with spaces could start something else). A drive path only.
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

  // C:\Program Files\… as the kernel names it: \Device\HarddiskVolume3\Program Files\…
  // null when it can't be had; `refused` when Windows denied the asking (a
  // token sharing an elevated logon's drive map, as a restricted one does).
  static string NtPath(string file, out bool refused) {
    var device = new StringBuilder(1024);
    int length = QueryDosDeviceW(file.Substring(0, 2), device, device.Capacity);
    refused = length == 0 && Marshal.GetLastWin32Error() == ERROR_ACCESS_DENIED;
    if (length == 0 || device.Length == 0) return null;
    return device.ToString() + file.Substring(2);
  }

  // The kernel's path of a process's program, without opening the process.
  static string NtImagePath(long pid) {
    const int capacity = 65536;
    IntPtr name = Marshal.AllocHGlobal(capacity);
    IntPtr info = Marshal.AllocHGlobal(24);
    try {
      // SYSTEM_PROCESS_ID_INFORMATION: process id, then a UNICODE_STRING
      // (length 8, maximum 10, buffer 16) for the kernel to fill.
      Marshal.WriteIntPtr(info, 0, new IntPtr(pid));
      Marshal.WriteInt16(info, 8, 0);
      Marshal.WriteInt16(info, 10, unchecked((short)(capacity - 2)));
      Marshal.WriteInt32(info, 12, 0);
      Marshal.WriteIntPtr(info, 16, name);
      int returned;
      if (NtQuerySystemInformation(SystemProcessIdInformation, info, 24, out returned) != 0) return null;
      int length = Marshal.ReadInt16(info, 8) & 0xFFFF;
      return length == 0 ? null : Marshal.PtrToStringUni(name, length / 2);
    } finally {
      Marshal.FreeHGlobal(info);
      Marshal.FreeHGlobal(name);
    }
  }

  // Every process: parent, creation, program name and session, by id.
  static Dictionary<long, Process> Snapshot() {
    int size = 1 << 20;
    while (true) {
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int needed;
        int status = NtQuerySystemInformation(SystemProcessInformation, buffer, size, out needed);
        if (status == STATUS_INFO_LENGTH_MISMATCH) {
          if (size >= MaxSnapshot) return null;
          size = Math.Min(MaxSnapshot, Math.Max(size * 2, needed + 65536));
          continue;
        }
        if (status != 0) return null;
        var processes = new Dictionary<long, Process>();
        long offset = 0;
        while (true) {
          IntPtr entry = new IntPtr(buffer.ToInt64() + offset);
          // SYSTEM_PROCESS_INFORMATION (64-bit): next 0x00, creation 0x20,
          // name 0x38 (length) and 0x40 (buffer), id 0x50, parent 0x58,
          // session 0x64.
          var process = new Process();
          process.Created = Marshal.ReadInt64(entry, 0x20);
          int length = Marshal.ReadInt16(entry, 0x38) & 0xFFFF;
          IntPtr image = Marshal.ReadIntPtr(entry, 0x40);
          process.Image = image == IntPtr.Zero ? "" : Marshal.PtrToStringUni(image, length / 2);
          long id = Marshal.ReadIntPtr(entry, 0x50).ToInt64();
          process.Parent = Marshal.ReadIntPtr(entry, 0x58).ToInt64();
          process.Session = Marshal.ReadInt32(entry, 0x64);
          processes[id] = process;
          int next = Marshal.ReadInt32(entry, 0);
          if (next <= 0) break;
          offset += next;
          if (offset + 0x68 > size) return null;
        }
        return processes;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
  }
}
