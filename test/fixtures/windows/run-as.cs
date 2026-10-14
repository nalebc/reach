// Starting a program as another, standard, Windows user with an interactive
// logon, for the real-Windows peer check test only
// (test/windows-tailscaled-peer.test.mjs; docs/parity/D-public-door.md §8).
// The runner is an elevated administrator; CreateProcessAsUser would need a
// privilege it doesn't hold, so this uses CreateProcessWithLogonW, on the
// interactive desktop that user is first let onto.
//
//   run-as.exe sid <user>                         prints the user's SID
//   run-as.exe desktop grant|revoke <sid>         WinSta0 and its Default desktop
//   run-as.exe logon-right add|remove <user> [<right>]
//                                                 SeInteractiveLogonRight, or the right named
//   run-as.exe run <user> <password> <dir> wait|nowait <command line>
//                                                 prints "pid <n>" (and "exit <code>")
// Failures print "error <Win32 code>" and exit 3. C# 5; mscorlib and System.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

static class RunAs {
  const int LOGON_WITH_PROFILE = 1;
  const int CREATE_NO_WINDOW = 0x08000000;
  const int CREATE_UNICODE_ENVIRONMENT = 0x400;
  const uint READ_CONTROL = 0x20000;
  const uint WRITE_DAC = 0x40000;
  const int DACL_SECURITY_INFORMATION = 4;
  const int GENERIC_ALL = 0x10000000;
  const int WINSTA_ALL = 0xF037F;
  const int DESKTOP_ALL = 0xF01FF;
  const int POLICY_CREATE_ACCOUNT = 0x10;
  const int POLICY_LOOKUP_NAMES = 0x800;
  const uint INFINITE = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb;
    public string lpReserved;
    public string lpDesktop;
    public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow, cbReserved2;
    public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION {
    public IntPtr hProcess, hThread;
    public int dwProcessId, dwThreadId;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct LSA_OBJECT_ATTRIBUTES {
    public int Length;
    public IntPtr RootDirectory, ObjectName;
    public int Attributes;
    public IntPtr SecurityDescriptor, SecurityQualityOfService;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct LSA_UNICODE_STRING {
    public ushort Length, MaximumLength;
    public string Buffer;
  }

  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessWithLogonW(string user, string domain, string password, int logonFlags, string application, StringBuilder commandLine, int creationFlags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("kernel32.dll")]
  static extern uint WaitForSingleObject(IntPtr handle, uint ms);
  [DllImport("kernel32.dll")]
  static extern bool GetExitCodeProcess(IntPtr process, out int code);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr OpenDesktopW(string name, uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool GetUserObjectSecurity(IntPtr handle, ref int requested, byte[] descriptor, int length, out int needed);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetUserObjectSecurity(IntPtr handle, ref int information, byte[] descriptor);
  [DllImport("user32.dll")]
  static extern bool CloseWindowStation(IntPtr handle);
  [DllImport("user32.dll")]
  static extern bool CloseDesktop(IntPtr handle);
  [DllImport("advapi32.dll")]
  static extern uint LsaOpenPolicy(IntPtr system, ref LSA_OBJECT_ATTRIBUTES attributes, int access, out IntPtr policy);
  [DllImport("advapi32.dll")]
  static extern uint LsaAddAccountRights(IntPtr policy, byte[] sid, LSA_UNICODE_STRING[] rights, int count);
  [DllImport("advapi32.dll")]
  static extern uint LsaRemoveAccountRights(IntPtr policy, byte[] sid, bool all, LSA_UNICODE_STRING[] rights, int count);
  [DllImport("advapi32.dll")]
  static extern int LsaNtStatusToWinError(uint status);
  [DllImport("advapi32.dll")]
  static extern uint LsaClose(IntPtr policy);

  static int Main(string[] args) {
    try {
      if (args.Length == 2 && args[0] == "sid") {
        Console.Out.WriteLine(Sid(args[1]).Value);
        return 0;
      }
      if (args.Length == 3 && args[0] == "desktop" && (args[1] == "grant" || args[1] == "revoke")) {
        Desktop(args[1] == "grant", new SecurityIdentifier(args[2]));
        return 0;
      }
      if ((args.Length == 3 || args.Length == 4) && args[0] == "logon-right" && (args[1] == "add" || args[1] == "remove")) {
        LogonRight(args[1] == "add", args[2], args.Length == 4 ? args[3] : "SeInteractiveLogonRight");
        return 0;
      }
      if (args.Length == 6 && args[0] == "run" && (args[4] == "wait" || args[4] == "nowait"))
        return Run(args[1], args[2], args[3], args[4] == "wait", args[5]);
      return 2;
    } catch (Win32Exception error) {
      Console.Out.WriteLine("error " + error.NativeErrorCode);
      return 3;
    }
  }

  static SecurityIdentifier Sid(string user) {
    return (SecurityIdentifier)new NTAccount(user).Translate(typeof(SecurityIdentifier));
  }

  // Lets `sid` onto the interactive window station and its desktop (revoke:
  // takes every one of its entries off again).
  static void Desktop(bool grant, SecurityIdentifier sid) {
    IntPtr station = OpenWindowStationW("WinSta0", false, READ_CONTROL | WRITE_DAC);
    if (station == IntPtr.Zero) throw new Win32Exception();
    try {
      Edit(station, sid, grant, true);
    } finally {
      CloseWindowStation(station);
    }
    IntPtr desktop = OpenDesktopW("Default", 0, false, READ_CONTROL | WRITE_DAC);
    if (desktop == IntPtr.Zero) throw new Win32Exception();
    try {
      Edit(desktop, sid, grant, false);
    } finally {
      CloseDesktop(desktop);
    }
  }

  static void Edit(IntPtr handle, SecurityIdentifier sid, bool grant, bool station) {
    int information = DACL_SECURITY_INFORMATION;
    int needed;
    GetUserObjectSecurity(handle, ref information, null, 0, out needed);
    if (needed <= 0) throw new Win32Exception();
    byte[] buffer = new byte[needed];
    if (!GetUserObjectSecurity(handle, ref information, buffer, needed, out needed)) throw new Win32Exception();
    var descriptor = new RawSecurityDescriptor(buffer, 0);
    RawAcl dacl = descriptor.DiscretionaryAcl;
    for (int i = dacl.Count - 1; i >= 0; i--) {
      var ace = dacl[i] as CommonAce;
      if (ace != null && ace.SecurityIdentifier == sid) dacl.RemoveAce(i);
    }
    if (grant) {
      if (station) {
        dacl.InsertAce(dacl.Count, new CommonAce(AceFlags.ContainerInherit | AceFlags.InheritOnly | AceFlags.ObjectInherit, AceQualifier.AccessAllowed, GENERIC_ALL, sid, false, null));
        dacl.InsertAce(dacl.Count, new CommonAce(AceFlags.NoPropagateInherit, AceQualifier.AccessAllowed, WINSTA_ALL, sid, false, null));
      } else dacl.InsertAce(dacl.Count, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, DESKTOP_ALL, sid, false, null));
    }
    descriptor.DiscretionaryAcl = dacl;
    byte[] updated = new byte[descriptor.BinaryLength];
    descriptor.GetBinaryForm(updated, 0);
    information = DACL_SECURITY_INFORMATION;
    if (!SetUserObjectSecurity(handle, ref information, updated)) throw new Win32Exception();
  }

  static void LogonRight(bool add, string user, string right) {
    SecurityIdentifier sid = Sid(user);
    byte[] binary = new byte[sid.BinaryLength];
    sid.GetBinaryForm(binary, 0);
    var attributes = new LSA_OBJECT_ATTRIBUTES();
    IntPtr policy;
    uint status = LsaOpenPolicy(IntPtr.Zero, ref attributes, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, out policy);
    if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    try {
      var rights = new LSA_UNICODE_STRING[1];
      rights[0].Buffer = right;
      rights[0].Length = (ushort)(right.Length * 2);
      rights[0].MaximumLength = (ushort)((right.Length + 1) * 2);
      status = add ? LsaAddAccountRights(policy, binary, rights, 1) : LsaRemoveAccountRights(policy, binary, false, rights, 1);
      if (status != 0) throw new Win32Exception(LsaNtStatusToWinError(status));
    } finally {
      LsaClose(policy);
    }
  }

  static int Run(string user, string password, string directory, bool wait, string commandLine) {
    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.lpDesktop = "winsta0\\default";
    PROCESS_INFORMATION info;
    if (!CreateProcessWithLogonW(user, ".", password, LOGON_WITH_PROFILE, null, new StringBuilder(commandLine), CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, directory, ref startup, out info))
      throw new Win32Exception();
    Console.Out.WriteLine("pid " + info.dwProcessId);
    Console.Out.Flush();
    int code = 0;
    if (wait) {
      WaitForSingleObject(info.hProcess, INFINITE);
      GetExitCodeProcess(info.hProcess, out code);
      Console.Out.WriteLine("exit " + code);
    }
    CloseHandle(info.hThread);
    CloseHandle(info.hProcess);
    return 0;
  }
}
