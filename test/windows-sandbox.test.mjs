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
    // Inline out variables are C# 7; `out var` is the unambiguous marker (a
    // typed `out IntPtr x` is legal C# 5 in a P/Invoke signature).
    [/\bout\s+var\b/, "inline out variable"],
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

import { windowsGrantRoots, windowsJobDenies, windowsJobSandbox, windowsJobReads, windowsShellInvocation } from "../server/windows-sandbox.mjs";

const WIN = { home: "C:\\Users\\me", platform: "win32", env: {} };

test("jobs and script grants refuse drive-root, Home and Home-ancestor roots (findings 1, 2)", () => {
  for (const [root, why] of [["C:\\", /whole drive/], ["c:\\", /whole drive/], ["C:\\Users\\me", /home folder/], ["C:\\Users", /home folder/]])
    assert.throws(() => windowsGrantRoots([root], WIN), (e) => e.status === 403 && why.test(e.message), root);
  // A project folder inside Home is granted, returned canonicalised.
  assert.deepEqual(windowsGrantRoots(["C:\\Users\\me\\Projects\\acme"], WIN), ["c:\\users\\me\\projects\\acme"]);
  // One bad root refuses the whole grant, naming nothing of the others.
  assert.throws(() => windowsGrantRoots(["C:\\Users\\me\\Projects\\acme", "D:\\"], WIN), { status: 403 });
});

test("the jobs deny set mirrors the Mac's read/write lists and omits in-root private names (finding 5)", () => {
  const config = { dataDir: "C:\\Users\\me\\.reach\\quick", agentPolicyFile: "C:\\Users\\me\\.reach\\policy.json", roots: ["C:\\Users\\me"] };
  const denies = windowsJobDenies(config, WIN);
  assert.ok(denies.some((d) => /\.reach\\quick$/i.test(d)), "Reach's data is denied");
  assert.ok(denies.some((d) => /Microsoft\\Credentials$/i.test(d)), "Windows credentials are denied");
  assert.ok(denies.some((d) => /Google$/i.test(d)), "browser sessions are denied");
  assert.ok(denies.some((d) => /Programs\\Startup$/i.test(d)), "startup programs are denied");
  assert.ok(!denies.some(d => /\\AppData$/i.test(d)), "the tool installations in AppData can be read");
  assert.ok(denies.some((d) => /System32\\config$/i.test(d)), "the Windows password database is denied");
  // The finding-5 distinction: an in-root .git / .npmrc is NOT denied, so git
  // and npm keep working inside a shared folder as they do on the Mac.
  assert.ok(!denies.includes("C:\\Users\\me\\Projects\\acme\\.git"), "an in-root .git is not denied");
  assert.ok(!denies.includes("C:\\Users\\me\\Projects\\acme\\.npmrc"), "an in-root .npmrc is not denied");
});

test("jobs can read named tool directories but an environment variable cannot grant a secret directory", () => {
  const config = { dataDir: String.raw`C:\Users\me\.reach` };
  const reads = windowsJobReads(config, { ...WIN, exists: () => true });
  for (const end of [String.raw`AppData\Local\npm-cache`, String.raw`AppData\Roaming\npm`, ".gitconfig", ".cargo", ".dotnet"])
    assert.ok(reads.some(item => item.endsWith(end.toLowerCase())), end);
  const evil = windowsJobReads(config, { ...WIN, exists: () => true,
    env: { VOLTA_HOME: String.raw`C:\Users\me\.ssh`, TEMP: String.raw`C:\Users\me\.reach` } });
  assert.ok(!evil.some(item => /\\(?:\.ssh|\.reach)$/.test(item)));
});

test("PowerShell receives Unicode command text as one encoded argument; cmd keeps its own syntax", () => {
  const command = "Write-Output 'café 日本'; Write-Output '$()'";
  const invoked = windowsShellInvocation("powershell", command);
  assert.equal(invoked.command, null);
  assert.match(Buffer.from(invoked.args.at(-1), "base64").toString("utf16le"), /café 日本/);
  assert.deepEqual(windowsShellInvocation("cmd", "echo %USERNAME%"), { command: "echo %USERNAME%", args: null });
});

