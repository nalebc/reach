import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { journeyNativeTool, observeJourneyNativeExec, createNativeCallRecorder, readNativeCallReports, readBoundedDiagnosticFile, safeFailureExtra } from "./helpers/journey-native-diagnostics.mjs";
import { copyPrivateAcceptanceArtifact } from "./acceptance/private-artifact.mjs";

test("journey diagnostics classify only the fixed app-catalog and file-icon commands", () => {
  const native = "C:\\private\\reach-app-icons-123456789abc-deadbeef.exe";
  assert.equal(journeyNativeTool(native, ["apps"]), "apps");
  assert.equal(journeyNativeTool(native, ["types", "folder", "pdf"]), "file-icons");
  assert.equal(journeyNativeTool(native, ["open", "private app ID"]), "app-open");
  assert.equal(journeyNativeTool(native, ["types", "../private-value"]), null);
  assert.equal(journeyNativeTool(native, ["apps", "private-value"]), null);
  assert.equal(journeyNativeTool("reach-app-icons-untrusted.exe", ["apps"]), null);
  assert.equal(journeyNativeTool("another.exe", ["types", "folder"]), null);
  const apps = ["-NoProfile", "-Command", "Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress"];
  assert.equal(journeyNativeTool("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", apps), "apps");
  assert.equal(journeyNativeTool("powershell.exe", [...apps.slice(0, 2), apps[2] + "; private-value"]), null);
  assert.equal(journeyNativeTool("another.exe", apps), null);
  const script = fs.readFileSync(new URL("../scripts/native/file-icons.ps1", import.meta.url), "utf8");
  const encoded = command => ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
  assert.equal(journeyNativeTool("powershell.exe", encoded("$types = @('folder','txt')\n" + script)), "file-icons");
  assert.equal(journeyNativeTool("powershell.exe", encoded("$types = @('private-value')\n" + script)), null);
  assert.equal(journeyNativeTool("powershell.exe", encoded("$types = @('folder')\n" + script + "\nprivate-value")), null);
});

test("the observer and its relative static script load from fresh staged bytes", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-journey-staged-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = fileURLToPath(new URL("../", import.meta.url));
  const members = ["test/helpers/journey-native-diagnostics.mjs", "scripts/native/file-icons.ps1"];
  const copied = copyPrivateAcceptanceArtifact({ source, destination: root, members });
  assert.equal(copied.files, 2);
  for (const member of members) {
    const target = path.join(root, member);
    const stagedBytes = readBoundedDiagnosticFile(target, 16384), sourceBytes = readBoundedDiagnosticFile(path.join(source, member), 16384);
    assert.ok(Buffer.isBuffer(stagedBytes) && Buffer.isBuffer(sourceBytes), "both descriptors name bounded regular files");
    assert.deepEqual(stagedBytes, sourceBytes);
  }
  assert.throws(() => copyPrivateAcceptanceArtifact({ source, destination: root, members }), /not empty/);
  const staged = await import(pathToFileURL(path.join(root, members[0])).href);
  const script = readBoundedDiagnosticFile(path.join(root, members[1]), 16384).toString("utf8");
  const encoded = text => ["-EncodedCommand", Buffer.from("$types = @('folder')\n" + text, "utf16le").toString("base64")];
  assert.equal(staged.journeyNativeTool("powershell.exe", encoded(script)), "file-icons");
  // A change to this test's own staged static asset proves classification
  // resolves beside the staged observer, with no fallback to checkout code.
  fs.writeFileSync(path.join(root, members[1]), script + "\n# owned staging control\n");
  assert.equal(staged.journeyNativeTool("powershell.exe", encoded(script)), null);
  assert.equal(staged.journeyNativeTool("powershell.exe", encoded(script + "\n# owned staging control\n")), "file-icons");
});

