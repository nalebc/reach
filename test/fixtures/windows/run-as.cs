// Starting a program as another, standard, Windows user with an interactive
// logon, for the real-Windows peer check test only
// (test/windows-tailscaled-peer.test.mjs; docs/parity/D-public-door.md §8).
// The runner is an elevated administrator; CreateProcessAsUser would need a
// privilege it doesn't hold, so `run` uses CreateProcessWithLogonW, on the
// interactive desktop that user is first let onto. That puts the user's
// program in the runner's own session; `system-run` (from a SYSTEM scheduled
// task) gives the user's interactive token a session of its choosing instead,
// and `filtered` runs the runner's own token as UAC hands it to a Terminal
// that wasn't elevated.
//
//   run-as.exe sid <user>                         prints the user's SID
//   run-as.exe desktop grant|revoke <sid>         WinSta0 and its Default desktop
//   run-as.exe logon-right add|remove <user> [<right>]
//                                                 SeInteractiveLogonRight, or the right named
//   run-as.exe run <user> <password> <dir> wait|nowait <command line>
//                                                 prints "pid <n>" (and "exit <code>")
//   run-as.exe filtered <dir> wait|nowait <command line>
//                                                 the same, as this account without
//                                                 elevation: Administrators deny-only,
//                                                 privileges dropped, Medium integrity
//   run-as.exe system-run <file>                  as SYSTEM: <file> holds user, password,
//                                                 session, dir, wait|nowait and command
//                                                 line, a line each; it's deleted once
//                                                 read, and <file>.out gets the answer
// Failures print "error <Win32 code>" and exit 3. C# 5; mscorlib and System.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
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
  const uint TOKEN_ALL_ACCESS = 0xF01FF;
  const uint DISABLE_MAX_PRIVILEGE = 0x1;

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
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool CreateRestrictedToken(IntPtr token, uint flags, int disableCount, IntPtr disable, int deleteCount, IntPtr delete, int restrictCount, IntPtr restrict, out IntPtr restricted);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool SetTokenInformation(IntPtr token, int infoClass, IntPtr info, int length);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcessAsUserW(IntPtr token, string application, StringBuilder commandLine, IntPtr processAttributes, IntPtr threadAttributes, bool inherit, int flags, IntPtr environment, string directory, ref STARTUPINFO startup, out PROCESS_INFORMATION info);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LogonUserW(string user, string domain, string password, int type, int provider, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool LookupPrivilegeValueW(string system, string name, out long luid);
  [DllImport("advapi32.dll", SetLastError = true)]
  static extern bool AdjustTokenPrivileges(IntPtr token, bool disableAll, IntPtr state, int length, IntPtr previous, IntPtr returned);
  [DllImport("userenv.dll", SetLastError = true)]
  static extern bool CreateEnvironmentBlock(out IntPtr environment, IntPtr token, bool inherit);
  [DllImport("userenv.dll")]
  static extern bool DestroyEnvironmentBlock(IntPtr environment);
  [DllImport("user32.dll", SetLastError = true)]
  static extern bool SetProcessWindowStation(IntPtr station);

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
      if (args.Length == 4 && args[0] == "filtered" && (args[2] == "wait" || args[2] == "nowait"))
        return Filtered(args[1], args[2] == "wait", args[3]);
      if (args.Length == 2 && args[0] == "system-run") return SystemRun(args[1]);
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
  // This program's own token as UAC hands it to a Terminal that wasn't
  // elevated: Administrators deny-only, privileges dropped, Medium integrity,
  // and what it makes owned by the account itself.
  static int Filtered(string directory, bool wait, string commandLine) {
    IntPtr own, token;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out own)) throw new Win32Exception();
    var held = new List<IntPtr>();
    try {
      string[] admin = { "S-1-5-32-544", "S-1-5-114" };
      // SID_AND_ATTRIBUTES (64-bit): the SID's address, then its attributes, 16 bytes.
      IntPtr array = Hold(held, 16 * admin.Length);
      for (int i = 0; i < admin.Length; i++) {
        Marshal.WriteIntPtr(array, 16 * i, Block(held, new SecurityIdentifier(admin[i])));
        Marshal.WriteInt64(array, 16 * i + 8, 0);
      }
      if (!CreateRestrictedToken(own, DISABLE_MAX_PRIVILEGE, admin.Length, array, 0, IntPtr.Zero, 0, IntPtr.Zero, out token)) throw new Win32Exception();
      try {
        SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
        IntPtr owner = Hold(held, 8);
        Marshal.WriteIntPtr(owner, 0, Block(held, user));
        if (!SetTokenInformation(token, 4, owner, 8)) throw new Win32Exception();
        // Its own objects (process, threads, what it creates) for the account
        // and SYSTEM, as UAC's limited token has them: an administrator's
        // default DACL names Administrators, deny-only here.
        var acl = new RawAcl(GenericAcl.AclRevision, 2);
        acl.InsertAce(0, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, GENERIC_ALL, user, false, null));
        acl.InsertAce(1, new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, GENERIC_ALL, new SecurityIdentifier("S-1-5-18"), false, null));
        byte[] binary = new byte[acl.BinaryLength];
        acl.GetBinaryForm(binary, 0);
        IntPtr aclBlock = Hold(held, binary.Length);
        Marshal.Copy(binary, 0, aclBlock, binary.Length);
        IntPtr dacl = Hold(held, 8);
        Marshal.WriteIntPtr(dacl, 0, aclBlock);
        if (!SetTokenInformation(token, 6, dacl, 8)) throw new Win32Exception();
        var medium = new SecurityIdentifier("S-1-16-8192");
        // TOKEN_MANDATORY_LABEL: one SID_AND_ATTRIBUTES, SE_GROUP_INTEGRITY.
        IntPtr label = Hold(held, 16);
        Marshal.WriteIntPtr(label, 0, Block(held, medium));
        Marshal.WriteInt64(label, 8, 0x20);
        if (!SetTokenInformation(token, 25, label, 16 + medium.BinaryLength)) throw new Win32Exception();
        return Start(token, IntPtr.Zero, directory, wait, commandLine, Console.Out);
      } finally {
        CloseHandle(token);
      }
    } finally {
      CloseHandle(own);
      foreach (IntPtr block in held) Marshal.FreeHGlobal(block);
    }
  }

  // As SYSTEM: the interactive token LogonUser makes for the user, put in the
  // session asked for, starts the command line there on WinSta0\Default,
  // without the secondary logon service.
  static int SystemRun(string file) {
    var output = new StringWriter();
    try {
      string[] lines = File.ReadAllLines(file);
      File.Delete(file);
      if (lines.Length < 6) throw new Win32Exception(87);
      int session = int.Parse(lines[2]);
      foreach (string name in new[] { "SeTcbPrivilege", "SeAssignPrimaryTokenPrivilege", "SeIncreaseQuotaPrivilege" }) Enable(name);
      IntPtr token;
      if (!LogonUserW(lines[0], ".", lines[1], 2, 0, out token)) throw new Win32Exception();
      IntPtr environment = IntPtr.Zero;
      IntPtr value = Marshal.AllocHGlobal(4);
      try {
        Marshal.WriteInt32(value, session);
        if (!SetTokenInformation(token, 12, value, 4)) throw new Win32Exception();
        if (session == 0) {
          // Session 0's WinSta0 (this task runs on a service window station):
          // the user let onto it and its Default desktop.
          IntPtr station = OpenWindowStationW("WinSta0", false, 0x37F);
          if (station == IntPtr.Zero || !SetProcessWindowStation(station)) throw new Win32Exception();
          Desktop(true, Sid(lines[0]));
        }
        if (!CreateEnvironmentBlock(out environment, token, false)) throw new Win32Exception();
        Start(token, environment, lines[3], lines[4] == "wait", lines[5], output);
      } finally {
        Marshal.FreeHGlobal(value);
        if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
        CloseHandle(token);
      }
    } catch (Win32Exception error) {
      output.WriteLine("error " + error.NativeErrorCode);
    } catch (Exception error) {
      output.WriteLine("error " + error.GetType().Name);
    }
    File.WriteAllText(file + ".out", output.ToString());
    return 0;
  }

  static int Start(IntPtr token, IntPtr environment, string directory, bool wait, string commandLine, TextWriter output) {
    var startup = new STARTUPINFO();
    startup.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    startup.lpDesktop = "winsta0\\default";
    PROCESS_INFORMATION info;
    if (!CreateProcessAsUserW(token, null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, false, CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, environment, directory, ref startup, out info))
      throw new Win32Exception();
    output.WriteLine("pid " + info.dwProcessId);
    output.Flush();
    if (wait) {
      int code;
      WaitForSingleObject(info.hProcess, INFINITE);
      GetExitCodeProcess(info.hProcess, out code);
      output.WriteLine("exit " + code);
    }
    CloseHandle(info.hThread);
    CloseHandle(info.hProcess);
    return 0;
  }

  static void Enable(string privilege) {
    long luid;
    if (!LookupPrivilegeValueW(null, privilege, out luid)) throw new Win32Exception();
    IntPtr own;
    if (!OpenProcessToken(GetCurrentProcess(), 0x28, out own)) throw new Win32Exception();
    IntPtr state = Marshal.AllocHGlobal(16);
    try {
      // TOKEN_PRIVILEGES: a count, then one LUID_AND_ATTRIBUTES (enabled).
      Marshal.WriteInt32(state, 0, 1);
      Marshal.WriteInt64(state, 4, luid);
      Marshal.WriteInt32(state, 12, 2);
      if (!AdjustTokenPrivileges(own, false, state, 16, IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
      if (Marshal.GetLastWin32Error() == 1300) throw new Win32Exception(1300);
    } finally {
      Marshal.FreeHGlobal(state);
      CloseHandle(own);
    }
  }

  static IntPtr Hold(List<IntPtr> held, int size) {
    IntPtr block = Marshal.AllocHGlobal(size);
    held.Add(block);
    return block;
  }

  static IntPtr Block(List<IntPtr> held, SecurityIdentifier sid) {
    byte[] binary = new byte[sid.BinaryLength];
    sid.GetBinaryForm(binary, 0);
    IntPtr block = Hold(held, binary.Length);
    Marshal.Copy(binary, 0, block, binary.Length);
    return block;
  }
}
