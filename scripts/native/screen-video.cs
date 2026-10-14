// Reach's live screen on Windows as H.264 video, with nothing to install
// (server/windows-video.mjs): what scripts/native/screen-stream.swift is on a
// Mac. C# 5, the language of the .NET Framework 4.x compiler
// (docs/WINDOWS_AGENT_PARITY.md, rule 3).
//   screen-video <display> <fps> <max width> <bitrate>
//     display: primary or DISPLAYn. One request a line on stdin, as the Mac's
//     helper reads them: "frame", "key" (start a picture), "bitrate N". Each
//     frame or key gets exactly one answer, 4 bytes of length (big endian)
//     then: one byte, 0 when nothing changed, 2 when the PC is locked; or a
//     video frame: 4 bytes of JSON length, {key,timestamp,width,height,codec},
//     then the frame as Annex B with an AUD first and SPS and PPS before every
//     IDR, as FFmpeg writes it (server/windows-video.mjs AnnexBFrames splits
//     either). Ends when stdin closes (Reach gone). On trouble, a line on
//     stderr says why, then exit 1 (3: no H.264 encoder works here). Lines
//     starting "note: " say what changed on the way (an encoder or a capture
//     that gave out) and go to Reach's log.
//   screen-video --probe
//     {"encoder":"…","hardware":true,"capture":"duplication",…} when this PC
//     can stream video (an encoder made a real picture), exit 0; otherwise
//     why on stderr, exit 3.
// Capture: DXGI Desktop Duplication (only changed frames, the pointer's shape
// and position, per monitor); GDI's BitBlt, as scripts/native/screen-stream.ps1
// captures, where that isn't available (some VMs and RDP sessions, a rotated
// or HDR display). Encode: Media Foundation's H.264 encoder, a hardware one
// first, else Microsoft's own, in low-latency mode; colours BT.709.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;

static class ReachScreenVideo {
  [MTAThread]
  static int Main(string[] args) {
    Desktop.Aware();
    try {
      if (args.Length == 1 && args[0] == "--probe") return Probe.Run();
      return Run(Options.Parse(args));
    } catch (VideoException e) {
      Say(e.Message);
      return e.Code;
    } catch (Exception e) {
      Say("Windows' screen video stopped: " + Plain(e) + ".");
      return 1;
    }
  }

  static int Run(Options options) {
    Mf.Start();
    using (Session session = new Session(options)) {
      Stream output = Console.OpenStandardOutput();
      StreamReader input = new StreamReader(Console.OpenStandardInput(), Encoding.ASCII);
      string line;
      while ((line = input.ReadLine()) != null) {
        if (line.StartsWith("bitrate ")) {
          int value;
          if (int.TryParse(line.Substring(8), out value) && value >= 250000 && value <= 50000000) session.Bitrate(value);
          continue;
        }
        if (line != "frame" && line != "key") continue;
        byte[] answer = session.Next(line == "key");
        byte[] length = BigEndian(answer.Length);
        output.Write(length, 0, 4);
        output.Write(answer, 0, answer.Length);
        output.Flush();
      }
    }
    return 0;
  }

  public static byte[] BigEndian(int value) {
    return new byte[] { (byte)(value >> 24), (byte)(value >> 16), (byte)(value >> 8), (byte)value };
  }
  public static void Say(string text) {
    try {
      Console.Error.WriteLine(text.Replace('\r', ' ').Replace('\n', ' '));
      Console.Error.Flush();
    } catch (IOException) {}
  }
  // What changed on the way, for Reach's log; never the reason it stopped.
  public static void Note(string text) {
    Say("note: " + text);
  }
  // An error in words with its code, never a stack.
  public static string Plain(Exception e) {
    COMException com = e as COMException;
    if (com != null) return "0x" + com.ErrorCode.ToString("X8");
    string text = e.Message.Replace('\r', ' ').Replace('\n', ' ').Trim().TrimEnd('.');
    return text.Length > 200 ? text.Substring(0, 200) : text;
  }
  public static string Hex(int hr) {
    return "0x" + hr.ToString("X8");
  }
}

sealed class VideoException : Exception {
  public readonly int Code;
  public VideoException(int code, string message) : base(message) {
    Code = code;
  }
}

// An encoder that gave out mid-stream: the next one takes over.
sealed class EncoderException : Exception {
  public EncoderException(string message) : base(message) {}
}

sealed class Options {
  public string Display;
  public int Fps, MaxWidth, Bitrate;
  public static Options Parse(string[] args) {
    Options o = new Options();
    if (args.Length != 4) throw new VideoException(1, "Usage: screen-video <display> <fps> <max width> <bitrate>, or --probe.");
    o.Display = args[0];
    bool display = o.Display == "primary";
    if (!display && o.Display.StartsWith("DISPLAY") && o.Display.Length > 7 && o.Display.Length <= 10) {
      display = true;
      for (int i = 7; i < o.Display.Length; i++) if (o.Display[i] < '0' || o.Display[i] > '9') display = false;
    }
    if (!display
      || !int.TryParse(args[1], out o.Fps) || o.Fps < 1 || o.Fps > 60
      || !int.TryParse(args[2], out o.MaxWidth) || o.MaxWidth < 160 || o.MaxWidth > 7680
      || !int.TryParse(args[3], out o.Bitrate) || o.Bitrate < 250000 || o.Bitrate > 50000000)
      throw new VideoException(1, "Invalid display or video settings.");
    return o;
  }
}

// One stream: the display's picture kept as NV12 at the stream's size,
// changed only where the screen changed, and the pointer drawn on a copy.
sealed class Session : IDisposable {
  readonly Options options;
  readonly ScreenCapture capture;
  readonly List<EncoderChoice> choices;
  int choice = -1;
  Encoder encoder;
  Converter converter;
  byte[] clean, composed, sps, pps;
  int[] patch = new int[0];
  bool havePicture;
  string codec = "";
  readonly Stopwatch clock = Stopwatch.StartNew();
  // Milliseconds on the session's clock; never yet: long ago.
  long sentAt = -100000, keyAt = -100000, lockAt = -100000, lastTime = -1, waitingSince;
  bool locked;
  int bitrate;

  public Session(Options options) {
    this.options = options;
    bitrate = options.Bitrate;
    capture = new ScreenCapture(Desktop.Find(options.Display));
    choices = Encoders.List();
    if (choices.Count == 0) throw new VideoException(3, Why.NoEncoder(null));
    Resize();
  }

  // The stream's size: the display's pixels, no wider than asked and at most
  // 2160 high (as FFmpeg's path), even on both sides for 4:2:0.
  void Resize() {
    double scale = Math.Min(1.0, Math.Min(options.MaxWidth / (double)capture.Width, 2160.0 / capture.Height));
    int width = Math.Max(2, (int)(capture.Width * scale) / 2 * 2);
    int height = Math.Max(2, (int)(capture.Height * scale) / 2 * 2);
    converter = new Converter(capture.Width, capture.Height, width, height);
    clean = new byte[width * height * 3 / 2];
    composed = new byte[clean.Length];
    havePicture = false;
    waitingSince = clock.ElapsedMilliseconds;
    if (encoder != null) encoder.Dispose();
    encoder = null;
    string failures = null;
    for (int i = choice < 0 ? 0 : choice; i < choices.Count; i++) {
      try {
        encoder = Encoder.Open(choices[i], width, height, options.Fps, bitrate);
        choice = i;
        return;
      } catch (Exception e) {
        failures = (failures == null ? "" : failures + "; ") + choices[i].Name + " (" + ReachScreenVideo.Plain(e) + ")";
        if (i + 1 < choices.Count) ReachScreenVideo.Note(choices[i].Name + " wouldn't start (" + ReachScreenVideo.Plain(e) + "); " + choices[i + 1].Name + " takes over.");
      }
    }
    throw new VideoException(3, Why.NoEncoder(failures));
  }

  public void Bitrate(int value) {
    bitrate = value;
    if (encoder != null) encoder.SetBitrate(value);
  }

  // Locked only when both the session and the input desktop say so, read
  // as scripts/native/screen-stream.ps1 reads them, at most 4 times a second.
  bool Locked(bool now) {
    long at = clock.ElapsedMilliseconds;
    if (now || at - lockAt >= 250) {
      locked = Desktop.Locked();
      lockAt = at;
    }
    return locked;
  }

  public byte[] Next(bool key) {
    // Locked: one byte (2), as the Mac's helper says it. The phone keeps the
    // last picture, dimmed, with "Windows PC locked", and asks again about
    // once a second (server/remote-screen.mjs); the first picture after it
    // starts afresh.
    if (Locked(false)) return new byte[] { 2 };
    int state = capture.Update(!havePicture);
    if (state == ScreenCapture.Lost && Locked(true)) return new byte[] { 2 };
    if (capture.Width != converter.SourceWidth || capture.Height != converter.SourceHeight) {
      Resize();
      key = true;
    }
    if (state == ScreenCapture.Changed) Refresh();
    if (!havePicture) {
      // No picture at all, ten seconds on: said in words, and Reach tries again.
      if (state == ScreenCapture.Lost || clock.ElapsedMilliseconds - waitingSince > 10000)
        throw new VideoException(1, "Windows could not stream the desktop. Keep the computer signed in and unlocked, and run Reach in your desktop session.");
      return new byte[] { 0 };
    }
    long now = clock.ElapsedMilliseconds;
    // Nothing new: one byte, and the phone has nothing to decode or draw. A
    // real frame still goes every second (the phone's watchdog), and one
    // the encoder still holds is pushed out.
    bool changed = key || state == ScreenCapture.Changed;
    if (!changed && now - sentAt < 1000 && !encoder.Holding) return new byte[] { 0 };
    // A keyframe is as heavy as seconds of other frames: the phone asks for
    // one when it needs one; every 10 s of change is only a safety net.
    bool forceKey = key || keyAt < 0 || (state == ScreenCapture.Changed && now - keyAt >= 10000);
    byte[] picture = Compose();
    bool idr;
    byte[] frame = Encode(picture, forceKey, changed, out idr);
    if (frame != null && forceKey && !idr) {
      // The encoder ignored the request: a fresh one starts with an IDR.
      Restart(null);
      frame = Encode(picture, true, true, out idr);
    }
    if (frame == null) return new byte[] { 0 };
    sentAt = now;
    if (idr) keyAt = now;
    string meta = "{\"key\":" + (idr ? "true" : "false") + ",\"timestamp\":" + (clock.ElapsedTicks * 1000000 / Stopwatch.Frequency)
      + ",\"width\":" + converter.Width + ",\"height\":" + converter.Height + ",\"codec\":\"" + codec + "\"}";
    byte[] json = Encoding.ASCII.GetBytes(meta);
    byte[] packet = new byte[4 + json.Length + frame.Length];
    Buffer.BlockCopy(ReachScreenVideo.BigEndian(json.Length), 0, packet, 0, 4);
    Buffer.BlockCopy(json, 0, packet, 4, json.Length);
    Buffer.BlockCopy(frame, 0, packet, 4 + json.Length, frame.Length);
    return packet;
  }

  // The stream's picture updated where the screen changed.
  void Refresh() {
    if (capture.Full || !havePicture) {
      converter.Convert(capture.Pixels, capture.Width, 0, 0, clean, new Rect(0, 0, converter.Width, converter.Height));
      havePicture = true;
      return;
    }
    List<Rect> areas = new List<Rect>();
    foreach (Rect r in capture.Dirty) {
      Rect o = converter.OutputRect(r);
      if (!o.Empty) areas.Add(o);
    }
    areas = Rect.Merge(areas, converter.Width, converter.Height);
    foreach (Rect o in areas) converter.Convert(capture.Pixels, capture.Width, 0, 0, clean, o);
  }

  // The picture with the pointer Desktop Duplication reports drawn on it
  // (GDI's capture already has it), at the stream's scale.
  byte[] Compose() {
    PointerState p = capture.Pointer;
    if (!p.Visible || p.Shape == null) return clean;
    PointerShape shape = p.Shape;
    Rect area = new Rect(p.X, p.Y, p.X + shape.Width, p.Y + shape.Rows).Intersect(new Rect(0, 0, capture.Width, capture.Height));
    if (area.Empty) return clean;
    Rect o = converter.OutputRect(area);
    if (o.Empty) return clean;
    Rect s = converter.SourceRect(o);
    int w = s.Right - s.Left, h = s.Bottom - s.Top;
    if (patch.Length < w * h) patch = new int[w * h];
    for (int y = 0; y < h; y++) Array.Copy(capture.Pixels, (s.Top + y) * capture.Width + s.Left, patch, y * w, w);
    shape.Draw(patch, w, s, p.X, p.Y);
    Buffer.BlockCopy(clean, 0, composed, 0, clean.Length);
    converter.Convert(patch, w, s.Left, s.Top, composed, o);
    return composed;
  }

