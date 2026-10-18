// Disposable hosted-VM UI setup for the installed-upgrade acceptance test only.
// Unlike the daemon-only standard-user-process.cs, this uses the real visible
// WinSta0. No token filtering, profile substitution or redirected Reach output.
// Microsoft: window-stations, CreateProcessWithLogonW, Get/SetUserObjectSecurity,
// CreateDesktopW and SwitchDesktop in the Win32 documentation.
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;

public sealed class ReachUpgradeInteractiveProcess : IDisposable {
    const uint DaclInformation = 4, ReadControl = 0x20000, WriteDacl = 0x40000;
    // No clipboard, screen read, desktop creation, attribute writes or logoff.
    const int UserStationRights = 0x123; // enumerate desktops/station, read attributes, global atoms
    // Only the dedicated desktop: read/write objects, create window/menu, enumerate.
    const int UserDesktopRights = 0xC7;
    const uint DesktopRead = 1, DesktopSwitch = 0x100;
    const ControlFlags DaclFlags = ControlFlags.DiscretionaryAclPresent | ControlFlags.DiscretionaryAclDefaulted
        | ControlFlags.DiscretionaryAclAutoInheritRequired | ControlFlags.DiscretionaryAclAutoInherited | ControlFlags.DiscretionaryAclProtected;
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, BufferWidth, BufferHeight, Fill, Flags;
        public short Show, ReservedLength; public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Size; public IntPtr Descriptor; public bool Inherit; }
    public sealed class DesktopState {
        public string WindowStation, Desktop; public uint WindowStationFlags;
        public bool WindowStationVisible, InputDesktop; public int SessionId;
    }
    public sealed class Evidence {
        public string Stage = "not-opened", TargetSid, CallerWindowStation, CallerDesktop, OriginalInputDesktop, Desktop;
        public uint WindowStationFlags; public bool WindowStationVisible;
        public int SessionId, GrantedStationMask = UserStationRights, GrantedDesktopMask = UserDesktopRights;
        public string OriginalStationDacl, TemporaryStationDacl, RestoredStationDacl;
        public string OriginalDaclSHA256, TemporaryDaclSHA256, RestoredDaclSHA256;
        public int OriginalDaclControl, TemporaryDaclControl, RestoredDaclControl;
        public string UnexpectedStationDacl, UnexpectedAclCleanupAction, UnexpectedCleanupDaclSHA256;
        public int UnexpectedAclExactAceMatches;
        public bool UnexpectedAclOnlyOurAceRemoved, UnexpectedAclOtherRulesPreserved;
        public bool StationGrantApplied, DesktopCreated, DesktopActivated, DedicatedDesktopReceivesInput;
        public bool OriginalInputRestored, CallerThreadDesktopRestored, StationBeforeRestoreMatchesExpected, StationAclRestored;
        public bool DesktopHandleClosed, DesktopRemoved, StationHandleClosed, ProcessHandlesClosed = true;
        public string Cleanup = "pending", ErrorStage; public int NativeError;
    }
    public sealed class Result { public int ProcessId, ExitCode; }
    public readonly Evidence State = new Evidence();
    readonly SecurityIdentifier target;
    IntPtr station, desktop, originalInput, originalThreadDesktop;
    byte[] originalSecurity, expectedAcl, ownedAce;
    ControlFlags originalFlags;
    bool mayHaveChangedAcl, inputChanged, disposed, processHandleFailure;

    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetThreadDesktop(uint threadId);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetThreadDesktop(IntPtr desktop);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserObjectInformationW(IntPtr handle, int kind, IntPtr data, uint size, out uint needed);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool GetUserObjectSecurity(IntPtr handle, ref uint information, [Out] byte[] descriptor, uint length, out uint needed);
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetUserObjectSecurity(IntPtr handle, ref uint information, byte[] descriptor);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes security);
    [UnmanagedFunctionPointer(CallingConvention.Winapi, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    delegate bool DesktopCallback([MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool EnumDesktopsW(IntPtr station, DesktopCallback callback, IntPtr parameter);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SwitchDesktop(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] static extern bool CloseWindowStation(IntPtr handle);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithLogonW(string user, string domain, string password, int logonFlags, string application, StringBuilder command, int flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr handle, out int code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr handle, int code);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    static byte[] ObjectInformation(IntPtr handle, int kind) {
        uint needed;
        GetUserObjectInformationW(handle, kind, IntPtr.Zero, 0, out needed);
        if (needed == 0 || needed > 65536) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr data = Marshal.AllocHGlobal((int)needed);
        try {
            if (!GetUserObjectInformationW(handle, kind, data, needed, out needed)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var bytes = new byte[(int)needed]; Marshal.Copy(data, bytes, 0, bytes.Length); return bytes;
        } finally { Marshal.FreeHGlobal(data); }
    }
    static string Name(IntPtr handle) { return Encoding.Unicode.GetString(ObjectInformation(handle, 2)).TrimEnd('\0'); }
    static uint Flags(IntPtr handle) { return BitConverter.ToUInt32(ObjectInformation(handle, 1), 8); }
    static bool ReceivesInput(IntPtr handle) { return BitConverter.ToInt32(ObjectInformation(handle, 6), 0) != 0; }
    public static DesktopState InspectCurrent() {
        IntPtr station = GetProcessWindowStation(), desktop = GetThreadDesktop(GetCurrentThreadId());
        if (station == IntPtr.Zero || desktop == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        uint flags = Flags(station);
        return new DesktopState { WindowStation = Name(station), WindowStationFlags = flags,
            WindowStationVisible = (flags & 1) != 0, Desktop = Name(desktop), InputDesktop = ReceivesInput(desktop),
            SessionId = Process.GetCurrentProcess().SessionId };
    }
    Win32Exception NativeFailure() {
        State.ErrorStage = State.Stage; State.NativeError = Marshal.GetLastWin32Error(); return new Win32Exception(State.NativeError);
    }
    static byte[] AclBytes(RawSecurityDescriptor value) {
        if (value.DiscretionaryAcl == null) throw new Exception("A real explicit window-station DACL is required.");
        var bytes = new byte[value.DiscretionaryAcl.BinaryLength]; value.DiscretionaryAcl.GetBinaryForm(bytes, 0); return bytes;
    }
    static byte[] AceBytes(GenericAce ace) { var bytes = new byte[ace.BinaryLength]; ace.GetBinaryForm(bytes, 0); return bytes; }
    static string Digest(byte[] bytes) { using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(); }
    static bool Equal(byte[] a, byte[] b) {
        if (a.Length != b.Length) return false;
        for (int i = 0; i < a.Length; i++) if (a[i] != b[i]) return false;
        return true;
    }
    byte[] Security() {
        uint information = DaclInformation, needed;
        GetUserObjectSecurity(station, ref information, null, 0, out needed);
        if (needed == 0 || needed > 65536) throw NativeFailure();
        var bytes = new byte[(int)needed];
        if (!GetUserObjectSecurity(station, ref information, bytes, needed, out needed)) throw NativeFailure();
        return bytes;
    }
    void SetSecurity(byte[] bytes) {
        uint information = DaclInformation;
        if (!SetUserObjectSecurity(station, ref information, bytes)) throw NativeFailure();
    }

    public ReachUpgradeInteractiveProcess(string sid) {
        if (Environment.OSVersion.Platform != PlatformID.Win32NT || Environment.GetEnvironmentVariable("GITHUB_ACTIONS") != "true"
            || Environment.GetEnvironmentVariable("RUNNER_ENVIRONMENT") != "github-hosted" || Environment.GetEnvironmentVariable("RUNNER_OS") != "Windows")
            throw new Exception("Interactive setup is restricted to a disposable GitHub-hosted Windows VM.");
        if (!Regex.IsMatch(sid, "^S-1-5-21-[0-9]+-[0-9]+-[0-9]+-[0-9]+$")) throw new Exception("An explicit generated local-account SID is required.");
        target = new SecurityIdentifier(sid); State.TargetSid = sid;
    }
    public void Open() {
        State.Stage = "verify-existing-interactive-station";
        var current = InspectCurrent();
        State.CallerWindowStation = current.WindowStation; State.CallerDesktop = current.Desktop;
        State.WindowStationFlags = current.WindowStationFlags; State.WindowStationVisible = current.WindowStationVisible; State.SessionId = current.SessionId;
        if (!String.Equals(current.WindowStation, "WinSta0", StringComparison.OrdinalIgnoreCase) || !current.WindowStationVisible)
            throw new Exception("A real visible WinSta0 is a missing fixture prerequisite; no UI probe ran.");
        originalThreadDesktop = GetThreadDesktop(GetCurrentThreadId());
        if (originalThreadDesktop == IntPtr.Zero) throw NativeFailure();
        station = OpenWindowStationW("WinSta0", false, ReadControl | WriteDacl | 3);
        if (station == IntPtr.Zero) throw NativeFailure();
        originalInput = OpenInputDesktop(0, false, DesktopRead | DesktopSwitch);
        if (originalInput == IntPtr.Zero) throw NativeFailure();
        State.OriginalInputDesktop = Name(originalInput);
        if (!ReceivesInput(originalInput)) throw new Exception("The actual input desktop could not be established.");
        State.Stage = "capture-and-grant-station-ACL";
        originalSecurity = Security();
        var security = new RawSecurityDescriptor(originalSecurity, 0);
        byte[] originalAcl = AclBytes(security); originalFlags = security.ControlFlags & DaclFlags;
        State.OriginalDaclControl = (int)originalFlags;
        State.OriginalStationDacl = security.GetSddlForm(AccessControlSections.Access); State.OriginalDaclSHA256 = Digest(originalAcl);
        int insert = security.DiscretionaryAcl.Count;
        for (int i = 0; i < security.DiscretionaryAcl.Count; i++) {
            var known = security.DiscretionaryAcl[i] as KnownAce;
            if (known != null && known.SecurityIdentifier.Equals(target)) throw new Exception("The generated SID unexpectedly already has a station ACE.");
            if ((security.DiscretionaryAcl[i].AceFlags & AceFlags.Inherited) != 0 && insert == security.DiscretionaryAcl.Count) insert = i;
        }
        var added = new CommonAce(AceFlags.None, AceQualifier.AccessAllowed, UserStationRights, target, false, null);
        ownedAce = AceBytes(added); security.DiscretionaryAcl.InsertAce(insert, added);
        expectedAcl = AclBytes(security);
        State.TemporaryStationDacl = security.GetSddlForm(AccessControlSections.Access); State.TemporaryDaclSHA256 = Digest(expectedAcl);
        var changed = new byte[security.BinaryLength]; security.GetBinaryForm(changed, 0);
        mayHaveChangedAcl = true; SetSecurity(changed);
        var applied = new RawSecurityDescriptor(Security(), 0);
        State.TemporaryDaclControl = (int)(applied.ControlFlags & DaclFlags);
        if (!Equal(expectedAcl, AclBytes(applied)) || (applied.ControlFlags & DaclFlags) != originalFlags) throw new Exception("The temporary station ACE did not match the requested exact ACL.");
        State.StationGrantApplied = true;
        State.Stage = "create-dedicated-interactive-desktop";
        State.Desktop = "ReachUpgrade" + Guid.NewGuid().ToString("N");
        var descriptor = new RawSecurityDescriptor("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x000000c7;;;" + target.Value + ")");
        var data = new byte[descriptor.BinaryLength]; descriptor.GetBinaryForm(data, 0);
        IntPtr memory = Marshal.AllocHGlobal(data.Length);
        try {
            Marshal.Copy(data, 0, memory, data.Length);
            var attributes = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = memory };
            desktop = CreateDesktopW(State.Desktop, IntPtr.Zero, IntPtr.Zero, 0, 0xF01FF, ref attributes);
            if (desktop == IntPtr.Zero) throw NativeFailure();
            State.DesktopCreated = true;
        } finally { Marshal.FreeHGlobal(memory); }
        State.Stage = "activate-owned-VM-desktop";
        if (!SwitchDesktop(desktop)) throw NativeFailure();
        inputChanged = true; State.DesktopActivated = true; State.DedicatedDesktopReceivesInput = ReceivesInput(desktop);
        if (!State.DedicatedDesktopReceivesInput) throw new Exception("The dedicated real desktop did not receive input.");
        State.Stage = "interactive-desktop-ready";
    }
    // An unexpected concurrent ACL is never overwritten with an old snapshot.
    // Remove our one exact ACE only when unique; preserve every other ACE in
    // its current order and retain the current control flags. This path always
    // fails qualification, even if that narrowly scoped removal succeeds.
    void RemoveOnlyOwnedAce(RawSecurityDescriptor current) {
        State.UnexpectedStationDacl = current.GetSddlForm(AccessControlSections.Access);
        byte[] before = AclBytes(current);
        ControlFlags flags = current.ControlFlags & DaclFlags;
        int found = -1;
        for (int i = 0; i < current.DiscretionaryAcl.Count; i++) if (Equal(AceBytes(current.DiscretionaryAcl[i]), ownedAce)) {
            State.UnexpectedAclExactAceMatches++; found = i;
        }
        if (State.UnexpectedAclExactAceMatches != 1) {
            State.UnexpectedAclCleanupAction = "unchanged: no unique exact generated-account ACE"; return;
        }
        // A second native read must still match the inspected ACL before any
        // mutation. A further change is left untouched and remains a failure.
        var latest = new RawSecurityDescriptor(Security(), 0);
        if (!Equal(before, AclBytes(latest)) || (latest.ControlFlags & DaclFlags) != flags) {
            State.UnexpectedAclCleanupAction = "unchanged: station ACL changed again"; return;
        }
        current.DiscretionaryAcl.RemoveAce(found);
        byte[] remaining = AclBytes(current);
        var changed = new byte[current.BinaryLength]; current.GetBinaryForm(changed, 0);
        SetSecurity(changed);
        var after = new RawSecurityDescriptor(Security(), 0);
        State.UnexpectedCleanupDaclSHA256 = Digest(AclBytes(after));
        State.UnexpectedAclOtherRulesPreserved = Equal(remaining, AclBytes(after)) && (after.ControlFlags & DaclFlags) == flags;
        State.UnexpectedAclOnlyOurAceRemoved = State.UnexpectedAclOtherRulesPreserved;
        State.UnexpectedAclCleanupAction = State.UnexpectedAclOnlyOurAceRemoved
            ? "removed only unique exact generated-account ACE; every other rule retained; fixture still failed"
            : "exact generated-account ACE removal could not be verified; fixture failed";
    }
    // Password only crosses this in-process call and the Windows credential API.
    // The real profile environment is created by Windows; no HOME/state override.
    public Result Run(string user, string password, string application, string command, string directory, uint timeoutMs) {
        if (!State.StationGrantApplied || !State.DedicatedDesktopReceivesInput || disposed) throw new Exception("The actual interactive fixture is not ready.");
        State.Stage = "credential-process-launch-and-wait";
        var process = new ProcessInfo();
        try {
            var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Desktop = "WinSta0\\" + State.Desktop, Title = "Reach standard-user installed upgrade" };
            if (!CreateProcessWithLogonW(user, ".", password, 1, application, new StringBuilder(command), 0x410, IntPtr.Zero, directory, ref startup, out process)) throw NativeFailure();
            uint wait = WaitForSingleObject(process.Process, timeoutMs);
            if (wait != 0) {
                if (!TerminateProcess(process.Process, 124)) throw NativeFailure();
                WaitForSingleObject(process.Process, 3000);
                throw new Exception("The interactive standard-user worker did not finish within its existing bound.");
            }
            int exit; if (!GetExitCodeProcess(process.Process, out exit)) throw NativeFailure();
            State.Stage = "worker-finished";
            return new Result { ProcessId = process.ProcessId, ExitCode = exit };
        } finally {
            if (process.Thread != IntPtr.Zero && !CloseHandle(process.Thread)) { NativeFailure(); processHandleFailure = true; }
            if (process.Process != IntPtr.Zero && !CloseHandle(process.Process)) { NativeFailure(); processHandleFailure = true; }
            State.ProcessHandlesClosed = !processHandleFailure;
            if (processHandleFailure) throw new Exception("Owned credential-process handles did not close.");
        }
    }
    // Called after the PS harness ends only this generated SID's processes.
    // Every restoration/close is attempted, including after a failed worker.
    public void Dispose() {
        if (disposed) return; disposed = true;
        bool failed = processHandleFailure;
        if (inputChanged) {
            State.Stage = "restore-original-input-desktop";
            try { if (!SwitchDesktop(originalInput)) throw NativeFailure(); State.OriginalInputRestored = ReceivesInput(originalInput); if (!State.OriginalInputRestored) failed = true; }
            catch { failed = true; }
        } else State.OriginalInputRestored = true;
        if (originalThreadDesktop != IntPtr.Zero) {
            State.Stage = "restore-caller-thread-desktop";
            try {
                if (!String.Equals(Name(GetThreadDesktop(GetCurrentThreadId())), State.CallerDesktop, StringComparison.OrdinalIgnoreCase)
                    && !SetThreadDesktop(originalThreadDesktop)) throw NativeFailure();
                State.CallerThreadDesktopRestored = String.Equals(Name(GetThreadDesktop(GetCurrentThreadId())), State.CallerDesktop, StringComparison.OrdinalIgnoreCase);
                if (!State.CallerThreadDesktopRestored) failed = true;
            } catch { failed = true; }
        } else State.CallerThreadDesktopRestored = true;
        if (mayHaveChangedAcl) {
            State.Stage = "restore-original-station-ACL";
            try {
                var before = new RawSecurityDescriptor(Security(), 0);
                State.StationBeforeRestoreMatchesExpected = Equal(expectedAcl, AclBytes(before)) && (before.ControlFlags & DaclFlags) == originalFlags;
                if (State.StationBeforeRestoreMatchesExpected) {
                    SetSecurity(originalSecurity);
                    var restored = new RawSecurityDescriptor(Security(), 0);
                    State.RestoredDaclControl = (int)(restored.ControlFlags & DaclFlags);
                    State.RestoredStationDacl = restored.GetSddlForm(AccessControlSections.Access); State.RestoredDaclSHA256 = Digest(AclBytes(restored));
                    State.StationAclRestored = Equal(AclBytes(new RawSecurityDescriptor(originalSecurity, 0)), AclBytes(restored))
                        && (restored.ControlFlags & DaclFlags) == originalFlags && State.OriginalStationDacl == State.RestoredStationDacl;
                    if (!State.StationAclRestored) failed = true;
                } else {
                    failed = true; State.StationAclRestored = false; RemoveOnlyOwnedAce(before);
                }
            } catch { failed = true; }
        } else State.StationAclRestored = true;
        if (desktop != IntPtr.Zero) {
            State.Stage = "close-dedicated-desktop"; State.DesktopHandleClosed = CloseDesktop(desktop); desktop = IntPtr.Zero;
            if (!State.DesktopHandleClosed) failed = true;
            for (int i = 0; i < 60; i++) {
                bool present = false;
                DesktopCallback check = delegate(string name, IntPtr unused) { if (String.Equals(name, State.Desktop, StringComparison.OrdinalIgnoreCase)) present = true; return true; };
                if (!EnumDesktopsW(station, check, IntPtr.Zero)) { NativeFailure(); failed = true; break; }
                if (!present) { State.DesktopRemoved = true; break; }
                Thread.Sleep(50);
            }
            if (!State.DesktopRemoved) failed = true;
        }
        if (originalInput != IntPtr.Zero) { if (!CloseDesktop(originalInput)) failed = true; originalInput = IntPtr.Zero; }
        if (station != IntPtr.Zero) { State.StationHandleClosed = CloseWindowStation(station); station = IntPtr.Zero; if (!State.StationHandleClosed) failed = true; }
        State.Cleanup = failed ? "FAIL" : "PASS"; State.Stage = "interactive-cleanup-finished";
        if (failed) throw new Exception("Interactive fixture cleanup failed; see allowlisted desktop/ACL evidence.");
    }
}
