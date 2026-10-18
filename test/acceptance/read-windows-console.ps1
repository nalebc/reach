param([Parameter(Mandatory=$true)][int]$ConsoleProcessId)
$ErrorActionPreference = 'Stop'
# Read the actual visible console, not a transcript or a test stdout pipe.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
public static class ReachAcceptanceConsole {
    [StructLayout(LayoutKind.Sequential)] public struct Coord { public short X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public short Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct Info { public Coord Size, Cursor; public short Attributes; public Rect Window; public Coord Maximum; }
    [DllImport("kernel32.dll")] static extern bool FreeConsole();
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AttachConsole(uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetConsoleScreenBufferInfo(IntPtr handle, out Info info);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ReadConsoleOutputCharacter(IntPtr handle, StringBuilder text, uint count, Coord at, out uint read);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    public static string Read(uint pid) {
        FreeConsole();
        if (!AttachConsole(pid)) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr handle = new IntPtr(-1);
        try {
            if (!IsWindowVisible(GetConsoleWindow())) throw new Exception("The Reach console is not visible.");
            handle = CreateFile("CONOUT$", 0x80000000, 3, IntPtr.Zero, 3, 0, IntPtr.Zero);
            Info info;
            if (!GetConsoleScreenBufferInfo(handle, out info)) throw new Win32Exception(Marshal.GetLastWin32Error());
            int rows = Math.Min(info.Size.Y, info.Cursor.Y + 2);
            int count = Math.Min(200000, info.Size.X * rows);
            var buffer = new StringBuilder(count);
            uint read;
            if (!ReadConsoleOutputCharacter(handle, buffer, (uint)count, new Coord(), out read)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return buffer.ToString();
        } finally { if (handle != new IntPtr(-1)) CloseHandle(handle); FreeConsole(); }
    }
}
'@
$text = [ReachAcceptanceConsole]::Read([uint32]$ConsoleProcessId)
@{ visible = $true; text = $text } | ConvertTo-Json -Compress