  // Encoded as one access unit: an AUD first, SPS and PPS before an IDR.
  byte[] Encode(byte[] picture, bool key, bool changed, out bool idr) {
    idr = false;
    long time = clock.ElapsedTicks * 10000000 / Stopwatch.Frequency;
    if (time <= lastTime) time = lastTime + 1;
    lastTime = time;
    byte[] raw;
    while (true) {
      try {
        raw = encoder.Encode(picture, time, key, changed);
        break;
      } catch (VideoException) {
        throw;
      } catch (Exception e) {
        Restart(ReachScreenVideo.Plain(e));
        key = true;
      }
    }
    if (raw == null || raw.Length == 0) return null;
    byte[] frame = AnnexB.AccessUnit(raw, ref sps, ref pps, encoder.SequenceHeader, out idr);
    if (sps != null) codec = AnnexB.Codec(sps);
    return codec.Length == 0 ? null : frame;
  }

  // A new encoder for the same picture: this one again when it only ignored
  // a keyframe request, the next one when it gave out.
  void Restart(string failure) {
    string was = encoder.Name;
    encoder.Dispose();
    encoder = null;
    if (failure == null) {
      try {
        encoder = Encoder.Open(choices[choice], converter.Width, converter.Height, options.Fps, bitrate);
        return;
      } catch (Exception e) {
        failure = "it wouldn't start again: " + ReachScreenVideo.Plain(e);
      }
    }
    for (int i = choice + 1; i < choices.Count; i++) {
      try {
        encoder = Encoder.Open(choices[i], converter.Width, converter.Height, options.Fps, bitrate);
        ReachScreenVideo.Note(was + " stopped (" + failure + "); " + choices[i].Name + " takes over.");
        choice = i;
        return;
      } catch (Exception e) {
        failure += "; " + choices[i].Name + " (" + ReachScreenVideo.Plain(e) + ")";
      }
    }
    throw new VideoException(3, "Windows' H.264 encoder stopped: " + was + " (" + failure + ").");
  }

  public void Dispose() {
    if (encoder != null) encoder.Dispose();
    encoder = null;
    capture.Dispose();
    foreach (EncoderChoice c in choices) c.Dispose();
  }
}

struct Rect {
  public int Left, Top, Right, Bottom;
  public Rect(int left, int top, int right, int bottom) {
    Left = left;
    Top = top;
    Right = right;
    Bottom = bottom;
  }
  public bool Empty { get { return Right <= Left || Bottom <= Top; } }
  public long Area { get { return Empty ? 0 : (long)(Right - Left) * (Bottom - Top); } }
  public Rect Intersect(Rect o) {
    return new Rect(Math.Max(Left, o.Left), Math.Max(Top, o.Top), Math.Min(Right, o.Right), Math.Min(Bottom, o.Bottom));
  }
  public Rect Union(Rect o) {
    return new Rect(Math.Min(Left, o.Left), Math.Min(Top, o.Top), Math.Max(Right, o.Right), Math.Max(Bottom, o.Bottom));
  }
  bool Touches(Rect o) {
    return Left <= o.Right && o.Left <= Right && Top <= o.Bottom && o.Top <= Bottom;
  }
  // Overlapping areas as one; many, or most of the picture, as all of it.
  public static List<Rect> Merge(List<Rect> areas, int width, int height) {
    List<Rect> merged = new List<Rect>();
    if (areas.Count > 24) areas = new List<Rect> { Bounds(areas) };
    foreach (Rect a in areas) {
      Rect r = a;
      for (bool again = true; again; ) {
        again = false;
        for (int i = 0; i < merged.Count; i++) {
          if (!merged[i].Touches(r)) continue;
          r = r.Union(merged[i]);
          merged.RemoveAt(i);
          again = true;
          break;
        }
      }
      merged.Add(r);
    }
    long total = 0;
    foreach (Rect r in merged) total += r.Area;
    if (total * 10 >= (long)width * height * 6) return new List<Rect> { new Rect(0, 0, width, height) };
    return merged;
  }
  static Rect Bounds(List<Rect> areas) {
    Rect b = areas[0];
    foreach (Rect r in areas) b = b.Union(r);
    return b;
  }
}

// BGRA pixels (as ints) into NV12 at the stream's size: each output pixel
// the area-weighted average of the source pixels it covers, then BT.709
// with video range, as the Mac's capture (ScreenCaptureKit, 420v) makes it.
sealed class Converter {
  public readonly int SourceWidth, SourceHeight, Width, Height;
  readonly bool same;
  readonly int taps;
  readonly int[] xStart, xCount, xWeight, yStart, yCount, yWeight;
  readonly int bands;

  public Converter(int sourceWidth, int sourceHeight, int width, int height) {
    SourceWidth = sourceWidth;
    SourceHeight = sourceHeight;
    Width = width;
    Height = height;
    same = width == sourceWidth && height == sourceHeight;
    taps = Math.Max((sourceWidth + width - 1) / width, (sourceHeight + height - 1) / height) + 2;
    Weights(sourceWidth, width, out xStart, out xCount, out xWeight);
    Weights(sourceHeight, height, out yStart, out yCount, out yWeight);
    bands = Math.Max(1, Math.Min(8, Environment.ProcessorCount));
  }

  // Which source pixels each output pixel covers and how much of each, in
  // 256ths that add up to 256.
  void Weights(int source, int output, out int[] start, out int[] count, out int[] weight) {
    start = new int[output];
    count = new int[output];
    weight = new int[output * taps];
    double step = source / (double)output;
    for (int o = 0; o < output; o++) {
      double a = o * step, b = Math.Min(source, (o + 1) * step);
      int first = Math.Min(source - 1, (int)Math.Floor(a));
      int last = Math.Max(first, Math.Min(source - 1, (int)Math.Ceiling(b) - 1));
      int n = Math.Min(taps, last - first + 1), sum = 0, biggest = 0;
      for (int i = 0; i < n; i++) {
        double cover = Math.Min(b, first + i + 1) - Math.Max(a, first + i);
        int w = (int)Math.Round(Math.Max(0, cover) / (b - a) * 256);
        weight[o * taps + i] = w;
        sum += w;
        if (w > weight[o * taps + biggest]) biggest = i;
      }
      weight[o * taps + biggest] += 256 - sum;
      start[o] = first;
      count[o] = n;
    }
  }

  // The output pixels a source area changes (with a pixel to spare for the
  // filter), even on every side so whole 2x2 chroma blocks are redone.
  public Rect OutputRect(Rect s) {
    int left = (int)Math.Floor(s.Left * (double)Width / SourceWidth) - 1;
    int top = (int)Math.Floor(s.Top * (double)Height / SourceHeight) - 1;
    int right = (int)Math.Ceiling(s.Right * (double)Width / SourceWidth) + 1;
    int bottom = (int)Math.Ceiling(s.Bottom * (double)Height / SourceHeight) + 1;
    left = Math.Max(0, left) & ~1;
    top = Math.Max(0, top) & ~1;
    right = Math.Min(Width, (right + 1) & ~1);
    bottom = Math.Min(Height, (bottom + 1) & ~1);
    return new Rect(left, top, right, bottom);
  }

  // The source pixels the output pixels of an area read.
  public Rect SourceRect(Rect o) {
    return new Rect(xStart[o.Left], yStart[o.Top], xStart[o.Right - 1] + xCount[o.Right - 1], yStart[o.Bottom - 1] + yCount[o.Bottom - 1]);
  }

  // Writes the output area `o` of `nv12` from `pixels`, whose first int is
  // the source pixel (sx, sy) and whose rows are `stride` ints apart.
  public void Convert(int[] pixels, int stride, int sx, int sy, byte[] nv12, Rect o) {
    if (o.Empty) return;
    int pairs = (o.Bottom - o.Top) / 2;
    int n = Math.Min(bands, Math.Max(1, pairs / 32));
    if (n <= 1) {
      Band(pixels, stride, sx, sy, nv12, o.Left, o.Right, o.Top, o.Bottom);
      return;
    }
    Parallel.For(0, n, delegate (int band) {
      int top = o.Top + 2 * (int)((long)pairs * band / n);
      int bottom = o.Top + 2 * (int)((long)pairs * (band + 1) / n);
      Band(pixels, stride, sx, sy, nv12, o.Left, o.Right, top, bottom);
    });
  }

  void Band(int[] pixels, int stride, int sx, int sy, byte[] nv12, int left, int right, int top, int bottom) {
    int chroma = Width * Height;
    for (int y = top; y < bottom; y += 2) {
      int row0 = y * Width, row1 = row0 + Width, uv = chroma + (y / 2) * Width;
      for (int x = left; x < right; x += 2) {
        int a = Pick(pixels, stride, sx, sy, x, y), b = Pick(pixels, stride, sx, sy, x + 1, y);
        int c = Pick(pixels, stride, sx, sy, x, y + 1), d = Pick(pixels, stride, sx, sy, x + 1, y + 1);
        nv12[row0 + x] = Luma(a);
        nv12[row0 + x + 1] = Luma(b);
        nv12[row1 + x] = Luma(c);
        nv12[row1 + x + 1] = Luma(d);
        int r = (((a >> 16) & 255) + ((b >> 16) & 255) + ((c >> 16) & 255) + ((d >> 16) & 255) + 2) >> 2;
        int g = (((a >> 8) & 255) + ((b >> 8) & 255) + ((c >> 8) & 255) + ((d >> 8) & 255) + 2) >> 2;
        int bl = ((a & 255) + (b & 255) + (c & 255) + (d & 255) + 2) >> 2;
        nv12[uv + x] = (byte)(((-6595 * r - 22189 * g + 28784 * bl + 32768) >> 16) + 128);
        nv12[uv + x + 1] = (byte)(((28784 * r - 26145 * g - 2639 * bl + 32768) >> 16) + 128);
      }
    }
  }

  static byte Luma(int p) {
    return (byte)(((11966 * ((p >> 16) & 255) + 40254 * ((p >> 8) & 255) + 4064 * (p & 255) + 32768) >> 16) + 16);
  }

  // One output pixel's colour as 0xRRGGBB.
  int Pick(int[] pixels, int stride, int sx, int sy, int x, int y) {
    if (same) return pixels[(y - sy) * stride + (x - sx)] & 0xFFFFFF;
    int r = 0, g = 0, b = 0;
    int x0 = xStart[x] - sx, xn = xCount[x], xw = x * taps;
    int y0 = yStart[y] - sy, yn = yCount[y], yw = y * taps;
    for (int j = 0; j < yn; j++) {
      int wy = yWeight[yw + j];
      if (wy == 0) continue;
      int row = (y0 + j) * stride + x0;
      for (int i = 0; i < xn; i++) {
        int w = wy * xWeight[xw + i];
        int p = pixels[row + i];
        r += w * ((p >> 16) & 255);
        g += w * ((p >> 8) & 255);
        b += w * (p & 255);
      }
    }
    return (((r + 32768) >> 16) << 16) | (((g + 32768) >> 16) << 8) | ((b + 32768) >> 16);
  }
}

sealed class PointerShape {
  public const int Monochrome = 1, Color = 2, MaskedColor = 4;
  public int Type, Width, Height, Pitch;
  public byte[] Data;
  // Rows on screen: a monochrome pointer is its AND mask over its XOR mask.
  public int Rows { get { return Type == Monochrome ? Height / 2 : Height; } }

