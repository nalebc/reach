// The icon Windows shows for each app or program, as a PNG: what Start, the
// taskbar and Explorer draw (the shell's own image for the item). Run by
// server/app-icons.mjs, the twin of a Mac's scripts/native/app-icon.js.
//
//   app-icons.exe <size>
// stdin: one target a line: an app's id from Start (Get-StartApps' AppID,
// read through shell:AppsFolder) or a program's full path (C:\...\x.exe).
// stdout: one line per target, in order: its icon as base64 PNG, square,
// <size> pixels (16 to 256), or an empty line when Windows has none.
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

static class AppIcons {
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
    int size;
    if (args.Length != 1 || !int.TryParse(args[0], out size) || size < 16 || size > 256) return 2;
    var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
    var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    output.NewLine = "\n";
    string line;
    while ((line = input.ReadLine()) != null) {
      string target = line.Trim();
      output.WriteLine(target.Length == 0 || target.Length > 1024 || target.IndexOf('\0') >= 0 ? "" : Png(target, size));
      output.Flush();
    }
    return 0;
  }
}