// Actual local Node children prove observation preserves subprocess delivery.
// The injected tool classifier is modeled; these are not Windows app lookups.
test("observation returns the exact real exec Promise and child with unchanged output", async () => {
  const events = [], actual = promisify(execFile), receiver = {};
  let pending;
  function original(...args) { assert.equal(this, receiver); return pending = actual(...args); }
  const observed = observeJourneyNativeExec(original, event => events.push(event), { classify: () => "apps" });
  const result = observed.call(receiver, process.execPath, ["-e", "process.stdout.write('private stdout');process.stderr.write('private stderr')"], { timeout: 5000 });
  assert.equal(result, pending);
  assert.equal(result.child, pending.child);
  assert.deepEqual(await result, { stdout: "private stdout", stderr: "private stderr" });
  assert.deepEqual(events.map(event => event.phase), ["started", "settled"]);
  assert.equal(events[1].code, "OK");
  assert.equal(events[1].exitCode, 0);
  assert.ok(events[1].elapsedMs >= 0);
  assert.doesNotMatch(JSON.stringify(events), /private|stdout|stderr|execPath/);
});

test("observation preserves a real failure and timeout while recording only fixed diagnostics", async () => {
  const actual = promisify(execFile);
  for (const [source, options] of [
    ["process.stdout.write('private stdout');process.stderr.write('private stderr');process.exitCode=7", { timeout: 5000 }],
    ["setTimeout(() => {}, 5000)", { timeout: 25 }],
  ]) {
    const events = [];
    let pending, nativeError;
    function original(...args) {
      pending = actual(...args);
      pending.catch(error => { nativeError = error; });
      return pending;
    }
    const observed = observeJourneyNativeExec(original, event => events.push(event), { classify: () => "file-icons" });
    const result = observed(process.execPath, ["-e", source], options);
    assert.equal(result, pending);
    await assert.rejects(result, error => {
      assert.equal(error, nativeError, "the original error object reaches the caller");
      if (options.timeout === 5000) {
        assert.equal(error.code, 7);
        assert.equal(error.stdout, "private stdout");
        assert.equal(error.stderr, "private stderr");
      } else assert.equal(error.killed, true);
      return true;
    });
    assert.equal(events[0].phase, "started");
    assert.equal(events[1].phase, "settled");
    assert.equal(events[1].code, options.timeout === 5000 ? "EXIT_NONZERO" : "CHILD_FAILED");
    if (options.timeout === 5000) assert.equal(events[1].exitCode, 7);
    else assert.equal(events[1].killed, true);
    assert.doesNotMatch(JSON.stringify(events), /private|stdout|stderr|setTimeout/);
  }
});

test("unclassified calls and evidence-write failures keep the real result", async () => {
  const actual = promisify(execFile), args = [process.execPath, ["-e", "process.stdout.write('ok')"]];
  const events = [];
  const unclassified = observeJourneyNativeExec(actual, event => events.push(event));
  assert.equal((await unclassified(...args)).stdout, "ok");
  assert.deepEqual(events, []);
  const unavailable = observeJourneyNativeExec(actual, () => { throw Error("unavailable diagnostic file"); }, { classify: () => "apps" });
  assert.equal((await unavailable(...args)).stdout, "ok");
  const noClock = observeJourneyNativeExec(actual, event => events.push(event), { classify: () => "apps", now: () => { throw Error("clock unavailable"); } });
  assert.equal((await noClock(...args)).stdout, "ok");
  assert.equal(events[1].elapsedMs, 0);
});

test("native report storage is bounded and excludes raw fields", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-journey-observer-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "native"), file = prefix + "-123.json";
  const record = createNativeCallRecorder(file);
  for (let i = 0; i < 100; i++) record({ tool: "apps", phase: "settled", elapsedMs: i, code: "ENOENT", exitCode: null,
    signal: "private-signal", stderr: "private output", args: ["private arguments"], path: "/private/user" });
  const values = readNativeCallReports(prefix);
  assert.equal(values.length, 24);
  assert.equal(values[0].signal, null);
  assert.equal(values[23].elapsedMs, 23, "the first-call evidence is retained");
  const bytes = readBoundedDiagnosticFile(file);
  assert.ok(Buffer.isBuffer(bytes) && bytes.length <= 8192);
  assert.doesNotMatch(bytes.toString("utf8"), /private|stderr|args|path/);
  fs.writeFileSync(prefix + "-456.json", "x".repeat(8193));
  assert.equal(readNativeCallReports(prefix).length, 24, "oversized or corrupt files are ignored");
});