  // Draws the pointer, its top-left at (px, py), on `patch`: the source area
  // `s`, rows `stride` ints apart. As Windows draws it: colour blended by its
  // alpha; masked colour replaced or XORed; monochrome by its AND and XOR masks.
  public void Draw(int[] patch, int stride, Rect s, int px, int py) {
    int rows = Rows;
    for (int j = 0; j < rows; j++) {
      int y = py + j;
      if (y < s.Top || y >= s.Bottom) continue;
      for (int i = 0; i < Width; i++) {
        int x = px + i;
        if (x < s.Left || x >= s.Right) continue;
        int at = (y - s.Top) * stride + (x - s.Left);
        int under = patch[at];
        if (Type == Monochrome) {
          int bit = 0x80 >> (i & 7);
          bool and = (Data[j * Pitch + i / 8] & bit) != 0, xor = (Data[(j + rows) * Pitch + i / 8] & bit) != 0;
          patch[at] = (under & (and ? -1 : unchecked((int)0xFF000000))) ^ (xor ? 0x00FFFFFF : 0);
          continue;
        }
        int c = BitConverter.ToInt32(Data, j * Pitch + i * 4);
        if (Type == MaskedColor) {
          patch[at] = (c & unchecked((int)0xFF000000)) != 0 ? (under ^ c) | unchecked((int)0xFF000000) : c | unchecked((int)0xFF000000);
          continue;
        }
        int alpha = (c >> 24) & 255;
        if (alpha == 0) continue;
        int rest = 255 - alpha;
        int r = (((c >> 16) & 255) * alpha + ((under >> 16) & 255) * rest + 127) / 255;
        int g = (((c >> 8) & 255) * alpha + ((under >> 8) & 255) * rest + 127) / 255;
        int b = ((c & 255) * alpha + (under & 255) * rest + 127) / 255;
        patch[at] = unchecked((int)0xFF000000) | (r << 16) | (g << 8) | b;
      }
    }
  }
}

sealed class PointerState {
  public bool Visible;
  public int X, Y;
  public PointerShape Shape;
}

// The display's pixels, kept current: Desktop Duplication while it works,
// GDI otherwise. Update says whether anything changed and where.
sealed class ScreenCapture : IDisposable {
  public const int Lost = -1, Same = 0, Changed = 1;
  public readonly Display Display;
  public int Width, Height;
  public int[] Pixels;
  public readonly List<Rect> Dirty = new List<Rect>();
  // All of the picture changed (a first picture, a new capture).
  public bool Full;
  // Pixels hold a whole picture (none before the first, nor after a resize).
  public bool HasPicture;
  // Desktop Duplication's pointer: GDI's capture draws it in its pixels.
  public readonly PointerState Pointer = new PointerState();
  public string Mode = "";
  Duplication duplication;
  GdiCapture gdi;
  int[] scratch;
  // Desktop Duplication can't work here (a rotated or HDR display, a VM or
  // a session without it): GDI for the rest of this stream.
  bool duplicationGone;
  long retryAt;
  readonly Stopwatch clock = Stopwatch.StartNew();

  public ScreenCapture(Display display) {
    Display = display;
    Width = display.Bounds.Right - display.Bounds.Left;
    Height = display.Bounds.Bottom - display.Bounds.Top;
    Pixels = new int[Width * Height];
  }

  public int Update(bool firstPicture) {
    Dirty.Clear();
    Full = false;
    if (duplication == null && !duplicationGone && clock.ElapsedMilliseconds >= retryAt) Open();
    if (duplication != null) {
      int state = duplication.Next(this, firstPicture || !HasPicture ? 300 : 0);
      if (state != Lost) {
        if (Mode != "duplication") Pointer.Visible = false;
        Mode = "duplication";
        // Until Desktop Duplication brings a whole picture, GDI's (or none
        // yet, while GDI can't either).
        if (!HasPicture) return Grab(true) == Changed ? Changed : Same;
        return state;
      }
      // A desktop switch (the lock screen, UAC), a new display mode: made
      // again soon; meanwhile GDI, if Windows lets it.
      duplication.Dispose();
      duplication = null;
      retryAt = clock.ElapsedMilliseconds + 250;
    }
    return Grab(false);
  }

  void Open() {
    string why;
    bool forGood;
    duplication = Duplication.Open(Display, out why, out forGood);
    if (duplication != null) {
      if (duplication.Width != Width || duplication.Height != Height) Resize(duplication.Width, duplication.Height);
      return;
    }
    if (forGood) {
      duplicationGone = true;
      ReachScreenVideo.Note("Desktop Duplication isn't available for this display (" + why + "); GDI captures it instead.");
    } else retryAt = clock.ElapsedMilliseconds + 1000;
  }

  void Resize(int width, int height) {
    Width = width;
    Height = height;
    Pixels = new int[width * height];
    scratch = null;
    HasPicture = false;
  }

  // A GDI picture: a first one while Desktop Duplication has none yet, or
  // every one when it isn't available.
  int Grab(bool first) {
    if (gdi == null || gdi.Stale) {
      if (gdi != null) gdi.Dispose();
      gdi = GdiCapture.Open(Display.Device);
      if (gdi == null) return Lost;
      if (gdi.Width != Width || gdi.Height != Height) {
        if (duplication != null) return Lost;
        Resize(gdi.Width, gdi.Height);
      }
    }
    if (scratch == null || scratch.Length != Width * Height) scratch = new int[Width * Height];
    // Drawn with the pointer, unless Desktop Duplication draws it.
    if (!gdi.Grab(scratch, duplication == null)) return Lost;
    int[] previous = Pixels;
    Pixels = scratch;
    scratch = previous;
    bool whole = first || Mode != "gdi" || !HasPicture;
    HasPicture = true;
    if (whole) {
      if (duplication == null) {
        Mode = "gdi";
        Pointer.Visible = false;
      }
      Full = true;
      return Changed;
    }
    int top = -1, bottom = -1;
    for (int y = 0; y < Height; y++) {
      int at = y * Width, end = at + Width;
      while (at < end && Pixels[at] == previous[at]) at++;
      if (at == end) continue;
      if (top < 0) top = y;
      bottom = y + 1;
    }
    if (top < 0) return Same;
    Dirty.Add(new Rect(0, top, Width, bottom));
    return Changed;
  }

  public void Dispose() {
    if (duplication != null) duplication.Dispose();
    duplication = null;
    if (gdi != null) gdi.Dispose();
    gdi = null;
  }
}

// One display through Desktop Duplication: its own D3D11 device on the
// adapter that drives it, a staging texture the changed areas are copied to.
sealed class Duplication : IDisposable {
  const int DXGI_ERROR_WAIT_TIMEOUT = unchecked((int)0x887A0027), DXGI_ERROR_ACCESS_LOST = unchecked((int)0x887A0026);
  const int DXGI_ERROR_NOT_FOUND = unchecked((int)0x887A0002), DXGI_ERROR_MORE_DATA = unchecked((int)0x887A0003);
  const int DXGI_ERROR_UNSUPPORTED = unchecked((int)0x887A0004), E_ACCESSDENIED = unchecked((int)0x80070005);
  const int DXGI_ERROR_NOT_CURRENTLY_AVAILABLE = unchecked((int)0x887A0022), DXGI_ERROR_SESSION_DISCONNECTED = unchecked((int)0x887A0028);
  const int DXGI_FORMAT_B8G8R8A8_UNORM = 87;
  public int Width, Height;
  ID3D11Device device;
  ID3D11DeviceContext context;
  IDXGIOutputDuplication duplication;
  ID3D11Texture2D staging;
  // The staging texture as a resource (the same object).
  ID3D11Resource target;
  bool fresh = true;
  RECT[] dirty = new RECT[64];
  MoveRect[] moves = new MoveRect[16];
  byte[] shapeBuffer = new byte[0];

  // Null with why when it can't; forGood when it never will for this display.
  public static Duplication Open(Display display, out string why, out bool forGood) {
    why = "";
    forGood = true;
    IDXGIFactory1 factory = null;
    IDXGIAdapter1 adapter = null;
    IDXGIOutput output = null;
    Duplication d = new Duplication();
    try {
      Guid iid = typeof(IDXGIFactory1).GUID;
      int hr = Native.CreateDXGIFactory1(ref iid, out factory);
      if (hr < 0) { why = "DXGI " + ReachScreenVideo.Hex(hr); return null; }
      OutputDesc desc = new OutputDesc();
      for (int a = 0; output == null; a++) {
        if (factory.EnumAdapters1(a, out adapter) < 0) break;
        for (int o = 0; ; o++) {
          IDXGIOutput candidate;
          if (adapter.EnumOutputs(o, out candidate) < 0) break;
          OutputDesc found;
          if (candidate.GetDesc(out found) >= 0 && string.Equals(found.DeviceName, display.Device, StringComparison.OrdinalIgnoreCase)) {
            output = candidate;
            desc = found;
            break;
          }
          Marshal.ReleaseComObject(candidate);
        }
        if (output == null) {
          Marshal.ReleaseComObject(adapter);
          adapter = null;
        }
      }
      if (output == null) { why = "no DXGI output for " + display.Device; return null; }
      if (desc.Rotation > 1) { why = "the display is rotated"; return null; }
      IntPtr adapterPointer = Marshal.GetComInterfaceForObject(adapter, typeof(IDXGIAdapter1));
      int level;
      try {
        hr = Native.D3D11CreateDevice(adapterPointer, 0, IntPtr.Zero, 0x20, IntPtr.Zero, 0, 7, out d.device, out level, out d.context);
      } finally {
        Marshal.Release(adapterPointer);
      }
      if (hr < 0) { why = "Direct3D 11 " + ReachScreenVideo.Hex(hr); return null; }
      IDXGIOutput5 output5 = output as IDXGIOutput5;
      hr = -1;
      if (output5 != null) hr = output5.DuplicateOutput1(d.device, 0, 1, new int[] { DXGI_FORMAT_B8G8R8A8_UNORM }, out d.duplication);
      if (hr < 0) {
        IDXGIOutput1 output1 = output as IDXGIOutput1;
        if (output1 == null) { why = "DXGI 1.2 is missing"; return null; }
        hr = output1.DuplicateOutput(d.device, out d.duplication);
      }
      if (hr < 0) {
        why = ReachScreenVideo.Hex(hr);
        // The lock screen or UAC's desktop, another session on top, four
        // other duplications already: worth trying again later.
        forGood = !(hr == E_ACCESSDENIED || hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE || hr == DXGI_ERROR_SESSION_DISCONNECTED);
        return null;
      }
      DuplicationDesc dd;
      d.duplication.GetDesc(out dd);
      if (dd.Format != DXGI_FORMAT_B8G8R8A8_UNORM) { why = "its desktop isn't 8-bit BGRA (HDR?)"; return null; }
      d.Width = dd.Width;
      d.Height = dd.Height;
      if (d.Width != desc.Desktop.Right - desc.Desktop.Left || d.Height != desc.Desktop.Bottom - desc.Desktop.Top) { why = "its picture isn't the display's size"; return null; }
      TextureDesc td = new TextureDesc();
      td.Width = d.Width;
      td.Height = d.Height;
      td.MipLevels = 1;
      td.ArraySize = 1;
      td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
      td.SampleCount = 1;
      td.Usage = 3;
      td.CpuAccessFlags = 0x20000;
      hr = d.device.CreateTexture2D(ref td, IntPtr.Zero, out d.staging);
      if (hr < 0) { why = "staging texture " + ReachScreenVideo.Hex(hr); return null; }
      d.target = (ID3D11Resource)d.staging;
      Duplication done = d;
      d = null;
      return done;
    } catch (Exception e) {
      why = ReachScreenVideo.Plain(e);
      return null;
    } finally {
      if (d != null) d.Dispose();
      if (output != null) Marshal.ReleaseComObject(output);
      if (adapter != null) Marshal.ReleaseComObject(adapter);
      if (factory != null) Marshal.ReleaseComObject(factory);
    }
  }

