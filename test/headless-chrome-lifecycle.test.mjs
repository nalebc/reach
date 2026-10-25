import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { launchChrome } from "./helpers/headless-chrome.mjs";
import { parseWindowsBrokerProgress, prepareWindowsBrowserBroker, verifyPreparedBrowserBroker, windowsBrokerStatusDetails, windowsBrowserProcess } from "./helpers/windows-browser-lifetime.mjs";

let preparedBroker, diagnosticRemaining = 16384;
test.before(async t => {
  if (process.platform !== "win32") return;
  const began = performance.now();
  preparedBroker = await prepareWindowsBrowserBroker({ signal: t.signal, onStage(stage, details) {
    const line = JSON.stringify({ stage, phase: "preparation", elapsedMs: Math.round(performance.now() - began), ...details }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > diagnosticRemaining) return;
    diagnosticRemaining -= bytes;
    process.stderr.write(line);
  } });
}, { timeout: 120000 });

// Model a browser whose parent exits before its inherited protocol pipes
// close. No real Chrome, process group or operating-system signal is used.
async function controlledBrowser(t, { closePipes = false, answerClose = true, confirmStopped = true } = {}) {
  const hooks = [], requests = [], terminations = [], child = new EventEmitter();
  const output = new PassThrough();
  let profile, exited = false, closed = false;
  const exit = () => {
    if (exited) return;
    exited = true;
    child.exitCode = 0;
    child.emit("exit", 0, null);
    if (closePipes) finish();
  };
  const finish = () => {
    if (closed) return;
    closed = true;
    output.end();
    child.emit("close", child.exitCode, child.signalCode);
  };
  child.pid = 123456789;
  child.exitCode = child.signalCode = null;
  child.stderr = new PassThrough();
  child.stdio = [null, null, child.stderr, new Writable({
    write(bytes, _encoding, done) {
      const request = JSON.parse(bytes.toString().replace(/\0$/, ""));
      requests.push(request.method);
      if ((request.method === "Browser.close" && !answerClose) || request.method === "Unanswered.call") return done();
      queueMicrotask(() => {
        output.write(JSON.stringify({ id: request.id, result: { product: "controlled browser" } }) + "\0");
        if (request.method === "Browser.close") exit();
      });
      done();
    },
  }), output];
  child.kill = () => { queueMicrotask(exit); return true; };
  child.unref = () => {};
  const launchProcess = (_binary, flags) => {
    profile = flags.find(flag => flag.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    fs.mkdirSync(path.join(profile, "Default"));
    fs.writeFileSync(path.join(profile, "Default", "active"), "owned browser state");
    return {
      child,
      async terminate(limit) {
        assert.equal(limit, 2000);
        terminations.push(process.platform === "win32" ? "owned-job-model" : "group-model");
        child.kill("SIGKILL");
      },
      assertStopped() { if (!confirmStopped) throw Error("controlled owned-tree confirmation missing"); },
      snapshot: () => ({ owner: "modeled", confirmed: confirmStopped }),
    };
  };
  const browser = await launchChrome({ after: hook => hooks.push(hook) }, { binary: "controlled-browser", launchProcess });
  return { browser, requests, terminations, profile, finish,
    async dispose() {
      exit(); finish();
      await Promise.allSettled(hooks.map(hook => hook()));
      t.mock.restoreAll();
      fs.rmSync(profile, { recursive: true, force: true });
    },
  };
}

test("browser close is shared and waits for inherited pipes before deleting its profile", { timeout: 5000 }, async t => {
  const f = await controlledBrowser(t);
  let first, second;
  try {
    first = f.browser.close();
    second = f.browser.close();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(await fs.promises.readFile(path.join(f.profile, "Default", "active"), "utf8"), "owned browser state", "parent exit alone must not remove a profile still held by browser children");
    assert.equal(first, second, "explicit cleanup and the test hook share one shutdown");
    assert.equal(f.requests.filter(method => method === "Browser.close").length, 1, "ask Chrome to stop its children before forcing termination");
    f.finish();
    await first;
    await assert.rejects(fs.promises.stat(f.profile), { code: "ENOENT" });
  } finally {
    f.finish();
    await Promise.allSettled([first, second]);
    await f.dispose();
  }
});

test("an unresponsive browser has a bounded owned-process fallback and retires unanswered calls", { timeout: 5000 }, async t => {
  const f = await controlledBrowser(t, { closePipes: true, answerClose: false });
  try {
    const pending = assert.rejects(f.browser.send("Unanswered.call"), /Chrome exited/);
    // Close deliberately goes unanswered so the helper must enforce its
    // real two-second deadline and reject earlier outstanding protocol work.
    await f.browser.close();
    await pending;
    assert.deepEqual(f.terminations, [process.platform === "win32" ? "owned-job-model" : "group-model"]);
    await assert.rejects(fs.promises.stat(f.profile), { code: "ENOENT" });
    await assert.rejects(f.browser.send("After.close"), /Chrome exited/);
  } finally { await f.dispose(); }
});

test("closed pipes cannot replace the owned-tree termination confirmation", { timeout: 5000 }, async t => {
  const f = await controlledBrowser(t, { closePipes: true, confirmStopped: false });
  try {
    const first = f.browser.close();
    await assert.rejects(first, /owned-tree confirmation missing/);
    assert.equal(f.browser.close(), first, "the failed confirmation remains visible to every close caller");
    assert.equal(await fs.promises.readFile(path.join(f.profile, "Default", "active"), "utf8"), "owned browser state");
  } finally { await f.dispose(); }
});

test("a permanent profile cleanup error remains visible and shutdown is not repeated", { timeout: 5000 }, async t => {
  const f = await controlledBrowser(t, { closePipes: true });
  const failure = Object.assign(Error("controlled profile removal failure"), { code: "ENOTEMPTY" });
  let removals = 0;
  const remove = () => { removals++; throw failure; };
  t.mock.method(fs, "rmSync", remove);
  t.mock.method(fs.promises, "rm", async () => remove());
  try {
    const first = f.browser.close();
    await assert.rejects(first, error => error === failure);
    const second = f.browser.close();
    const rejection = assert.rejects(second, error => error === failure);
    assert.equal(second, first);
    await rejection;
    assert.equal(removals, 1, "a repeated hook must preserve the original cleanup error without another profile deletion");
  } finally { await f.dispose(); }
});

// A real failed child launch must retire CDP timers and cleanup hooks. The
// subprocess must exit naturally; an unanswered 20 s call used to retain it.
const failedStartStages = new Set(["script-entered", "handshake-begin", "native-owner-setup-begin", "prepared-broker-check-begin", "prepared-broker-verified", "prepared-broker-refused", "broker-spawn-begin", "broker-spawn-returned", "native-owner-setup-returned", "broker-progress", "broker-status", "child-exit", "child-close", "child-deadline", "handshake-refused", "cleanup-hook-begin", "cleanup-hook-end", "retired"]);
const timingInteger = value => Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff;
function failedStartTiming(line) {
  if (line.length > 1500) return null;
  let value; try { value = JSON.parse(line); } catch { return null; }
  if (!value || !failedStartStages.has(value.stage) || !timingInteger(value.elapsedMs)) return null;
  const result = { childStage: value.stage, childElapsedMs: value.elapsedMs };
  for (const key of ["pid", "index", "bytes", "hookCount"])
    if (timingInteger(value[key])) result[key] = value[key];
  for (const key of ["refused", "ownerReturned"])
    if (typeof value[key] === "boolean") result[key] = value[key];
  if (value.exitCode === null || timingInteger(value.exitCode)) result.exitCode = value.exitCode;
  if ([null, "SIGTERM", "SIGKILL", "SIGABRT", "SIGSEGV"].includes(value.signalCode)) result.signalCode = value.signalCode;
  if (Array.isArray(value.pipes)) result.pipes = value.pipes.slice(0, 5).map(pipe => ({
    readableEnded: pipe?.readableEnded === true, writableEnded: pipe?.writableEnded === true, destroyed: pipe?.destroyed === true,
  }));
  if (value.ownedTree?.owner === "windows-job") result.ownedTree = {
    owner: "windows-job", protocolError: value.ownedTree.protocolError !== null,
    events: Array.isArray(value.ownedTree.events) ? value.ownedTree.events.slice(-4).map(windowsBrokerStatusDetails).filter(Boolean) : [],
  };
  const progress = parseWindowsBrokerProgress({ kind: "progress", stage: value.nativeStage, elapsedMs: value.nativeElapsedMs });
  if (progress && ["stderr", "status"].includes(value.channel)) Object.assign(result, { nativeStage: progress.stage, nativeElapsedMs: progress.elapsedMs, channel: value.channel });
  if (value.stage === "broker-status") Object.assign(result, windowsBrokerStatusDetails({ ...value, kind: value.nativeKind, stage: value.nativeStage, elapsedMs: value.nativeElapsedMs }));
  return result;
}

test("failed browser startup releases protocol calls and exits naturally after cleanup", { timeout: 15000 }, async t => {
  const helper = new URL("./helpers/headless-chrome.mjs", import.meta.url).href;
  const windowsOwner = new URL("./helpers/windows-browser-lifetime.mjs", import.meta.url).href;
  const guard = new URL("./helpers/runaway-guard.mjs", import.meta.url).href;
  const parentBudget = Math.min(6144, diagnosticRemaining);
  const reserve = Math.min(1024, parentBudget);
  const script = `
    import { launchChrome } from ${JSON.stringify(helper)};
    import { windowsBrowserProcess } from ${JSON.stringify(windowsOwner)};
    const hooks = [];
    const began = performance.now();
    let remaining = ${Math.max(0, diagnosticRemaining - parentBudget)}, owner;
    const mark = (stage, details = {}) => {
      const base = { stage, elapsedMs: Math.round(performance.now() - began) };
      let line = JSON.stringify({ ...base, ...details });
      if (line.length > 1500) line = JSON.stringify({ ...base, details: line.slice(0, 1000), truncated: true });
      const bytes = Buffer.byteLength(line) + 1;
      if (bytes > remaining) return;
      remaining -= bytes;
      process.stderr.write(line + "\\n");
    };
    const snapshot = () => {
      if (!owner) return { ownerReturned: false };
      const child = owner.child, tree = owner.snapshot?.();
      return {
        pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
        pipes: [child.stdin, child.stderr, child.stdio[3], child.stdio[4], child.stdio[5]].map(pipe => ({
          readableEnded: pipe?.readableEnded === true, writableEnded: pipe?.writableEnded === true, destroyed: pipe?.destroyed === true,
        })),
        ...(tree ? { ownedTree: { owner: tree.owner, protocolError: tree.protocolError, events: tree.events?.slice(-4) } } : {}),
      };
    };
    const deadline = setTimeout(() => mark("child-deadline", { hookCount: hooks.length, ...snapshot() }), 8000);
    deadline.unref();
    mark("script-entered", { platform: process.platform, arch: process.arch });
    const options = { binary: process.execPath };
    if (process.platform === "win32") {
      const preparedBroker = JSON.parse(process.env.REACH_TEST_PREPARED_BROWSER_BROKER || "null");
      delete process.env.REACH_TEST_PREPARED_BROWSER_BROKER;
      if (!preparedBroker) throw Error("The parent did not prepare its Windows browser broker");
      options.launchProcess = async (binary, flags) => {
        mark("native-owner-setup-begin");
        owner = await windowsBrowserProcess(binary, flags, { onStage: mark, preparedBroker });
        mark("native-owner-setup-returned", snapshot());
        owner.child.once("exit", () => mark("child-exit", snapshot()));
        owner.child.once("close", () => mark("child-close", snapshot()));
        return owner;
      };
    }
    let refused = false;
    try {
      mark("handshake-begin");
      await launchChrome({ after: (fn) => hooks.push(fn) }, options);
    } catch (error) {
      refused = error instanceof Error;
      mark("handshake-refused", { refused, ...snapshot() });
    }
    for (const [index, close] of hooks.entries()) {
      mark("cleanup-hook-begin", { index, ...snapshot() });
      await close();
      mark("cleanup-hook-end", { index, ...snapshot() });
    }
    if (!refused) throw Error("The non-browser must fail its handshake");
    clearTimeout(deadline);
    mark("retired", snapshot());
    process.stdout.write("retired\\n");
  `;
  // This clock starts before execFile. Arrival includes spawn/startup AND pipe
  // delivery/parent scheduling; it is not an exact Node-bootstrap duration.
  const parentBegan = performance.now();
  let child, remaining = parentBudget - reserve, reservedRemaining = reserve, firstStderrMs = null, firstMarkerMs = null;
  let stderrBytes = 0, markerCount = 0, line = "", discard = false;
  const elapsed = () => Math.round(performance.now() - parentBegan);
  const parentSnapshot = () => ({ pid: child?.pid ?? null, exitCode: child?.exitCode ?? null, signalCode: child?.signalCode ?? null,
    stderrBytes, markerCount, firstStderrMs, firstMarkerMs });
  const parentMark = (stage, details = {}, reserved = false) => {
    const text = JSON.stringify({ phase: "parent", stage, parentElapsedMs: elapsed(), ...details }) + "\n";
    const bytes = Buffer.byteLength(text);
    if (bytes > (reserved ? reservedRemaining : remaining)) return;
    if (reserved) reservedRemaining -= bytes;
    else remaining -= bytes;
    process.stderr.write(text);
  };
  const deadline = setTimeout(() => parentMark("parent-deadline", parentSnapshot(), true), 8000);
  deadline.unref();
  try {
    const pending = promisify(execFile)(process.execPath, ["--import", guard, "--input-type=module", "-e", script], { timeout: 10000, windowsHide: true,
      ...(preparedBroker ? { env: { ...process.env, REACH_TEST_PREPARED_BROWSER_BROKER: JSON.stringify(preparedBroker) } } : {}),
    });
    child = pending.child;
    parentMark("parent-exec-returned", parentSnapshot());
    child.once("spawn", () => parentMark("parent-spawn", parentSnapshot()));
    child.once("exit", () => parentMark("parent-exit", parentSnapshot()));
    child.stderr.on("data", chunk => {
      stderrBytes = Math.min(0xffffffff, stderrBytes + Buffer.byteLength(chunk));
      if (firstStderrMs === null) { firstStderrMs = elapsed(); parentMark("parent-first-stderr", parentSnapshot()); }
      for (const part of chunk.toString("utf8").split(/(?<=\n)/)) {
        if (!discard && line.length + part.length > 1500) { discard = true; line = ""; }
        if (!discard) line += part;
        if (!part.endsWith("\n")) continue;
        const timing = !discard && failedStartTiming(line);
        if (timing && markerCount < 64) {
          markerCount++;
          if (firstMarkerMs === null) firstMarkerMs = elapsed();
          parentMark("parent-child-marker", timing);
        }
        line = ""; discard = false;
      }
    });
    const { stdout } = await pending;
    parentMark("parent-complete", parentSnapshot());
    assert.equal(stdout.trim(), "retired");
  } catch (error) {
    parentMark("parent-failed", { ...parentSnapshot(), killed: error?.killed === true }, true);
    // execFile errors embed the whole command/script and raw stderr. The
    // allowlisted observations above preserve timing without publishing them.
    throw Error("Failed-start subprocess did not pass its existing 10-second behavior check");
  } finally { clearTimeout(deadline); }
});

test("broker timing observations are bounded and cannot masquerade as ownership proof or disclose raw data", () => {
  assert.deepEqual(parseWindowsBrokerProgress({ kind: "progress", stage: "main", elapsedMs: 0 }), { kind: "progress", stage: "main", elapsedMs: 0 });
  for (const value of [{ kind: "started", stage: "main", elapsedMs: 0 }, { kind: "progress", stage: "secret-path", elapsedMs: 0 },
    { kind: "progress", stage: "main", elapsedMs: -1 }, { kind: "progress", stage: "main", elapsedMs: Infinity },
    { kind: "progress", stage: "main", elapsedMs: 86400001 }, { kind: "progress", stage: "main", elapsedMs: 0, message: "secret" }])
    assert.equal(parseWindowsBrokerProgress(value), null);
  assert.equal(windowsBrokerStatusDetails({ kind: "progress", stage: "empty", active: 0 }), null);
  assert.equal(failedStartTiming("x".repeat(1501)), null);
  assert.equal(failedStartTiming(JSON.stringify({ stage: "unknown", elapsedMs: 1 })), null);
  const observed = failedStartTiming(JSON.stringify({ stage: "broker-status", elapsedMs: 7, nativeKind: "empty", nativeElapsedMs: 4,
    active: 0, total: 1, terminated: false, creationTime: "private-creation-time", message: "secret", argv: ["secret"] }));
  assert.deepEqual(observed, { childStage: "broker-status", childElapsedMs: 7, nativeKind: "empty", active: 0, total: 1, terminated: false, nativeElapsedMs: 4 });
  assert.equal(JSON.stringify(observed).includes("secret"), false);
});

// These are descriptor-refusal models using guard-only bytes. They never run
// that file; the Windows before hook/failed-start child runs the real C# build.
function guardOnlyDescriptor(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-fixtures-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "browser-job.exe"), bytes = Buffer.from("guard-only-record-A");
  fs.writeFileSync(file, bytes);
  return { schema: 1, file, bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    sourceSha256: crypto.createHash("sha256").update(fs.readFileSync(new URL("./fixtures/windows/browser-job.cs", import.meta.url))).digest("hex"),
    creatorPid: process.ppid };
}

