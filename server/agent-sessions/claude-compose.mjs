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
import { object, uncertainDelivery } from "./compatibility.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { desktopBinary } from "../desktop-native.mjs";
import { claudeAppRunning, claudeAppShown, idleSeconds } from "./claude-import.mjs";

const exec = promisify(execFile);
// Why a message (or a draft, a Stop) is still waiting; shown on the phone. An
// expected state, not a failure: 409, so the server never logs it as a crash.
const waiting = (message) => Object.assign(new Error(message), { waiting: true, status: 409 });
const settingUnknown = (message) => Object.assign(new Error(message), {
  status: 409, code: "AGENT_SETTINGS_UNKNOWN", uncertain: true, retryable: false,
});

// The Claude app, as macOS names it.
export const CLAUDE_BUNDLE = "com.anthropic.claudefordesktop";
// The app in use (frontmost) on the Mac, by its bundle id, or null.
export async function frontBundle(run = exec) {
  const { stdout: front } = await run("/usr/bin/lsappinfo", ["front"], { timeout: 3000 });
  const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "bundleid", String(front).trim()], { timeout: 3000 });
  return /"([^"]+)"\s*$/.exec(String(stdout).trim())?.[1] || null;
}
// Whether the Claude app is the one in use (frontmost) on the Mac.
export async function claudeFrontmost(run = exec) {
  return (await frontBundle(run)) === CLAUDE_BUNDLE;
}
// Opens a claude:// link without taking the Mac from whoever uses it: `open
// -g` asks for that, but the Claude app comes forward anyway when it handles
// the link. Whatever app was in front is put back in front.
export async function openInBackground(url, { run = exec, front = () => frontBundle(run), wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const before = await Promise.resolve(front()).catch(() => null);
  await run("/usr/bin/open", ["-g", url], { timeout: 10000 });
  if (!before || before === CLAUDE_BUNDLE) return;
  for (const ms of [100, 250, 500, 1000]) {
    await wait(ms);
    if ((await Promise.resolve(front()).catch(() => null)) !== CLAUDE_BUNDLE) continue;
    await run("/usr/bin/open", ["-b", before], { timeout: 10000 }).catch(() => {});
    return;
  }
}

// Claude Code's effort levels as the Claude app's menu names them.
export const APP_EFFORTS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

// session: the chat by the app's own id (local_…), which the window must
// show (by its title only without one); waitMs: how long it's given to.
export async function typeIntoClaude(
  { title, session, waitMs, text = "", images = [], draft, expected, stop, effort, model, keep },
  { dataDir, run = exec, binary = () => desktopBinary({ dataDir }, "claude-compose") } = {},
) {
  const file = await binary();
  const json = draft || expected !== undefined || keep;
  let call;
  try { call = run(file, ["--title", title, ...(session ? ["--session", session] : []), ...(waitMs != null ? ["--wait", String(waitMs)] : []), ...(model ? ["--model", model] : effort ? ["--effort", effort] : stop ? ["--stop"] : json ? ["--json"] : ["--text", text]), ...(model || effort ? [] : images.flatMap((image) => ["--image", image]))], {
    timeout: 30000,
  }); } catch { throw uncertainDelivery("claude"); }
  if (json && call.child?.stdin) {
    call.child.stdin.on("error", () => {}); // helper can refuse before reading
    call.child.stdin.end(JSON.stringify({ text, expected: expected ?? "", draft: !!draft, ...(keep ? { keep: true } : {}) }));
  }
  let result;
  try {
    const { stdout } = await call;
    result = JSON.parse(String(stdout).trim().split("\n").at(-1));
  } catch { throw uncertainDelivery("claude"); }
  if (!object(result)) throw uncertainDelivery("claude");
  if (model) {
    if (typeof result.error === "string") throw (result.unconfirmed ? settingUnknown(result.error) : waiting(result.error));
    if (result.model !== model || result.unconfirmed) throw settingUnknown("Claude didn't confirm the model change. Check the model in Claude before trying again.");
    return result;
  }
  // An effort the app's menu didn't offer says so; nothing was changed.
  if (effort) {
    if (typeof result.error === "string") throw (result.unconfirmed ? settingUnknown(result.error) : waiting(result.error));
    if (result.effort !== effort) throw settingUnknown("Claude didn't confirm the thinking level. Check it in Claude before trying again.");
    return result;
  }
  const action = stop ? "stopped" : draft ? "drafted" : "sent";
  // A refusal says what didn't happen ({"sent": false, "error": …}), and is
  // tried again. otherChat: the window shows another chat (it says which).
  // Anything else unclear: maybe sent, never retried.
  // occupied: the box holds text Reach doesn't know of; nothing was typed.
  // kept: text typed on the Mac, set aside (keep) and not put back.
  if (result[action] === false && typeof result.error === "string")
    throw Object.assign(waiting(result.error), Array.isArray(result.sessions) ? { otherChat: true } : {}, result.draft === true ? { occupied: true } : {}, typeof result.kept === "string" ? { kept: result.kept } : {});
  if (result[action] !== true || result.error) throw uncertainDelivery("claude");
  return result;
}

// Which chat the Claude app's window shows, by the app's own id for it
// (local_…, from the page's address); null when it can't tell.
export async function claudeOnScreen({ dataDir, run = exec, binary = () => desktopBinary({ dataDir }, "claude-compose") } = {}) {
  const { stdout } = await run(await binary(), ["--check"], { timeout: 10000 });
  const sessions = JSON.parse(String(stdout).trim().split("\n").at(-1)).sessions;
  return Array.isArray(sessions) && sessions.length === 1 ? sessions[0] : null;
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
  // Text typed on the Mac that was set aside for a message and couldn't be
  // put back in its box: saved, never lost.
  keepText = (id, text) => console.warn(`Reach: text from the Claude app's box for ${id} couldn't be put back:\n${text}`),
  open,
  // Whether the chat's transcript shows the message arrived after `since`.
  arrived,
  shown = () => claudeAppShown(),
  idle = idleSeconds,
  appRunning = claudeAppRunning,
  awayMs = 30 * 1000,
  switchMs = 15 * 1000,
  // After a switch that didn't put the message in, how long before the
  // window is switched for that chat again.
  heldMs = 5 * 60 * 1000,
  clock = Date.now,
  confirmMs = 10 * 1000,
  wait = (ms) => new Promise((r) => setTimeout(r, ms)),
  // The next write to a chat's transcript, and the next change to the Claude
  // app's records (which chat it shows), or ms on: what waits here wakes on
  // those instead of looking every few hundred milliseconds.
  transcriptNews = (id, ms) => wait(Math.min(ms, 300)),
  appNews = (ms) => wait(Math.min(ms, 250)),
  // The chat the window shows, by the app's own id for it (claudeOnScreen);
  // tests that don't say: the one the app's records name first.
  onScreen = async () => shown()[0]?.session ?? null,
  store = null,
}) {
  const link = (session) => `claude://code/continue?session=${session}`;
  const drafts = new Map(
    Object.entries(store?.load() || {}).filter(([, d]) => d && typeof d.text === "string"),
  );
  const keep = () => store?.save(Object.fromEntries(drafts));
  // What the box may hold from Reach: the draft it saw land, and any it typed
  // without seeing it land (`maybe`). One unconfirmed write otherwise left
  // Reach's own words there taken for text typed on the Mac, and every draft
  // and message after it waited for good.
  const known = (draft) => [draft.text, ...(Array.isArray(draft.maybe) ? draft.maybe : [])];
  // The app's own id for a chat: what the window must show to be typed in.
  const sessionOf = (id) => shown().find((s) => s.id === id)?.session || null;
  const screen = () => Promise.resolve(onScreen()).catch(() => null);
  // Chats the window isn't switched to again for now (id -> until): one tried
  // in the background and refused. Retried every few seconds, each try
  // switched the window there and back, over and over, pulling Claude in
  // front of the app in use. (A box holding text typed on the Mac never holds
  // a message: it's set aside and put back once nobody is at the Mac.)
  const held = new Map();
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
        let result;
        try {
          result = await type({ title, session: sessionOf(id), waitMs: 0, text, draft: true, expected: previous ? known(previous) : [""] });
        } catch (e) {
          // Any failure but a box holding someone else's text: it may be in.
          if (!e?.occupied && (text || previous)) {
            const maybe = [...new Set([...(previous?.maybe || []), text])].slice(-8);
            drafts.set(id, { owner, text: previous?.text ?? "", maybe });
            keep();
          }
          throw e;
        }
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
        const result = await type({ title, session: sessionOf(id), waitMs: 0, stop: true });
        if (result?.stopped !== true) throw waiting("Claude didn't confirm Stop.");
        return { stopped: true };
      });
    },
    // The catalog resolves an API model id to the exact name in the app's menu.
    // Never switch chats for a setting or accept an unconfirmed native click.
    model(id, { title, model }) {
      return serial(async () => {
        if (typeof model !== "string" || !/^[A-Za-z][A-Za-z0-9 .()-]{0,79}$/.test(model))
          throw Object.assign(new Error("Reach can't identify that model in the Claude app."), { status: 400 });
        const session = sessionOf(id);
        if (!session || !(await appRunning()) || await screen() !== session)
          throw waiting("Open this chat in the Claude app on your Mac to change its model from here.");
        const result = await type({ title, session, waitMs: 0, model });
        if (result?.model !== model || result.unconfirmed)
          throw waiting("Claude didn't confirm the model change. Check the model in Claude before trying again.");
        return { model };
      });
    },
    // An effort level picked on the phone, picked in the app's own menu (so
    // both show the same one) while the chat is on screen there.
    effort(id, { title, effort }) {
      return serial(async () => {
        const label = APP_EFFORTS[effort];
        if (!label) throw Object.assign(new Error("Reach can't pick that effort level in the Claude app."), { status: 400 });
        const session = sessionOf(id);
        if (!session || !(await appRunning()) || await screen() !== session)
          throw waiting("Open this chat in the Claude app on your Mac to change its effort from here.");
        const result = await type({ title, session, waitMs: 0, effort: label });
        return { effort, unconfirmed: !!result.unconfirmed };
      });
    },
    // `now`: sent with Send now from the phone, so it goes in even while
    // someone uses the Mac (the Claude window switches to this chat).
    deliver(id, { title, text = "", images = [], owner, now = false }) {
      return serial(async () => {
      if (!(await appRunning())) throw Object.assign(waiting("Goes in when the Claude app is open on your Mac."), { appClosed: true });
      const list = shown();
      const target = list.find((s) => s.id === id);
      if (!target) throw Object.assign(waiting("The Claude app doesn't list this chat."), { unlisted: true });
      // Another chat on screen: switched in the background while you're in
      // another app or away; never under you while you use the Claude app (a
      // switch under someone typing would put their words in this chat).
      // Which chat the window really shows, by its id (the app's records
      // can lag): this one, or one to switch from and back to.
      let back = null;
      let switched = false;
      const showing = await screen();
      // Only while nobody uses the Mac, whichever app is in front: a window
      // switching chats under someone in another app, and Claude coming
      // forward over it, is just as much in their way. The same goes for
      // setting aside text typed in the chat's box.
      const seconds = now ? Infinity : await Promise.resolve(idle()).catch(() => null);
      const away = seconds != null && seconds * 1000 >= awayMs;
      const awayIn = seconds == null ? {} : { retryMs: Math.max(0, awayMs - seconds * 1000) };
      if (showing !== target.session) {
        if (!now && (held.get(id) ?? 0) > clock())
          throw waiting("The Claude app didn't open this chat; trying again in a few minutes. Send now puts it in at once.");
        if (!away)
          throw Object.assign(
            waiting("Goes in when you open this chat in the Claude app, or step away from the Mac. Send now puts it in at once."),
            // Tried again once you'd count as away (no input for awayMs).
            { inApp: true, ...awayIn },
          );
        back = showing || list[0]?.session || null;
        // In the background: Claude never comes forward over what you're doing.
        await open(link(target.session), { background: true });
        switched = true;
      }
      const since = Date.now() - 2000;
      try {
        const draft = drafts.get(id);
        if (draft && draft.owner !== owner) throw waiting("Another device is editing this draft.");
        // Typed only while the window shows this very chat, by its id; just
        // switched to, it's given switchMs to get there. A mode picked on the
        // phone isn't picked here: it goes with Claude Code's next request
        // (agent-asks.mjs).
        // Text typed on the Mac in its box is set aside and put back after
        // Send, only while nobody is at the Mac (or with Send now).
        const into = { title, session: target.session, ...(switched ? { waitMs: switchMs } : {}), ...(away ? { keep: true } : {}) };
        const result = await type({ ...into, text, images, ...(draft ? { expected: known(draft) } : {}) });
        if (typeof result?.kept === "string") keepText(id, result.kept);
        held.delete(id);
        if (drafts.delete(id)) keep();
      } catch (e) {
        if (typeof e?.kept === "string") keepText(id, e.kept);
        // Text typed on the Mac, while you're at it: goes in once you step
        // away (it's set aside then and put back).
        if (e?.occupied)
          throw Object.assign(
            waiting("This chat's box in the Claude app has text in it. Goes in once you step away from the Mac (the text is put back after); Send now puts it in at once."),
            { inApp: true, ...(away ? {} : awayIn) },
          );
        if (switched && e?.waiting) held.set(id, clock() + heldMs);
        // Switched to, but the window never showed it: back, and again later.
        if (switched && e?.otherChat) throw waiting("The Claude app didn't open this chat; trying again.");
        throw e;
      } finally {
        if (back) await open(link(back), { background: true }).catch(() => {});
      }
      // The app cleared its box after Send: taken. The transcript says so
      // shortly (never sent twice either way).
      for (const until = Date.now() + confirmMs; Date.now() < until; await transcriptNews(id, Math.max(0, until - Date.now())))
        if (await arrived(id, text, since, { images: images.length })) return { delivered: true };
      return { delivered: true, unconfirmed: true };
      });
    },
  };
}
