// A disposable NTFS handle-mode probe, compiled WITH the unchanged production
// private-state source. Reflection calls its actual Open primitive; no ACL
// algorithm, native result or access token is replaced. The fixture's stdio
// barrier lets the parent attempt a real hardlink/rename while handles remain
// held. It is not an authenticated Reach/browser acceptance test.
using System;
using System.IO;
using System.Reflection;
using System.Threading;

static class PrivateStateHandles {
  static readonly Type Core = typeof(PrivateState);
  static IntPtr Open(IntPtr parent, string name, bool directory, bool exclusiveFile) {
    MethodInfo method = Core.GetMethod("Open", BindingFlags.Static | BindingFlags.NonPublic);
    return (IntPtr)method.Invoke(null, new object[] { parent, name, directory, true, false, null, exclusiveFile });
  }
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static int Main(string[] args) {
    IntPtr directory = IntPtr.Zero, file = IntPtr.Zero;
    try {
      if (args.Length != 2 || (args[0] != "repair" && args[0] != "private" && args[0] != "directory")) return 2;
      string path = Path.GetFullPath(args[1]);
      if (Path.GetFileName(path) != "history" || path.IndexOf("\\reach-existing-state-", StringComparison.OrdinalIgnoreCase) < 0) return 2;
      using (var deadline = new Timer(delegate(object unused) { Environment.Exit(3); }, null, 30000, Timeout.Infinite)) {
        directory = Open(IntPtr.Zero, "\\??\\" + path, true, false);
        if (args[0] != "directory") file = Open(directory, "legacy.json", false, args[0] == "repair");
        Console.WriteLine("held"); Console.Out.Flush();
        if (Console.ReadLine() != "release") return 2;
      }
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    finally { if (file != IntPtr.Zero) CloseHandle(file); if (directory != IntPtr.Zero) CloseHandle(directory); }
  }
}
