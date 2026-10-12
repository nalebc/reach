param([string]$Display="primary", [int]$MaxWidth=1600)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class ReachScreenDpi {
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern bool GetCursorInfo(out CURSORINFO value);
 [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr hdc,int x,int y,IntPtr icon,int width,int height,int step,IntPtr brush,uint flags);
 [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon,out ICONINFO info);
 [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr value);
 [StructLayout(LayoutKind.Sequential)] public struct ICONINFO { public bool fIcon; public uint xHotspot,yHotspot; public IntPtr hbmMask,hbmColor; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int x,y; }
 [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize,flags; public IntPtr hCursor; public POINT ptScreenPos; }
 [DllImport("wtsapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server,int session,int infoClass,out IntPtr buffer,out int bytes);
 [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr memory);
 // This session locked (WTSSessionInfoEx, level 1: SessionFlags is
 // WTS_SESSIONSTATE_LOCK). Unknown reads as unlocked: capture then fails
 // as before, with its message.
 public static bool Locked() {
  IntPtr buffer; int bytes;
  if (!WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buffer, out bytes)) return false;
  try { return bytes >= 16 && Marshal.ReadInt32(buffer) == 1 && Marshal.ReadInt32(buffer, 12) == 0; }
  finally { WTSFreeMemory(buffer); }
 }
}
'@
[ReachScreenDpi]::SetThreadDpiAwarenessContext([IntPtr](-4)) | Out-Null
$out = [Console]::OpenStandardOutput()
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$params = New-Object System.Drawing.Imaging.EncoderParameters(1)
$params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter([System.Drawing.Imaging.Encoder]::Quality, [long]65)
try {
    while ($null -ne ($line = [Console]::ReadLine())) {
        if ($line -notin 'frame','key') { continue }
        # Locked: one byte (2), as the Mac's helper says it. The phone keeps
        # the last picture, dimmed, with "Windows PC locked", and asks again
        # about once a second instead of reconnecting (remote-screen.mjs).
        if ($env:REACH_TEST_SCREEN_LOCKED -eq '1' -or [ReachScreenDpi]::Locked()) {
            $out.Write([BitConverter]::GetBytes([System.Net.IPAddress]::HostToNetworkOrder([int]1)), 0, 4)
            $out.WriteByte(2)
            $out.Flush()
            continue
        }
        $screen = if ($Display -eq 'primary') {[System.Windows.Forms.Screen]::PrimaryScreen} else {[System.Windows.Forms.Screen]::AllScreens | Where-Object {($_.DeviceName -replace '^.*(DISPLAY[0-9]+)$','$1') -eq $Display} | Select-Object -First 1}
        if (!$screen) { throw 'Display disconnected' }
        $bounds = $screen.Bounds
        $bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $scaled = $null
        $resize = $null
        $memory = New-Object System.IO.MemoryStream
        try {
            $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
            $cursor = New-Object ReachScreenDpi+CURSORINFO
            $cursor.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($cursor)
            if ([ReachScreenDpi]::GetCursorInfo([ref]$cursor) -and $cursor.flags -eq 1) {
                $icon=New-Object ReachScreenDpi+ICONINFO
                if ([ReachScreenDpi]::GetIconInfo($cursor.hCursor,[ref]$icon)) {
                    $hdc=$graphics.GetHdc()
                    try {[ReachScreenDpi]::DrawIconEx($hdc,($cursor.ptScreenPos.x-$bounds.X-[int]$icon.xHotspot),($cursor.ptScreenPos.y-$bounds.Y-[int]$icon.yHotspot),$cursor.hCursor,0,0,0,[IntPtr]::Zero,3) | Out-Null} finally {
                        $graphics.ReleaseHdc($hdc)
                        if ($icon.hbmMask -ne [IntPtr]::Zero) {[ReachScreenDpi]::DeleteObject($icon.hbmMask) | Out-Null}
                        if ($icon.hbmColor -ne [IntPtr]::Zero) {[ReachScreenDpi]::DeleteObject($icon.hbmColor) | Out-Null}
                    }
                }
            }
            $scale = [Math]::Min(1.0, $MaxWidth / $bounds.Width)
            $scaled = New-Object System.Drawing.Bitmap([int]($bounds.Width * $scale), [int]($bounds.Height * $scale))
            $resize = [System.Drawing.Graphics]::FromImage($scaled)
            $resize.DrawImage($bitmap, 0, 0, $scaled.Width, $scaled.Height)
            $scaled.Save($memory, $codec, $params)
            $data = $memory.ToArray()
            $length = [BitConverter]::GetBytes([System.Net.IPAddress]::HostToNetworkOrder([int]$data.Length))
            $out.Write($length, 0, 4)
            $out.Write($data, 0, $data.Length)
            $out.Flush()
        } finally {
            if ($resize) { $resize.Dispose() }
            if ($scaled) { $scaled.Dispose() }
            $graphics.Dispose(); $bitmap.Dispose(); $memory.Dispose()
        }
    }
} catch {
    [Console]::Error.WriteLine('Windows could not stream the desktop. Keep the computer signed in and unlocked, and run Reach in your desktop session.')
    exit 1
} finally { $params.Dispose(); $out.Dispose() }
