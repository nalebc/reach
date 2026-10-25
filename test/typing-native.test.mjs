import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { desktopBinary } from "../server/desktop-native.mjs";

// Typing on the live screen, end to end on this Mac: a tap on a text field must
// open the phone's keyboard. The phone asks the real desktop-input helper "is
// there a text field here?" on touch-down (probe). This opens a window of fields
// as real apps draw them and asks at each one. It caught the ChatGPT app's
// composer answering "no": macOS hits a placeholder layer drawn over the field.
//
// Opens a window and needs Accessibility, so it runs only when asked, from
// Terminal (which holds Reach's Accessibility permission):
//   npm run test:typing
const exec = promisify(execFile);
const enabled = process.platform === "darwin" && process.env.REACH_TEST_TYPING_NATIVE === "1";

test("a tap on any kind of text field is seen as a field, quickly; a label is not; a canvas is a place the Mac can't see", { skip: !enabled && "set REACH_TEST_TYPING_NATIVE=1 (macOS, from Terminal)", timeout: 240000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-typing-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixtureBinary = path.join(dir, "typing-fields");
  await exec("/usr/bin/xcrun", ["swiftc", "-O", new URL("./fixtures/typing-fields.swift", import.meta.url).pathname, "-o", fixtureBinary], {
    timeout: 180000,
  });
  // The helper exactly as Reach builds it from today's source.
  const helperBinary = await desktopBinary({ dataDir: dir }, "desktop-input");

  const fixture = spawn(fixtureBinary, [], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => fixture.kill());
  const [line] = await once(createInterface({ input: fixture.stdout }), "line");
  const layout = JSON.parse(line);
  // Let the window settle in front and web content describe itself.
  await new Promise((r) => setTimeout(r, 1500));

  const helper = spawn(helperBinary, ["primary"], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => helper.kill());
  const answers = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  const { display } = layout;
  const ask = async (at) => {
    const started = performance.now();
    helper.stdin.write(
      JSON.stringify({
        type: "probe",
        x: (at.x - display.x) / Math.max(1, display.width - 1),
        y: (at.y - display.y) / Math.max(1, display.height - 1),
      }) + "\n",
    );
    const { value } = await answers.next();
    const answer = JSON.parse(value);
    assert.ok(
      !/Accessibility/.test(answer.error || ""),
      "The helper needs Accessibility: run this test from Terminal (System Settings → Privacy & Security → Accessibility).",
    );
    return { ...answer, ms: performance.now() - started };
  };
  // Web content in a fresh app wakes its accessibility on first asking: wait
  // until something answers at each point before judging it.
  for (const { at } of [...layout.fields, ...layout.notFields])
    for (let i = 0; i < 10 && !(await ask(at)).field; i++) await new Promise((r) => setTimeout(r, 300));
  for (const { name, at } of layout.fields) {
    const answer = await ask(at);
    assert.equal(answer.field, true, `${name} at ${Math.round(at.x)},${Math.round(at.y)} was not seen as a text field`);
    assert.ok(answer.ms < 400, `${name}: ${Math.round(answer.ms)} ms, too slow for the tap's click`);
  }
  // Not fields. Where the Mac can't see (a canvas, a game), it says so: the
  // phone shows its Type button there instead.
  for (const { name, at, blind } of layout.notFields) {
    const answer = await ask(at);
    assert.equal(answer.field, false, `${name} was taken for a text field`);
    assert.equal(answer.blind === true, blind, `${name}: ${blind ? "should" : "shouldn't"} count as a place the Mac can't see`);
  }
});