  // Changed, Same, or Lost: what the next frame brought into `into`.
  public int Next(ScreenCapture into, int wait) {
    FrameInfo info;
    IDXGIResource resource;
    int hr = duplication.AcquireNextFrame(wait, out info, out resource);
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) return ScreenCapture.Same;
    if (hr < 0) return ScreenCapture.Lost;
    bool changed = false;
    try {
      // A first frame that didn't bring the desktop (only the pointer
      // moved) is no picture yet: the next one is read whole.
      if (info.LastPresentTime != 0) {
        if (!Read(into, resource, info)) return ScreenCapture.Lost;
        changed = true;
      }
      if (info.LastMouseUpdateTime != 0) {
        PointerState p = into.Pointer;
        bool visible = info.PointerVisible != 0;
        if (visible != p.Visible || info.PointerX != p.X || info.PointerY != p.Y) changed = true;
        p.Visible = visible;
        p.X = info.PointerX;
        p.Y = info.PointerY;
        if (info.PointerShapeBufferSize > 0) {
          if (shapeBuffer.Length < info.PointerShapeBufferSize) shapeBuffer = new byte[info.PointerShapeBufferSize];
          int needed;
          ShapeInfo shape;
          if (duplication.GetFramePointerShape(shapeBuffer.Length, shapeBuffer, out needed, out shape) >= 0 && shape.Width > 0 && shape.Height > 0) {
            PointerShape s = new PointerShape();
            s.Type = shape.Type;
            s.Width = shape.Width;
            s.Height = shape.Height;
            s.Pitch = shape.Pitch;
            s.Data = new byte[Math.Min(needed, shapeBuffer.Length)];
            Buffer.BlockCopy(shapeBuffer, 0, s.Data, 0, s.Data.Length);
            if (s.Data.Length >= s.Pitch * s.Height) {
              p.Shape = s;
              changed = true;
            }
          }
        }
      }
    } finally {
      if (resource != null) Marshal.ReleaseComObject(resource);
      duplication.ReleaseFrame();
    }
    return changed ? ScreenCapture.Changed : ScreenCapture.Same;
  }

  // Copies what changed (all of it the first time) into the capture's pixels.
  bool Read(ScreenCapture into, IDXGIResource resource, FrameInfo info) {
    List<Rect> areas = new List<Rect>();
    bool whole = fresh || info.RectsCoalesced != 0 || into.Pixels.Length != Width * Height;
    if (!whole) whole = !Areas(info, areas);
    if (whole) {
      areas.Clear();
      areas.Add(new Rect(0, 0, Width, Height));
    }
    if (areas.Count == 0) return true;
    ID3D11Resource texture = (ID3D11Resource)resource;
    Rect bounds = areas[0];
    foreach (Rect r in areas) bounds = bounds.Union(r);
    if (whole) context.CopyResource(target, texture);
    else {
      Box box = new Box();
      box.Left = bounds.Left;
      box.Top = bounds.Top;
      box.Front = 0;
      box.Right = bounds.Right;
      box.Bottom = bounds.Bottom;
      box.Back = 1;
      context.CopySubresourceRegion(target, 0, bounds.Left, bounds.Top, 0, texture, 0, ref box);
    }
    Mapped mapped;
    int hr = context.Map(target, 0, 1, 0, out mapped);
    if (hr < 0) return false;
    try {
      foreach (Rect r in areas)
        for (int y = r.Top; y < r.Bottom; y++)
          Marshal.Copy(IntPtr.Add(mapped.Data, y * mapped.RowPitch + r.Left * 4), into.Pixels, y * Width + r.Left, r.Right - r.Left);
    } finally {
      context.Unmap(target, 0);
    }
    if (whole) {
      into.Full = true;
      into.HasPicture = true;
    } else into.Dirty.AddRange(areas);
    fresh = false;
    return true;
  }

  // The frame's changed areas: its dirty rectangles and where moved areas
  // landed. False when Windows wouldn't say (then all of it is read).
  bool Areas(FrameInfo info, List<Rect> areas) {
    if (info.TotalMetadataBufferSize <= 0) return false;
    int needed, size = Marshal.SizeOf(typeof(MoveRect));
    if (moves.Length * size < info.TotalMetadataBufferSize) moves = new MoveRect[info.TotalMetadataBufferSize / size + 1];
    int hr = duplication.GetFrameMoveRects(moves.Length * size, moves, out needed);
    if (hr == DXGI_ERROR_MORE_DATA) {
      moves = new MoveRect[needed / size + 1];
      hr = duplication.GetFrameMoveRects(moves.Length * size, moves, out needed);
    }
    if (hr < 0) return false;
    for (int i = 0; i < needed / size; i++) Add(areas, moves[i].Destination);
    size = Marshal.SizeOf(typeof(RECT));
    if (dirty.Length * size < info.TotalMetadataBufferSize) dirty = new RECT[info.TotalMetadataBufferSize / size + 1];
    hr = duplication.GetFrameDirtyRects(dirty.Length * size, dirty, out needed);
    if (hr == DXGI_ERROR_MORE_DATA) {
      dirty = new RECT[needed / size + 1];
      hr = duplication.GetFrameDirtyRects(dirty.Length * size, dirty, out needed);
    }
    if (hr < 0) return false;
    for (int i = 0; i < needed / size; i++) Add(areas, dirty[i]);
    return true;
  }

  void Add(List<Rect> areas, RECT r) {
    Rect a = new Rect(r.Left, r.Top, r.Right, r.Bottom).Intersect(new Rect(0, 0, Width, Height));
    if (!a.Empty) areas.Add(a);
  }

  public void Dispose() {
    if (staging != null) Marshal.ReleaseComObject(staging);
    if (duplication != null) Marshal.ReleaseComObject(duplication);
    if (context != null) Marshal.ReleaseComObject(context);
    if (device != null) Marshal.ReleaseComObject(device);
    staging = null;
    target = null;
    duplication = null;
    context = null;
    device = null;
  }
}

// One display through GDI, as scripts/native/screen-stream.ps1 captures it:
// a BitBlt of the screen, the pointer drawn by DrawIconEx.
sealed class GdiCapture : IDisposable {
  public int Width, Height;
  int left, top;
  IntPtr screen, memory, bitmap, previous, bits;
  string device;
  readonly Stopwatch age = Stopwatch.StartNew();
  // The display may have moved or changed size: looked at again every 2 s.
  public bool Stale { get { return age.ElapsedMilliseconds > 2000 && !Same(); } }

  public static GdiCapture Open(string device) {
    Display display = Desktop.Lookup(device);
    if (display == null) return null;
    GdiCapture g = new GdiCapture();
    g.device = device;
    g.left = display.Bounds.Left;
    g.top = display.Bounds.Top;
    g.Width = display.Bounds.Right - display.Bounds.Left;
    g.Height = display.Bounds.Bottom - display.Bounds.Top;
    g.screen = Native.GetDC(IntPtr.Zero);
    if (g.screen == IntPtr.Zero) return null;
    g.memory = Native.CreateCompatibleDC(g.screen);
    BitmapInfo info = new BitmapInfo();
    info.Size = Marshal.SizeOf(typeof(BitmapInfo));
    info.Width = g.Width;
    info.Height = -g.Height;
    info.Planes = 1;
    info.BitCount = 32;
    g.bitmap = Native.CreateDIBSection(g.screen, ref info, 0, out g.bits, IntPtr.Zero, 0);
    if (g.memory == IntPtr.Zero || g.bitmap == IntPtr.Zero) {
      g.Dispose();
      return null;
    }
    g.previous = Native.SelectObject(g.memory, g.bitmap);
    return g;
  }

  bool Same() {
    Display display = Desktop.Lookup(device);
    age.Restart();
    return display != null && display.Bounds.Left == left && display.Bounds.Top == top
      && display.Bounds.Right - display.Bounds.Left == Width && display.Bounds.Bottom - display.Bounds.Top == Height;
  }

  public bool Grab(int[] into, bool pointer) {
    if (!Native.BitBlt(memory, 0, 0, Width, Height, screen, left, top, 0x00CC0020)) return false;
    if (pointer) {
      CursorInfo cursor = new CursorInfo();
      cursor.Size = Marshal.SizeOf(typeof(CursorInfo));
      IconInfo icon;
      if (Native.GetCursorInfo(ref cursor) && cursor.Flags == 1 && Native.GetIconInfo(cursor.Cursor, out icon)) {
        Native.DrawIconEx(memory, cursor.X - left - icon.HotspotX, cursor.Y - top - icon.HotspotY, cursor.Cursor, 0, 0, 0, IntPtr.Zero, 3);
        if (icon.Mask != IntPtr.Zero) Native.DeleteObject(icon.Mask);
        if (icon.Color != IntPtr.Zero) Native.DeleteObject(icon.Color);
      }
    }
    Native.GdiFlush();
    Marshal.Copy(bits, into, 0, Width * Height);
    return true;
  }

  public void Dispose() {
    if (memory != IntPtr.Zero && previous != IntPtr.Zero) Native.SelectObject(memory, previous);
    if (bitmap != IntPtr.Zero) Native.DeleteObject(bitmap);
    if (memory != IntPtr.Zero) Native.DeleteDC(memory);
    if (screen != IntPtr.Zero) Native.ReleaseDC(IntPtr.Zero, screen);
    memory = bitmap = screen = previous = IntPtr.Zero;
  }
}

sealed class Display {
  public string Device;
  public RECT Bounds;
  public bool Primary;
}

// The displays, the lock state and DPI, read as Reach's PowerShell helpers
// read them (screen-stream.ps1, desktop-input.ps1).
static class Desktop {
  // Per-monitor DPI aware (v2), so every size and position is in pixels.
  public static void Aware() {
    try {
      if (Native.SetProcessDpiAwarenessContext(new IntPtr(-4))) return;
    } catch (EntryPointNotFoundException) {}
    try {
      Native.SetProcessDpiAwareness(2);
      return;
    } catch (DllNotFoundException) {} catch (EntryPointNotFoundException) {}
    Native.SetProcessDPIAware();
  }

  // "primary" or DISPLAYn, as desktop-input.ps1 lists them.
  public static Display Find(string id) {
    foreach (Display d in All()) {
      if (id == "primary" ? d.Primary : d.Device.EndsWith("\\" + id, StringComparison.OrdinalIgnoreCase)) return d;
    }
    throw new VideoException(1, "This display is unavailable. Select an available display and reconnect.");
  }

  public static Display Lookup(string device) {
    foreach (Display d in All()) if (string.Equals(d.Device, device, StringComparison.OrdinalIgnoreCase)) return d;
    return null;
  }

  static List<Display> All() {
    List<Display> found = new List<Display>();
    Native.MonitorEnum each = delegate (IntPtr monitor, IntPtr dc, ref RECT clip, IntPtr data) {
      MonitorInfo info = new MonitorInfo();
      info.Size = Marshal.SizeOf(typeof(MonitorInfo));
      if (Native.GetMonitorInfo(monitor, ref info)) {
        Display d = new Display();
        d.Device = info.Device;
        d.Bounds = info.Monitor;
        d.Primary = (info.Flags & 1) != 0;
        found.Add(d);
      }
      return true;
    };
    Native.EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, each, IntPtr.Zero);
    GC.KeepAlive(each);
    return found;
  }

  // WTSINFOEXW: Level, then (8-byte aligned: the struct holds LARGE_INTEGERs)
  // WTSINFOEX_LEVEL1_W at 8: SessionId, SessionState, SessionFlags at 16;
  // WTS_SESSIONSTATE_LOCK is 0.
  static bool SessionLocked() {
    IntPtr buffer;
    int bytes;
    if (!Native.WTSQuerySessionInformation(IntPtr.Zero, -1, 25, out buffer, out bytes)) return false;
    try { return bytes >= 20 && Marshal.ReadInt32(buffer) == 1 && Marshal.ReadInt32(buffer, 16) == 0; }
    finally { Native.WTSFreeMemory(buffer); }
  }
  // Keys and clicks go to the desktop named "Default" while it's unlocked;
  // the lock screen's is closed to Reach.
  static bool InputOnDefault() {
    IntPtr desk = Native.OpenInputDesktop(0, false, 0x0001);
    if (desk == IntPtr.Zero) return false;
    try {
      StringBuilder name = new StringBuilder(64);
      int needed;
      return Native.GetUserObjectInformation(desk, 2, name, 128, out needed) && name.ToString() == "Default";
    } finally { Native.CloseDesktop(desk); }
  }
  // Locked only when both say so: one wrong reading can't blank a screen in
  // use. Told by Reach's tests, which can't lock the PC they run on.
  public static bool Locked() {
    if (Environment.GetEnvironmentVariable("REACH_TEST_SCREEN_LOCKED") == "1") return true;
    return SessionLocked() && !InputOnDefault();
  }
}

// Media Foundation, started once. N and KN editions of Windows leave it out.
static class Mf {
  static bool started;
  public static void Start() {
    if (started) return;
    int hr;
    try {
      hr = Native.MFStartup(0x00020070, 1);
    } catch (DllNotFoundException) {
      throw new VideoException(3, Why.NoEncoder(null));
    } catch (EntryPointNotFoundException) {
      throw new VideoException(3, Why.NoEncoder(null));
    }
    if (hr < 0) throw new VideoException(3, Why.NoEncoder("Media Foundation wouldn't start, " + ReachScreenVideo.Hex(hr)));
    started = true;
  }
}

