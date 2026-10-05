import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { createMacPrompts, macPrompt } from "../server/mac-prompts.mjs";

const PNG = "data:image/png;base64,iVBORw0KGgo=";
const settle = (ms = 10) => new Promise((r) => setTimeout(r, ms));

test("a macOS dialog reads as the Mac's: who asks, for what; a password dialog says only that", () => {
  // A real Automation prompt, as the watcher reported it on macOS 26.6.
  const real = JSON.parse(fs.readFileSync(new URL("./fixtures/mac-prompt-automation.json", import.meta.url), "utf8"));
  assert.deepEqual(macPrompt({ ...real, image: PNG }), {
    id: String(real.id),
    kind: "privacy",
    title: "“Reach prompt test” wants access to control “Finder”.",
    detail:
      "Allowing control will provide access to documents and data in “Finder”, and to perform actions within that app. Test only (safe to delete): lets Reach learn how macOS permission prompts look.",
    app: "Reach prompt test",
    buttons: ["Don’t Allow", "Allow"],
    // Drawn as macOS draws it: its message, its app's reason, and the button Return presses.
    lines: real.texts,
    default: "Allow",
    image: PNG,
  });
  // The button macOS marks as the default, when it says.
  assert.equal(macPrompt({ ...real, default: "Don’t Allow" }).default, "Don’t Allow");
  assert.equal(macPrompt({ ...real, default: "Something else" }).default, "Allow");
  // No text exposed: still said, with its picture.
  assert.deepEqual(macPrompt({ id: 1, kind: "privacy", image: PNG }), {
    id: "1",
    kind: "privacy",
    title: "Your Mac is asking for permission",
    detail: "",
    app: null,
    buttons: [],
    lines: [],
    image: PNG,
  });
  // A password dialog: nothing of it travels, even if something came along.
  assert.deepEqual(macPrompt({ id: 2, kind: "password", texts: ["secret"], image: PNG }), {
    id: "2",
    kind: "password",
    title: "Your Mac is asking for your password",
    detail: "",
    app: null,
  });
  // Only a picture Reach took itself.
  assert.equal(macPrompt({ id: 3, kind: "privacy", image: "https://x.example/a.png" }).image, undefined);
});

test("the dialogs follow the watcher: they show while up, clear when closed, and the watcher comes back if it stops", async () => {
  const runs = [];
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => child.emit("exit", 0);
    runs.push(child);
    return child;
  };
  const prompts = createMacPrompts({ dataDir: "/tmp", platform: "darwin", binary: async () => "/bin/mac-prompts", spawn, retryMs: 20 });
  let changes = 0;
  prompts.onChange(() => changes++);
  prompts.start();
  await settle();
  assert.equal(runs.length, 1);
  runs[0].stdout.write(`${JSON.stringify({ prompts: [{ id: 7, kind: "privacy", texts: ["“Claude” would like to access files in your Documents folder."] }] })}\n`);
  await settle();
  assert.deepEqual(prompts.current().prompts.map((p) => [p.title, p.app]), [["“Claude” would like to access files in your Documents folder.", "Claude"]]);
  // The same again (a redraw) is no change.
  runs[0].stdout.write(`${JSON.stringify({ prompts: [{ id: 7, kind: "privacy", texts: ["“Claude” would like to access files in your Documents folder."] }] })}\n`);
  await settle();
  assert.equal(changes, 1);
  runs[0].stdout.write(`${JSON.stringify({ prompts: [] })}\n`);
  await settle();
  assert.deepEqual(prompts.current().prompts, []);
  assert.equal(prompts.current().version, 2);
  // It stops: nothing is left showing, and it runs again.
  runs[0].stdout.write(`${JSON.stringify({ prompts: [{ id: 8, kind: "password" }] })}\n`);
  await settle();
  runs[0].emit("exit", 1);
  assert.deepEqual(prompts.current().prompts, []);
  await settle(40);
  assert.equal(runs.length, 2);
  prompts.close();
  await settle(40);
  assert.equal(runs.length, 2, "not after Reach quits");
  // Not a Mac: nothing runs.
  const elsewhere = createMacPrompts({ dataDir: "/tmp", platform: "linux", binary: async () => "/x", spawn });
  elsewhere.start();
  await settle();
  assert.equal(runs.length, 2);
});
