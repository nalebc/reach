// How long this PC has had no keyboard or mouse input, and whether its
// session is locked: one JSON line, then it exits. The Windows twin of the
// Mac's ioreg readings (server/agent-sessions/claude-import.mjs), read by
// server/windows-presence.mjs. {"idleMs":<ms>|null,"locked":true|false|null}:
// null when Windows won't say, never a guess.
using System;
using System.Runtime.InteropServices;
using System.Text;

static class Presence {
  [StructLayout(LayoutKind.Sequential)] struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);

  // The last input of this session (keys, mouse, pen, touch), as a tick
  // count: both wrap every 49.7 days, and unsigned subtraction stays right.
  static string IdleMs() {
    var info = new LASTINPUTINFO();
    info.cbSize = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO));
    if (!GetLastInputInfo(ref info)) return "null";
    return unchecked(GetTickCount() - info.dwTime).ToString();
  }
  // WTSINFOEXW: Level, then (8-byte aligned) WTSINFOEX_LEVEL1_W: SessionId,
  // SessionState, SessionFlags at 16; WTS_SESSIONSTATE_LOCK is 0, UNLOCK 1.
  // As scripts/native/screen-stream.ps1 reads it. -1: not told.
  static int SessionLocked() {
    IntPtr buffer; int bytes;
    if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buffer, out bytes)) return -1;
    try {
      if (bytes < 20 || Marshal.ReadInt32(buffer) != 1) return -1;
      int flags = Marshal.ReadInt32(buffer, 16);
      return flags == 0 ? 1 : flags == 1 ? 0 : -1;
    } finally { WTSFreeMemory(buffer); }
  }
  // Keys and clicks go to the desktop named "Default" while it's unlocked;
  // the lock screen's can't be opened. 1: on Default, 0: elsewhere.
  static int InputOnDefault() {
    IntPtr desk = OpenInputDesktop(0, false, 0x0001);
    if (desk == IntPtr.Zero) return 0;
    try {
      var name = new StringBuilder(64);
      int needed;
      if (!GetUserObjectInformation(desk, 2, name, 128, out needed)) return -1;
      return name.ToString() == "Default" ? 1 : 0;
    } finally { CloseDesktop(desk); }
  }
  static void Main() {
    // Locked only when both say so (screen-stream.ps1's rule); unlocked when
    // either says so; otherwise not told.
    int session = SessionLocked(), input = InputOnDefault();
    string locked = session == 1 && input == 0 ? "true" : session == 0 || input == 1 ? "false" : "null";
    Console.Out.Write("{\"idleMs\":" + IdleMs() + ",\"locked\":" + locked + "}\n");
  }
}
