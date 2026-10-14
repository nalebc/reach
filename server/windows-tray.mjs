import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { windowsBinary } from "./desktop-native.mjs";

// Reach's icon in the Windows notification area (scripts/native/tray.cs), as
// a Mac has its menu bar item: on or paused, messages from the phone waiting
// for their Claude app chat, and Pause or Resume. Its clicks arrive as
// onMenu(paused). It lives while Reach runs, and comes back if it stops
// (at most 5 times), as the Mac's helper's item does.
const ICONS = ["../dist/icons/reach-192.png", "../public/icons/reach-192.png"].map((p) => fileURLToPath(new URL(p, import.meta.url)));
const b64 = (text) => Buffer.from(String(text ?? ""), "utf8").toString("base64");
export const waitingLine = (chats = []) =>
  ["waiting", ...chats.slice(0, 20).map((chat) => `${Math.max(1, Math.floor(Number(chat?.count) || 1))}:${b64(chat?.link)}:${b64(chat?.title)}`)].join(" ");

export function createWindowsTray({
  dataDir,
  onMenu = () => {},
  build = windowsBinary,
  spawn = spawnChild,
  icon = ICONS.find((file) => fs.existsSync(file)) || "",
  log = (line) => console.warn(line),
  later = (fn, ms) => setTimeout(fn, ms).unref?.(),
  restartLimit = 5,
} = {}) {
  let child = null;
  let stopped = false;
  let restarts = 0;
  let paused = false;
  let chats = [];
  const send = (line) => {
    try {
      child?.stdin.write(`${line}\n`);
    } catch {}
  };
  const push = () => {
    send(`paused ${paused ? 1 : 0}`);
    send(waitingLine(chats));
  };
  async function start() {
    if (stopped) return;
    let file;
    try {
      file = await build({ dataDir }, "tray");
    } catch (error) {
      log(`Reach: the notification area icon couldn't start: ${error.message}`);
      return;
    }
    if (stopped) return;
    const proc = spawn(file, icon ? [icon] : [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    child = proc;
    proc.stdin.on("error", () => {});
    proc.on("error", () => {});
    readline.createInterface({ input: proc.stdout }).on("line", (line) => {
      if (line === "pause" || line === "resume") onMenu(line === "pause");
    });
    proc.once("exit", () => {
      if (child === proc) child = null;
      if (stopped) return;
      if (++restarts > restartLimit) return log("Reach: the notification area icon kept stopping, so it stays off until Reach restarts.");
      later(() => void start(), 2000 * restarts);
    });
    push();
  }
  void start();
  return {
    update(state = {}) {
      if (typeof state.paused === "boolean") paused = state.paused;
      if (Array.isArray(state.waiting)) chats = state.waiting;
      push();
    },
    stop() {
      stopped = true;
      try {
        child?.stdin.end();
      } catch {}
      child = null;
    },
  };
}
