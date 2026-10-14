import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
    catch (error) { refused = /Chrome/.test(error.message); }
    if (!refused) throw Error("The non-browser must fail its handshake");
    for (const close of hooks) await close();
    process.stdout.write("retired\\n");
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", guard, "--input-type=module", "-e", script], { timeout: 10000, windowsHide: true });
  assert.equal(stdout.trim(), "retired");
});