test("prepared broker guard refuses malformed provenance without logging descriptor data or compiling", async t => {
  const base = guardOnlyDescriptor(t), events = [], secret = "guard-value-never-log";
  for (const [value, reason] of [[null, "descriptor"], [{ ...base, token: secret }, "descriptor"],
    [{ ...base, file: "relative/browser-job.exe" }, "descriptor"], [{ ...base, creatorPid: -1 }, "descriptor"],
    [{ ...base, sourceSha256: "0".repeat(64) }, "source"], [{ ...base, bytes: base.bytes + 1 }, "file"],
    [{ ...base, sha256: "0".repeat(64) }, "digest"]]) {
    assert.throws(() => verifyPreparedBrowserBroker(value, { onStage: (stage, data) => events.push({ stage, ...data }) }),
      { code: "ERR_PREPARED_BROWSER_BROKER", reason });
  }
  const log = JSON.stringify(events);
  assert.equal(log.includes(secret), false);
  assert.equal(log.includes(base.file), false);
  assert.ok(events.every(event => Object.keys(event).every(key => ["stage", "reason"].includes(key))));
  await assert.rejects(windowsBrowserProcess("must-never-start", [], { preparedBroker: null, onStage() { throw Error(secret); } }),
    { code: "ERR_PREPARED_BROWSER_BROKER", reason: "descriptor" });
});

