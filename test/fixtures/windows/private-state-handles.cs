// A disposable NTFS handle-mode probe, compiled WITH the unchanged production
// private-state source. Reflection calls its actual Open/Retain/Update; no ACL
// algorithm, native result or access token is replaced. Retain receives the
// actual Windows SID. The stdio barrier lets the parent create a real alias
// before Update, or attempt a rename while directory handles remain held.
// It is not an authenticated Reach/browser acceptance test.
using System;
using System.IO;
using System.Reflection;
using System.Security.Principal;
using System.Threading;

static class PrivateStateHandles {
  static readonly Type Core = typeof(PrivateState);
  static IntPtr Open(IntPtr parent, string name, bool directory, bool exclusiveFile) {
    MethodInfo method = Core.GetMethod("Open", BindingFlags.Static | BindingFlags.NonPublic);
    return (IntPtr)method.Invoke(null, new object[] { parent, name, directory, true, false, null, exclusiveFile });
  }
  static object Retain(IntPtr parent, string path) {
    Core.GetField("Me", BindingFlags.Static | BindingFlags.NonPublic).SetValue(null, WindowsIdentity.GetCurrent().User.Value);
    MethodInfo method = Core.GetMethod("Retain", BindingFlags.Static | BindingFlags.NonPublic);
    return method.Invoke(null, new object[] { parent, "legacy.json", path, false, false });
  }
  static int Update(object entry) {
    try {
      Core.GetMethod("Update", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { entry });
      Console.WriteLine("updated"); return 4;
    } catch (TargetInvocationException error) {
      Type refused = Core.GetNestedType("Refused", BindingFlags.NonPublic);
      if (error.InnerException == null || error.InnerException.GetType() != refused) throw;
      string reason = (string)refused.GetField("Reason", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(error.InnerException);
      if (reason != "hardlink") throw;
      Console.WriteLine("refused hardlink"); return 0;
    }
  }
  [System.Runtime.InteropServices.DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static int Main(string[] args) {
    IntPtr directory = IntPtr.Zero, file = IntPtr.Zero;
    try {
      if (args.Length != 2 || (args[0] != "repair" && args[0] != "repair-update" && args[0] != "private" && args[0] != "directory")) return 2;
      string path = Path.GetFullPath(args[1]);
      if (Path.GetFileName(path) != "history" || path.IndexOf("\\reach-existing-state-", StringComparison.OrdinalIgnoreCase) < 0) return 2;
      using (var deadline = new Timer(delegate(object unused) { Environment.Exit(3); }, null, 30000, Timeout.Infinite)) {
        directory = Open(IntPtr.Zero, "\\??\\" + path, true, false);
        object entry = null;
        if (args[0] == "repair-update") {
          entry = Retain(directory, Path.Combine(path, "legacy.json"));
          file = (IntPtr)entry.GetType().GetField("Handle", BindingFlags.Instance | BindingFlags.NonPublic).GetValue(entry);
        } else if (args[0] != "directory") file = Open(directory, "legacy.json", false, args[0] == "repair");
        Console.WriteLine("held"); Console.Out.Flush();
        string command = Console.ReadLine();
        if (entry != null) return command == "update" ? Update(entry) : 2;
        if (command != "release") return 2;
      }
      return 0;
    } catch (Exception error) { Console.Error.WriteLine(error.ToString()); return 1; }
    finally { if (file != IntPtr.Zero) CloseHandle(file); if (directory != IntPtr.Zero) CloseHandle(directory); }
  }
}
