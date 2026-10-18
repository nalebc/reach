using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// Acceptance instrumentation only. No process is created or modified.
// https://learn.microsoft.com/windows/win32/api/wow64apiset/nf-wow64apiset-iswow64process2
public static class ReachAcceptanceArchitecture {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool IsWow64Process2(IntPtr process, out ushort processMachine, out ushort nativeMachine);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder image, ref uint size);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static string Machine(ushort value) {
        switch (value) {
            case 0: return "native";
            case 0x014c: return "x86";
            case 0x01c4: return "arm";
            case 0x8664: return "x64";
            case 0xaa64: return "arm64";
            case 0xa641: return "arm64ec";
            case 0xa64e: return "arm64x";
            default: return "0x" + value.ToString("x4");
        }
    }

    public static Dictionary<string, object> FileArchitecture(string file) {
        // Read only the executable's PE headers, never provider state.
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
        using (var reader = new BinaryReader(stream)) {
            if (stream.Length < 64 || reader.ReadUInt16() != 0x5a4d) throw new InvalidDataException("Expected a Windows executable.");
            stream.Position = 0x3c;
            int pe = reader.ReadInt32();
            if (pe < 64 || pe > stream.Length - 26) throw new InvalidDataException("Invalid PE header.");
            stream.Position = pe;
            if (reader.ReadUInt32() != 0x00004550) throw new InvalidDataException("Invalid PE signature.");
            ushort machine = reader.ReadUInt16();
            stream.Position = pe + 24;
            ushort magic = reader.ReadUInt16();
            int directories = magic == 0x10b ? 96 : magic == 0x20b ? 112 : 0;
            if (directories == 0 || pe + 24 + directories + 15 * 8 > stream.Length) throw new InvalidDataException("Invalid PE optional header.");
            stream.Position = pe + 24 + directories + 14 * 8;
            bool managed = reader.ReadUInt32() != 0;
            return new Dictionary<string, object> {
                { "path", Path.GetFullPath(file) }, { "peMachine", Machine(machine) },
                { "peMachineHex", "0x" + machine.ToString("x4") }, { "managed", managed }
            };
        }
    }

    public static Dictionary<string, object> Inspect(int processId) {
        IntPtr handle = OpenProcess(0x1000, false, (uint)processId); // QUERY_LIMITED_INFORMATION
        if (handle == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            ushort processMachine, nativeMachine;
            if (!IsWow64Process2(handle, out processMachine, out nativeMachine)) throw new Win32Exception(Marshal.GetLastWin32Error());
            var image = new StringBuilder(32768);
            uint size = (uint)image.Capacity;
            if (!QueryFullProcessImageName(handle, 0, image, ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new Dictionary<string, object> {
                { "processId", processId }, { "executable", image.ToString() },
                { "runtimeArchitecture", Machine(processMachine == 0 ? nativeMachine : processMachine) },
                { "nativeArchitecture", Machine(nativeMachine) }, { "emulated", processMachine != 0 },
                { "processMachineHex", "0x" + processMachine.ToString("x4") },
                { "nativeMachineHex", "0x" + nativeMachine.ToString("x4") },
                { "image", FileArchitecture(image.ToString()) }
            };
        } finally { CloseHandle(handle); }
    }
}