// Actual filesystem replacement/growth at a controlled scheduling seam.
// The hooks choose the race point; this is not native Windows race proof.
test("report reads stay on one opened file when its pathname is replaced", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-report-replace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "native"), file = prefix + "-123.json";
  const record = elapsedMs => JSON.stringify([{ tool: "apps", phase: "settled", elapsedMs, code: "OK" }]);
  fs.writeFileSync(file, record(1));
  const originalOpen = fs.openSync, originalClose = fs.closeSync;
  let replaced = false, opened, closed = 0;
  const replace = () => {
    if (replaced) return;
    replaced = true;
    fs.renameSync(file, path.join(root, "held-original.json"));
    fs.writeFileSync(file, record(999));
  };
  // Replace the real pathname immediately after opening. All validation
  // and bytes must keep using that already-opened file descriptor.
  const open = t.mock.method(fs, "openSync", (at, ...args) => { const fd = originalOpen(at, ...args); if (at === file) { opened = fd; replace(); } return fd; });
  const close = t.mock.method(fs, "closeSync", fd => { if (fd === opened) closed++; return originalClose(fd); });
  let values;
  try { values = readNativeCallReports(prefix); }
  finally { open.mock.restore(); close.mock.restore(); }
  assert.equal(replaced, true);
  assert.equal(values[0]?.elapsedMs, 1, "a replacement must not substitute different checked bytes");
  assert.equal(closed, 1, "the pinned descriptor is closed");
});

test("growth after the size check is bounded and refused with its descriptor closed", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-report-growth-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const prefix = path.join(root, "native"), file = prefix + "-123.json";
  fs.writeFileSync(file, JSON.stringify([{ tool: "apps", phase: "settled", elapsedMs: 1, code: "OK" }]));
  const originalOpen = fs.openSync, originalRead = fs.readSync, originalClose = fs.closeSync;
  let grew = false, opened, closed = 0, largestRead = 0;
  const grow = () => { if (!grew) { grew = true; fs.appendFileSync(file, " ".repeat(65536)); } };
  const open = t.mock.method(fs, "openSync", (at, ...args) => { const fd = originalOpen(at, ...args); if (at === file) opened = fd; return fd; });
  const read = t.mock.method(fs, "readSync", (fd, buffer, offset, length, position) => {
    if (fd === opened) { grow(); largestRead = Math.max(largestRead, length); }
    return originalRead(fd, buffer, offset, length, position);
  });
  const close = t.mock.method(fs, "closeSync", fd => { if (fd === opened) closed++; return originalClose(fd); });
  let values;
  try { values = readNativeCallReports(prefix); }
  finally { open.mock.restore(); read.mock.restore(); close.mock.restore(); }
  assert.equal(grew, true);
  assert.deepEqual(values, [], "a growing oversized report is never accepted");
  assert.ok(largestRead > 0 && largestRead <= 8193, "at most the fixed limit plus one sentinel byte is requested");
  assert.equal(closed, 1);
});

test("screenshot failure extras allow only numeric sample and fixed target lifecycle fields", () => {
  const safe = safeFailureExtra({
    sample: { x: 1, y: 2, width: 3, height: 4, r: 255, g: NaN, b: 0, output: "private" },
    target: { ageMs: 5, alive: false, exitCode: 7, signalCode: "SIGTERM", clicks: 1, lifetimeMs: 120000, args: "private" },
    headers: "private", body: "private", error: "private",
  });
  assert.deepEqual(safe, { sample: { x: 1, y: 2, width: 3, height: 4, r: 255, g: null, b: 0 },
    target: { ageMs: 5, alive: false, exitCode: 7, signalCode: "SIGTERM", clicks: 1, lifetimeMs: 120000 } });
  assert.doesNotMatch(JSON.stringify(safe), /private|headers|body|error|output|args/);
});
