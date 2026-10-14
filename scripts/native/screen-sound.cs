using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

// The PC's sound for a phone that listens beside its live screen
// (server/screen-sound.mjs): what Windows plays to its default output, as a
// loopback capture (WASAPI), never a microphone. The same packets as the
// Mac's helper (scripts/native/screen-sound.swift): a 4-byte big-endian
// length, then "i" and JSON {rate, channels} whenever the format is new, or
// "p" and 16-bit little-endian samples, interleaved, 20 ms each. Windows
// sends nothing while nothing plays; Reach fills that silence itself.
// C# 5: csc.exe of the .NET Framework that comes with Windows builds it.
static class ReachScreenSound
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumerator { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int context, IntPtr parameters, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
        [PreserveSig] int OpenPropertyStore(int access, out IntPtr store);
        [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint frames);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong counterPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    const int RENDER = 0, CONSOLE = 0, ALL_CONTEXTS = 23, SHARED = 0, LOOPBACK = 0x00020000;
    const uint SILENT = 0x2;
    const int NOT_FOUND = unchecked((int)0x80070490);
    const int SERVICE_NOT_RUNNING = unchecked((int)0x88890010);
    const int DEVICE_INVALIDATED = unchecked((int)0x88890004);
    const int DEVICE_IN_USE = unchecked((int)0x8889000A);
    static readonly Guid FLOAT = new Guid("00000003-0000-0010-8000-00AA00389B71");
    static readonly Guid PCM = new Guid("00000001-0000-0010-8000-00AA00389B71");
    static readonly Stream Output = Console.OpenStandardOutput();

    static void Packet(byte kind, byte[] body, int length)
    {
        int size = length + 1;
        byte[] head = { (byte)(size >> 24), (byte)(size >> 16), (byte)(size >> 8), (byte)size, kind };
        Output.Write(head, 0, 5);
        Output.Write(body, 0, length);
        Output.Flush();
    }

    static void Announce(int rate, int channels)
    {
        byte[] json = System.Text.Encoding.ASCII.GetBytes("{\"rate\":" + rate + ",\"channels\":" + channels + "}");
        Packet((byte)'i', json, json.Length);
    }

    // Said plainly on the last line, then out: Reach shows it on the phone.
    static void Fail(string text)
    {
        Console.Error.WriteLine(text);
        Console.Error.Flush();
        Environment.Exit(1);
    }

    static void Check(int result, string what)
    {
        if (result >= 0) return;
        if (result == NOT_FOUND)
            Fail("This PC has no sound output for Reach to hear. Turn on its speakers or headphones.");
        if (result == SERVICE_NOT_RUNNING)
            Fail("Windows Audio isn't running on this PC.");
        if (result == DEVICE_INVALIDATED)
            Fail("The PC's sound output changed. Reconnecting.");
        if (result == DEVICE_IN_USE)
            Fail("Another app has the PC's sound output to itself.");
        Fail("Windows couldn't capture its sound (" + what + ", 0x" + result.ToString("X8") + ").");
    }

    // 440 Hz left, 660 Hz right, 20 ms a packet, without capturing anything:
    // what the tests run, as the Mac's helper does.
    static void SelfTest(double seconds)
    {
        Announce(48000, 2);
        const int frames = 960;
        byte[] body = new byte[frames * 4];
        int t = 0;
        for (int p = 0; p < (int)(seconds * 50); p++)
        {
            for (int i = 0; i < frames; i++)
            {
                double at = (t + i) / 48000.0;
                short l = (short)(Math.Sin(2 * Math.PI * 440 * at) * 12000);
                short r = (short)(Math.Sin(2 * Math.PI * 660 * at) * 12000);
                body[i * 4] = (byte)l;
                body[i * 4 + 1] = (byte)(l >> 8);
                body[i * 4 + 2] = (byte)r;
                body[i * 4 + 3] = (byte)(r >> 8);
            }
            t += frames;
            Packet((byte)'p', body, body.Length);
        }
    }

    static IMMDevice DefaultOutput(IMMDeviceEnumerator devices)
    {
        IMMDevice device;
        Check(devices.GetDefaultAudioEndpoint(RENDER, CONSOLE, out device), "output");
        return device;
    }

    static string IdOf(IMMDevice device)
    {
        string id;
        return device.GetId(out id) >= 0 ? id : "";
    }

    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--self-test")
        {
            double seconds = 1;
            if (args.Length > 1) double.TryParse(args[1], System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out seconds);
            SelfTest(Math.Max(0.02, Math.Min(10, seconds)));
            return 0;
        }
        // Reach closes the pipe (or is gone): the capture ends with this helper.
        Thread watch = new Thread(() =>
        {
            try
            {
                Stream input = Console.OpenStandardInput();
                byte[] buffer = new byte[256];
                while (input.Read(buffer, 0, buffer.Length) > 0) { }
            }
            catch { }
            Environment.Exit(0);
        });
        watch.IsBackground = true;
        watch.Start();

        IMMDeviceEnumerator devices;
        try
        {
            devices = (IMMDeviceEnumerator)new MMDeviceEnumerator();
        }
        catch (COMException e)
        {
            Check(e.ErrorCode, "devices");
            return 1;
        }
        IMMDevice device = DefaultOutput(devices);
        string id = IdOf(device);
        Guid clientId = typeof(IAudioClient).GUID;
        object activated;
        Check(device.Activate(ref clientId, ALL_CONTEXTS, IntPtr.Zero, out activated), "activate");
        IAudioClient client = (IAudioClient)activated;
        IntPtr format;
        Check(client.GetMixFormat(out format), "format");
        int tag = (ushort)Marshal.ReadInt16(format, 0);
        int channels = (ushort)Marshal.ReadInt16(format, 2);
        int rate = Marshal.ReadInt32(format, 4);
        int block = (ushort)Marshal.ReadInt16(format, 12);
        int bits = (ushort)Marshal.ReadInt16(format, 14);
        int extra = (ushort)Marshal.ReadInt16(format, 16);
        int mask = 0;
        bool isFloat = tag == 3, isPcm = tag == 1;
        if (tag == 0xFFFE && extra >= 22)
        {
            mask = Marshal.ReadInt32(format, 20);
            byte[] sub = new byte[16];
            Marshal.Copy(new IntPtr(format.ToInt64() + 24), sub, 0, 16);
            Guid kind = new Guid(sub);
            isFloat = kind == FLOAT;
            isPcm = kind == PCM;
        }
        int size = channels > 0 ? block / channels : 0;
        if (channels < 1 || channels > 32 || rate < 8000 || rate > 384000 || size < 2
            || !((isFloat && bits == 32 && size == 4) || (isPcm && (size == 2 || size == 3 || size == 4))))
            Fail("The PC's sound came in a format Reach can't read.");
        // 200 ms of room on Windows' side; read about every 10 ms.
        Check(client.Initialize(SHARED, LOOPBACK, 2000000, 0, format, IntPtr.Zero), "start");
        Marshal.FreeCoTaskMem(format);
        Guid captureId = typeof(IAudioCaptureClient).GUID;
        object service;
        Check(client.GetService(ref captureId, out service), "capture");
        IAudioCaptureClient capture = (IAudioCaptureClient)service;
        Check(client.Start(), "start");

        // Two channels go out: a mono output in one, the front left and right
        // of more, with the center mixed into both when there is one.
        int outChannels = channels == 1 ? 1 : 2;
        bool center = channels >= 3 && (mask & 0x4) != 0;
        Announce(rate, outChannels);
        int chunk = rate / 50;
        short[] pending = new short[chunk * outChannels * 4];
        int count = 0;
        byte[] raw = new byte[0];
        byte[] body = new byte[chunk * outChannels * 2];
        DateTime checkedAt = DateTime.UtcNow;
        while (true)
        {
            Thread.Sleep(10);
            // The owner picked other speakers or headphones: Reach starts again
            // on them (this capture would stay on the old ones).
            if ((DateTime.UtcNow - checkedAt).TotalSeconds >= 2)
            {
                checkedAt = DateTime.UtcNow;
                IMMDevice now;
                if (devices.GetDefaultAudioEndpoint(RENDER, CONSOLE, out now) >= 0 && IdOf(now) != id)
                    Fail("The PC's sound output changed. Reconnecting.");
            }
            uint next;
            Check(capture.GetNextPacketSize(out next), "read");
            while (next > 0)
            {
                IntPtr data;
                uint frames, flags;
                ulong position, counter;
                Check(capture.GetBuffer(out data, out frames, out flags, out position, out counter), "read");
                int length = (int)frames * block;
                if (raw.Length < length) raw = new byte[length];
                bool silent = (flags & SILENT) != 0;
                if (!silent && length > 0) Marshal.Copy(data, raw, 0, length);
                for (int i = 0; i < (int)frames; i++)
                {
                    if (count + outChannels > pending.Length)
                    {
                        short[] grown = new short[pending.Length * 2];
                        Array.Copy(pending, grown, count);
                        pending = grown;
                    }
                    for (int c = 0; c < outChannels; c++)
                    {
                        double v = silent ? 0 : Sample(raw, i * block + c * size, size, isFloat);
                        if (center && !silent) v += 0.7071 * Sample(raw, i * block + 2 * size, size, isFloat);
                        if (v > 1) v = 1;
                        if (v < -1) v = -1;
                        pending[count++] = (short)(v * 32767);
                    }
                }
                Check(capture.ReleaseBuffer(frames), "read");
                int whole = chunk * outChannels;
                int sent = 0;
                while (count - sent >= whole)
                {
                    for (int i = 0; i < whole; i++)
                    {
                        body[i * 2] = (byte)pending[sent + i];
                        body[i * 2 + 1] = (byte)(pending[sent + i] >> 8);
                    }
                    Packet((byte)'p', body, whole * 2);
                    sent += whole;
                }
                if (sent > 0)
                {
                    Array.Copy(pending, sent, pending, 0, count - sent);
                    count -= sent;
                }
                Check(capture.GetNextPacketSize(out next), "read");
            }
        }
    }

    // One sample, -1 to 1: float, or 16-, 24- or 32-bit integer.
    static double Sample(byte[] raw, int at, int size, bool isFloat)
    {
        if (isFloat) return BitConverter.ToSingle(raw, at);
        if (size == 2) return BitConverter.ToInt16(raw, at) / 32768.0;
        if (size == 3) return ((raw[at] << 8) | (raw[at + 1] << 16) | (raw[at + 2] << 24)) / 2147483648.0;
        return BitConverter.ToInt32(raw, at) / 2147483648.0;
    }
}