// Why there's no video, in words the owner can act on.
static class Why {
  public static string NoEncoder(string detail) {
    string edition = "", kind = "";
    try {
      edition = (Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "EditionID", "") as string) ?? "";
      kind = (Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\Microsoft\Windows NT\CurrentVersion", "InstallationType", "") as string) ?? "";
    } catch (Exception) {}
    string because = detail == null ? "" : " (" + detail + ")";
    if (kind.StartsWith("Server", StringComparison.OrdinalIgnoreCase))
      return "This Windows Server has no H.264 video encoder" + because + ": it comes with its Media Foundation feature (Server Manager, Add Roles and Features).";
    if (edition.EndsWith("N", StringComparison.Ordinal))
      return "This N edition of Windows has no H.264 video encoder" + because + ": it comes with the Media Feature Pack (Settings, Apps, Optional features).";
    return "Windows has no working H.264 video encoder on this PC" + because + ".";
  }
}

sealed class EncoderChoice : IDisposable {
  public IMFActivate Activate;
  public string Name = "";
  public bool Hardware;
  public void Dispose() {
    if (Activate != null) Marshal.ReleaseComObject(Activate);
    Activate = null;
  }
}

static class Encoders {
  static Guid VideoEncoder = new Guid("f79eac7d-e545-4387-bdee-d647d7bde42a");
  public static Guid Video = new Guid("73646976-0000-0010-8000-00aa00389b71");
  public static Guid NV12 = new Guid("3231564e-0000-0010-8000-00aa00389b71");
  public static Guid H264 = new Guid("34363248-0000-0010-8000-00aa00389b71");
  static Guid FriendlyName = new Guid("314ffbae-5b41-4c95-9c19-4e7d586face3");

  // H.264 encoders taking NV12: hardware ones first (best first), then
  // Microsoft's own and any other in software.
  public static List<EncoderChoice> List() {
    List<EncoderChoice> found = new List<EncoderChoice>();
    Add(found, 0x4 | 0x40, true);
    Add(found, 0x1 | 0x2 | 0x10 | 0x40, false);
    return found;
  }

  static void Add(List<EncoderChoice> found, int flags, bool hardware) {
    TypeInfo input = new TypeInfo();
    input.Major = Video;
    input.Sub = NV12;
    TypeInfo output = new TypeInfo();
    output.Major = Video;
    output.Sub = H264;
    IntPtr list;
    int count;
    if (Native.MFTEnumEx(VideoEncoder, flags, ref input, ref output, out list, out count) < 0 || list == IntPtr.Zero) return;
    try {
      for (int i = 0; i < count; i++) {
        IntPtr pointer = Marshal.ReadIntPtr(list, i * IntPtr.Size);
        if (pointer == IntPtr.Zero) continue;
        EncoderChoice c = new EncoderChoice();
        c.Activate = (IMFActivate)Marshal.GetObjectForIUnknown(pointer);
        Marshal.Release(pointer);
        c.Hardware = hardware;
        IntPtr text;
        int length;
        if (((IMFAttributes)c.Activate).GetAllocatedString(ref FriendlyName, out text, out length) >= 0) {
          c.Name = Marshal.PtrToStringUni(text, length);
          Marshal.FreeCoTaskMem(text);
        }
        if (c.Name.Length == 0) c.Name = hardware ? "a hardware H.264 encoder" : "an H.264 encoder";
        found.Add(c);
      }
    } finally {
      Marshal.FreeCoTaskMem(list);
    }
  }
}

// One Media Foundation H.264 encoder at one size: NV12 in, H.264 out. Sync
// encoders (Microsoft's) are driven directly; async ones (most hardware)
// through their events, on a thread of their own.
sealed class Encoder : IDisposable {
  const int MF_E_TRANSFORM_NEED_MORE_INPUT = unchecked((int)0xC00D6D72), MF_E_TRANSFORM_STREAM_CHANGE = unchecked((int)0xC00D6D61);
  const int MF_E_NOTACCEPTING = unchecked((int)0xC00D36B5);
  const int METransformNeedInput = 601, METransformHaveOutput = 602, MEError = 1;
  static Guid IID_IMFTransform = new Guid("bf94c121-5b05-4e6f-8000-ba598961414d");
  static Guid MF_TRANSFORM_ASYNC = new Guid("f81a699a-649a-497d-8c73-29f8fed6ad7a");
  static Guid MF_TRANSFORM_ASYNC_UNLOCK = new Guid("e5666d6b-3422-4eb6-a421-da7db1f8e207");
  static Guid MF_LOW_LATENCY = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
  static Guid MF_MT_MAJOR_TYPE = new Guid("48eba18e-f8c9-4687-bf11-0a74c9f96a8f");
  static Guid MF_MT_SUBTYPE = new Guid("f7e34c9a-42e8-4714-b74b-cb29d72c35e5");
  static Guid MF_MT_FRAME_SIZE = new Guid("1652c33d-d6b2-4012-b834-72030849a37d");
  static Guid MF_MT_FRAME_RATE = new Guid("c459a2e8-3d2c-4e44-b132-fee5156c7bb0");
  static Guid MF_MT_PIXEL_ASPECT_RATIO = new Guid("c6376a1e-8d0a-4027-be45-6d9a0ad39bb6");
  static Guid MF_MT_INTERLACE_MODE = new Guid("e2724bb8-e676-4806-b4b2-a8d6efb44ccd");
  static Guid MF_MT_AVG_BITRATE = new Guid("20332624-fb0d-4d9e-bd0d-cbf6786c102e");
  static Guid MF_MT_MPEG2_PROFILE = new Guid("ad76a80b-2d5c-4e0b-b375-64e520137036");
  static Guid MF_MT_MPEG2_LEVEL = new Guid("96f66574-11c5-4015-8666-bff516436da7");
  static Guid MF_MT_DEFAULT_STRIDE = new Guid("644b4e48-1e02-4516-b0eb-c01ca9d49ac6");
  static Guid MF_MT_MPEG_SEQUENCE_HEADER = new Guid("3c036de7-3ad0-4c9e-9216-ee6d6ac21cb3");
  static Guid MF_MT_YUV_MATRIX = new Guid("3e23d450-2c75-4d25-a00e-b91670d12327");
  static Guid MF_MT_VIDEO_NOMINAL_RANGE = new Guid("c21b8ee5-b956-4071-8daf-325edf5cab11");
  static Guid MF_MT_VIDEO_PRIMARIES = new Guid("dbfbe4d7-0740-4ee0-8192-850ab0e21935");
  static Guid MF_MT_TRANSFER_FUNCTION = new Guid("5fb0fce9-be5c-4935-a811-ec838f8eed93");
  static Guid RateControlMode = new Guid("1c0608e9-370c-4710-8a58-cb6181c42423");
  static Guid MeanBitRate = new Guid("f7222374-2144-4815-b550-a37f8e12ee52");
  static Guid LowLatencyMode = new Guid("9c27891a-ed7a-40e1-88e8-b22727a024ee");
  static Guid BPictureCount = new Guid("8d390aac-dc5c-4200-b57f-814d04babab2");
  static Guid GopSize = new Guid("95f31b26-95a4-41aa-9303-246a7fc6eef1");
  static Guid ForceKeyFrame = new Guid("398c1b98-8353-475a-9ef2-8f265d260345");

  public readonly string Name;
  public readonly bool Hardware;
  // SPS and PPS from the output type, for an encoder that leaves them out
  // of its IDRs.
  public byte[] SequenceHeader;
  readonly EncoderChoice choice;
  readonly int width, height, fps;
  int bitrate;
  IMFTransform mft;
  ICodecAPI codec;
  bool async, providesSamples;
  int outputSize;
  IMFSample outSample;
  IMFMediaBuffer outBuffer;
  IntPtr outPointer;
  // Async: what its events asked for and gave, and why it gave out.
  readonly object gate = new object();
  readonly AutoResetEvent signal = new AutoResetEvent(false);
  readonly Queue<byte[]> outputs = new Queue<byte[]>();
  int needInput;
  // The last changed picture in, and the newest picture out, by time.
  long changedIn = -1, latestOut = -1;
  string failure;
  Thread pump;
  volatile bool stopping;
  long encoded;

  // A changed picture still inside the encoder: the next request pushes
  // it out (with the same picture again) instead of saying "unchanged".
  public bool Holding { get { lock (gate) return latestOut < changedIn; } }

  Encoder(EncoderChoice choice, int width, int height, int fps, int bitrate) {
    this.choice = choice;
    Name = choice.Name;
    Hardware = choice.Hardware;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.bitrate = bitrate;
  }

  public static Encoder Open(EncoderChoice choice, int width, int height, int fps, int bitrate) {
    Encoder e = new Encoder(choice, width, height, fps, bitrate);
    try {
      object made;
      Check(choice.Activate.ActivateObject(ref IID_IMFTransform, out made), "start");
      e.mft = (IMFTransform)made;
      e.Configure();
      return e;
    } catch {
      e.Dispose();
      throw;
    }
  }

  static void Check(int hr, string what) {
    if (hr < 0) throw new EncoderException(what + " " + ReachScreenVideo.Hex(hr));
  }

  void Configure() {
    IMFAttributes attributes;
    if (mft.GetAttributes(out attributes) >= 0 && attributes != null) {
      try {
        int value;
        if (attributes.GetUINT32(ref MF_TRANSFORM_ASYNC, out value) >= 0 && value != 0) {
          async = true;
          Check(attributes.SetUINT32(ref MF_TRANSFORM_ASYNC_UNLOCK, 1), "unlock");
        }
        attributes.SetUINT32(ref MF_LOW_LATENCY, 1);
      } finally {
        Marshal.ReleaseComObject(attributes);
      }
    }
    codec = mft as ICodecAPI;
    // Low latency, no B-frames, constant bitrate: set before the types where
    // an encoder wants them then, and again after where it wants them later.
    bool[] set = Settings(new bool[5]);
    SetOutput();
    SetInput();
    Settings(set);
    StreamInfo info;
    Check(mft.GetOutputStreamInfo(0, out info), "output info");
    providesSamples = (info.Flags & 0x100) != 0;
    outputSize = Math.Max(info.Size, width * height * 2 + 65536);
    if (!providesSamples) {
      Check(Native.MFCreateSample(out outSample), "output sample");
      Check(Native.MFCreateMemoryBuffer(outputSize, out outBuffer), "output buffer");
      Check(outSample.AddBuffer(outBuffer), "output buffer");
      outPointer = Marshal.GetComInterfaceForObject(outSample, typeof(IMFSample));
    }
    IMFMediaType current;
    if (mft.GetOutputCurrentType(0, out current) >= 0 && current != null) {
      try {
        IMFAttributes a = (IMFAttributes)current;
        int size;
        if (a.GetBlobSize(ref MF_MT_MPEG_SEQUENCE_HEADER, out size) >= 0 && size > 0 && size < 4096) {
          byte[] blob = new byte[size];
          if (a.GetBlob(ref MF_MT_MPEG_SEQUENCE_HEADER, blob, size, out size) >= 0) SequenceHeader = blob;
        }
      } finally {
        Marshal.ReleaseComObject(current);
      }
    }
    Check(mft.ProcessMessage(0x10000000, IntPtr.Zero), "begin streaming");
    Check(mft.ProcessMessage(0x10000003, IntPtr.Zero), "start of stream");
    if (async) {
      pump = new Thread(Pump);
      pump.IsBackground = true;
      pump.SetApartmentState(ApartmentState.MTA);
      pump.Start();
    }
  }

  // Each setting tried once more if it didn't take; `done` says which did.
  bool[] Settings(bool[] done) {
    object[][] all = {
      new object[] { LowLatencyMode, true },
      new object[] { RateControlMode, (uint)0 },
      new object[] { MeanBitRate, (uint)bitrate },
      new object[] { BPictureCount, (uint)0 },
      new object[] { GopSize, (uint)(fps * 10) },
    };
    for (int i = 0; i < all.Length; i++) if (!done[i]) done[i] = Set((Guid)all[i][0], all[i][1]);
    return done;
  }

  bool Set(Guid api, object value) {
    if (codec == null) return false;
    try { return codec.SetValue(ref api, ref value) >= 0; } catch (Exception) { return false; }
  }

  public void SetBitrate(int value) {
    bitrate = value;
    Set(MeanBitRate, (uint)value);
  }

  // The lowest level this size and rate fit, so the phone's decoder isn't
  // asked for more than it needs (High@5.2 restarted an iPhone's decoder).
  static int Level(int width, int height, int fps) {
    long frame = (long)((width + 15) / 16) * ((height + 15) / 16), rate = frame * fps;
    int[,] levels = { { 31, 3600, 108000 }, { 32, 5120, 216000 }, { 41, 8192, 245760 }, { 42, 8704, 522240 }, { 50, 22080, 589824 }, { 51, 36864, 983040 }, { 52, 36864, 2073600 } };
    for (int i = 0; i < levels.GetLength(0); i++) if (frame <= levels[i, 1] && rate <= levels[i, 2]) return levels[i, 0];
    return 52;
  }

