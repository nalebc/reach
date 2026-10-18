// A harmless marker program for a disposable historical-cache attack fixture.
// A matching EXE/note pair must never make Reach execute this program.
using System;
using System.IO;
using System.Reflection;
static class PlantedStateHelper {
  static int Main() {
    string folder = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
    if (folder.IndexOf("\\reach-existing-state-", StringComparison.OrdinalIgnoreCase) < 0) return 2;
    File.WriteAllText(Path.Combine(folder, "planted-helper-ran.txt"), "A historical cached program was executed.\n");
    return 0;
  }
}
