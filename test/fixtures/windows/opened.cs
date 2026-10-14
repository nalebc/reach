// What Reach opens on a real Windows runner, recorded instead of opened, for
// real-console tests only (test/windows-console.test.mjs): copied in as
// explorer.exe (first on the PATH: the pages Reach opens in the browser) and
// as tailscale-ipn.exe (Tailscale's app, where Reach looks for it).
//
// Appends "<its own file name>\t<each argument, tab-separated>" to
// opened.log beside it. As explorer.exe it exits 1, as Explorer does even
// when the page opened. C# 5; mscorlib only.
using System;
using System.IO;

static class Opened {
  static int Main(string[] args) {
    string self = System.Reflection.Assembly.GetEntryAssembly().Location;
    string dir = Path.GetDirectoryName(self);
    string name = Path.GetFileName(self);
    File.AppendAllText(Path.Combine(dir, "opened.log"), name.ToLowerInvariant() + "\t" + string.Join("\t", args) + "\r\n");
    return name.Equals("explorer.exe", StringComparison.OrdinalIgnoreCase) ? 1 : 0;
  }
}
