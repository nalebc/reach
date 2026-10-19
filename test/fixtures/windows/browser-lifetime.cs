// Actual Windows subprocess/handle fixture for disposable Chrome lifetime tests.
// It speaks only the CDP handshake/close needed by launchChrome. Its descendant
// retains the inherited protocol/stderr handles and a real profile file lock.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

static class BrowserLifetime {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    // These strings belong to Windows, not the out-struct marshaller. Keep
    // their borrowed pointers intact when reading or passing startup info.
    public int cb; public IntPtr reserved, desktop, title;
    public int x, y, width, height, cols, rows, fill, flags;
    public short show; public ushort reservedBytes;
    public IntPtr reservedHandles, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern void GetStartupInfoW(out STARTUPINFO info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFO startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
  static long Created(IntPtr process) {
    long created, exited, kernel, user;
    if (!GetProcessTimes(process, out created, out exited, out kernel, out user)) throw new Win32Exception();
    return created;
  }
  static object Identity(int pid, IntPtr process) { return new { pid = pid, creationTime = Created(process).ToString() }; }
  static string Quote(string text) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in text) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  static IntPtr Handle(STARTUPINFO info, int fd) {
    if (info.reservedHandles == IntPtr.Zero || info.reservedBytes < 4) throw new InvalidOperationException("missing CRT handles");
    int count = Marshal.ReadInt32(info.reservedHandles);
    if (count < 5 || count > 256 || info.reservedBytes < 4 + count * (1 + IntPtr.Size)) throw new InvalidOperationException("invalid CRT handles");
    return Marshal.ReadIntPtr(info.reservedHandles, 4 + count + fd * IntPtr.Size);
  }
  static string Option(string[] args, string name) {
    foreach (string arg in args) if (arg.StartsWith(name + "=", StringComparison.Ordinal)) return arg.Substring(name.Length + 1);
    return null;
  }
  static int Probe(string[] args) {
    int pid = int.Parse(args[1]);
    IntPtr process = OpenProcess(0x1000 | 0x100000 | (args[0] == "--terminate" ? 1u : 0u), false, pid);
    if (process == IntPtr.Zero) {
      int error = Marshal.GetLastWin32Error();
      if (error != 87 && error != 1168) throw new Win32Exception(error);
      Console.WriteLine("{\"alive\":false,\"creationMatches\":false}"); return 0;
    }
    try {
      bool matches = Created(process).ToString() == args[2];
      bool alive = WaitForSingleObject(process, 0) == 0x102;
      if (args[0] == "--terminate" && alive) {
        if (!matches) throw new InvalidOperationException("refusing a reused PID");
        if (!TerminateProcess(process, 1) || WaitForSingleObject(process, 2000) != 0) throw new Win32Exception();
        alive = false;
      }
      Console.WriteLine(Json.Serialize(new { alive = alive, creationMatches = matches })); return 0;
    } finally { CloseHandle(process); }
  }
  static int Main(string[] args) {
    if (args.Length > 0 && (args[0] == "--probe" || args[0] == "--terminate")) return Probe(args);
    if (args.Length > 0 && args[0] == "--hold") {
      Directory.CreateDirectory(Path.GetDirectoryName(args[1]));
      using (var held = new FileStream(args[1], FileMode.Create, FileAccess.ReadWrite, FileShare.ReadWrite)) {
        File.WriteAllText(args[2], "ready"); Thread.Sleep(Timeout.Infinite);
      }
      return 0;
    }
    if (args.Length > 0 && args[0] == "--canary") {
      File.WriteAllText(args[1], Json.Serialize(Identity(Process.GetCurrentProcess().Id, GetCurrentProcess())));
      Thread.Sleep(Timeout.Infinite); return 0;
    }
    string mode = Option(args, "--fixture-mode"), state = Option(args, "--fixture-state"), profile = Option(args, "--user-data-dir");
    if (mode == null || state == null || profile == null) throw new InvalidOperationException("fixture arguments missing");
    STARTUPINFO inherited; GetStartupInfoW(out inherited);
    for (int i = 0; i < 5; i++) if (!SetHandleInformation(Handle(inherited, i), 1, 1)) throw new Win32Exception();
    var startup = inherited; startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    string exe = Process.GetCurrentProcess().MainModule.FileName;
    string ready = state + ".holder-ready";
    var command = new StringBuilder(Quote(exe) + " --hold " + Quote(Path.Combine(profile, "Default", "held")) + " " + Quote(ready));
    PROCESS_INFORMATION holder;
    if (!CreateProcessW(exe, command, IntPtr.Zero, IntPtr.Zero, true, 0x08000400, IntPtr.Zero, null, ref startup, out holder)) throw new Win32Exception();
    object identities = new { parent = Identity(Process.GetCurrentProcess().Id, GetCurrentProcess()), descendant = Identity(holder.pid, holder.process), profile = profile };
    File.WriteAllText(state, Json.Serialize(identities)); CloseHandle(holder.thread); CloseHandle(holder.process);
    var deadline = Stopwatch.StartNew();
    while (!File.Exists(ready)) { if (deadline.ElapsedMilliseconds > 5000) throw new InvalidOperationException("holder did not become ready"); Thread.Sleep(10); }
    using (var input = new FileStream(new SafeFileHandle(Handle(inherited, 3), false), FileAccess.Read))
    using (var output = new FileStream(new SafeFileHandle(Handle(inherited, 4), false), FileAccess.Write)) {
      var packet = new MemoryStream();
      for (;;) {
        int value = input.ReadByte(); if (value < 0) return 0;
        if (value != 0) { packet.WriteByte((byte)value); continue; }
        var request = Json.Deserialize<Dictionary<string, object>>(Encoding.UTF8.GetString(packet.ToArray())); packet.SetLength(0);
        string method = (string)request["method"];
        if (method == "Browser.close" && mode == "unresponsive") continue;
        object result = method == "Browser.getVersion" ? (object)new { product = "Reach lifetime fixture" } : new { };
        byte[] response = Encoding.UTF8.GetBytes(Json.Serialize(new { id = request["id"], result = result }) + "\0");
        output.Write(response, 0, response.Length); output.Flush();
        if (method == "Browser.close") return 0;
      }
    }
  }
}
