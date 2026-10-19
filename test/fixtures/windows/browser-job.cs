// A test-only browser owner. C# 5 / .NET Framework, built by windowsFixture.
// No PID lookup or image-name kill: the suspended browser joins this unnamed
// job before running. Its descendants remain owned after their parent exits.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class BrowserJob {
  const uint CREATE_SUSPENDED = 4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000, EXTENDED_STARTUPINFO_PRESENT = 0x80000;
  const uint KILL_ON_JOB_CLOSE = 0x2000, INHERIT = 1;
  const int STARTF_USESTDHANDLES = 0x100;
  static readonly IntPtr Invalid = new IntPtr(-1);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct STARTUPINFO {
    public int cb; public string reserved, desktop, title;
    public int x, y, width, height, cols, rows, fill, flags;
    public short show; public ushort reservedBytes;
    public IntPtr reservedHandles, stdin, stdout, stderr;
  }
  [StructLayout(LayoutKind.Sequential)] struct STARTUPINFOEX { public STARTUPINFO info; public IntPtr attributes; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr process, thread; public int pid, tid; }
  [StructLayout(LayoutKind.Sequential)] struct LIMITS {
    public long processTime, jobTime; public uint flags; public UIntPtr minWorking, maxWorking;
    public uint activeLimit; public UIntPtr affinity; public uint priority, scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] struct EXTENDED_LIMITS {
    public LIMITS basic; public IO_COUNTERS io; public UIntPtr processMemory, jobMemory, peakProcess, peakJob;
  }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNTING {
    public long userTime, kernelTime, periodUser, periodKernel;
    public uint faults, total, active, terminated;
  }
  [StructLayout(LayoutKind.Sequential)] struct SECURITY_ATTRIBUTES { public int size; public IntPtr descriptor; public bool inherit; }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern void GetStartupInfoW(out STARTUPINFO info);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref EXTENDED_LIMITS info, int size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, out ACCOUNTING info, int size, out int returned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool assigned);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcessW(string app, string command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX startup, out PROCESS_INFORMATION process);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr bytes);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr bytes, IntPtr previous, IntPtr returned);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFileW(string name, uint access, uint share, ref SECURITY_ATTRIBUTES attributes, uint creation, uint flags, IntPtr template);

  // libuv's Windows CRT stdio buffer: uint count, byte flags[count], HANDLE[count].
  // Pass fd 3/4 through byte-for-byte; neither the control input nor status fd 5
  // is inherited by Chrome. The explicit handle list excludes every other handle.
  static IntPtr Handle(STARTUPINFO info, int fd) {
    if (info.reservedHandles == IntPtr.Zero || info.reservedBytes < 4) throw new InvalidOperationException("missing stdio table");
    int count = Marshal.ReadInt32(info.reservedHandles);
    if (count < 6 || count > 256 || info.reservedBytes < 4 + count * (1 + IntPtr.Size)) throw new InvalidOperationException("invalid stdio table");
    return Marshal.ReadIntPtr(info.reservedHandles, 4 + count + fd * IntPtr.Size);
  }
  static string Quote(string text) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in text) {
      if (c == '\\') { slashes++; continue; }
      result.Append('\\', c == '"' ? slashes * 2 + 1 : slashes); result.Append(c); slashes = 0;
    }
    result.Append('\\', slashes * 2); return result.Append('"').ToString();
  }
  static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
  static ACCOUNTING Count(IntPtr job) {
    ACCOUNTING info; int returned;
    Check(QueryInformationJobObject(job, 1, out info, Marshal.SizeOf(typeof(ACCOUNTING)), out returned)); return info;
  }

  static int Main(string[] args) {
    IntPtr job = IntPtr.Zero, table = IntPtr.Zero, attributes = IntPtr.Zero, handleList = IntPtr.Zero, nul = Invalid;
    PROCESS_INFORMATION browser = new PROCESS_INFORMATION(); StreamWriter status = null;
    bool attributeListReady = false; string stage = "stdio"; var clock = Stopwatch.StartNew();
    try {
      STARTUPINFO inherited; GetStartupInfoW(out inherited);
      status = new StreamWriter(new FileStream(new SafeFileHandle(Handle(inherited, 5), false), FileAccess.Write), new UTF8Encoding(false)); status.AutoFlush = true;
      if (args.Length == 0) throw new InvalidOperationException("missing browser");
      stage = "job";
      job = CreateJobObjectW(IntPtr.Zero, null); Check(job != IntPtr.Zero);
      var limits = new EXTENDED_LIMITS(); limits.basic.flags = KILL_ON_JOB_CLOSE;
      Check(SetInformationJobObject(job, 9, ref limits, Marshal.SizeOf(typeof(EXTENDED_LIMITS))));
      var sa = new SECURITY_ATTRIBUTES { size = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)), inherit = true };
      nul = CreateFileW("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero); Check(nul != Invalid);
      table = Marshal.AllocHGlobal(4 + 5 * (1 + IntPtr.Size)); Marshal.WriteInt32(table, 5);
      var handles = new List<IntPtr>();
      for (int i = 0; i < 5; i++) {
        IntPtr handle = i == 0 ? nul : Handle(inherited, i);
        Check(handle != IntPtr.Zero && handle != Invalid && SetHandleInformation(handle, INHERIT, INHERIT));
        Marshal.WriteByte(table, 4 + i, i == 0 ? (byte)0x41 : Marshal.ReadByte(inherited.reservedHandles, 4 + i));
        Marshal.WriteIntPtr(table, 4 + 5 + i * IntPtr.Size, handle);
        if (!handles.Contains(handle)) handles.Add(handle);
      }
      IntPtr bytes = IntPtr.Zero; InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref bytes); Check(bytes != IntPtr.Zero);
      attributes = Marshal.AllocHGlobal(bytes); Check(InitializeProcThreadAttributeList(attributes, 1, 0, ref bytes)); attributeListReady = true;
      handleList = Marshal.AllocHGlobal(handles.Count * IntPtr.Size);
      for (int i = 0; i < handles.Count; i++) Marshal.WriteIntPtr(handleList, i * IntPtr.Size, handles[i]);
      Check(UpdateProcThreadAttribute(attributes, 0, new IntPtr(0x20002), handleList, new IntPtr(handles.Count * IntPtr.Size), IntPtr.Zero, IntPtr.Zero));
      var startup = new STARTUPINFOEX(); startup.info.cb = Marshal.SizeOf(typeof(STARTUPINFOEX)); startup.attributes = attributes;
      startup.info.flags = STARTF_USESTDHANDLES; startup.info.stdin = nul; startup.info.stdout = Handle(inherited, 1); startup.info.stderr = Handle(inherited, 2);
      startup.info.reservedHandles = table; startup.info.reservedBytes = (ushort)(4 + 5 * (1 + IntPtr.Size));
      var command = new StringBuilder(); foreach (string arg in args) { if (command.Length > 0) command.Append(' '); command.Append(Quote(arg)); }
      stage = "create-suspended";
      Check(CreateProcessW(args[0], command.ToString(), IntPtr.Zero, IntPtr.Zero, true,
        CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, IntPtr.Zero, null, ref startup, out browser));
      stage = "assign"; Check(AssignProcessToJobObject(job, browser.process)); bool assigned; Check(IsProcessInJob(browser.process, job, out assigned) && assigned);
      long created, exited, kernel, user; Check(GetProcessTimes(browser.process, out created, out exited, out kernel, out user));
      status.WriteLine("{\"kind\":\"started\",\"pid\":" + browser.pid + ",\"creationTime\":\"" + created + "\",\"assignedBeforeResume\":true,\"elapsedMs\":" + clock.ElapsedMilliseconds + "}");
      stage = "resume"; Check(ResumeThread(browser.thread) != uint.MaxValue); CloseHandle(browser.thread); browser.thread = IntPtr.Zero;
      var terminate = new ManualResetEvent(false);
      new Thread(() => { try { while (Console.ReadLine() != null) { terminate.Set(); break; } } catch {} finally { terminate.Set(); } }) { IsBackground = true }.Start();
      bool requested = false, parentExited = false; long stopAt = 0;
      stage = "wait";
      for (;;) {
        if (!parentExited && WaitForSingleObject(browser.process, 0) == 0) {
          uint code; Check(GetExitCodeProcess(browser.process, out code)); parentExited = true;
          status.WriteLine("{\"kind\":\"parent-exit\",\"exitCode\":" + code + ",\"active\":" + Count(job).active + ",\"elapsedMs\":" + clock.ElapsedMilliseconds + "}");
        }
        ACCOUNTING count = Count(job);
        if (count.active == 0) {
          status.WriteLine("{\"kind\":\"empty\",\"active\":0,\"total\":" + count.total + ",\"terminated\":" + (requested ? "true" : "false") + ",\"elapsedMs\":" + clock.ElapsedMilliseconds + "}");
          return 0;
        }
        if (!requested && terminate.WaitOne(0)) { stage = "terminate"; Check(TerminateJobObject(job, 1)); requested = true; stopAt = clock.ElapsedMilliseconds; }
        if (requested && clock.ElapsedMilliseconds - stopAt >= 2000) { stage = "termination-deadline"; throw new InvalidOperationException("owned processes remained"); }
        Thread.Sleep(10);
      }
    } catch (Exception error) {
      var native = error as Win32Exception;
      if (status != null) { try { status.WriteLine("{\"kind\":\"error\",\"stage\":\"" + stage + "\",\"win32\":" + (native == null ? 0 : native.NativeErrorCode) + "}"); } catch {} }
      return 1;
    } finally {
      // Assignment failure must never resume an unowned browser.
      if (browser.thread != IntPtr.Zero) { TerminateProcess(browser.process, 1); CloseHandle(browser.thread); }
      if (job != IntPtr.Zero) CloseHandle(job);
      if (browser.process != IntPtr.Zero) CloseHandle(browser.process);
      if (attributeListReady) DeleteProcThreadAttributeList(attributes);
      if (attributes != IntPtr.Zero) Marshal.FreeHGlobal(attributes);
      if (handleList != IntPtr.Zero) Marshal.FreeHGlobal(handleList);
      if (table != IntPtr.Zero) Marshal.FreeHGlobal(table);
      if (nul != Invalid) CloseHandle(nul);
      if (status != null) status.Dispose();
    }
  }
}