  // Size, rate, progressive square pixels; and (unless an encoder refuses
  // them) the colours as converted: BT.709, video range.
  void Describe(IMFAttributes a, bool colour) {
    a.SetUINT64(ref MF_MT_FRAME_SIZE, ((long)width << 32) | (uint)height);
    a.SetUINT64(ref MF_MT_FRAME_RATE, ((long)fps << 32) | 1);
    a.SetUINT64(ref MF_MT_PIXEL_ASPECT_RATIO, (1L << 32) | 1);
    a.SetUINT32(ref MF_MT_INTERLACE_MODE, 2);
    if (!colour) return;
    a.SetUINT32(ref MF_MT_YUV_MATRIX, 1);
    a.SetUINT32(ref MF_MT_VIDEO_NOMINAL_RANGE, 2);
    a.SetUINT32(ref MF_MT_VIDEO_PRIMARIES, 2);
    a.SetUINT32(ref MF_MT_TRANSFER_FUNCTION, 5);
  }

  // H.264 out: High, else Main, else Baseline, at the level this size needs
  // (or the encoder's own); else whatever H.264 type it offers, sized.
  void SetOutput() {
    int last = 0;
    foreach (int profile in new int[] { 100, 77, 66 }) {
      // With the level and colours, without the level, without either.
      for (int attempt = 0; attempt < 3; attempt++) {
        IMFMediaType type;
        Check(Native.MFCreateMediaType(out type), "media type");
        try {
          IMFAttributes a = (IMFAttributes)type;
          a.SetGUID(ref MF_MT_MAJOR_TYPE, ref Encoders.Video);
          a.SetGUID(ref MF_MT_SUBTYPE, ref Encoders.H264);
          a.SetUINT32(ref MF_MT_AVG_BITRATE, bitrate);
          a.SetUINT32(ref MF_MT_MPEG2_PROFILE, profile);
          if (attempt == 0) a.SetUINT32(ref MF_MT_MPEG2_LEVEL, Level(width, height, fps));
          Describe(a, attempt < 2);
          last = mft.SetOutputType(0, type, 0);
          if (last >= 0) return;
        } finally {
          Marshal.ReleaseComObject(type);
        }
      }
    }
    for (int i = 0; i < 32; i++) {
      IMFMediaType type;
      if (mft.GetOutputAvailableType(0, i, out type) < 0 || type == null) break;
      try {
        IMFAttributes a = (IMFAttributes)type;
        Guid sub;
        if (a.GetGUID(ref MF_MT_SUBTYPE, out sub) < 0 || sub != Encoders.H264) continue;
        a.SetUINT32(ref MF_MT_AVG_BITRATE, bitrate);
        Describe(a, false);
        last = mft.SetOutputType(0, type, 0);
        if (last >= 0) return;
      } finally {
        Marshal.ReleaseComObject(type);
      }
    }
    throw new EncoderException("no H.264 output at " + width + "x" + height + " " + ReachScreenVideo.Hex(last));
  }

  // NV12 in, rows `width` bytes apart: the encoder's own NV12 type if it
  // offers one, else one made here; with the colours, else without.
  void SetInput() {
    int last = 0;
    for (int colour = 1; colour >= 0; colour--) {
      for (int i = 0; i < 64; i++) {
        IMFMediaType type;
        if (mft.GetInputAvailableType(0, i, out type) < 0 || type == null) break;
        try {
          IMFAttributes a = (IMFAttributes)type;
          Guid sub;
          if (a.GetGUID(ref MF_MT_SUBTYPE, out sub) < 0 || sub != Encoders.NV12) continue;
          Describe(a, colour == 1);
          a.SetUINT32(ref MF_MT_DEFAULT_STRIDE, width);
          last = mft.SetInputType(0, type, 0);
          if (last >= 0) return;
        } finally {
          Marshal.ReleaseComObject(type);
        }
      }
      IMFMediaType made;
      Check(Native.MFCreateMediaType(out made), "media type");
      try {
        IMFAttributes a = (IMFAttributes)made;
        a.SetGUID(ref MF_MT_MAJOR_TYPE, ref Encoders.Video);
        a.SetGUID(ref MF_MT_SUBTYPE, ref Encoders.NV12);
        Describe(a, colour == 1);
        a.SetUINT32(ref MF_MT_DEFAULT_STRIDE, width);
        last = mft.SetInputType(0, made, 0);
        if (last >= 0) return;
      } finally {
        Marshal.ReleaseComObject(made);
      }
    }
    throw new EncoderException("no NV12 input at " + width + "x" + height + " " + ReachScreenVideo.Hex(last));
  }

  // One picture in; what the encoder gave back (null when it holds it).
  public byte[] Encode(byte[] nv12, long time, bool key, bool changed) {
    if (key) Set(ForceKeyFrame, (uint)1);
    if (changed) lock (gate) changedIn = time;
    IMFSample sample;
    IMFMediaBuffer buffer;
    Check(Native.MFCreateSample(out sample), "sample");
    try {
      Check(Native.MFCreateMemoryBuffer(nv12.Length, out buffer), "buffer");
      try {
        IntPtr data;
        int max, length;
        Check(buffer.Lock(out data, out max, out length), "lock");
        Marshal.Copy(nv12, 0, data, nv12.Length);
        buffer.Unlock();
        Check(buffer.SetCurrentLength(nv12.Length), "length");
        Check(sample.AddBuffer(buffer), "add buffer");
      } finally {
        Marshal.ReleaseComObject(buffer);
      }
      Check(sample.SetSampleTime(time), "time");
      Check(sample.SetSampleDuration(10000000 / fps), "duration");
      byte[] result = async ? EncodeAsync(sample) : EncodeSync(sample);
      encoded++;
      return result;
    } finally {
      Marshal.ReleaseComObject(sample);
    }
  }

  byte[] EncodeSync(IMFSample sample) {
    MemoryStream got = new MemoryStream();
    int hr = mft.ProcessInput(0, sample, 0);
    if (hr == MF_E_NOTACCEPTING) {
      Drain(got);
      hr = mft.ProcessInput(0, sample, 0);
    }
    Check(hr, "input");
    Drain(got);
    return got.Length == 0 ? null : got.ToArray();
  }

  // Everything the encoder has ready.
  void Drain(MemoryStream got) {
    for (int i = 0; i < 16; i++) {
      byte[] data = Output();
      if (data == null) return;
      got.Write(data, 0, data.Length);
    }
  }

  // One ProcessOutput: its bytes, or null when it needs more input.
  byte[] Output() {
    for (int attempt = 0; attempt < 4; attempt++) {
      OutputBuffer o = new OutputBuffer();
      if (!providesSamples) {
        outBuffer.SetCurrentLength(0);
        o.Sample = outPointer;
      }
      int status;
      int hr = mft.ProcessOutput(0, 1, ref o, out status);
      if (o.Events != IntPtr.Zero) Marshal.Release(o.Events);
      if (hr == MF_E_TRANSFORM_NEED_MORE_INPUT) {
        if (providesSamples && o.Sample != IntPtr.Zero) Marshal.Release(o.Sample);
        return null;
      }
      if (hr == MF_E_TRANSFORM_STREAM_CHANGE) {
        // The encoder settled its output type itself: take it and ask again.
        if (providesSamples && o.Sample != IntPtr.Zero) Marshal.Release(o.Sample);
        IMFMediaType type;
        Check(mft.GetOutputAvailableType(0, 0, out type), "new output type");
        try { Check(mft.SetOutputType(0, type, 0), "new output type"); } finally { Marshal.ReleaseComObject(type); }
        continue;
      }
      if (hr < 0) {
        if (providesSamples && o.Sample != IntPtr.Zero) Marshal.Release(o.Sample);
        Check(hr, "output");
      }
      if (!providesSamples) return Read(outSample);
      if (o.Sample == IntPtr.Zero) return new byte[0];
      try {
        IMFSample given = (IMFSample)Marshal.GetObjectForIUnknown(o.Sample);
        try { return Read(given); } finally { Marshal.ReleaseComObject(given); }
      } finally {
        Marshal.Release(o.Sample);
      }
    }
    throw new EncoderException("output type kept changing");
  }

  byte[] Read(IMFSample sample) {
    // An encoder that doesn't say which picture this is never holds one.
    long time;
    bool known = sample.GetSampleTime(out time) >= 0;
    lock (gate) latestOut = known ? Math.Max(latestOut, time) : long.MaxValue;
    IMFMediaBuffer buffer;
    Check(sample.ConvertToContiguousBuffer(out buffer), "output buffer");
    try {
      IntPtr data;
      int max, length;
      Check(buffer.Lock(out data, out max, out length), "lock output");
      try {
        byte[] bytes = new byte[length];
        Marshal.Copy(data, bytes, 0, length);
        return bytes;
      } finally {
        buffer.Unlock();
      }
    } finally {
      Marshal.ReleaseComObject(buffer);
    }
  }

  // Async: in when it asked for a picture, out when it said it has one. Its
  // output usually comes within milliseconds; one that comes later goes out
  // with the next request.
  byte[] EncodeAsync(IMFSample sample) {
    Wait(delegate { return needInput > 0; }, 3000, "asking for a picture");
    lock (gate) needInput--;
    Check(mft.ProcessInput(0, sample, 0), "input");
    // Hardware encoders answer within milliseconds; one that keeps the
    // picture until the next gives it then.
    Wait(delegate { return outputs.Count > 0; }, encoded < 2 ? 3000 : Math.Max(30, 2000 / fps), null);
    MemoryStream got = new MemoryStream();
    lock (gate) {
      while (outputs.Count > 0) {
        byte[] data = outputs.Dequeue();
        got.Write(data, 0, data.Length);
      }
    }
    return got.Length == 0 ? null : got.ToArray();
  }

  delegate bool Ready();
  void Wait(Ready ready, int ms, string what) {
    Stopwatch waited = Stopwatch.StartNew();
    while (true) {
      lock (gate) {
        if (failure != null) throw new EncoderException(failure);
        if (ready()) return;
      }
      long left = ms - waited.ElapsedMilliseconds;
      if (left <= 0) {
        if (what == null) return;
        throw new EncoderException("timed out " + what);
      }
      signal.WaitOne((int)left);
    }
  }

  void Pump() {
    IMFMediaEventGenerator events = (IMFMediaEventGenerator)mft;
    try {
      while (!stopping) {
        IMFMediaEvent e;
        int hr = events.GetEvent(0, out e);
        if (hr < 0) {
          if (!stopping) Fail("events " + ReachScreenVideo.Hex(hr));
          return;
        }
        int type, status;
        try {
          e.GetEventType(out type);
          e.GetStatus(out status);
        } finally {
          Marshal.ReleaseComObject(e);
        }
        if (status < 0 || type == MEError) {
          Fail("event " + type + " " + ReachScreenVideo.Hex(status));
          return;
        }
        if (type == METransformNeedInput) {
          lock (gate) needInput++;
          signal.Set();
        } else if (type == METransformHaveOutput) {
          byte[] data = Output();
          lock (gate) {
            if (data != null && data.Length > 0) outputs.Enqueue(data);
          }
          signal.Set();
        }
      }
    } catch (Exception e) {
      if (!stopping) Fail(ReachScreenVideo.Plain(e));
    }
  }

  void Fail(string why) {
    lock (gate) {
      if (failure == null) failure = why;
    }
    signal.Set();
  }

  public void Dispose() {
    stopping = true;
    if (mft != null) {
      try { mft.ProcessMessage(0x10000001, IntPtr.Zero); } catch (Exception) {}
      IMFShutdown shutdown = mft as IMFShutdown;
      if (shutdown != null) try { shutdown.Shutdown(); } catch (Exception) {}
    }
    if (pump != null) pump.Join(2000);
    if (outPointer != IntPtr.Zero) Marshal.Release(outPointer);
    outPointer = IntPtr.Zero;
    if (outBuffer != null) Marshal.ReleaseComObject(outBuffer);
    if (outSample != null) Marshal.ReleaseComObject(outSample);
    outBuffer = null;
    outSample = null;
    if (mft != null) Marshal.ReleaseComObject(mft);
    mft = null;
    codec = null;
    // Hardware encoders are let go through the object that made them.
    if (choice != null && choice.Activate != null) try { choice.Activate.ShutdownObject(); } catch (Exception) {}
  }
}