// Copy selected text, end to end on this Mac: the real helper reads what's
// selected in the app in front. Oct 25: on a page in Chrome it said "Select
// non-password text on your laptop first" with text selected, because Chrome
// never answers the system-wide ask for the focused element (the only test
// of it used a stand-in helper). Opens two windows of its own (a text view
// and a Chrome window with its own profile); nothing is typed or clicked.
test("Copy selected text reads what's selected in a native text view and on a page in Chrome; a blank selection is nothing", { skip: !enabled && "set REACH_TEST_TYPING_NATIVE=1 (macOS, from Terminal)", timeout: 240000 }, async (t) => {
  const { findChrome } = await import("./helpers/headless-chrome.mjs");
  const { eventually } = await import("./helpers/eventually.mjs");
  const chromeBinary = findChrome();
  assert.ok(chromeBinary, "needs Chrome");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-selection-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fixtureBinary = path.join(dir, "selection-text");
  await exec("/usr/bin/xcrun", ["swiftc", "-O", new URL("./fixtures/selection-text.swift", import.meta.url).pathname, "-o", fixtureBinary], { timeout: 180000 });
  const helperBinary = await desktopBinary({ dataDir: dir }, "desktop-input");
  const helper = spawn(helperBinary, ["primary"], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => helper.kill());
  const answers = createInterface({ input: helper.stdout })[Symbol.asyncIterator]();
  const read = async () => {
    helper.stdin.write(JSON.stringify({ type: "selection-read" }) + "\n");
    const answer = JSON.parse((await answers.next()).value);
    assert.ok(!/Accessibility/.test(answer.error || ""), "The helper needs Accessibility: run this test from Terminal.");
    return answer;
  };

  // A native app's text view, in front with "copies this native" selected.
  const fixture = spawn(fixtureBinary, [], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => fixture.kill());
  const lines = createInterface({ input: fixture.stdout })[Symbol.asyncIterator]();
  assert.equal((await lines.next()).value, "ready");
  const native = await eventually(async () => ((await read()).text === "copies this native" ? "copies this native" : null), { timeoutMs: 10000, intervalMs: 300, label: "the native selection" });
  assert.equal(native, "copies this native");

  // A page in Chrome (its own profile and window), its words selected by
  // its own script, as when you drag over text on a page.
  const page = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><title>Reach selection page</title><p id=p style="font:20px system-ui">Reach copies this page selection</p><script>
    const text = document.getElementById("p").firstChild, range = document.createRange();
    range.setStart(text, 6); range.setEnd(text, 26); getSelection().removeAllRanges(); getSelection().addRange(range);
  </script>`)}`;
  // Opened by the app in front, as a link it opens (macOS brings nothing
  // forward for a process in the background), its own profile and window.
  const profile = path.join(dir, "chrome");
  const bundle = chromeBinary.replace(/\/Contents\/MacOS\/[^/]+$/, "");
  fixture.stdin.write(`launch ${JSON.stringify({ app: bundle, args: [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=640,240", `--app=${page}`] })}\n`);
  const launched = /^launched (\d+)$/.exec((await lines.next()).value);
  assert.ok(launched, "Chrome opened");
  await eventually(async () => {
    fixture.stdin.write("front\n");
    return (await lines.next()).value === `front ${launched[1]}`;
  }, { timeoutMs: 15000, intervalMs: 300, label: "the test's Chrome in front" });
  // Not this test's child: ended by its own profile, whatever happens.
  t.after(() => exec("/usr/bin/pkill", ["-f", "--", `--user-data-dir=${profile}`]).catch(() => {}));
  const chromePid = await eventually(async () => {
    const { stdout } = await exec("/usr/bin/pgrep", ["-f", "--", `--user-data-dir=${profile}`]).catch(() => ({ stdout: "" }));
    return Number(stdout.trim().split("\n")[0]) || null;
  }, { timeoutMs: 20000, intervalMs: 300, label: "the test's Chrome" });
  let last;
  await eventually(async () => (last = await read()).text === "copies this page sel", { timeoutMs: 20000, intervalMs: 400, label: "the page's selection" })
    .catch((error) => assert.fail(`${error.message}; the helper last said ${JSON.stringify(last)}`));
  process.kill(chromePid);
  await exec("/usr/bin/pkill", ["-f", "--", `--user-data-dir=${profile}`]).catch(() => {});

  // A selection of only a space is nothing to copy: the phone is told so,
  // never handed a blank line.
  fixture.stdin.write("select 5 1\n");
  assert.equal((await lines.next()).value, "selected");
  const blank = await eventually(async () => {
    const answer = await read();
    return answer.error === "Select some text on your laptop first." ? answer : null;
  }, { timeoutMs: 10000, intervalMs: 300, label: "a blank selection refused" });
  assert.equal(blank.text, undefined);
  fixture.stdin.end();
});
