// Real Windows account/process APIs for the disposable acceptance runner.
// No token filtering, executable substitution or provider emulation.
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class ReachAcceptanceUserProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
        public int Size;
        public string Reserved, Desktop, Title;
        public int X, Y, Width, Height, BufferWidth, BufferHeight, Fill, Flags;
        public short Show, ReservedLength;
        public IntPtr ReservedData, Input, Output, Error;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr Process, Thread; public int ProcessId, ThreadId; }
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public int Size; public IntPtr Descriptor; public bool Inherit; }
    public sealed class Result { public int ProcessId, ExitCode; public string Desktop; }
    public sealed class TokenState { public int ProcessId; public bool Elevated; public string UserSid, IntegritySid, ProfileDirectory; }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcessWithLogonW(string user, string domain, string password, int logonFlags, string application, StringBuilder command, int flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, int revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool ConvertSidToStringSidW(IntPtr sid, out IntPtr text);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool GetUserProfileDirectoryW(IntPtr token, StringBuilder directory, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int processId);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out int code);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr process, int code);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateDesktopW(string name, IntPtr device, IntPtr mode, uint flags, uint access, ref SecurityAttributes security);
    [DllImport("user32.dll")]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)]
    static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll")]
    static extern bool CloseWindowStation(IntPtr station);
    [DllImport("user32.dll")]
    static extern bool CloseDesktop(IntPtr desktop);

    static Win32Exception NativeError() { return new Win32Exception(Marshal.GetLastWin32Error()); }
    static string SidString(IntPtr sid) {
        IntPtr text;
        if (!ConvertSidToStringSidW(sid, out text)) throw NativeError();
        try { return Marshal.PtrToStringUni(text); } finally { LocalFree(text); }
    }
    static IntPtr TokenInfo(IntPtr token, int kind) {
        int needed;
        GetTokenInformation(token, kind, IntPtr.Zero, 0, out needed);
        if (needed <= 0) throw NativeError();
        IntPtr data = Marshal.AllocHGlobal(needed);
        if (!GetTokenInformation(token, kind, data, needed, out needed)) {
            int error = Marshal.GetLastWin32Error();
            Marshal.FreeHGlobal(data);
            throw new Win32Exception(error);
        }
        return data;
    }
    public static TokenState Inspect(int processId) {
        IntPtr process = OpenProcess(0x1000, false, processId), token = IntPtr.Zero;
        if (process == IntPtr.Zero) throw NativeError();
        try {
            if (!OpenProcessToken(process, 8, out token)) throw NativeError();
            var state = new TokenState { ProcessId = processId };
            IntPtr data = TokenInfo(token, 20); // TokenElevation
            try { state.Elevated = Marshal.ReadInt32(data) != 0; } finally { Marshal.FreeHGlobal(data); }
            data = TokenInfo(token, 1); // TOKEN_USER starts with SID_AND_ATTRIBUTES.
            try { state.UserSid = SidString(Marshal.ReadIntPtr(data)); } finally { Marshal.FreeHGlobal(data); }
            data = TokenInfo(token, 25); // TOKEN_MANDATORY_LABEL starts with SID_AND_ATTRIBUTES.
            try { state.IntegritySid = SidString(Marshal.ReadIntPtr(data)); } finally { Marshal.FreeHGlobal(data); }
            uint size = 0;
            GetUserProfileDirectoryW(token, null, ref size);
            if (size == 0) throw NativeError();
            var directory = new StringBuilder((int)size);
            if (!GetUserProfileDirectoryW(token, directory, ref size)) throw NativeError();
            state.ProfileDirectory = directory.ToString();
            return state;
        } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
    }

    // The password is passed only through an in-process managed call to the
    // credential API. It is never a command argument, file or environment var.
    // A private test window station avoids granting access to WinSta0/Default.
    // LOGON_WITH_PROFILE and a null environment load the real new user's profile.
    public static Result Run(string user, string password, string sid, string application, string command, string directory, uint timeoutMs) {
        IntPtr descriptor = IntPtr.Zero, station = IntPtr.Zero, desktop = IntPtr.Zero;
        IntPtr original = GetProcessWindowStation();
        var process = new ProcessInfo();
        string stationName = "ReachAcceptance" + Guid.NewGuid().ToString("N");
        try {
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;" + sid + ")", 1, out descriptor, IntPtr.Zero)) throw NativeError();
            var security = new SecurityAttributes { Size = Marshal.SizeOf(typeof(SecurityAttributes)), Descriptor = descriptor };
            station = CreateWindowStationW(stationName, 0, 0xF037F, ref security);
            if (station == IntPtr.Zero) throw NativeError();
            if (!SetProcessWindowStation(station)) throw NativeError();
            try {
                desktop = CreateDesktopW("Default", IntPtr.Zero, IntPtr.Zero, 0, 0xF01FF, ref security);
                if (desktop == IntPtr.Zero) throw NativeError();
            } finally { if (!SetProcessWindowStation(original)) throw NativeError(); }
            var startup = new StartupInfo { Size = Marshal.SizeOf(typeof(StartupInfo)), Desktop = stationName + "\\Default", Title = "Reach standard-user Codex acceptance" };
            // Explicit application prevents command-line executable ambiguity.
            // CREATE_NEW_CONSOLE | CREATE_UNICODE_ENVIRONMENT, no inherited env.
            if (!CreateProcessWithLogonW(user, ".", password, 1, application, new StringBuilder(command), 0x410, IntPtr.Zero, directory, ref startup, out process)) throw NativeError();
            uint wait = WaitForSingleObject(process.Process, timeoutMs);
            if (wait != 0) {
                TerminateProcess(process.Process, 124);
                WaitForSingleObject(process.Process, 3000);
                throw new Exception(wait == 258 ? "The standard-user worker exceeded its bounded runtime." : "Waiting for the standard-user worker failed.");
            }
            int exit;
            if (!GetExitCodeProcess(process.Process, out exit)) throw NativeError();
            return new Result { ProcessId = process.ProcessId, ExitCode = exit, Desktop = "private acceptance window station and desktop" };
        } finally {
            if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
            if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
            if (desktop != IntPtr.Zero) CloseDesktop(desktop);
            if (station != IntPtr.Zero) CloseWindowStation(station);
            if (descriptor != IntPtr.Zero) LocalFree(descriptor);
        }
    }
}
