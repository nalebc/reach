// The stand-in Tailscale's tailscale.exe on a real Windows runner
// (test/helpers/fake-tailscale.mjs): Reach runs it as it runs Tailscale's
// own command line, and it runs the stand-in's script with Node.
//
// Beside it, fake-tailscale-shim.txt names Node (line 1) and the script
// (line 2). Its arguments go on exactly as Reach quoted them (the rest of its
// command line, never re-quoted), its standard handles are the script's, and
// its exit code is the script's. The script runs in a kill-on-close job of
// this process's own, so it ends when this process ends, however it ends:
// as Tailscale drops a foreground session once its `tailscale serve` is gone.
// Ctrl+C is the script's to answer (this process waits for it). C# 5;
// mscorlib only.
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

static class TailscaleShim {
  const uint CREATE_SUSPENDED = 0x4;
  const uint CREATE_UNICODE_ENVIRONMENT = 0x400;
  const int STARTF_USESTDHANDLES = 0x100;
  const uint HANDLE_FLAG_INHERIT = 1;
  const uint INFINITE = 0xFFFFFFFF;
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved, lpDesktop, lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount, ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
    public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }

  delegate bool ConsoleHandler(int kind);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string application, string commandLine, IntPtr processAttributes, IntPtr threadAttributes,
    bool inheritHandles, uint flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int kind, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")]
  static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
  [DllImport("kernel32.dll")]
  static extern bool SetConsoleCtrlHandler(ConsoleHandler handler, bool add);

  // Kept alive for as long as Windows may call it.
  static ConsoleHandler waitForScript = kind => kind == 0 || kind == 1;

  // The command line after the program's own name, as Windows splits the
  // first word: up to the closing quote if it starts with one, else up to
  // the first space or tab. Then the spaces between.
  static string Rest(string line) {
    int i = 0;
    if (line.Length > 0 && line[0] == '"') {
      i = line.IndexOf('"', 1);
      i = i < 0 ? line.Length : i + 1;
    } else {
      while (i < line.Length && line[i] != ' ' && line[i] != '\t') i++;
    }
    while (i < line.Length && (line[i] == ' ' || line[i] == '\t')) i++;
    return line.Substring(i);
  }

  static IntPtr Inherited(int which) {
    IntPtr handle = GetStdHandle(which);
    if (handle != IntPtr.Zero && handle != new IntPtr(-1)) SetHandleInformation(handle, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);
    return handle;
  }

  static int Main() {
    string[] target = File.ReadAllLines(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "fake-tailscale-shim.txt"));
    string rest = Rest(Environment.CommandLine);
    string commandLine = "\"" + target[0] + "\" \"" + target[1] + "\"" + (rest.Length > 0 ? " " + rest : "");

    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
      throw new Win32Exception();

    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = Inherited(-10);
    startup.hStdOutput = Inherited(-11);
    startup.hStdError = Inherited(-12);
    PROCESS_INFORMATION info;
    if (!CreateProcess(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref startup, out info))
      throw new Win32Exception();
    if (!AssignProcessToJobObject(job, info.hProcess)) {
      int error = Marshal.GetLastWin32Error();
      TerminateProcess(info.hProcess, 1);
      throw new Win32Exception(error);
    }
    SetConsoleCtrlHandler(waitForScript, true);
    ResumeThread(info.hThread);
    WaitForSingleObject(info.hProcess, INFINITE);
    uint code;
    GetExitCodeProcess(info.hProcess, out code);
    return (int)code;
  }
}
