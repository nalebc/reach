// Every window Windows shows on this desktop, as it shows it, for the
// real-Windows test only (test/windows-quiet-background.test.mjs): whether
// anything a background Reach runs flashes a window up.
//
//   window-watch.exe <log> <stop file> [<pid>...]
//
// Writes one JSON line per event to <log>: first {"session":n} for itself
// and {"pid":p,"session":n} for each <pid> named, then for every top-level
// window that becomes visible {"shown":hwnd,"pid":p,"class":"…","title":"…",
// "at":ms}. A WinEvent hook (EVENT_OBJECT_SHOW, out of context) sees even a
// window that shows for a moment. Ends once <stop file> exists. C# 5;
// mscorlib and System.dll only.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

static class WindowWatch {
  const uint EVENT_OBJECT_SHOW = 0x8002;
  const uint WINEVENT_OUTOFCONTEXT = 0;
  const int OBJID_WINDOW = 0;
  const uint GA_ROOT = 2;

  delegate void WinEventProc(IntPtr hook, uint kind, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

  [StructLayout(LayoutKind.Sequential)]
  struct MSG {
    public IntPtr hwnd;
    public uint message;
    public IntPtr wParam, lParam;
    public uint time;
    public int x, y;
  }

  [DllImport("user32.dll")]
  static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint process, uint thread, uint flags);
  [DllImport("user32.dll")]
  static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")]
  static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr hwnd, StringBuilder name, int size);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int size);
  [DllImport("user32.dll")]
  static extern UIntPtr SetTimer(IntPtr hwnd, UIntPtr id, uint ms, IntPtr proc);
  [DllImport("user32.dll")]
  static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")]
  static extern bool TranslateMessage(ref MSG msg);
  [DllImport("user32.dll")]
  static extern IntPtr DispatchMessage(ref MSG msg);
  [DllImport("kernel32.dll")]
  static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("kernel32.dll")]
  static extern uint GetCurrentProcessId();
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("kernel32.dll")]
  static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr info, int length, out int returned);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr CommandLineToArgvW(string line, out int count);
  [DllImport("kernel32.dll")]
  static extern IntPtr LocalFree(IntPtr memory);

  static string log;
  static readonly DateTime epoch = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc);
  // Kept alive for as long as Windows may call it.
  static readonly WinEventProc proc = Shown;
  static int described;
  const long EPOCH = 116444736000000000L;
  sealed class Description {
    public uint Pid;
    public long At, Window;
  }
  static readonly Queue<Description> descriptions = new Queue<Description>();
  static readonly AutoResetEvent pending = new AutoResetEvent(false);
  static volatile bool ending;
  static volatile Process diagnosticChild;

  // Diagnostic flags only: values, scripts, paths and unrecognized words are
  // never written. In particular -Command/-EncodedCommand values may be secrets.
  static readonly List<string> SafeFlags = new List<string> {
    "--list", "--quiet", "--all", "--running", "--verbose", "--status", "--version", "--help",
    "--distribution", "--user", "--exec", "--cd", "--system", "--install", "--update", "--shutdown",
    "--terminate", "--unregister", "--import", "--export", "--web-download", "--no-launch",
    "-l", "-q", "-v", "-d", "-u", "-e", "--",
    "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-EncodedCommand", "-File", "-ExecutionPolicy"
  };

  static string CommandFlags(IntPtr process) {
    int needed;
    NtQueryInformationProcess(process, 60, IntPtr.Zero, 0, out needed);
    int headerBytes = IntPtr.Size * 2, capacity = needed;
    if (capacity < headerBytes || capacity > 1 << 20) return "null";
    IntPtr buffer = Marshal.AllocHGlobal(capacity);
    try {
      int returned;
      if (NtQueryInformationProcess(process, 60, buffer, capacity, out returned) != 0 || returned < headerBytes || returned > capacity) return "null";
      int length = (ushort)Marshal.ReadInt16(buffer);
      int maximum = (ushort)Marshal.ReadInt16(buffer, 2);
      IntPtr text = Marshal.ReadIntPtr(buffer, IntPtr.Size);
      if (text == IntPtr.Zero || length == 0 || (length & 1) != 0 || length > maximum) return "null";
      // UNICODE_STRING's pointer is native-width and must name bytes inside
      // this original allocation. Subtract after ordering; never overflow an
      // address by adding the returned length to an unchecked pointer.
      ulong first = IntPtr.Size == 4 ? (uint)buffer.ToInt32() : (ulong)buffer.ToInt64();
      ulong address = IntPtr.Size == 4 ? (uint)text.ToInt32() : (ulong)text.ToInt64();
      if (address < first || (address & 1) != 0) return "null";
      ulong offset = address - first;
      if (offset < (ulong)headerBytes || offset > (ulong)capacity || (ulong)length > (ulong)capacity - offset) return "null";
      int count;
      IntPtr argv = CommandLineToArgvW(Marshal.PtrToStringUni(text, length / 2), out count);
      if (argv == IntPtr.Zero) return "null";
      try {
        var flags = new List<string>();
        for (int i = 1; i < Math.Min(count, 32); i++) {
          string word = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
          flags.Add(Quote(SafeFlags.Exists(flag => string.Equals(flag, word, StringComparison.OrdinalIgnoreCase)) ? word : "<redacted>"));
        }
        return "{\"arguments\":[" + string.Join(",", flags.ToArray()) + "],\"argumentCount\":" + Math.Max(0, count - 1) + ",\"truncated\":" + (count > 32 ? "true" : "false") + "}";
      } finally { LocalFree(argv); }
    } finally { Marshal.FreeHGlobal(buffer); }
  }

  // Best-effort diagnostics, not an ownership oracle. Run in an isolated query
  // process with a 750 ms deadline, off the hook thread. Keep unknown/reused
  // parent identities explicit; no child is attributed to Reach here or
  // excluded from the visibility assertion.
  static string Ancestry(uint pid, long at) {
    var clock = Stopwatch.StartNew();
    long queriedAt = (long)(DateTime.UtcNow - epoch).TotalMilliseconds;
    var entries = new Dictionary<uint, PROCESSENTRY32W>();
    IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
    if (snapshot == new IntPtr(-1)) return "{\"status\":\"snapshot-unavailable\"}";
    try {
      var entry = new PROCESSENTRY32W();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snapshot, ref entry)) do {
        entries[entry.th32ProcessID] = entry;
      } while (entries.Count < 8192 && Process32NextW(snapshot, ref entry));
    } finally { CloseHandle(snapshot); }
    var rows = new List<string>();
    var visited = new List<uint>();
    long childStarted = 0;
    string status = "root";
    while (pid > 0) {
      if (rows.Count >= 8 || clock.ElapsedMilliseconds >= 250) { status = "bounded"; break; }
      if (visited.Contains(pid)) { status = "cycle"; break; }
      visited.Add(pid);
      PROCESSENTRY32W entry;
      if (!entries.TryGetValue(pid, out entry)) { status = "process-unavailable"; break; }
      long created = 0, exited, kernel, user;
      string image = null, flags = "null";
      IntPtr process = OpenProcess(0x1000, false, pid);
      if (process != IntPtr.Zero) try {
        var name = new StringBuilder(32768); uint size = (uint)name.Capacity;
        if (QueryFullProcessImageNameW(process, 0, name, ref size)) image = Path.GetFileName(name.ToString());
        if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) created = 0;
        flags = CommandFlags(process);
      } finally { CloseHandle(process); }
      string relation = created <= EPOCH ? "unknown" : childStarted == 0
        ? ((created - EPOCH) / 10000 > at ? "pid-reused" : "event-pid-candidate")
        : created > childStarted ? "pid-reused" : "snapshot-parent-started-before-child";
      rows.Add("{\"pid\":" + pid + ",\"snapshotParentPid\":" + entry.th32ParentProcessID + ",\"snapshotImage\":" + Quote(entry.szExeFile)
        + ",\"image\":" + (image == null ? "null" : Quote(image)) + ",\"startedAt\":" + (created > EPOCH ? ((created - EPOCH) / 10000).ToString() : "null")
        + ",\"startedTicks\":" + (created > EPOCH ? Quote(created.ToString()) : "null") + ",\"relation\":" + Quote(relation) + ",\"command\":" + flags + "}");
      if (relation == "unknown" || relation == "pid-reused") { status = relation; break; }
      childStarted = created;
      pid = entry.th32ParentProcessID;
    }
    return "{\"status\":" + Quote(status) + ",\"queriedAt\":" + queriedAt + ",\"elapsedMs\":" + clock.ElapsedMilliseconds + ",\"rows\":[" + string.Join(",", rows.ToArray()) + "]}";
  }

  static string Describe(Description request) {
    using (var child = new Process()) {
      child.StartInfo = new ProcessStartInfo(typeof(WindowWatch).Assembly.Location,
        "--describe " + request.Pid + " " + request.At) {
        UseShellExecute = false, CreateNoWindow = true,
        RedirectStandardOutput = true, RedirectStandardError = true
      };
      try {
        child.Start();
        diagnosticChild = child;
        var output = child.StandardOutput.ReadToEndAsync();
        var errors = child.StandardError.ReadToEndAsync();
        if (!child.WaitForExit(750)) {
          try { child.Kill(); } catch (Exception) { }
          child.WaitForExit(100);
          return "{\"status\":\"query-timeout\"}";
        }
        if (child.ExitCode != 0 || !output.Wait(100)) return "{\"status\":\"query-unavailable\"}";
        string result = output.Result.Trim();
        return result.Length <= 65536 && result.StartsWith("{") && result.EndsWith("}")
          ? result : "{\"status\":\"query-unreadable\"}";
      } finally {
        try { if (!child.HasExited) child.Kill(); } catch (Exception) { }
        diagnosticChild = null;
      }
    }
  }

  static void DescribeLoop() {
    while (!ending) {
      Description request = null;
      lock (descriptions) { if (descriptions.Count > 0) request = descriptions.Dequeue(); }
      if (request == null) { pending.WaitOne(100); continue; }
      string ancestry;
      try { ancestry = Describe(request); }
      catch (Exception) { ancestry = "{\"status\":\"query-unavailable\"}"; }
      try { Evidence("{\"evidenceFor\":" + request.Window + ",\"pid\":" + request.Pid + ",\"at\":" + request.At + ",\"ancestry\":" + ancestry + "}"); }
      catch (Exception) { }
    }
  }

  static string Quote(string text) {
    var quoted = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') quoted.Append('\\').Append(c);
      else if (c < ' ') quoted.Append("\\u").Append(((int)c).ToString("x4"));
      else quoted.Append(c);
    }
    return quoted.Append('"').ToString();
  }

  static void Note(string line) {
    File.AppendAllText(log, line + "\n");
  }

  static void Evidence(string line) {
    File.AppendAllText(log + ".processes", line + "\n");
  }

  static string SessionOf(uint pid) {
    uint session;
    return ProcessIdToSessionId(pid, out session) ? session.ToString() : "null";
  }

  static void Shown(IntPtr hook, uint kind, IntPtr hwnd, int idObject, int idChild, uint thread, uint time) {
    if (idObject != OBJID_WINDOW || idChild != 0 || hwnd == IntPtr.Zero) return;
    if (GetAncestor(hwnd, GA_ROOT) != hwnd || !IsWindowVisible(hwnd)) return;
    uint pid;
    GetWindowThreadProcessId(hwnd, out pid);
    var name = new StringBuilder(256);
    GetClassName(hwnd, name, name.Capacity);
    var title = new StringBuilder(512);
    GetWindowText(hwnd, title, title.Capacity);
    long at = (long)(DateTime.UtcNow - epoch).TotalMilliseconds;
    // Save the original visibility event first; a diagnostic failure must not
    // erase it or change the test's visibility result.
    Note("{\"shown\":" + hwnd.ToInt64() + ",\"pid\":" + pid + ",\"class\":" + Quote(name.ToString()) + ",\"title\":" + Quote(title.ToString()) + ",\"at\":" + at + "}");
    if (described++ < 32) {
      lock (descriptions) { descriptions.Enqueue(new Description { Pid = pid, At = at, Window = hwnd.ToInt64() }); }
      pending.Set();
    }
  }

  static int Main(string[] args) {
    if (args.Length == 3 && args[0] == "--describe") {
      uint pid; long at;
      if (!uint.TryParse(args[1], out pid) || !long.TryParse(args[2], out at)) return 2;
      Console.Out.WriteLine(Ancestry(pid, at));
      return 0;
    }
    if (args.Length < 2) return 2;
    log = args[0];
    string stop = args[1];
    Note("{\"session\":" + SessionOf(GetCurrentProcessId()) + "}");
    for (int i = 2; i < args.Length; i++) {
      uint pid;
      if (uint.TryParse(args[i], out pid)) Note("{\"pid\":" + pid + ",\"session\":" + SessionOf(pid) + "}");
    }
    IntPtr hook = SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (hook == IntPtr.Zero) {
      Note("{\"error\":\"SetWinEventHook\"}");
      return 3;
    }
    Note("{\"watching\":true}");
    try { Evidence("{\"limits\":{\"maxEvents\":32,\"maxAncestors\":8,\"queryTimeoutMs\":750,\"commandArguments\":31},\"timing\":\"queued-after-visibility-event\"}"); }
    catch (Exception) { }
    Thread worker = null;
    try { worker = new Thread(DescribeLoop) { IsBackground = true }; worker.Start(); }
    catch (Exception) { worker = null; }
    SetTimer(IntPtr.Zero, UIntPtr.Zero, 100, IntPtr.Zero);
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) {
      if (File.Exists(stop)) break;
      TranslateMessage(ref msg);
      DispatchMessage(ref msg);
    }
    UnhookWinEvent(hook);
    ending = true;
    pending.Set();
    if (worker != null && !worker.Join(1500)) {
      Process child = diagnosticChild;
      if (child != null) try { child.Kill(); } catch (Exception) { }
    }
    return 0;
  }
}
