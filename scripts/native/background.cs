// Reach's background task on Windows (scripts/windows-task.mjs): what launchd
// is to the Mac's LaunchAgent. Task Scheduler starts it when you sign in, in
// your session. It runs Reach with no window, writes what Reach says to its
// logs, and starts Reach again 5 s after it ends unexpectedly. C# 5, the
// language of the .NET Framework 4.x compiler (docs/WINDOWS_AGENT_PARITY.md,
// rule 3).
// Built as a Windows program (/target:winexe): no console window opens for
// it. Reach gets a console nobody sees (CREATE_NO_WINDOW), which everything
// Reach starts shares: a program started with no console at all would open
// a window of its own for each console program it starts.
//   background --log <folder> --hold <file> [--env NAME=VALUE]... -- <program> [arguments...]
//   --log: what Reach says goes to companion.log there, its errors to
//     companion-error.log (as the LaunchAgent's StandardOutPath and
//     StandardErrorPath).
//   --hold: while this file exists, a Reach that ended isn't started again
//     (reach stop, uninstall and update write it first, as launchd's bootout
//     does). One left from before is removed at start: a new sign-in.
//   --env: set for Reach (REACH_DATA, REACH_HOME…).
// Reach ending with 0 stopped as asked: this ends too, with 0.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

static class Background {
  static int Main(string[] args) {
    string log = null, hold = null;
    List<KeyValuePair<string, string>> env = new List<KeyValuePair<string, string>>();
    int at = 0;
    for (; at < args.Length; at++) {
      string arg = args[at];
      if (arg == "--") { at++; break; }
      if (at + 1 >= args.Length) return 2;
      if (arg == "--log") log = args[++at];
      else if (arg == "--hold") hold = args[++at];
      else if (arg == "--env") {
        string pair = args[++at];
        int equals = pair.IndexOf('=');
        if (equals <= 0) return 2;
        env.Add(new KeyValuePair<string, string>(pair.Substring(0, equals), pair.Substring(equals + 1)));
      } else return 2;
    }
    if (log == null || hold == null || at >= args.Length) return 2;
    string program = args[at];
    StringBuilder line = new StringBuilder();
    for (int i = at + 1; i < args.Length; i++) {
      if (line.Length > 0) line.Append(' ');
      line.Append(Quote(args[i]));
    }
    try { File.Delete(hold); } catch (Exception) { }
    for (;;) {
      int code;
      try {
        code = Run(program, line.ToString(), env, log);
      } catch (Exception e) {
        Note(log, "Reach's background task couldn't start " + program + ": " + e.Message);
        return 1;
      }
      if (code == 0 || File.Exists(hold)) return 0;
      // launchd's ThrottleInterval: not again at once. Reach's own backoff
      // (scripts/service-backoff.mjs) waits longer when starts keep failing.
      for (int waited = 0; waited < 5000; waited += 250) {
        if (File.Exists(hold)) return 0;
        Thread.Sleep(250);
      }
    }
  }

  static int Run(string program, string arguments, List<KeyValuePair<string, string>> env, string log) {
    ProcessStartInfo start = new ProcessStartInfo(program, arguments);
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    start.RedirectStandardInput = true;
    start.RedirectStandardOutput = true;
    start.RedirectStandardError = true;
    // Never Reach's own folder: npm replaces it on an update.
    start.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
    foreach (KeyValuePair<string, string> pair in env) start.EnvironmentVariables[pair.Key] = pair.Value;
    using (Process child = Process.Start(start)) {
      // Nothing to read, as launchd gives /dev/null.
      child.StandardInput.Close();
      Thread output = Copy(child.StandardOutput.BaseStream, Path.Combine(log, "companion.log"));
      Thread errors = Copy(child.StandardError.BaseStream, Path.Combine(log, "companion-error.log"));
      child.WaitForExit();
      // What it said last, unless something it started still holds its output.
      output.Join(2000);
      errors.Join(2000);
      return child.ExitCode;
    }
  }

  // Each chunk appended as it comes: Reach trims its logs in place while it runs.
  static Thread Copy(Stream from, string file) {
    Thread copy = new Thread(() => {
      byte[] buffer = new byte[8192];
      try {
        int read;
        while ((read = from.Read(buffer, 0, buffer.Length)) > 0)
          using (FileStream to = new FileStream(file, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete))
            to.Write(buffer, 0, read);
      } catch (Exception) { }
    });
    copy.IsBackground = true;
    copy.Start();
    return copy;
  }

  static void Note(string log, string text) {
    try { File.AppendAllText(Path.Combine(log, "companion-error.log"), "Reach: " + text + Environment.NewLine); } catch (Exception) { }
  }

  // An argument as the C runtime reads it back (Node does).
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    StringBuilder b = new StringBuilder("\"");
    for (int i = 0; ; i++) {
      int slashes = 0;
      while (i < arg.Length && arg[i] == '\\') { i++; slashes++; }
      if (i == arg.Length) { b.Append('\\', slashes * 2); break; }
      if (arg[i] == '"') b.Append('\\', slashes * 2 + 1).Append('"');
      else b.Append('\\', slashes).Append(arg[i]);
    }
    return b.Append('"').ToString();
  }
}
