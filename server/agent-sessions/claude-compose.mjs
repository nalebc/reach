// A message from the phone to a chat the Claude app lists goes into the
// Claude app itself, as typed at the Mac (scripts/native/claude-compose.swift):
// the app's own Claude Code process runs it and its window shows it at once,
// pictures included; a chat that is working queues it, as the app does. (Sent
// from Reach's own process instead, it never showed in the app's window.)
// The window shows one chat at a time: the message goes in when that chat is
// on screen; when you're in another app (or away from the Mac), Reach opens
// the chat in the background, sends, and puts the window back, never bringing
// Claude forward. It waits, saying why, while you use the Claude app itself.
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopBinary } from "../desktop-native.mjs";
import { claudeAppRunning, claudeAppShown, idleSeconds } from "./claude-import.mjs";

const exec = promisify(execFile);
// Why a message (or a draft, a Stop) is still waiting; shown on the phone. An
// expected state, not a failure: 409, so the server never logs it as a crash.
const waiting = (message) => Object.assign(new Error(message), { waiting: true, status: 409 });

// Whether the Claude app is the one in use (frontmost) on the Mac.
export async function claudeFrontmost(run = exec) {
  const { stdout: front } = await run("/usr/bin/lsappinfo", ["front"], { timeout: 3000 });
  const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "bundleid", String(front).trim()], { timeout: 3000 });
  return /"com\.anthropic\.claudefordesktop"/.test(String(stdout));
}

export async function typeIntoClaude(
  { title, text = "", images = [], draft, expected, stop },
  { dataDir, run = exec, binary = () => desktopBinary({ dataDir }, "claude-compose") } = {},
) {
  const file = await binary();
  const json = draft || expected !== undefined;
  const call = run(file, ["--title", title, ...(stop ? ["--stop"] : json ? ["--json"] : ["--text", text]), ...images.flatMap((image) => ["--image", image])], {
    timeout: 30000,
  });
  if (json && call.child?.stdin) {
    call.child.stdin.on("error", () => {}); // helper can refuse before reading
    call.child.stdin.end(JSON.stringify({ text, expected: expected ?? "", draft: !!draft }));
  }
  const { stdout } = await call;
  let result = {};
  try {
    result = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch {
    throw waiting("Couldn't type it into the Claude app.");
  }
  if (result.error) throw waiting(result.error);
  return result;
}

// The drafts Reach put in the Claude app's message boxes, kept on disk: after
// a Reach restart the box still holds one, and a message sent then was refused
// as "the draft changed on your Mac" over and over, never sent.
export function draftFile(file) {
  return {
    load() {
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        return saved && typeof saved === "object" ? saved : {};
      } catch {
        return {};
      }
    },
    save(drafts) {
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(drafts), { mode: 0o600 });
        fs.renameSync(tmp, file);
      } catch {
        /* kept in memory until Reach restarts */
      }
    },
  };
}

export function createClaudeCompose({
  type,
  open,
  // Whether the chat's transcript shows the message arrived after `since`.
  arrived,
  shown = () => claudeAppShown(),
  idle = idleSeconds,
  appRunning = claudeAppRunning,
  // Tests that don't say treat the Claude app as the one in use (as before).
  frontmost = process.env.NODE_TEST_CONTEXT ? () => true : claudeFrontmost,
  awayMs = 30 * 1000,
  switchMs = 15 * 1000,
  confirmMs = 10 * 1000,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  store = null,
}) {
  const link = (session) => `claude://code/continue?session=${session}`;
  const drafts = new Map(
    Object.entries(store?.load() || {}).filter(([, d]) => d && typeof d.text === "string"),
  );
  const keep = () => store?.save(Object.fromEntries(drafts));
  let tail = Promise.resolve();
  const serial = (work) => {
    const result = tail.then(work);
    tail = result.catch(() => {});
    return result;
  };
  return {
    draft(id, { title, text, owner }) {
      return serial(async () => {
        if (!(await appRunning()) || shown()[0]?.id !== id)
          throw waiting("Draft stays on your phone until this chat is visible in Claude.");
        const previous = drafts.get(id);
        if (previous && previous.owner !== owner) throw waiting("Another device is editing this draft.");
        if (!previous && drafts.size >= 128) throw waiting("Too many drafts are open.");
        const result = await type({ title, text, draft: true, expected: previous?.text ?? "" });
        if (result?.drafted !== true) throw waiting("Claude didn't confirm the draft update.");
        if (text) drafts.set(id, { owner, text });
        else drafts.delete(id);
        keep();
        return { synced: true };
      });
    },
    stop(id, { title }) {
      return serial(async () => {
        if (!(await appRunning()) || shown()[0]?.id !== id) throw waiting("Open this chat in Claude to stop it.");
        const result = await type({ title, stop: true });
        if (result?.stopped !== true) throw waiting("Claude didn't confirm Stop.");
        return { stopped: true };
      });
    },
    // `now`: sent with Send now from the phone, so it goes in even while
    // someone uses the Mac (the Claude window switches to this chat).
    deliver(id, { title, text = "", images = [], owner, now = false }) {
      return serial(async () => {
      if (!(await appRunning())) throw waiting("Goes in when the Claude app is open on your Mac.");
      const list = shown();
      const target = list.find((s) => s.id === id);
      if (!target) throw Object.assign(waiting("The Claude app doesn't list this chat."), { unlisted: true });
      // Another chat on screen: switched in the background while you're in
      // another app or away; never under you while you use the Claude app (a
      // switch under someone typing would put their words in this chat).
      let back = null;
      if (list[0]?.id !== id) {
        const elsewhere = !now && !(await Promise.resolve(frontmost()).catch(() => true));
        const seconds = now || elsewhere ? Infinity : await Promise.resolve(idle()).catch(() => null);
        if (seconds == null || seconds * 1000 < awayMs)
          throw waiting("Goes in when you open this chat in the Claude app, or step away from the app. Send now puts it in at once.");
        back = list[0]?.session || null;
        // In the background: Claude never comes forward over what you're doing.
        await open(link(target.session), { background: true });
        for (const until = Date.now() + switchMs; shown()[0]?.id !== id; await wait(250))
          if (Date.now() > until) {
            if (back) await open(link(back), { background: true }).catch(() => {});
            throw waiting("The Claude app didn't open this chat; trying again.");
          }
      }
      const since = Date.now() - 2000;
      try {
        const draft = drafts.get(id);
        if (draft && draft.owner !== owner) throw waiting("Another device is editing this draft.");
        await type({ title, text, images, ...(draft ? { expected: draft.text } : {}) });
        if (drafts.delete(id)) keep();
      } finally {
        if (back) await open(link(back), { background: true }).catch(() => {});
      }
      // The app cleared its box after Send: taken. The transcript says so
      // shortly (never sent twice either way).
      for (const until = Date.now() + confirmMs; Date.now() < until; await wait(300))
        if (await arrived(id, text, since, { images: images.length })) return { delivered: true };
      return { delivered: true, unconfirmed: true };
      });
    },
  };
}
