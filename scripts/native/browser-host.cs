// Reach's native messaging host for its Chrome and Edge extension
// (docs/parity/G-browser-tools.md). Chrome or Edge starts it for the
// extension (registered per user under HKCU\Software\...\NativeMessagingHosts\
// com.reach.browser_tools); it relays native messaging frames (4-byte
// little-endian length, then UTF-8 JSON) between the browser (stdin/stdout)
// and Reach's server (a named pipe), and nothing else: it never reads what
// the frames say. Before a byte goes to the pipe, its server must be Reach's
// own node.exe running as this same Windows user. While Reach restarts, it
// stays up and tries again with a growing wait, telling the extension
// {"type":"waiting"}; when the browser closes the port, it ends.
//
// Built with Windows' own csc (server/desktop-native.mjs), C# 5.
using System;
using System.IO;
using System.IO.Pipes;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using Microsoft.Win32.SafeHandles;

static class BrowserHost {
  const int MaxFromBrowser = 32 * 1024 * 1024;
  // Chrome's own limit toward the extension: Reach splits anything bigger.
  const int MaxToBrowser = 1024 * 1024;
  static readonly object outLock = new object(), pipeLock = new object();
  static Stream stdout;
  static NamedPipeClientStream pipe;

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetNamedPipeServerProcessId(SafePipeHandle pipe, out uint processId);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder name, ref uint size);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  const uint QueryLimitedInformation = 0x1000, TokenQuery = 0x0008;

  static int Main(string[] args) {
    // Chrome and Edge pass the extension's origin first (and, on Windows, the
    // window that asked); anything else is not a browser starting us.
    string origin = args.Length > 0 ? args[0] : "";
    if (!Regex.IsMatch(origin, "^chrome-extension://[a-p]{32}/$")) return 2;
    string pipeName = null, server = null;
    try {
      string here = Path.GetDirectoryName(Assembly.GetEntryAssembly().Location);
      foreach (string line in File.ReadAllLines(Path.Combine(here, "reach-browser-host.config"), Encoding.UTF8)) {
        if (line.StartsWith("pipe=", StringComparison.Ordinal)) pipeName = line.Substring(5).Trim();
        else if (line.StartsWith("server=", StringComparison.Ordinal)) server = line.Substring(7).Trim();
      }
    } catch (Exception) {
      return 3;
    }
    if (pipeName == null || !Regex.IsMatch(pipeName, "^reach-browser-tools-[0-9a-f]{16}$") || string.IsNullOrEmpty(server) || !Path.IsPathRooted(server)) return 3;
    stdout = Console.OpenStandardOutput();
    Stream stdin = Console.OpenStandardInput();
    var relay = new Thread(delegate () { ToReach(pipeName, server, origin); });
    relay.IsBackground = true;
    relay.Start();
    // From the browser to Reach, while Reach is there; dropped otherwise
    // (the extension knows it's waiting and sends nothing that matters).
    for (;;) {
      byte[] message = ReadFrame(stdin, MaxFromBrowser);
      if (message == null) return 0;
      NamedPipeClientStream current;
      lock (pipeLock) current = pipe;
      if (current == null) continue;
      try {
        lock (current) WriteFrame(current, message);
      } catch (Exception) {
        try { current.Dispose(); } catch (Exception) { }
      }
    }
  }

  static void ToReach(string pipeName, string server, string origin) {
    int wait = 250;
    for (;;) {
      NamedPipeClientStream connection = null;
      bool joined = false;
      try {
        connection = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        connection.Connect(2000);
        if (!ReachServes(connection, server)) throw new UnauthorizedAccessException();
        WriteFrame(connection, Encoding.UTF8.GetBytes("{\"type\":\"host\",\"origin\":\"" + origin + "\",\"version\":1}"));
        lock (pipeLock) pipe = connection;
        joined = true;
        wait = 250;
        for (;;) {
          byte[] message = ReadFrame(connection, MaxToBrowser);
          if (message == null) break;
          ToBrowser(message);
        }
      } catch (Exception) {
        // Reach isn't there (yet), or isn't Reach: tried again below.
      }
      lock (pipeLock) if (pipe == connection) pipe = null;
      if (connection != null) try { connection.Dispose(); } catch (Exception) { }
      if (joined) ToBrowser(Encoding.UTF8.GetBytes("{\"type\":\"waiting\"}"));
      Thread.Sleep(wait);
      wait = Math.Min(wait * 2, 15000);
    }
  }

  // The pipe's server: Reach's node.exe (the path Reach wrote beside this
  // program), as this same user. A program that took the pipe's name first,
  // or another user's, gets nothing.
  static bool ReachServes(NamedPipeClientStream connection, string server) {
    uint pid;
    if (!GetNamedPipeServerProcessId(connection.SafePipeHandle, out pid) || pid == 0) return false;
    IntPtr process = OpenProcess(QueryLimitedInformation, false, pid);
    if (process == IntPtr.Zero) return false;
    try {
      var name = new StringBuilder(32768);
      uint size = (uint)name.Capacity;
      if (!QueryFullProcessImageNameW(process, 0, name, ref size)) return false;
      if (!string.Equals(Path.GetFullPath(name.ToString()), Path.GetFullPath(server), StringComparison.OrdinalIgnoreCase)) return false;
      IntPtr token;
      if (!OpenProcessToken(process, TokenQuery, out token)) return false;
      try {
        using (var them = new WindowsIdentity(token))
        using (var me = WindowsIdentity.GetCurrent())
          return them.User != null && them.User.Equals(me.User);
      } finally {
        CloseHandle(token);
      }
    } catch (Exception) {
      return false;
    } finally {
      CloseHandle(process);
    }
  }

  static void ToBrowser(byte[] message) {
    lock (outLock) {
      try {
        WriteFrame(stdout, message);
      } catch (Exception) {
        // The browser closed the port: Main ends on its own.
      }
    }
  }
  static byte[] ReadExactly(Stream stream, int count) {
    var buffer = new byte[count];
    int at = 0;
    while (at < count) {
      int read = stream.Read(buffer, at, count - at);
      if (read <= 0) return null;
      at += read;
    }
    return buffer;
  }
  static byte[] ReadFrame(Stream stream, int max) {
    byte[] head = ReadExactly(stream, 4);
    if (head == null) return null;
    uint size = BitConverter.ToUInt32(head, 0);
    if (size > (uint)max) return null;
    return ReadExactly(stream, (int)size);
  }
  static void WriteFrame(Stream stream, byte[] message) {
    var head = BitConverter.GetBytes((uint)message.Length);
    stream.Write(head, 0, 4);
    stream.Write(message, 0, message.Length);
    stream.Flush();
  }
}
