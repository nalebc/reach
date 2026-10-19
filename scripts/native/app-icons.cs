// The icon Windows shows for each app or program, as a PNG: what Start, the
// taskbar and Explorer draw (the shell's own image for the item). Run by
// server/app-icons.mjs, the twin of a Mac's scripts/native/app-icon.js.
//
//   app-icons.exe <size>
// stdin: one target a line: an app's id from Start (Get-StartApps' AppID,
// read through shell:AppsFolder) or a program's full path (C:\...\x.exe).
// stdout: one line per target, in order: its icon as base64 PNG, square,
// <size> pixels (16 to 256), or an empty line when Windows has none.
//
//   app-icons.exe apps
// stdout: AppsFolder's launchable items, one base64 UTF-8 AppID, tab and
// base64 UTF-8 name per line. The ID is the same shell identity Start uses.
//   app-icons.exe types <type...>
// stdout: Explorer's 48 px file type icons, one base64 PNG per argument.
//   app-icons.exe open <AppID>
// One ShellExecute request for an ID the server validated in its catalog.
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;

static class AppIcons {
  static object Member(object value, string name, BindingFlags action, params object[] args) {
    return value.GetType().InvokeMember(name, action, null, value, args);
  }
  static void Release(object value) {
    if (value != null && Marshal.IsComObject(value)) Marshal.ReleaseComObject(value);
  }
  static void Apps(TextWriter output) {
    object shell = null, folder = null, items = null;
    try {
      shell = Activator.CreateInstance(Type.GetTypeFromProgID("Shell.Application", true));
      folder = Member(shell, "NameSpace", BindingFlags.InvokeMethod, "shell:AppsFolder");
      if (folder == null) throw new InvalidOperationException("AppsFolder is unavailable.");
      items = Member(folder, "Items", BindingFlags.InvokeMethod);
      int count = Convert.ToInt32(Member(items, "Count", BindingFlags.GetProperty));
      for (int i = 0; i < count; i++) {
        object item = null;
        try {
          item = Member(items, "Item", BindingFlags.InvokeMethod, i);
          string name = Convert.ToString(Member(item, "Name", BindingFlags.GetProperty));
          string id = Convert.ToString(Member(item, "ExtendedProperty", BindingFlags.InvokeMethod, "System.AppUserModel.ID"));
          // Unpackaged Start items can expose their stable shell identity as
          // Path instead. This remains AppsFolder's ID, never a name-derived
          // command or an identity guessed from a different installation.
          if (String.IsNullOrEmpty(id)) id = Convert.ToString(Member(item, "Path", BindingFlags.GetProperty));
          if (String.IsNullOrEmpty(id) || String.IsNullOrEmpty(name)) continue;
          output.WriteLine(Convert.ToBase64String(Encoding.UTF8.GetBytes(id)) + "\t" + Convert.ToBase64String(Encoding.UTF8.GetBytes(name)));
        } finally { Release(item); }
      }
    } finally {
      Release(items); Release(folder); Release(shell);
    }
  }

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
    [PreserveSig] int Replace(int i, IntPtr image, int overlay);
    [PreserveSig] int AddMasked(IntPtr image, int mask, ref int index);
    [PreserveSig] int Draw(IntPtr parameters);
    [PreserveSig] int Remove(int i);
    [PreserveSig] int GetIcon(int i, int flags, ref IntPtr icon);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern IntPtr SHGetFileInfo(string path, uint attributes, ref FileInfo info, uint size, uint flags);
  [DllImport("shell32.dll", EntryPoint = "#727")]
  static extern int SHGetImageList(int list, ref Guid id, out IImageList images);
  [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr icon);
  static string FileTypePng(string type) {
    var info = new FileInfo();
    bool folder = type == "folder";
    // SHGFI_SYSICONINDEX | SHGFI_USEFILEATTRIBUTES: Explorer's icon for the
    // type, with no real file to read. SHIL_EXTRALARGE is 48 px.
    if (SHGetFileInfo(folder ? "folder" : type == "file" ? "file" : "file." + type,
        folder ? 0x10u : 0x80u, ref info, (uint)Marshal.SizeOf(info), 0x4010u) == IntPtr.Zero) return "";
    var id = new Guid("46EB5926-582E-4017-9FDF-E8998DAA0950");
    IImageList images;
    if (SHGetImageList(2, ref id, out images) != 0 || images == null) return "";
    IntPtr handle = IntPtr.Zero;
    try {
      if (images.GetIcon(info.index, 1, ref handle) != 0 || handle == IntPtr.Zero) return "";
      using (var icon = Icon.FromHandle(handle))
      using (var bitmap = icon.ToBitmap())
      using (var stream = new MemoryStream()) {
        bitmap.Save(stream, ImageFormat.Png);
        return Convert.ToBase64String(stream.ToArray());
      }
    } finally {
      if (handle != IntPtr.Zero) DestroyIcon(handle);
      Release(images);
    }
  }
  [StructLayout(LayoutKind.Sequential)] struct SIZE { public int cx, cy; }
  [ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr bitmap); }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  static extern int SHCreateItemFromParsingName(string path, IntPtr context, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory item);
  [StructLayout(LayoutKind.Sequential)]
  struct BITMAP { public int type, width, height, widthBytes; public ushort planes, bitsPixel; public IntPtr bits; }
  [StructLayout(LayoutKind.Sequential)]
  struct BITMAPINFOHEADER { public int size, width, height; public ushort planes, bitCount; public int compression, sizeImage, xPels, yPels, used, important; }
  [StructLayout(LayoutKind.Sequential)]
  struct DIBSECTION { public BITMAP bitmap; public BITMAPINFOHEADER header; public uint red, green, blue; public IntPtr section; public uint offset; }
  [DllImport("gdi32.dll")] static extern int GetObject(IntPtr handle, int size, out DIBSECTION section);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr handle);
  // SIIGBF_BIGGERSIZEOK | SIIGBF_ICONONLY: the item's icon, never a thumbnail
  // of its contents, scaled from a bigger one when that's what it has.
  const int Flags = 0x1 | 0x4;
  static readonly Guid Factory = new Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b");

  static string Png(string target, int size) {
    string parsing = Path.IsPathRooted(target) ? target : "shell:AppsFolder\\" + target;
    IShellItemImageFactory item;
    if (SHCreateItemFromParsingName(parsing, IntPtr.Zero, Factory, out item) != 0 || item == null) return "";
    IntPtr handle = IntPtr.Zero;
    try {
      var want = new SIZE { cx = size, cy = size };
      if (item.GetImage(want, Flags, out handle) != 0 || handle == IntPtr.Zero) return "";
      DIBSECTION dib;
      if (GetObject(handle, Marshal.SizeOf(typeof(DIBSECTION)), out dib) == 0) return "";
      int width = dib.bitmap.width, height = dib.bitmap.height;
      if (width <= 0 || height <= 0 || width > 1024 || height > 1024) return "";
      using (var image = new Bitmap(width, height, PixelFormat.Format32bppArgb)) {
        if (dib.bitmap.bitsPixel == 32 && dib.bitmap.bits != IntPtr.Zero) {
          // The image's own pixels with their transparency (FromHbitmap
          // would drop it). Rows go upwards unless its height is negative.
          var data = image.LockBits(new Rectangle(0, 0, width, height), ImageLockMode.WriteOnly, PixelFormat.Format32bppArgb);
          try {
            var row = new byte[width * 4];
            bool upwards = dib.header.height > 0;
            for (int y = 0; y < height; y++) {
              int from = upwards ? height - 1 - y : y;
              Marshal.Copy(new IntPtr(dib.bitmap.bits.ToInt64() + (long)from * dib.bitmap.widthBytes), row, 0, row.Length);
              Marshal.Copy(row, 0, new IntPtr(data.Scan0.ToInt64() + (long)y * data.Stride), row.Length);
            }
          } finally {
            image.UnlockBits(data);
          }
        } else {
          using (var plain = Image.FromHbitmap(handle))
          using (var g = Graphics.FromImage(image)) g.DrawImage(plain, 0, 0, width, height);
        }
        using (var square = new Bitmap(size, size, PixelFormat.Format32bppArgb)) {
          using (var g = Graphics.FromImage(square)) {
            g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
            float scale = Math.Min((float)size / width, (float)size / height);
            float w = width * scale, h = height * scale;
            g.DrawImage(image, (size - w) / 2, (size - h) / 2, w, h);
          }
          using (var png = new MemoryStream()) {
            square.Save(png, ImageFormat.Png);
            return Convert.ToBase64String(png.ToArray());
          }
        }
      }
    } catch (Exception) {
      return "";
    } finally {
      if (handle != IntPtr.Zero) DeleteObject(handle);
      Marshal.ReleaseComObject(item);
    }
  }

  [STAThread]
  static int Main(string[] args) {
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.NewLine = "\n";
    if (args.Length == 1 && args[0] == "apps") {
      try { Apps(output); output.Flush(); return 0; }
      catch { return 1; }
    }
    if (args.Length == 2 && args[0] == "open" && args[1].Length > 0 && args[1].IndexOf('\0') < 0) {
      try {
        Process.Start(new ProcessStartInfo("shell:AppsFolder\\" + args[1]) { UseShellExecute = true, ErrorDialog = false });
        return 0;
      } catch { return 1; }
    }
    if (args.Length >= 2 && args.Length <= 65 && args[0] == "types") {
      for (int i = 1; i < args.Length; i++)
        if (!Regex.IsMatch(args[i], "\\A(?:folder|file|[a-z0-9]{1,16})\\z")) return 2;
      for (int i = 1; i < args.Length; i++) {
        try { output.WriteLine(FileTypePng(args[i])); }
        catch { output.WriteLine(""); }
      }
      output.Flush();
      return 0;
    }
    int size;
    if (args.Length != 1 || !int.TryParse(args[0], out size) || size < 16 || size > 256) return 2;
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    string line;
    while ((line = input.ReadLine()) != null) {
      string target = line.Trim();
      output.WriteLine(target.Length == 0 || target.Length > 1024 || target.IndexOf('\0') >= 0 ? "" : Png(target, size));
      output.Flush();
    }
    return 0;
  }
}
