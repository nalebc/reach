// Reach's sandbox host on Windows (server/windows-sandbox.mjs,
// docs/parity/C-sandbox.md): one short-lived process per operation that runs
// an agent's or invited person's command, the Full-control shell, an approved
// script, or one protected file operation, inside the confinement its mode
// asks for. The Mac does this with sandbox-exec and a descriptor-confined
// Swift helper (scripts/native/browser-files.swift); Windows has no
// allow-default file sandbox, so each surface gets the mechanism that matches
// its Mac policy: a Job Object on the owner's token for the Full-control shell;
// a regular AppContainer plus a Job Object for jobs; an LPAC AppContainer plus
// a one-process Job Object for scripts; and, for the Files helper, this process
// on the owner's token doing NT handle-relative I/O that follows no reparse
// point (no AppContainer, matching the Mac's descriptor discipline).
//
// Built and launched through workstream A's windowsBinary/spawnVerified into a
// folder Reach made private this launch, its SHA-256 re-checked before every
// spawn. Compiled with the in-box .NET Framework 4.x csc.exe, so C# 5 only (no
// string interpolation, no null-conditional operator, no expression-bodied
// members, no inline out variables); mscorlib and System alone (the shared
// REFERENCES list has no JSON library, so the protocol is hand-framed).
//
//   sandbox.exe selftest     answer whether the OS lets the helper run, then exit
//   sandbox.exe run          read one framed request on stdin and carry it out
//
// Protocol (server/windows-sandbox.mjs is the other end):
//   Request  (stdin):  [uint32 BE length][payload]; payload is a list of
//                      entries, each [uint32 BE keyLen][key][uint32 BE valLen]
//                      [value] (UTF-8). A repeated key is a list. stdin then
//                      stays open as the end-of-input lifeline: its EOF aborts.
//   Response (stdout): a stream of frames, each [1 type byte][uint32 BE length]
//                      [payload]. The child the helper launches inherits only
//                      pipe handles the helper owns (never this stdout), so a
//                      child's bytes can only ever become 'O'/'E' data frames;
//                      it can't forge an 'X'/'R'/'F' control frame.
//     'S' started    (payload: the child's pid, 4 bytes BE, when there is one)
//     'O' / 'E'      child stdout / stderr bytes, relayed verbatim
//     'X' exit       (payload: the main process's exit code, 4 bytes BE signed)
//     'R' result     (payload: a UTF-8 JSON object, for file operations)
//     'F' refused    (payload: [uint32 BE status][UTF-8 message])
using System;
using System.IO;
using System.Collections.Generic;
using System.Text;

static class Sandbox {
  // Frame types on the wire to Node. One byte each.
  const byte FrameStarted = (byte)'S';
  const byte FrameStdout = (byte)'O';
  const byte FrameStderr = (byte)'E';
  const byte FrameExit = (byte)'X';
  const byte FrameResult = (byte)'R';
  const byte FrameRefused = (byte)'F';

  // A refusal that carries an HTTP-shaped status, so the Node side can keep the
  // same wording and codes the Mac helper returns. The message never contains a
  // secret value (vault fills are blacked out well before they reach here).
  class Refused : Exception {
    public readonly int Status;
    public Refused(int status, string message) : base(message) { Status = status; }
  }

  static readonly object WriteLock = new object();
  static Stream Out;

  static int Main(string[] args) {
    // One byte at a time would be slow; frames are written whole under a lock.
    Out = Console.OpenStandardOutput();
    try {
      if (args.Length == 1 && args[0] == "selftest") {
        // The no-op launch self-test (docs/parity/C-sandbox.md §2.2): simply
        // starting and answering proves the operating system lets Reach's
        // already-hash-verified helper run here. Whether a sandboxed child can
        // then start is the runtime probe's job, not this one's.
        WriteControl(FrameStarted, new byte[0]);
        return 0;
      }
      if (args.Length == 1 && args[0] == "run") {
        Request request = ReadRequest(Console.OpenStandardInput());
        return Run(request);
      }
      // Unknown invocation: say so in the same framed channel and stop. Never
      // fall back to running anything (plan rule 2, fail closed).
      Refuse(new Refused(400, "Unknown sandbox request."));
      return 2;
    } catch (Refused refused) {
      Refuse(refused);
      return 1;
    } catch (Exception error) {
      Refuse(new Refused(503, "The sandbox helper could not complete the request: " + Short(error.Message)));
      return 1;
    }
  }

