import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import fs from "node:fs";
import { createMacPrompts, macPrompt, macSetting, SETTING_URLS } from "../server/mac-prompts.mjs";

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
    // Where it's switched on: System Settings' Automation page.
    setting: { name: "Automation", url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation" },
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

test("each Mac prompt points to the System Settings page where it is switched on, from its own words", () => {
  const page = (text) => macSetting(text)?.name || null;
  assert.equal(page("“claude” would like to control this computer using accessibility features."), "Accessibility");
  assert.equal(page("“Terminal” wants access to control “Finder”. Allowing control will provide access…"), "Automation");
  assert.equal(page("“Zoom” would like to record this computer's screen and audio."), "Screen & System Audio Recording");
  assert.equal(page("“node” would like to access files in your Documents folder."), "Files & Folders");
  assert.equal(page("“Tool” would like to receive keystrokes from any application."), "Input Monitoring");
  assert.equal(page("“FaceTime” would like to access the camera."), "Camera");
  assert.equal(page("“Voice” would like to access the microphone."), "Microphone");
  assert.equal(page("“Tool” is an app downloaded from the internet. Are you sure you want to open it?"), "Privacy & Security");
  assert.equal(page("Something macOS has never asked."), null);
  // Only System Settings' own privacy pages.
  for (const url of SETTING_URLS) assert.match(url, /^x-apple\.systempreferences:com\.apple\.preference\.security\?[A-Za-z_]+$/);
});

test("opening a prompt's setting opens only its own System Settings page, and only while the prompt is up", async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() =>
      child.stdout.write(
        JSON.stringify({
          prompts: [
            { id: 7, kind: "privacy", texts: ["“claude” would like to control this computer using accessibility features."], buttons: ["Open System Settings", "Deny"] },
            { id: 8, kind: "privacy", texts: ["Something new."] },
          ],
        }) + "\n",
      ),
    );
    return child;
  };
  const prompts = createMacPrompts({ dataDir: "/tmp", platform: "darwin", binary: async () => "/bin/mac-prompts", spawn });
  prompts.start();
  await settle(20);
  const opened = [];
  const open = async (url) => opened.push(url);
  assert.deepEqual(await prompts.openSetting("7", open), { opened: "Accessibility", app: "claude" });
  assert.deepEqual(opened, ["x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"]);
  await assert.rejects(prompts.openSetting("8", open), (e) => e.status === 409);
  await assert.rejects(prompts.openSetting("99", open), (e) => e.status === 404);
  assert.equal(opened.length, 1);
  prompts.close();
});

test("a Mac prompt says where it is on screen (for the phone's screen view), only when the watcher gave a real place", () => {
  const raw = { id: 3, kind: "privacy", texts: ["“claude” would like to control this computer using accessibility features."] };
  assert.deepEqual(macPrompt({ ...raw, bounds: { x: 626, y: 334, width: 260, height: 314 } }).bounds, { x: 626, y: 334, width: 260, height: 314 });
  assert.equal(macPrompt({ ...raw, bounds: { x: 1, y: 2, width: 0, height: 9 } }).bounds, undefined);
  assert.equal(macPrompt({ ...raw, bounds: { x: "1", y: 2, width: 3, height: 4 } }).bounds, undefined);
  assert.equal(macPrompt(raw).bounds, undefined);
  // A password dialog keeps its place (the screen shows it) but nothing of its text.
  assert.deepEqual(macPrompt({ id: 4, kind: "password", texts: ["secret"], bounds: { x: 1, y: 2, width: 3, height: 4 } }), {
    id: "4",
    kind: "password",
    title: "Your Mac is asking for your password",
    detail: "",
    app: null,
    bounds: { x: 1, y: 2, width: 3, height: 4 },
  });
});

test("a Mac dialog is answered with one of its own buttons, or its password; the password never goes on a command line", async () => {
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() =>
      child.stdout.write(
        JSON.stringify({
          prompts: [
            { id: 51, kind: "privacy", texts: ["“Terminal” wants access to control “Finder”."], buttons: ["Don’t Allow", "Allow"], default: "Allow" },
            { id: 52, kind: "password", texts: ["ignored"] },
          ],
        }) + "\n",
      ),
    );
    return child;
  };
  const runs = [];
  let reply = { pressed: "Allow" };
  const answer = async (args, input) => (runs.push([args, input]), reply);
  const prompts = createMacPrompts({ dataDir: "/tmp", platform: "darwin", binary: async () => "/bin/mac-prompts", spawn, answer });
  prompts.start();
  await settle(20);
  // One of the dialog's own buttons, while it's up.
  assert.deepEqual(await prompts.press("51", "Allow"), { pressed: "Allow" });
  assert.deepEqual(runs.at(-1), [["--press", "--window", "51", "--button", "Allow"], undefined]);
  await assert.rejects(prompts.press("51", "Allow everything"), (e) => e.status === 400);
  await assert.rejects(prompts.press("52", "OK"), (e) => e.status === 409);
  await assert.rejects(prompts.press("99", "Allow"), (e) => e.status === 404);
  // macOS refusing the press is said, not hidden.
  reply = { error: "macOS didn't take the press from Reach. Answer it at the Mac.", refused: true };
  await assert.rejects(prompts.press("51", "Don’t Allow"), (e) => e.status === 409 && e.refused && /Answer it at the Mac/.test(e.message));
  // The password: only for a password dialog, on stdin, never in the arguments.
  reply = { done: true };
  assert.deepEqual(await prompts.password("52", "correct horse"), { done: true });
  assert.deepEqual(runs.at(-1), [["--password", "--window", "52"], "correct horse\n"]);
  assert.ok(runs.every(([args]) => !args.some((a) => a.includes("correct horse"))));
  await assert.rejects(prompts.password("51", "x"), (e) => e.status === 409);
  // Nothing a password field can't take: Tab would move to the visible name
  // field, Escape would cancel the dialog.
  for (const bad of ["", "a\nb", "pw\tx", "pw\u001bx", "pw\u007fx", "x".repeat(257), 42])
    await assert.rejects(prompts.password("52", bad), (e) => e.status === 400);
  reply = { error: "Your Mac's password dialog doesn't have the keyboard. Type it at the Mac.", refused: true };
  await assert.rejects(prompts.password("52", "pw"), /doesn't have the keyboard/);
  prompts.close();
});
