import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { createWindowsTray, waitingLine } from "../server/windows-tray.mjs";
import { windowsBinary } from "../server/desktop-native.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Reach's icon in the Windows notification area (parity audit #16), as a Mac
// has its menu bar item: Pause or Resume, and messages from the phone
// waiting for their Claude app chat.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function fakeHelper() {
  const started = [];
  const spawnFake = (file, args) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.lines = [];
    readline.createInterface({ input: child.stdin }).on("line", (line) => child.lines.push(line));
    child.file = file;
    child.args = args;
    started.push(child);
    return child;
  };
  return { started, spawn: spawnFake, build: async ({ dataDir }, kind) => path.win32.join(dataDir, `reach-${kind}-abc.exe`) };
}

test("its state as lines, its clicks as Pause and Resume, and it comes back if it stops (5 times)", async () => {
  const helper = fakeHelper();
  const asked = [];
  const timers = [];
  const tray = createWindowsTray({ dataDir: "C:\\r", onMenu: (value) => asked.push(value), build: helper.build, spawn: helper.spawn, icon: "C:\\r\\reach.png", later: (fn) => timers.push(fn), log: () => {} });
  await sleep(10);
  const [first] = helper.started;
  assert.equal(first.file, "C:\\r\\reach-tray-abc.exe");
  assert.deepEqual(first.args, ["C:\\r\\reach.png"]);
  tray.update({ paused: true, waiting: [{ title: "Fix the build", count: 2, link: "claude://code/continue?session=local_x" }] });
  await sleep(10);
  assert.deepEqual(first.lines.slice(-2), ["paused 1", waitingLine([{ title: "Fix the build", count: 2, link: "claude://code/continue?session=local_x" }])]);
  first.stdout.write("resume\npause\nsomething else\n");
  await sleep(10);
  assert.deepEqual(asked, [false, true]);
  // It stops by itself: started again, told everything again.
  first.emit("exit", 1);
  assert.equal(timers.length, 1);
  timers.shift()();
  await sleep(10);
  const second = helper.started[1];
  assert.deepEqual(second.lines.slice(0, 1), ["paused 1"]);
  for (let i = 0; i < 5; i++) {
    helper.started.at(-1).emit("exit", 1);
    if (timers.length) timers.shift()();
    await sleep(5);
  }
  assert.equal(helper.started.length, 6, "five times, then it stays off");
  tray.stop();
});

test("the waiting line: titles and links as base64, counts at least 1, at most 20 chats", () => {
  const line = waitingLine([{ title: "Ça marche: \u201cfin\u201d", count: 0, link: "claude://x" }, { title: "B", count: 3.7, link: "claude://y" }]);
  const [word, ...items] = line.split(" ");
  assert.equal(word, "waiting");
  assert.deepEqual(items.map((item) => item.split(":").map((part, i) => (i ? Buffer.from(part, "base64").toString("utf8") : part))), [["1", "claude://x", "Ça marche: \u201cfin\u201d"], ["3", "claude://y", "B"]]);
  assert.equal(waitingLine([]), "waiting");
  assert.equal(waitingLine(Array.from({ length: 30 }, () => ({ title: "t", count: 1, link: "claude://z" }))).split(" ").length, 21);
});

test("a Windows Reach: Pause from the icon pauses it; Pause from the phone shows on the icon", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tray-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const updates = [];
  let menu = null;
  const reach = await createReach({
    roots: [dir],
    dataDir: path.join(dir, "data"),
    port: 0,
    windowsTray: ({ onMenu }) => {
      menu = onMenu;
      return { update: (state) => updates.push(state), stop: () => updates.push("stopped") };
    },
  });
  t.after(() => reach.close());
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  assert.ok(menu, "started once Reach listens");
  assert.deepEqual(updates[0], { paused: false, waiting: [] });
  const phone = reach.auth.issue("Phone", ALL_SCOPES, "device");
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const pause = async (value) =>
    (await fetch(`${url}/api/settings/pause`, { method: "POST", headers: { Authorization: `Bearer ${phone.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ paused: value }) })).json();
  // From the icon.
  menu(true);
  for (let i = 0; i < 50 && !updates.some((u) => u.paused === true); i++) await sleep(20);
  assert.ok(updates.some((u) => u.paused === true));
  const settings = await (await fetch(`${url}/api/settings`, { headers: { Authorization: `Bearer ${phone.token}` } })).json();
  assert.equal(settings.paused, true, "Reach itself is paused");
  // From the phone.
  await pause(false);
  assert.deepEqual(updates.at(-1), { paused: false });
  await reach.close();
  assert.equal(updates.at(-1), "stopped");
});

test("on a real Windows PC: built with its C# compiler, it says ready, turns clicks into Pause and Resume, and ends with Reach", { skip: process.platform !== "win32", timeout: 180000 }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-tray-real-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = await windowsBinary({ dataDir }, "tray");
  const child = spawn(file, [path.resolve("public/icons/reach-192.png")], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  t.after(() => child.kill());
  const lines = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => lines.push(line));
  const until = async (check, what) => {
    for (const end = Date.now() + 30000; !check(); ) {
      if (Date.now() > end) throw Error(`timed out: ${what}; said ${JSON.stringify(lines)}`);
      await sleep(50);
    }
  };
  await until(() => lines.includes("ready"), "ready");
  child.stdin.write(`paused 0\n${waitingLine([{ title: "Fix the build", count: 2, link: "https://example.com" }])}\nclick toggle\n`);
  await until(() => lines.includes("pause"), "Pause");
  child.stdin.write("paused 1\nclick toggle\n");
  await until(() => lines.includes("resume"), "Resume");
  // A link that isn't the Claude app's is never opened; nothing is said.
  child.stdin.write("click open 0\nclick open 7\n");
  await sleep(500);
  assert.deepEqual(lines, ["ready", "pause", "resume"]);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  const code = await Promise.race([exited, sleep(10000).then(() => "still running")]);
  assert.equal(code, 0, "it ends when Reach does");
});
