import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { DesktopInput } from "../server/desktop-native.mjs";
import { AgentDesktopHelper } from "../server/agent-desktop.mjs";

// Both host platforms use these JSON-line readers. These inert pipe events
// split real UTF-8 bytes at every boundary; no native process or desktop input.
function child() {
  const process = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: new EventEmitter(),
  });
  process.stdin.write = () => {};
  process.stdin.end = () => {};
  return process;
}

for (const [name, Helper] of [["phone", DesktopInput], ["agent", AgentDesktopHelper]]) {
  test(`${name} desktop replies preserve Unicode across every pipe boundary`, async () => {
    const process = child(), helper = new Helper(process);
    const reply = { ok: true, text: "Café 日本語 👩🏽‍💻 e\u0301", app: "Éditeur" };
    const bytes = Buffer.from(JSON.stringify(reply) + "\n");
    try {
      for (let boundary = 1; boundary < bytes.length; boundary++) {
        const pending = helper.send(name === "phone" ? { type: "clipboard-read" } : { op: "front" });
        process.stdout.emit("data", bytes.subarray(0, boundary));
        process.stdout.emit("data", bytes.subarray(boundary));
        assert.deepEqual(await pending, reply, `UTF-8 boundary ${boundary}`);
      }
      // A pipe may also deliver a character over more than two reads.
      const pending = helper.send(name === "phone" ? { type: "selection-read" } : { op: "elements" });
      for (const byte of bytes) process.stdout.emit("data", Buffer.from([byte]));
      assert.deepEqual(await pending, reply);
    } finally {
      helper.stop();
      process.emit("exit", 0);
      await helper.terminated;
    }
  });
}