test("prepared broker guard refuses changed and missing files across a real child boundary", { timeout: 15000 }, async t => {
  const base = { ...guardOnlyDescriptor(t), creatorPid: process.pid };
  const helper = new URL("./helpers/windows-browser-lifetime.mjs", import.meta.url).href;
  const guard = new URL("./helpers/runaway-guard.mjs", import.meta.url).href;
  const script = `
    import { verifyPreparedBrowserBroker } from ${JSON.stringify(helper)};
    const prepared = JSON.parse(process.env.REACH_TEST_PREPARED_BROWSER_BROKER);
    delete process.env.REACH_TEST_PREPARED_BROWSER_BROKER;
    try { verifyPreparedBrowserBroker(prepared); process.stdout.write("accepted\\n"); }
    catch (error) {
      if (error.code !== "ERR_PREPARED_BROWSER_BROKER") throw error;
      process.stdout.write("refused:" + error.reason + "\\n");
    }
  `;
  const run = () => promisify(execFile)(process.execPath, ["--import", guard, "--input-type=module", "-e", script], {
    timeout: 10000, windowsHide: true, env: { ...process.env, REACH_TEST_PREPARED_BROWSER_BROKER: JSON.stringify(base) },
  });
  fs.writeFileSync(base.file, "guard-only-record-B");
  assert.equal((await run()).stdout.trim(), "refused:digest");
  fs.rmSync(base.file);
  assert.equal((await run()).stdout.trim(), "refused:unavailable");
});

test("prepared broker guard refuses a linked preparation directory", t => {
  const base = guardOnlyDescriptor(t);
  const links = fs.mkdtempSync(path.join(os.tmpdir(), "reach-guard-links-"));
  t.after(() => fs.rmSync(links, { recursive: true, force: true }));
  const link = path.join(links, "reach-fixtures-ABC123");
  fs.symlinkSync(path.dirname(base.file), link, process.platform === "win32" ? "junction" : "dir");
  assert.throws(() => verifyPreparedBrowserBroker({ ...base, file: path.join(link, "browser-job.exe") }),
    { code: "ERR_PREPARED_BROWSER_BROKER", reason: "file" });
});
