// Another Windows user trying to take Reach's keyed port, for the real-Windows
// peer check test only (test/windows-tailscaled-peer.test.mjs, case 9;
// docs/parity/D-public-door.md §8 and §10 risk 3).
//
//   bind-probe.exe <address> <port> plain|reuse <log> [hold <seconds>]
//
// Appends "bound" or "refused <WSA error>" to <log>; holding, it listens and
// appends "accepted <remote>" for each connection it gets. [::] binds dual
// stack (IPV6_V6ONLY off). C# 5; mscorlib and System.
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;

static class BindProbe {
  static string log;

  static void Note(string line) {
    File.AppendAllText(log, line + "\r\n");
  }

  static int Main(string[] args) {
    if (args.Length != 4 && args.Length != 6) return 2;
    log = args[3];
    IPAddress address = IPAddress.Parse(args[0] == "[::]" ? "::" : args[0]);
    int port = int.Parse(args[1]);
    bool reuse = args[2] == "reuse";
    int hold = args.Length == 6 && args[4] == "hold" ? int.Parse(args[5]) : 0;
    var socket = new Socket(address.AddressFamily, SocketType.Stream, ProtocolType.Tcp);
    if (address.AddressFamily == AddressFamily.InterNetworkV6) socket.DualMode = true;
    if (reuse) socket.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
    try {
      socket.Bind(new IPEndPoint(address, port));
    } catch (SocketException error) {
      Note("refused " + error.ErrorCode);
      return 0;
    }
    Note("bound");
    if (hold <= 0) return 0;
    socket.Listen(16);
    DateTime until = DateTime.UtcNow.AddSeconds(hold);
    while (DateTime.UtcNow < until) {
      if (!socket.Poll(100000, SelectMode.SelectRead)) continue;
      Socket accepted = socket.Accept();
      Note("accepted " + accepted.RemoteEndPoint);
      accepted.Close();
    }
    socket.Close();
    return 0;
  }
}
