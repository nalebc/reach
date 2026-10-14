import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import {
  encodeSandboxRequest, createSandboxFrameReader, sandboxSelfTest,
  SAC_BLOCKED, POLICY_BLOCKED, HELPER_WONT_START,
} from "../server/windows-sandbox.mjs";

// A frame as scripts/native/sandbox.cs writes it: [type][uint32 BE length][payload].
const frame = (type, payload = Buffer.alloc(0)) => {
  const head = Buffer.alloc(5);
  head[0] = type.charCodeAt(0);
  head.writeUInt32BE(payload.length, 1);
  return Buffer.concat([head, payload]);
};
const beInt = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0, 0); return b; };

// A reader that mirrors the C# request parser, so the encoder is checked end to end.
function decodeRequest(buffer) {
  const total = buffer.readUInt32BE(0);
  const payload = buffer.subarray(4, 4 + total);
  const entries = [];
  let at = 0;
  while (at < payload.length) {
    const keyLen = payload.readUInt32BE(at); at += 4;
    const key = payload.subarray(at, at + keyLen).toString("utf8"); at += keyLen;
    const valLen = payload.readUInt32BE(at); at += 4;
    const value = payload.subarray(at, at + valLen).toString("utf8"); at += valLen;
    entries.push([key, value]);
  }
  return { total, entries };
}

test("the request encoder round-trips entries, repeated keys and awkward bytes", () => {
  const entries = [
    ["mode", "jobs"],
    ["command", "echo \"a & b\"\nsecond line"],
    ["grant", "C:\\Users\\me\\Projects\\acme"],
    ["grant", "C:\\Users\\me\\Projects\\other"],
    ["deny", "C:\\Users\\me\\.reach"],
  ];
  const { total, entries: back } = decodeRequest(encodeSandboxRequest(entries));
  assert.deepEqual(back, entries);
  assert.equal(total, Buffer.concat(entries.map(([k, v]) =>
    Buffer.concat([beInt(Buffer.byteLength(k)), Buffer.from(k), beInt(Buffer.byteLength(v)), Buffer.from(v)]))).length);
});

test("the frame reader splits control and data frames across arbitrary chunk boundaries", () => {
  const seen = { out: [], err: [], started: [], exit: [], refused: [] };
  const read = createSandboxFrameReader({
    onStarted: (pid) => seen.started.push(pid),
    onStdout: (b) => seen.out.push(b.toString()),
    onStderr: (b) => seen.err.push(b.toString()),
    onExit: (c) => seen.exit.push(c),
    onRefused: (r) => seen.refused.push(r),
  });
  const stream = Buffer.concat([
    frame("S", beInt(4242)),
    frame("O", Buffer.from("hello ")),
    frame("E", Buffer.from("warn")),
    frame("O", Buffer.from("world")),
    frame("X", (() => { const b = Buffer.alloc(4); b.writeInt32BE(3, 0); return b; })()),
  ]);
  for (let i = 0; i < stream.length; i += 3) read(stream.subarray(i, i + 3)); // tiny chunks
  assert.deepEqual(seen.started, [4242]);
  assert.deepEqual(seen.out, ["hello ", "world"]);
  assert.deepEqual(seen.err, ["warn"]);
  assert.deepEqual(seen.exit, [3]);
  assert.deepEqual(seen.refused, []);
});

// Finding 13: a child can only ever produce data frames. A data frame whose
// payload bytes are themselves a well-formed exit frame must be delivered as
// output, never acted on as a control frame.
test("a forged control frame inside a data frame's payload is treated as output, not control", () => {
  let exits = 0, out = null;
  const forgedExit = frame("X", (() => { const b = Buffer.alloc(4); b.writeInt32BE(0, 0); return b; })());
  const read = createSandboxFrameReader({
    onExit: () => { exits++; },
    onStdout: (b) => { out = b; },
  });
  read(frame("O", forgedExit));
  assert.equal(exits, 0, "the embedded exit bytes never fired onExit");
  assert.deepEqual(out, forgedExit, "the embedded bytes were delivered verbatim as output");
});

test("a refused frame carries its status and message", () => {
  let refused;
  const read = createSandboxFrameReader({ onRefused: (r) => { refused = r; } });
  read(frame("F", Buffer.concat([beInt(403), Buffer.from("Stay inside the selected shared folder.")])));
  assert.deepEqual(refused, { status: 403, message: "Stay inside the selected shared folder." });
});

// §2.1: the helper is C# 5 for the in-box .NET Framework compiler. A future
// edit must not silently require Roslyn.
test("the sandbox helper source uses no C# 6+ constructs", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../scripts/native/sandbox.cs", import.meta.url)), "utf8");
  for (const [pattern, what] of [
    [/\$"/, "string interpolation"],
    [/\?\./, "null-conditional member access"],
    [/\?\[/, "null-conditional indexing"],
    [/\bnameof\s*\(/, "nameof"],
    [/\busing\s+static\b/, "using static"],
    [/\bout\s+(?:var|int|uint|bool|string|byte|long|IntPtr)\b/, "inline out variable"],
  ])
    assert.ok(!pattern.test(source), `sandbox.cs must not use ${what}`);
});

const fakeChild = (emit) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.kill = () => {};
  process.nextTick(() => emit(child));
  return child;
};

test("the launch self-test passes when the helper answers, refusing otherwise with worded reasons", async () => {
  const helper = async () => ({ file: "C:\\state\\native\\reach-sandbox-abc.exe", sha256: "x" });
  const win = { platform: "win32" };
  // The OS runs it: a Started frame arrives.
  const ok = await sandboxSelfTest({
    ...win, helper,
    start: () => fakeChild((c) => c.stdout.emit("data", frame("S"))),
    run: async () => ({ stdout: "" }),
  });
  assert.deepEqual(ok, { ok: true });
  // Spawn refused by policy, with Smart App Control On: SAC wording, permanent.
  const sac = await sandboxSelfTest({
    ...win, helper,
    start: () => { throw Object.assign(new Error("spawn EACCES"), { syscall: "spawn reach-sandbox", code: "EACCES" }); },
    sac: async () => true,
  });
  assert.deepEqual(sac, { ok: false, permanent: true, reason: SAC_BLOCKED("win32") });
  // Spawn refused by policy, SAC off: the application-control wording, permanent.
  const policy = await sandboxSelfTest({
    ...win, helper,
    start: () => { throw Object.assign(new Error("spawn UNKNOWN"), { syscall: "spawn reach-sandbox", code: "UNKNOWN" }); },
    sac: async () => false,
  });
  assert.deepEqual(policy, { ok: false, permanent: true, reason: POLICY_BLOCKED("win32") });
  // It starts but exits before answering, SAC off: a non-permanent "won't start".
  const stalled = await sandboxSelfTest({
    ...win, helper,
    start: () => fakeChild((c) => c.emit("exit", 1)),
    sac: async () => false,
  });
  assert.deepEqual(stalled, { ok: false, permanent: false, reason: HELPER_WONT_START("win32") });
});