// H.264 as Reach sends it: Annex B with 4-byte start codes, an access unit
// delimiter first, SPS and PPS before every IDR.
static class AnnexB {
  static readonly byte[] Start = { 0, 0, 0, 1 };
  static readonly byte[] Delimiter = { 0, 0, 0, 1, 9, 0xF0 };

  // The NAL units of an encoder's output: Annex B, or 4-byte lengths.
  public static List<byte[]> Units(byte[] data) {
    List<byte[]> units = new List<byte[]>();
    if (data.Length >= 3 && data[0] == 0 && data[1] == 0 && (data[2] == 1 || (data.Length >= 4 && data[2] == 0 && data[3] == 1))) {
      int at = -1;
      for (int i = 0; i + 2 < data.Length; i++) {
        if (data[i] != 0 || data[i + 1] != 0 || data[i + 2] != 1) continue;
        if (at >= 0) Add(units, data, at, i);
        at = i + 3;
        i += 2;
      }
      if (at >= 0) Add(units, data, at, data.Length);
      return units;
    }
    for (int at = 0; at + 4 <= data.Length; ) {
      int length = (data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3];
      if (length <= 0 || at + 4 + length > data.Length) throw new EncoderException("unreadable output");
      Add(units, data, at + 4, at + 4 + length);
      at += 4 + length;
    }
    return units;
  }

  // One NAL from `from` up to `to`, without the zeros before the next start code.
  static void Add(List<byte[]> units, byte[] data, int from, int to) {
    while (to > from && data[to - 1] == 0) to--;
    if (to <= from) return;
    byte[] unit = new byte[to - from];
    Buffer.BlockCopy(data, from, unit, 0, unit.Length);
    units.Add(unit);
  }

  // The frame Reach sends; remembers the last SPS and PPS for IDRs that
  // come without them.
  public static byte[] AccessUnit(byte[] raw, ref byte[] sps, ref byte[] pps, byte[] header, out bool idr) {
    List<byte[]> units = Units(raw);
    idr = false;
    bool hasSps = false, hasPps = false;
    foreach (byte[] u in units) {
      int type = u[0] & 31;
      if (type == 5) idr = true;
      if (type == 7) { sps = u; hasSps = true; }
      if (type == 8) { pps = u; hasPps = true; }
    }
    if ((sps == null || pps == null) && header != null) {
      foreach (byte[] u in Units(header)) {
        if ((u[0] & 31) == 7 && sps == null) sps = u;
        if ((u[0] & 31) == 8 && pps == null) pps = u;
      }
    }
    MemoryStream frame = new MemoryStream();
    frame.Write(Delimiter, 0, Delimiter.Length);
    if (idr && sps != null && pps != null) {
      Write(frame, hasSps ? Find(units, 7) : sps);
      Write(frame, hasPps ? Find(units, 8) : pps);
    }
    foreach (byte[] u in units) {
      int type = u[0] & 31;
      if (type == 9 || (idr && (type == 7 || type == 8))) continue;
      Write(frame, u);
    }
    return frame.ToArray();
  }

  static byte[] Find(List<byte[]> units, int type) {
    foreach (byte[] u in units) if ((u[0] & 31) == type) return u;
    return null;
  }

  static void Write(MemoryStream frame, byte[] unit) {
    frame.Write(Start, 0, 4);
    frame.Write(unit, 0, unit.Length);
  }

  // avc1.PPCCLL: profile, constraint flags and level, as the phone's
  // decoder is configured (src/useRemoteScreen.ts).
  public static string Codec(byte[] sps) {
    if (sps.Length < 4) return "";
    return "avc1." + sps[1].ToString("x2") + sps[2].ToString("x2") + sps[3].ToString("x2");
  }
}

// What this PC can do, for Reach to choose its video once (server/windows-video.mjs).
static class Probe {
  public static int Run() {
    Stopwatch took = Stopwatch.StartNew();
    Mf.Start();
    List<EncoderChoice> choices = Encoders.List();
    StringBuilder tried = new StringBuilder();
    EncoderChoice chosen = null;
    string failures = null;
    try {
      foreach (EncoderChoice c in choices) {
        string error = Test(c);
        tried.Append(tried.Length == 0 ? "" : ",").Append("{\"name\":").Append(Json(c.Name)).Append(",\"hardware\":").Append(c.Hardware ? "true" : "false")
          .Append(",\"ok\":").Append(error == null ? "true" : "false").Append(error == null ? "" : ",\"error\":" + Json(error)).Append("}");
        if (error == null) {
          chosen = c;
          break;
        }
        failures = (failures == null ? "" : failures + "; ") + c.Name + " (" + error + ")";
      }
      if (chosen == null) throw new VideoException(3, Why.NoEncoder(failures));
      string capture = "gdi", why = "";
      try {
        bool forGood;
        Duplication d = Duplication.Open(Desktop.Find("primary"), out why, out forGood);
        if (d != null) {
          capture = "duplication";
          d.Dispose();
        }
      } catch (VideoException e) {
        capture = "none";
        why = e.Message;
      }
      Console.Out.Write("{\"encoder\":" + Json(chosen.Name) + ",\"hardware\":" + (chosen.Hardware ? "true" : "false")
        + ",\"capture\":\"" + capture + "\"" + (why.Length > 0 ? ",\"captureWhy\":" + Json(why) : "")
        + ",\"tried\":[" + tried + "],\"ms\":" + took.ElapsedMilliseconds + "}\n");
      Console.Out.Flush();
      return 0;
    } finally {
      foreach (EncoderChoice c in choices) c.Dispose();
    }
  }

  // Two synthetic pictures through the encoder: it must give back an IDR
  // with its SPS and PPS, as a stream's first frame needs.
  static string Test(EncoderChoice c) {
    try {
      using (Encoder e = Encoder.Open(c, 640, 360, 30, 1000000)) {
        byte[] picture = new byte[640 * 360 * 3 / 2];
        for (int y = 0; y < 360; y++) for (int x = 0; x < 640; x++) picture[y * 640 + x] = (byte)(32 + (x / 20 + y / 10) % 160);
        for (int i = 640 * 360; i < picture.Length; i++) picture[i] = 128;
        byte[] sps = null, pps = null;
        for (int frame = 0; frame < 3; frame++) {
          byte[] raw = e.Encode(picture, frame * 333333L, frame == 0, true);
          if (raw == null) continue;
          bool idr;
          AnnexB.AccessUnit(raw, ref sps, ref pps, e.SequenceHeader, out idr);
          if (idr && sps != null && pps != null) return null;
        }
        return "no keyframe with SPS and PPS";
      }
    } catch (Exception e) {
      return ReachScreenVideo.Plain(e);
    }
  }

  // A JSON string, ASCII only.
  static string Json(string text) {
    StringBuilder s = new StringBuilder("\"");
    foreach (char c in text) {
      if (c == '"' || c == '\\') s.Append('\\').Append(c);
      else if (c < 32 || c > 126) s.Append("\\u").Append(((int)c).ToString("x4"));
      else s.Append(c);
    }
    return s.Append('"').ToString();
  }
}

