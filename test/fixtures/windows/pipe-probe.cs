// Another Windows user trying an agent's shared connection pipe, for the
// real-Windows test only (test/windows-agent-pipe.test.mjs).
//
//   pipe-probe.exe <pipe name> <log>
//
// Opens \\.\pipe\<pipe name> for reading and writing, then for reading only,
// as whoever runs it, and appends what Windows said to <log>: "readwrite ok"
// or "readwrite error <Win32 code>", then the same for "read". Let in to
// write, it asks something ({"id":1,"route":"/probe"}) and notes "asked".
// C# 5; mscorlib only.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

static class PipeProbe {
  const uint GENERIC_READ = 0x80000000;
  const uint GENERIC_WRITE = 0x40000000;
  const uint OPEN_EXISTING = 3;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);

  static string log;

  static void Note(string line) {
    File.AppendAllText(log, line + "\r\n");
  }

  static void Try(string pipe, string label, uint access) {
    using (SafeFileHandle handle = CreateFile(pipe, access, 0, IntPtr.Zero, OPEN_EXISTING, 0, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        Note(label + " error " + Marshal.GetLastWin32Error());
        return;
      }
      Note(label + " ok");
      if ((access & GENERIC_WRITE) == 0) return;
      using (var stream = new FileStream(handle, FileAccess.ReadWrite)) {
        byte[] ask = Encoding.UTF8.GetBytes("{\"id\":1,\"route\":\"/probe\",\"method\":\"GET\"}\n");
        stream.Write(ask, 0, ask.Length);
        stream.Flush();
        Note("asked");
      }
    }
  }

  static int Main(string[] args) {
    if (args.Length != 2) return 2;
    log = args[1];
    string pipe = @"\\.\pipe\" + args[0];
    Try(pipe, "readwrite", GENERIC_READ | GENERIC_WRITE);
    Try(pipe, "read", GENERIC_READ);
    return 0;
  }
}
