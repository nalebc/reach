// Keeps this Windows PC awake while Reach runs (scripts/stay-awake.mjs): what
// caffeinate -d -i -s is on a Mac. It asks Windows to keep the system and
// the display on (SetThreadExecutionState) for as long as it runs, always or
// only while the PC is plugged in, and lets go when Reach ends (its input
// closes). Windows' own settings aren't changed: locking (Windows+L, a
// screen saver's lock, a policy), closing the lid and the power button
// still apply. C# 5, the language of the .NET Framework 4.x compiler
// (docs/WINDOWS_AGENT_PARITY.md, rule 3).
//   stay-awake always|ac
// One JSON line each time what it holds changes, ASCII only:
//   {"active":true,"ac":true}
// "ac": plugged in (true), on battery (false), or unknown (null). Unknown
// counts as plugged in: a desktop PC without a battery says so.
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class StayAwake {
  const uint ES_CONTINUOUS = 0x80000000, ES_SYSTEM_REQUIRED = 0x1, ES_DISPLAY_REQUIRED = 0x2;

  [StructLayout(LayoutKind.Sequential)]
  struct SYSTEM_POWER_STATUS {
    public byte ACLineStatus;
    public byte BatteryFlag;
    public byte BatteryLifePercent;
    public byte SystemStatusFlag;
    public int BatteryLifeTime;
    public int BatteryFullLifeTime;
  }
  [DllImport("kernel32.dll")]
  static extern uint SetThreadExecutionState(uint flags);
  [DllImport("kernel32.dll")]
  static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS status);

  static readonly ManualResetEvent ended = new ManualResetEvent(false);

  static int Main(string[] args) {
    bool always = args.Length == 1 && args[0] == "always";
    if (!always && !(args.Length == 1 && args[0] == "ac")) {
      Console.Error.WriteLine("Usage: stay-awake always|ac");
      return 2;
    }
    // Reach ended, or closed this helper's input: let go. Only a signal here;
    // what's asked of Windows belongs to the thread below.
    Thread watch = new Thread(() => {
      try {
        Stream input = Console.OpenStandardInput();
        byte[] buffer = new byte[256];
        while (input.Read(buffer, 0, buffer.Length) > 0) { }
      } catch (Exception) { }
      ended.Set();
    });
    watch.IsBackground = true;
    watch.Start();
    string last = null;
    // On this thread only: what it asks lasts until this thread asks again or ends.
    do {
      bool? ac = PluggedIn();
      bool hold = always || ac != false;
      bool held = SetThreadExecutionState(hold ? ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED : ES_CONTINUOUS) != 0 && hold;
      string said = "{\"active\":" + (held ? "true" : "false") + ",\"ac\":" + (ac == null ? "null" : ac.Value ? "true" : "false") + "}";
      if (said != last) {
        try {
          Console.Out.Write(said + "\n");
          Console.Out.Flush();
        } catch (IOException) {
          // Nobody reads it any more: Reach is gone.
          break;
        }
        last = said;
      }
    } while (!ended.WaitOne(5000));
    SetThreadExecutionState(ES_CONTINUOUS);
    return 0;
  }

  static bool? PluggedIn() {
    SYSTEM_POWER_STATUS status;
    if (!GetSystemPowerStatus(out status)) return null;
    if (status.ACLineStatus == 0) return false;
    if (status.ACLineStatus == 1) return true;
    return null;
  }
}
