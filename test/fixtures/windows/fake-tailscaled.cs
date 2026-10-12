// A stand-in for Tailscale's Windows service, for the real-Windows peer check
// test only (test/windows-tailscaled-peer.test.mjs; docs/parity/D-public-door.md
// §8). That test registers it as the service "Tailscale" (LocalSystem) on a
// disposable CI runner, and refuses to if a real one is installed. Shaped
// like Tailscale 1.104's: the service process babysits a child it starts as
// `tailscaled.exe /subproc`, and the child makes the connections.
//
// Started by the service manager with start parameters <mode> <url> <log>:
//   subproc  the child asks <url>/probe1 then <url>/probe2 on one connection
//   self     the service process itself asks them
//   nokey    the child asks <url> as given (no key), once
//   linger   the child asks <url>/linger every 2 s, and stays when the
//            service stops (an orphan)
//   idle     nothing
// Run directly: tailscaled.exe /direct <url> <log>: the same probes from a
// process that isn't the service's.
// Each answer is a line appended to <log>: "<who> <path> <status>" or
// "<who> <path> error <what>". C# 5; mscorlib, System, System.ServiceProcess.
using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.ServiceProcess;
using System.Threading;

class FakeTailscaled : ServiceBase {
  Process child;
  Thread worker;
  string mode = "idle";

  static void Note(string log, string line) {
    try {
      File.AppendAllText(log, line + "\r\n");
    } catch (Exception) {
    }
  }

  static void Ask(string who, string url, string path, string log, bool keepAlive) {
    try {
      var request = (HttpWebRequest)WebRequest.Create(url + path);
      request.KeepAlive = keepAlive;
      request.Timeout = 10000;
      request.Proxy = null;
      using (var response = (HttpWebResponse)request.GetResponse()) {
        Note(log, who + " " + path + " " + (int)response.StatusCode);
      }
    } catch (WebException error) {
      var response = error.Response as HttpWebResponse;
      if (response != null) {
        Note(log, who + " " + path + " " + (int)response.StatusCode);
        response.Close();
      } else Note(log, who + " " + path + " error " + error.Status);
    } catch (Exception error) {
      Note(log, who + " " + path + " error " + error.GetType().Name);
    }
  }

  static void Probes(string who, string url, string log) {
    Ask(who, url, "/probe1", log, true);
    Ask(who, url, "/probe2", log, true);
  }

  static int Main(string[] args) {
    if (args.Length == 4 && args[0] == "/subproc") {
      string mode = args[1], url = args[2], log = args[3];
      if (mode == "subproc") Probes("child", url, log);
      else if (mode == "nokey") Ask("child", url, "", log, false);
      else if (mode == "linger")
        for (int i = 0; i < 300; i++) {
          Ask("child", url, "/linger", log, false);
          Thread.Sleep(2000);
        }
      // Kept alive, as Tailscale's daemon is, its idle connection with it.
      Thread.Sleep(Timeout.Infinite);
      return 0;
    }
    if (args.Length == 3 && args[0] == "/direct") {
      Probes("direct", args[1], args[2]);
      return 0;
    }
    ServiceBase.Run(new FakeTailscaled());
    return 0;
  }

  public FakeTailscaled() {
    ServiceName = "Tailscale";
    CanStop = true;
  }

  protected override void OnStart(string[] args) {
    mode = args.Length > 0 ? args[0] : "idle";
    if (args.Length < 3 || mode == "idle") return;
    string url = args[1], log = args[2];
    if (mode == "self") {
      worker = new Thread(delegate() { Probes("self", url, log); });
      worker.IsBackground = true;
      worker.Start();
      return;
    }
    var start = new ProcessStartInfo(Process.GetCurrentProcess().MainModule.FileName, "/subproc " + mode + " \"" + url + "\" \"" + log + "\"");
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    child = Process.Start(start);
  }

  protected override void OnStop() {
    // An orphan on purpose in linger mode; otherwise the child goes with it.
    if (child != null && mode != "linger") {
      try {
        child.Kill();
      } catch (Exception) {
      }
    }
  }
}