test("the jobs descriptor carries grants, the mirror denies, internet and a fork-bomb cap", () => {
  const config = { dataDir: "C:\\Users\\me\\.reach\\quick", roots: ["C:\\Users\\me"] };
  const client = { agentRoots: ["C:\\Users\\me\\Projects\\acme"] };
  const d = windowsJobSandbox(config, client, WIN);
  assert.equal(d.mode, "jobs");
  assert.equal(d.network, "internet");
  assert.deepEqual(d.capabilities, ["internetClient"]);
  assert.deepEqual(d.grants, [{ root: "c:\\users\\me\\projects\\acme", access: "rw" }]);
  assert.equal(d.limits.memoryBytes, 0, "no fixed memory cap beyond a runaway guard");
  assert.ok(d.denies.length > 0);
  // A client whose only root is Home is refused here (the §10 parity break).
  assert.throws(() => windowsJobSandbox(config, { agentRoots: ["C:\\Users\\me"] }, WIN), { status: 403 });
});

import os from "node:os";
import path from "node:path";
import { Jobs } from "../server/jobs.mjs";

const until = async (check, ms = 4000) => { const end = Date.now() + ms; while (!check()) { if (Date.now() > end) throw Error("timed out"); await new Promise((r) => setTimeout(r, 20)); } };

test("a Windows job runs through the helper: the framed request carries the grant, and frames drive output and exit", async (t) => {
  const realPlatform = process.platform;
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-jobs-win-"));
  const jobs = new Jobs({ dataDir: dir });
  t.after(() => { jobs.dispose(); fs.rmSync(dir, { recursive: true, force: true }); Object.defineProperty(process, "platform", { value: realPlatform, configurable: true }); });

  let child;
  const written = [];
  const spawnHelper = () => {
    child = new EventEmitter();
    child.pid = 4242;
    child.stdin = { write: (b) => { written.push(b); return true; }, end() {}, writable: true };
    child.stdout = new EventEmitter();
    child.kill = () => {};
    return child;
  };
  // cmd runs the command verbatim; the owner's shell is injected so the
  // framing is deterministic off Windows (windowsShell reads the host otherwise).
  const sandbox = { mode: "jobs", client: "agent", interpreter: { file: "C:\\Windows\\System32\\cmd.exe", kind: "cmd" }, grants: [{ root: "C:\\Users\\me\\Projects\\acme", access: "rw" }], reads: [{ root: "C:\\Users\\me\\AppData\\Local\\Temp", access: "ro" }], denies: ["C:\\Users\\me\\.reach"], network: "internet", capabilities: ["internetClient"], loopback: [{ address: "127.0.0.1", port: 8443 }], limits: { activeProcesses: 512 } };
  const job = jobs.start({ command: "echo hi", cwd: "C:\\Users\\me\\Projects\\acme", timeoutMs: 60000 }, "agent",
    { sandbox, helper: { file: "C:\\state\\native\\reach-sandbox.exe", sha256: "abc" }, spawnHelper });

  // The framed request the helper receives carries the mode, the grant, the
  // read, the deny, the loopback target and the command verbatim.
  const { entries } = decodeRequest(Buffer.concat(written));
  assert.ok(entries.some(([k, v]) => k === "mode" && v === "jobs"));
  assert.ok(entries.some(([k, v]) => k === "grant" && /acme/i.test(v)));
  assert.ok(entries.some(([k, v]) => k === "read" && /Temp/i.test(v)));
  assert.ok(entries.some(([k, v]) => k === "deny" && /\.reach/i.test(v)));
  assert.ok(entries.some(([k, v]) => k === "loopback" && v === "127.0.0.1:8443"));
  assert.ok(entries.some(([k, v]) => k === "command" && v === "echo hi"));
  assert.ok(entries.some(([k, v]) => k === "interpreter" && /cmd\.exe$/i.test(v)));
  assert.ok(entries.some(([k, v]) => k === "interpreterKind" && v === "cmd"));

  // Frames drive the job: started, output, then the main process's exit code.
  child.stdout.emit("data", frame("S", beInt(4242)));
  child.stdout.emit("data", frame("O", Buffer.from("hi\n")));
  const exit = Buffer.alloc(4); exit.writeInt32BE(0, 0);
  child.stdout.emit("data", frame("X", exit));
  child.emit("close", 0);
  await until(() => job.status !== "running");
  assert.equal(job.status, "completed");
  assert.equal(job.exitCode, 0);
  assert.match(job.output, /hi/);

  // Without a helper, a Windows sandboxed job refuses rather than running.
  assert.throws(() => jobs.start({ command: "echo hi", cwd: "C:\\x", timeoutMs: 1000 }, "agent", { sandbox }), { status: 503 });
});

import { windowsShellRunner } from "../server/windows-sandbox.mjs";

const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n, 0); return b; };
const shellChild = (written) => {
  const child = new EventEmitter();
  child.pid = 99;
  child.stdin = { write: (b) => { written.push(b); return true; }, end() {}, writable: true };
  child.stdout = new EventEmitter();
  child.kill = () => {};
  return child;
};
const readyStub = { ready: async () => ({ ok: true, built: { file: "C:\\native\\reach-sandbox.exe", sha256: "z" } }) };

