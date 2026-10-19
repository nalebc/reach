import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { promisify } from "node:util";
import { launchChrome } from "./helpers/headless-chrome.mjs";

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
test("failed browser startup releases protocol calls and exits naturally after cleanup", { timeout: 15000 }, async () => {
  const helper = new URL("./helpers/headless-chrome.mjs", import.meta.url).href;
  const guard = new URL("./helpers/runaway-guard.mjs", import.meta.url).href;
  const script = `
    import { launchChrome } from ${JSON.stringify(helper)};
    const hooks = [];
    let refused = false;
    try { await launchChrome({ after: (fn) => hooks.push(fn) }, { binary: process.execPath }); }
    catch (error) { refused = error instanceof Error; }
    for (const close of hooks) await close();
    if (!refused) throw Error("The non-browser must fail its handshake");
    process.stdout.write("retired\\n");
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", guard, "--input-type=module", "-e", script], { timeout: 10000, windowsHide: true });
  assert.equal(stdout.trim(), "retired");
});
