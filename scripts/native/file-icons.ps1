# Explorer's icon for each file type in $types ("folder", "file" or an
# extension), as one line of base64 PNG each, in order; empty when unavailable.
# Run through -EncodedCommand with $types defined first (server/file-icons.mjs).
$ErrorActionPreference = "Stop"
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
public static class ReachFileIcons {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FileInfo {
    public IntPtr icon;
    public int index;
    public uint attributes;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string displayName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string typeName;
  }
  [ComImport, Guid("46EB5926-582E-4017-9FDF-E8998DAA0950"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IImageList {
    [PreserveSig] int Add(IntPtr image, IntPtr mask, ref int index);
    [PreserveSig] int ReplaceIcon(int i, IntPtr icon, ref int index);
    [PreserveSig] int SetOverlayImage(int image, int overlay);
    [PreserveSig] int Replace(int i, IntPtr image, IntPtr mask);
    [PreserveSig] int AddMasked(IntPtr image, int mask, ref int index);
    [PreserveSig] int Draw(IntPtr parameters);
    [PreserveSig] int Remove(int i);
    [PreserveSig] int GetIcon(int i, int flags, ref IntPtr icon);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SHGetFileInfo(string path, uint attributes, ref FileInfo info, uint size, uint flags);
  [DllImport("shell32.dll", EntryPoint = "#727")]
  static extern int SHGetImageList(int list, ref Guid id, out IImageList images);
  [DllImport("user32.dll")]
  static extern bool DestroyIcon(IntPtr icon);
  public static string Png(string type) {
    bool folder = type == "folder";
    var info = new FileInfo();
    // SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES: by type, no real file.
    SHGetFileInfo(folder ? "folder" : type == "file" ? "file" : "file." + type,
      folder ? 0x10u : 0x80u, ref info, (uint)Marshal.SizeOf(info), 0x4010u);
    var id = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
    IImageList images;
    // SHIL_EXTRALARGE: 48 px, the largest size every type provides.
    if (SHGetImageList(2, ref id, out images) != 0) return "";
    IntPtr handle = IntPtr.Zero;
    if (images.GetIcon(info.index, 1, ref handle) != 0 || handle == IntPtr.Zero) return "";
    try {
      using (var icon = Icon.FromHandle(handle))
      using (var bitmap = icon.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return Convert.ToBase64String(stream.ToArray());
      }
    } finally {
      DestroyIcon(handle);
    }
  }
}
"@
foreach ($type in $types) {
  try { [ReachFileIcons]::Png($type) } catch { "" }
}