test("the Full-control shell runner frames a shell request and reports output and exit", async () => {
  const written = [];
  let child;
  const interpreter = { file: String.raw`C:\Windows\System32\cmd.exe`, kind: "cmd" };
  const run = windowsShellRunner(readyStub, { interpreter, start: () => (child = shellChild(written)) });
  const promise = run({ command: "dir", cwd: "C:\\Users\\me", timeoutMs: 5000, maxOutput: 1024, signal: new AbortController().signal });
  await until(() => !!child);
  const { entries } = decodeRequest(Buffer.concat(written));
  assert.ok(entries.some(([k, v]) => k === "mode" && v === "shell"));
  assert.ok(entries.some(([k, v]) => k === "command" && v === "dir"));
  assert.ok(entries.some(([k, v]) => k === "interpreter" && v === interpreter.file));
  child.stdout.emit("data", frame("O", Buffer.from("Volume in drive C")));
  child.stdout.emit("data", frame("X", i32(0)));
  assert.deepEqual(await promise, { output: "Volume in drive C", exitCode: 0, timedOut: false });
});

test("the shell runner times out and surfaces a refusal frame", async () => {
  // A command that never exits times out (the Job Object reaps the tree).
  const timedOut = await windowsShellRunner(readyStub, { start: () => shellChild([]) })({ command: "pause", cwd: "C:\\x", timeoutMs: 40, maxOutput: 1024, signal: new AbortController().signal });
  assert.equal(timedOut.timedOut, true);
  // A refusal frame from the helper rejects with its status.
  let child;
  const promise = windowsShellRunner(readyStub, { start: () => (child = shellChild([])) })({ command: "x", cwd: "C:\\x", timeoutMs: 5000, maxOutput: 1024, signal: new AbortController().signal });
  await until(() => !!child);
  child.stdout.emit("data", frame("F", Buffer.concat([(() => { const b = Buffer.alloc(4); b.writeUInt32BE(403, 0); return b; })(), Buffer.from("Command access changed.")])));
  await assert.rejects(promise, (e) => e.status === 403);
});

test("the shell runner aborts on its revocation signal", async () => {
  const controller = new AbortController();
  let child;
  const promise = windowsShellRunner(readyStub, { start: () => (child = shellChild([])) })({ command: "sleep", cwd: "C:\\x", timeoutMs: 5000, maxOutput: 1024, signal: controller.signal });
  await until(() => !!child);
  const reason = Object.assign(new Error("Command access changed."), { status: 403 });
  controller.abort(reason);
  await assert.rejects(promise, (e) => e === reason);
});

test("reach_shell's description stays the Mac's wording on macOS and names the Job Object on Windows", () => {
  const source = fs.readFileSync(fileURLToPath(new URL("../server/browser-tools.mjs", import.meta.url)), "utf8");
  assert.match(source, /macOS permissions still apply\./, "the Mac wording is unchanged");
  assert.match(source, /Runs inside a Job Object as the owner's Windows account\./, "Windows names the Job Object");
});

import { createWindowsGrantLedger, revokeRequestEntries } from "../server/windows-sandbox.mjs";

test("the grants ledger revokes a client's roots and sweeps gone or expired grants (§4.6)", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-grant-ledger-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const revoked = [];
  const ledger = createWindowsGrantLedger({ dir, revoke: async (roots) => revoked.push(roots), now: () => 1000 });
  ledger.record({ clientId: "a", roots: ["c:\\users\\me\\a"], expiresAt: 500 }); // already expired
  ledger.record({ clientId: "b", roots: ["c:\\users\\me\\b"], expiresAt: 0 });   // no expiry
  // Revoking a client walks exactly its roots and forgets its entry.
  await ledger.revokeClient("b");
  assert.deepEqual(revoked, [["c:\\users\\me\\b"]]);
  // The sweep reclaims a gone client and an expired grant, keeping live ones.
  ledger.record({ clientId: "c", roots: ["c:\\users\\me\\c"], expiresAt: 0 });
  await ledger.sweep((id) => id === "c"); // a is live-but-expired and gets swept; c stays
  assert.deepEqual(revoked, [["c:\\users\\me\\b"], ["c:\\users\\me\\a"]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "windows-sandbox", "grants.json"), "utf8")).map((e) => e.clientId), ["c"]);
  assert.deepEqual(revokeRequestEntries(["c:\\x"]), [["mode", "revoke"], ["grant", "c:\\x"]]);
});
