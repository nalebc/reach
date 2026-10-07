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
//   REACH_TEST_TYPING_NATIVE=1 node --test test/typing-native.test.mjs
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
