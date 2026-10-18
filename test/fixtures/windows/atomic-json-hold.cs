// Disposable hosted-Windows fixture, never a shipped helper. Hold a real
// destination without FILE_SHARE_DELETE until the test observes a real
// failed rename and publishes its release barrier. No failure is injected.
using System;
using System.Diagnostics;
using System.IO;
using System.Threading;

static class AtomicJsonHold {
  static int Main(string[] args) {
    if (args.Length != 2) return 2;
    try {
      string volume = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(args[0]))).DriveFormat;
      if (volume != "NTFS") return 3;
      using (var held = new FileStream(args[0], FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) {
        Console.WriteLine("held NTFS"); Console.Out.Flush();
        var clock = Stopwatch.StartNew();
        while (!File.Exists(args[1])) {
          if (clock.ElapsedMilliseconds > 15000) return 4;
          Thread.Sleep(2);
        }
      }
      Console.WriteLine("released"); Console.Out.Flush();
      return 0;
    } catch (Exception error) {
      Console.Error.WriteLine(error.GetType().FullName);
      return 1;
    }
  }
}
