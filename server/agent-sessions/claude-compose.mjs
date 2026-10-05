// A message from the phone to a chat the Claude app lists goes into the
// Claude app itself, as typed at the Mac (scripts/native/claude-compose.swift):
// the app's own Claude Code process runs it and its window shows it at once,
// pictures included; a chat that is working queues it, as the app does. (Sent
// from Reach's own process instead, it never showed in the app's window.)
// The window shows one chat at a time: the message goes in when that chat is
// on screen, or, when nobody has used the Mac for a while, Reach opens it,
// sends, and puts the window back. It waits, saying why, otherwise.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopBinary } from "../desktop-native.mjs";
import { claudeAppRunning, claudeAppShown, idleSeconds } from "./claude-import.mjs";

const exec = promisify(execFile);
// Why a message is still waiting; shown under it on the phone.
const waiting = (message) => Object.assign(new Error(message), { waiting: true });

export async function typeIntoClaude(
  { title, text = "", images = [] },
  { dataDir, run = exec, binary = () => desktopBinary({ dataDir }, "claude-compose") } = {},
) {
  const file = await binary();
  const { stdout } = await run(file, ["--title", title, "--text", text, ...images.flatMap((image) => ["--image", image])], {
    timeout: 30000,
  });
  let result = {};
  try {
    result = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    throw waiting("Couldn't type it into the Claude app.");
  }
  if (result.error) throw waiting(result.error);
  return result;
}

export function createClaudeCompose({
  type,
  open,
  // Whether the chat's transcript shows the message arrived after `since`.
  arrived,
  shown = () => claudeAppShown(),
  idle = idleSeconds,
  appRunning = claudeAppRunning,
  awayMs = 30 * 1000,
  switchMs = 15 * 1000,
  confirmMs = 10 * 1000,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const link = (session) => `claude://code/continue?session=${session}`;
  return {
    async deliver(id, { title, text = "", images = [] }) {
      if (!(await appRunning())) throw waiting("Goes in when the Claude app is open on your Mac.");
      const list = shown();
      const target = list.find((s) => s.id === id);
      if (!target) throw waiting("The Claude app doesn't list this chat.");
      // Another chat on screen: only while nobody is using the Mac (a switch
      // under someone typing would put their words in this chat).
      let back = null;
      if (list[0]?.id !== id) {
        const seconds = await Promise.resolve(idle()).catch(() => null);
        if (seconds == null || seconds * 1000 < awayMs)
          throw waiting("Goes in when you open this chat in the Claude app, or step away from your Mac.");
        back = list[0]?.session || null;
        await open(link(target.session));
        for (const until = Date.now() + switchMs; shown()[0]?.id !== id; await wait(250))
          if (Date.now() > until) {
            if (back) await open(link(back)).catch(() => {});
            throw waiting("The Claude app didn't open this chat; trying again.");
          }
      }
      const since = Date.now() - 2000;
      try {
        await type({ title, text, images });
      } finally {
        if (back) await open(link(back)).catch(() => {});
      }
      // The app cleared its box after Send: taken. The transcript says so
      // shortly (never sent twice either way).
      for (const until = Date.now() + confirmMs; Date.now() < until; await wait(300))
        if (await arrived(id, text, since)) return { delivered: true };
      return { delivered: true, unconfirmed: true };
    },
  };
}