[StructLayout(LayoutKind.Sequential)]
struct RECT { public int Left, Top, Right, Bottom; }
[StructLayout(LayoutKind.Sequential)]
struct MoveRect { public int SourceX, SourceY; public RECT Destination; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct OutputDesc {
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
  public RECT Desktop;
  public int AttachedToDesktop, Rotation;
  public IntPtr Monitor;
}
// DXGI_OUTDUPL_DESC: DXGI_MODE_DESC, rotation, whether it's in system memory.
[StructLayout(LayoutKind.Sequential)]
struct DuplicationDesc { public int Width, Height, RefreshNumerator, RefreshDenominator, Format, ScanlineOrdering, Scaling, Rotation, InSystemMemory; }
// DXGI_OUTDUPL_FRAME_INFO.
[StructLayout(LayoutKind.Sequential)]
struct FrameInfo {
  public long LastPresentTime, LastMouseUpdateTime;
  public int AccumulatedFrames, RectsCoalesced, ProtectedContentMaskedOut;
  public int PointerX, PointerY, PointerVisible;
  public int TotalMetadataBufferSize, PointerShapeBufferSize;
}
// DXGI_OUTDUPL_POINTER_SHAPE_INFO.
[StructLayout(LayoutKind.Sequential)]
struct ShapeInfo { public int Type, Width, Height, Pitch, HotspotX, HotspotY; }
// D3D11_TEXTURE2D_DESC.
[StructLayout(LayoutKind.Sequential)]
struct TextureDesc { public int Width, Height, MipLevels, ArraySize, Format, SampleCount, SampleQuality, Usage, BindFlags, CpuAccessFlags, MiscFlags; }
[StructLayout(LayoutKind.Sequential)]
struct Box { public int Left, Top, Front, Right, Bottom, Back; }
// D3D11_MAPPED_SUBRESOURCE.
[StructLayout(LayoutKind.Sequential)]
struct Mapped { public IntPtr Data; public int RowPitch, DepthPitch; }
// MFT_REGISTER_TYPE_INFO.
[StructLayout(LayoutKind.Sequential)]
struct TypeInfo { public Guid Major, Sub; }
// MFT_OUTPUT_STREAM_INFO.
[StructLayout(LayoutKind.Sequential)]
struct StreamInfo { public int Flags, Size, Alignment; }
// MFT_OUTPUT_DATA_BUFFER.
[StructLayout(LayoutKind.Sequential)]
struct OutputBuffer { public int StreamId; public IntPtr Sample; public int Status; public IntPtr Events; }
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
struct MonitorInfo {
  public int Size;
  public RECT Monitor, Work;
  public int Flags;
  [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Device;
}
[StructLayout(LayoutKind.Sequential)]
struct BitmapInfo {
  public int Size, Width, Height;
  public short Planes, BitCount;
  public int Compression, SizeImage, XPelsPerMeter, YPelsPerMeter, ClrUsed, ClrImportant;
}
[StructLayout(LayoutKind.Sequential)]
struct CursorInfo { public int Size, Flags; public IntPtr Cursor; public int X, Y; }
[StructLayout(LayoutKind.Sequential)]
struct IconInfo { public bool IsIcon; public int HotspotX, HotspotY; public IntPtr Mask, Color; }

static class Native {
  public delegate bool MonitorEnum(IntPtr monitor, IntPtr dc, ref RECT clip, IntPtr data);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  [DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int value);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool EnumDisplayMonitors(IntPtr dc, IntPtr clip, MonitorEnum each, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
  [DllImport("wtsapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool WTSQuerySessionInformation(IntPtr server, int session, int infoClass, out IntPtr buffer, out int bytes);
  [DllImport("wtsapi32.dll")] public static extern void WTSFreeMemory(IntPtr memory);
  [DllImport("user32.dll", SetLastError = true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder info, int length, out int needed);
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr window);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr window, IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr dc, ref BitmapInfo info, int usage, out IntPtr bits, IntPtr section, int offset);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr source, int sx, int sy, int op);
  [DllImport("gdi32.dll")] public static extern bool GdiFlush();
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CursorInfo info);
  [DllImport("user32.dll")] public static extern bool GetIconInfo(IntPtr icon, out IconInfo info);
  [DllImport("user32.dll")] public static extern bool DrawIconEx(IntPtr dc, int x, int y, IntPtr icon, int width, int height, int step, IntPtr brush, int flags);
  [DllImport("dxgi.dll")] public static extern int CreateDXGIFactory1(ref Guid iid, out IDXGIFactory1 factory);
  [DllImport("d3d11.dll")] public static extern int D3D11CreateDevice(IntPtr adapter, int driverType, IntPtr software, int flags, IntPtr levels, int levelCount, int sdkVersion, out ID3D11Device device, out int level, out ID3D11DeviceContext context);
  [DllImport("mfplat.dll")] public static extern int MFStartup(int version, int flags);
  [DllImport("mfplat.dll")] public static extern int MFTEnumEx(Guid category, int flags, ref TypeInfo input, ref TypeInfo output, out IntPtr activates, out int count);
  [DllImport("mfplat.dll")] public static extern int MFCreateMediaType(out IMFMediaType type);
  [DllImport("mfplat.dll")] public static extern int MFCreateSample(out IMFSample sample);
  [DllImport("mfplat.dll")] public static extern int MFCreateMemoryBuffer(int length, out IMFMediaBuffer buffer);
}

// COM interfaces, declared by hand as their vtables are laid out (the
// Windows SDK's headers): each method in order, placeholders (_nn) for the
// ones Reach never calls.
[ComImport, Guid("770aae78-f26f-4dba-a829-253c83d1b387"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIFactory1 {
  // IDXGIObject: SetPrivateData, SetPrivateDataInterface, GetPrivateData,
  // GetParent; IDXGIFactory: EnumAdapters, MakeWindowAssociation,
  // GetWindowAssociation, CreateSwapChain, CreateSoftwareAdapter.
  void _00(); void _01(); void _02(); void _03(); void _04(); void _05(); void _06(); void _07(); void _08();
  [PreserveSig] int EnumAdapters1(int index, out IDXGIAdapter1 adapter);
}

[ComImport, Guid("29038f61-3839-4626-91fd-086879011a05"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIAdapter1 {
  // IDXGIObject's four.
  void _00(); void _01(); void _02(); void _03();
  [PreserveSig] int EnumOutputs(int index, out IDXGIOutput output);
}

[ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIOutput {
  void _00(); void _01(); void _02(); void _03();
  [PreserveSig] int GetDesc(out OutputDesc desc);
}

[ComImport, Guid("00cddea8-939b-4b83-a340-a685226666cc"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIOutput1 {
  // IDXGIObject's four; IDXGIOutput: GetDesc, GetDisplayModeList,
  // FindClosestMatchingMode, WaitForVBlank, TakeOwnership, ReleaseOwnership,
  // GetGammaControlCapabilities, SetGammaControl, GetGammaControl,
  // SetDisplaySurface, GetDisplaySurfaceData, GetFrameStatistics;
  // IDXGIOutput1: GetDisplayModeList1, FindClosestMatchingMode1,
  // GetDisplaySurfaceData1.
  void _00(); void _01(); void _02(); void _03(); void _04(); void _05(); void _06(); void _07();
  void _08(); void _09(); void _10(); void _11(); void _12(); void _13(); void _14(); void _15();
  void _16(); void _17(); void _18();
  [PreserveSig] int DuplicateOutput([MarshalAs(UnmanagedType.IUnknown)] object device, out IDXGIOutputDuplication duplication);
}

[ComImport, Guid("80a07424-ab52-42eb-833c-0c42fd282d98"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIOutput5 {
  // As IDXGIOutput1 up to its DuplicateOutput (_19); IDXGIOutput2:
  // SupportsOverlays; IDXGIOutput3: CheckOverlaySupport; IDXGIOutput4:
  // CheckOverlayColorSpaceSupport.
  void _00(); void _01(); void _02(); void _03(); void _04(); void _05(); void _06(); void _07();
  void _08(); void _09(); void _10(); void _11(); void _12(); void _13(); void _14(); void _15();
  void _16(); void _17(); void _18(); void _19(); void _20(); void _21(); void _22();
  [PreserveSig] int DuplicateOutput1([MarshalAs(UnmanagedType.IUnknown)] object device, int flags, int count, [In] int[] formats, out IDXGIOutputDuplication duplication);
}

[ComImport, Guid("191cfac3-a341-470d-b26e-a864f428319c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIOutputDuplication {
  void _00(); void _01(); void _02(); void _03();
  [PreserveSig] void GetDesc(out DuplicationDesc desc);
  [PreserveSig] int AcquireNextFrame(int timeout, out FrameInfo info, out IDXGIResource resource);
  [PreserveSig] int GetFrameDirtyRects(int size, [Out] RECT[] rects, out int needed);
  [PreserveSig] int GetFrameMoveRects(int size, [Out] MoveRect[] rects, out int needed);
  [PreserveSig] int GetFramePointerShape(int size, [Out] byte[] shape, out int needed, out ShapeInfo info);
  void _MapDesktopSurface(); void _UnMapDesktopSurface();
  [PreserveSig] int ReleaseFrame();
}

[ComImport, Guid("035f3ab4-482e-4e50-b41f-8a7f8bd8960b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IDXGIResource {}

[ComImport, Guid("dc8e63f3-d12b-4952-b47b-5e45026a862d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ID3D11Resource {}

[ComImport, Guid("6f15aaf2-d208-4e89-9ab4-489535d34f9c"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ID3D11Texture2D {}

[ComImport, Guid("db6f6ddb-ac77-4e88-8253-819df9bbf140"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ID3D11Device {
  // CreateBuffer, CreateTexture1D.
  void _00(); void _01();
  [PreserveSig] int CreateTexture2D(ref TextureDesc desc, IntPtr initial, out ID3D11Texture2D texture);
}

[ComImport, Guid("c0bfa96c-e089-44fb-8eaf-26f8796190da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ID3D11DeviceContext {
  // ID3D11DeviceChild: GetDevice, GetPrivateData, SetPrivateData,
  // SetPrivateDataInterface; then VSSetConstantBuffers, PSSetShaderResources,
  // PSSetShader, PSSetSamplers, VSSetShader, DrawIndexed, Draw.
  void _00(); void _01(); void _02(); void _03(); void _04(); void _05(); void _06(); void _07();
  void _08(); void _09(); void _10();
  [PreserveSig] int Map(ID3D11Resource resource, int subresource, int type, int flags, out Mapped mapped);
  [PreserveSig] void Unmap(ID3D11Resource resource, int subresource);
  // PSSetConstantBuffers through RSSetScissorRects.
  void _13(); void _14(); void _15(); void _16(); void _17(); void _18(); void _19(); void _20();
  void _21(); void _22(); void _23(); void _24(); void _25(); void _26(); void _27(); void _28();
  void _29(); void _30(); void _31(); void _32(); void _33(); void _34(); void _35(); void _36();
  void _37(); void _38(); void _39(); void _40(); void _41(); void _42();
  [PreserveSig] void CopySubresourceRegion(ID3D11Resource destination, int destinationSubresource, int x, int y, int z, ID3D11Resource source, int sourceSubresource, ref Box box);
  [PreserveSig] void CopyResource(ID3D11Resource destination, ID3D11Resource source);
}

[ComImport, Guid("2cd2d921-c447-44a7-a13c-4adabfc247e3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFAttributes {
  // GetItem, GetItemType, CompareItem, Compare.
  void _00(); void _01(); void _02(); void _03();
  [PreserveSig] int GetUINT32([In] ref Guid key, out int value);
  [PreserveSig] int GetUINT64([In] ref Guid key, out long value);
  void _06();
  [PreserveSig] int GetGUID([In] ref Guid key, out Guid value);
  // GetStringLength, GetString.
  void _08(); void _09();
  [PreserveSig] int GetAllocatedString([In] ref Guid key, out IntPtr value, out int length);
  [PreserveSig] int GetBlobSize([In] ref Guid key, out int size);
  [PreserveSig] int GetBlob([In] ref Guid key, [Out] byte[] buffer, int size, out int written);
  // GetAllocatedBlob, GetUnknown, SetItem, DeleteItem, DeleteAllItems.
  void _13(); void _14(); void _15(); void _16(); void _17();
  [PreserveSig] int SetUINT32([In] ref Guid key, int value);
  [PreserveSig] int SetUINT64([In] ref Guid key, long value);
  void _20();
  [PreserveSig] int SetGUID([In] ref Guid key, [In] ref Guid value);
  // SetString, SetBlob, SetUnknown, LockStore, UnlockStore, GetCount,
  // GetItemByIndex, CopyAllItems.
}

// IMFAttributes' 30 methods come first in each of these; attributes are
// read and set through IMFAttributes (the same object).
[ComImport, Guid("44ae0fa8-ea31-4109-8d2e-4cae4997c555"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFMediaType {}

[ComImport, Guid("7fee9e9a-4a89-47a6-899c-b6a53a70fb67"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFActivate {
  void _a00(); void _a01(); void _a02(); void _a03(); void _a04(); void _a05(); void _a06(); void _a07();
  void _a08(); void _a09(); void _a10(); void _a11(); void _a12(); void _a13(); void _a14(); void _a15();
  void _a16(); void _a17(); void _a18(); void _a19(); void _a20(); void _a21(); void _a22(); void _a23();
  void _a24(); void _a25(); void _a26(); void _a27(); void _a28(); void _a29();
  [PreserveSig] int ActivateObject([In] ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object made);
  [PreserveSig] int ShutdownObject();
}

[ComImport, Guid("c40a00f2-b93a-4d80-ae8c-5a1c634f58e4"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFSample {
  void _a00(); void _a01(); void _a02(); void _a03(); void _a04(); void _a05(); void _a06(); void _a07();
  void _a08(); void _a09(); void _a10(); void _a11(); void _a12(); void _a13(); void _a14(); void _a15();
  void _a16(); void _a17(); void _a18(); void _a19(); void _a20(); void _a21(); void _a22(); void _a23();
  void _a24(); void _a25(); void _a26(); void _a27(); void _a28(); void _a29();
  // GetSampleFlags, SetSampleFlags.
  void _30(); void _31();
  [PreserveSig] int GetSampleTime(out long time);
  [PreserveSig] int SetSampleTime(long time);
  void _34();
  [PreserveSig] int SetSampleDuration(long duration);
  // GetBufferCount, GetBufferByIndex.
  void _36(); void _37();
  [PreserveSig] int ConvertToContiguousBuffer(out IMFMediaBuffer buffer);
  [PreserveSig] int AddBuffer(IMFMediaBuffer buffer);
}

[ComImport, Guid("045fa593-8799-42b8-bc8d-8968c6453507"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFMediaBuffer {
  [PreserveSig] int Lock(out IntPtr data, out int max, out int length);
  [PreserveSig] int Unlock();
  [PreserveSig] int GetCurrentLength(out int length);
  [PreserveSig] int SetCurrentLength(int length);
}

[ComImport, Guid("bf94c121-5b05-4e6f-8000-ba598961414d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFTransform {
  // GetStreamLimits, GetStreamCount, GetStreamIDs, GetInputStreamInfo.
  void _00(); void _01(); void _02(); void _03();
  [PreserveSig] int GetOutputStreamInfo(int stream, out StreamInfo info);
  [PreserveSig] int GetAttributes(out IMFAttributes attributes);
  // GetInputStreamAttributes, GetOutputStreamAttributes, DeleteInputStream,
  // AddInputStreams.
  void _06(); void _07(); void _08(); void _09();
  [PreserveSig] int GetInputAvailableType(int stream, int index, out IMFMediaType type);
  [PreserveSig] int GetOutputAvailableType(int stream, int index, out IMFMediaType type);
  [PreserveSig] int SetInputType(int stream, IMFMediaType type, int flags);
  [PreserveSig] int SetOutputType(int stream, IMFMediaType type, int flags);
  void _14();
  [PreserveSig] int GetOutputCurrentType(int stream, out IMFMediaType type);
  // GetInputStatus, GetOutputStatus, SetOutputBounds, ProcessEvent.
  void _16(); void _17(); void _18(); void _19();
  [PreserveSig] int ProcessMessage(int message, IntPtr parameter);
  [PreserveSig] int ProcessInput(int stream, IMFSample sample, int flags);
  [PreserveSig] int ProcessOutput(int flags, int count, ref OutputBuffer buffer, out int status);
}

[ComImport, Guid("2cd0bd52-bcd5-4b89-b62c-eadc0c031e7d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFMediaEventGenerator {
  [PreserveSig] int GetEvent(int flags, out IMFMediaEvent e);
}

[ComImport, Guid("df598932-f10c-4e39-bba2-c308f101daa3"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFMediaEvent {
  void _a00(); void _a01(); void _a02(); void _a03(); void _a04(); void _a05(); void _a06(); void _a07();
  void _a08(); void _a09(); void _a10(); void _a11(); void _a12(); void _a13(); void _a14(); void _a15();
  void _a16(); void _a17(); void _a18(); void _a19(); void _a20(); void _a21(); void _a22(); void _a23();
  void _a24(); void _a25(); void _a26(); void _a27(); void _a28(); void _a29();
  [PreserveSig] int GetEventType(out int type);
  void _31();
  [PreserveSig] int GetStatus(out int status);
}

[ComImport, Guid("97ec2ea4-0e42-4937-97ac-9d6d328824e1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMFShutdown {
  [PreserveSig] int Shutdown();
}

[ComImport, Guid("901db4c7-31ce-41a2-85dc-8fa0bf41b8da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ICodecAPI {
  // IsSupported, IsModifiable, GetParameterRange, GetParameterValues,
  // GetDefaultValue, GetValue.
  void _00(); void _01(); void _02(); void _03(); void _04(); void _05();
  [PreserveSig] int SetValue([In] ref Guid api, [In] ref object value);
}