  // The request the Node side framed on stdin, parsed into single values and
  // lists. Keeping both lets a value appear once (mode, command) or many times
  // (grants, denies, argv) with no ambiguity.
  class Request {
    readonly Dictionary<string, List<string>> fields = new Dictionary<string, List<string>>(StringComparer.Ordinal);
    public void Add(string key, string value) {
      List<string> list;
      if (!fields.TryGetValue(key, out list)) { list = new List<string>(); fields[key] = list; }
      list.Add(value);
    }
    public string Get(string key) {
      List<string> list;
      if (fields.TryGetValue(key, out list) && list.Count > 0) return list[list.Count - 1];
      return null;
    }
    public string Get(string key, string fallback) {
      string value = Get(key);
      return value == null ? fallback : value;
    }
    public List<string> List(string key) {
      List<string> list;
      if (fields.TryGetValue(key, out list)) return list;
      return new List<string>();
    }
    public int Int(string key, int fallback) {
      string value = Get(key);
      int parsed;
      if (value != null && int.TryParse(value, out parsed)) return parsed;
      return fallback;
    }
  }

  static int Run(Request request) {
    string mode = request.Get("mode", "");
    // Each mode is built in its own slice (docs/parity/C-sandbox.md §3). Until a
    // mode is wired on both sides it refuses rather than running anything.
    switch (mode) {
      default:
        throw new Refused(400, "This sandbox mode is not available on this computer.");
    }
  }

  // Read exactly `count` bytes or throw: a short read means the pipe closed
  // mid-frame, which is never a valid request.
  static byte[] ReadExactly(Stream stream, int count) {
    byte[] buffer = new byte[count];
    int read = 0;
    while (read < count) {
      int got = stream.Read(buffer, read, count - read);
      if (got <= 0) throw new Refused(400, "The sandbox request ended early.");
      read += got;
    }
    return buffer;
  }

  static int ReadUInt32(Stream stream) {
    byte[] four = ReadExactly(stream, 4);
    return BeInt(four, 0);
  }

  static int BeInt(byte[] bytes, int offset) {
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3];
  }

  // The one length-prefixed request frame, parsed into entries. A length is
  // bounded so a wrong prefix can't ask the helper to allocate the world.
  static Request ReadRequest(Stream stdin) {
    int total = ReadUInt32(stdin);
    if (total < 0 || total > 8 * 1024 * 1024) throw new Refused(400, "The sandbox request is too large.");
    byte[] payload = ReadExactly(stdin, total);
    Request request = new Request();
    int at = 0;
    while (at < payload.Length) {
      if (at + 4 > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      int keyLen = BeInt(payload, at); at += 4;
      if (keyLen < 0 || at + keyLen > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      string key = Encoding.UTF8.GetString(payload, at, keyLen); at += keyLen;
      if (at + 4 > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      int valLen = BeInt(payload, at); at += 4;
      if (valLen < 0 || at + valLen > payload.Length) throw new Refused(400, "The sandbox request is malformed.");
      string value = Encoding.UTF8.GetString(payload, at, valLen); at += valLen;
      request.Add(key, value);
    }
    return request;
  }

  // A frame on stdout. Child output is wrapped the same way, so a child cannot
  // write a byte the Node side will read as a control frame.
  static void WriteControl(byte type, byte[] payload) {
    lock (WriteLock) {
      byte[] header = new byte[5];
      header[0] = type;
      int length = payload.Length;
      header[1] = (byte)((length >> 24) & 0xff);
      header[2] = (byte)((length >> 16) & 0xff);
      header[3] = (byte)((length >> 8) & 0xff);
      header[4] = (byte)(length & 0xff);
      Out.Write(header, 0, header.Length);
      if (length > 0) Out.Write(payload, 0, length);
      Out.Flush();
    }
  }

  static void Refuse(Refused refused) {
    byte[] message = Encoding.UTF8.GetBytes(refused.Message ?? "Refused.");
    byte[] payload = new byte[4 + message.Length];
    int status = refused.Status;
    payload[0] = (byte)((status >> 24) & 0xff);
    payload[1] = (byte)((status >> 16) & 0xff);
    payload[2] = (byte)((status >> 8) & 0xff);
    payload[3] = (byte)(status & 0xff);
    Array.Copy(message, 0, payload, 4, message.Length);
    WriteControl(FrameRefused, payload);
  }

  static string Short(string text) {
    if (text == null) return "";
    text = text.Replace("\r", " ").Replace("\n", " ");
    return text.Length > 300 ? text.Substring(0, 300) : text;
  }
}
