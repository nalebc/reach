import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Windows' Recycle Bin, as Explorer's Delete does: the file can be restored
// from there (parity audit #38; a Mac's ~/.Trash is its Trash, Windows has
// no such folder). SHFileOperation with undo, and no dialog of any kind:
// nothing appears on the PC. The path travels as data, never as script.
const SCRIPT = `
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class ReachRecycle {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
 struct Op { public IntPtr hwnd; public uint wFunc; public string pFrom; public string pTo; public ushort fFlags; public bool aborted; public IntPtr mappings; public string title; }
 [DllImport("shell32.dll", CharSet=CharSet.Unicode)] static extern int SHFileOperation(ref Op op);
 // FO_DELETE; FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI.
 public static int Recycle(string file) {
  var op = new Op { wFunc = 3, pFrom = file + "\\0", fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400 };
  int code = SHFileOperation(ref op);
  return code != 0 ? code : op.aborted ? -1 : 0;
 }
}
'@
$code = [ReachRecycle]::Recycle($env:REACH_RECYCLE)
if ($code -ne 0) { [Console]::Error.WriteLine("SHFileOperation $code"); exit 1 }
`;
export async function recycle(file, { run = exec } = {}) {
  await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
    timeout: 30000,
    windowsHide: true,
    env: { ...process.env, REACH_RECYCLE: file },
  });
}
