// A message from the phone to a chat the Claude app lists goes into the
// Claude app itself, as typed at the Mac (scripts/native/claude-compose.swift):
// the app's own Claude Code process runs it and its window shows it at once,
// pictures included; a chat that is working queues it, as the app does. (Sent
// from Reach's own process instead, it never showed in the app's window.)
// The window shows one chat at a time: the message goes in when that chat is
// on screen; when you're in another app (or away from the Mac), Reach opens
// the chat with a background request, sends, and restores its own selection
// only while the desktop transaction still owns it. It waits during control.
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
// Whether the Claude app is the one in use (frontmost) on the Mac.
export async function claudeFrontmost(run = exec) {
  const { stdout: front } = await run("/usr/bin/lsappinfo", ["front"], { timeout: 3000 });
  const { stdout } = await run("/usr/bin/lsappinfo", ["info", "-only", "bundleid", String(front).trim()], { timeout: 3000 });
  return String(stdout).includes(`"${CLAUDE_BUNDLE}"`);
}

// Claude Code's permission modes as the Claude app's menu names them; the ones
// Reach may pick there (never Bypass permissions, turned on at the Mac).
export const APP_MODES = { manual: "Manual", default: "Manual", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto" };
// Claude Code's effort levels as the Claude app's menu names them.
export const APP_EFFORTS = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };

// session: the chat by the app's own id (local_…), which the window must
// show (by its title only without one); waitMs: how long it's given to.
export async function typeIntoClaude(
  { title, session, waitMs, text = "", images = [], draft, expected, stop, mode, effort, model },
  { dataDir, run = exec, binary = () => desktopBinary({ dataDir }, "claude-compose"), beforeDispatch = () => {} } = {},
) {
  const file = await binary();
  const json = draft || expected !== undefined;
  // Helper preparation can await compilation. Ownership must still hold at
  // the actual subprocess dispatch, before any uncertain native side effect.
  try { beforeDispatch(); } catch (e) { throw Object.assign(e, { notDispatched: true }); }
  let call;
  try { call = run(file, ["--title", title, ...(session ? ["--session", session] : []), ...(waitMs != null ? ["--wait", String(waitMs)] : []), ...(model ? ["--model", model] : mode ? ["--mode", mode] : effort ? ["--effort", effort] : stop ? ["--stop"] : json ? ["--json"] : ["--text", text]), ...(model || mode || effort ? [] : images.flatMap((image) => ["--image", image]))], {
    timeout: 30000,
  }); } catch { throw uncertainDelivery("claude"); }
  if (json && call.child?.stdin) {
    call.child.stdin.on("error", () => {}); // helper can refuse before reading
    call.child.stdin.end(JSON.stringify({ text, expected: expected ?? "", draft: !!draft }));
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
  if (mode) {
    if (typeof result.error === "string") throw (result.unconfirmed ? settingUnknown(result.error) : waiting(result.error));
    if (result.mode !== mode || result.unconfirmed) throw settingUnknown("Claude didn't confirm the permission mode. Check it in Claude before trying again.");
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
  if (result[action] === false && typeof result.error === "string")
    throw Object.assign(waiting(result.error), Array.isArray(result.sessions) ? { otherChat: true } : {}, result.draft === true ? { occupied: true } : {});
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
  // The next write to a chat's transcript, and the next change to the Claude
  // app's records (which chat it shows), or ms on: what waits here wakes on
  // those instead of looking every few hundred milliseconds.
  transcriptNews = (id, ms) => wait(Math.min(ms, 300)),
  appNews = (ms) => wait(Math.min(ms, 250)),
  // The chat the window shows, by the app's own id for it (claudeOnScreen);
  // tests that don't say: the one the app's records name first.
  onScreen = async () => shown()[0]?.session ?? null,
  store = null,
  desktopAutomation = null,
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
  let tail = Promise.resolve();
  const serial = (work) => {
    const result = tail.then(() => desktopAutomation ? desktopAutomation.run(work) : work(() => {}));
    tail = result.catch(() => {});
    return result;
  };
  return {
    draft(id, { title, text, owner }) {
      return serial(async (guard) => {
        if (!(await appRunning()) || shown()[0]?.id !== id)
          throw waiting("Draft stays on your phone until this chat is visible in Claude.");
        const previous = drafts.get(id);
        if (previous && previous.owner !== owner) throw waiting("Another device is editing this draft.");
        if (!previous && drafts.size >= 128) throw waiting("Too many drafts are open.");
        let result;
        guard();
        try {
          result = await type({ title, session: sessionOf(id), waitMs: 0, text, draft: true, expected: previous ? known(previous) : [""] }, guard);
        } catch (e) {
          // Any failure but a box holding someone else's text: it may be in.
          if (!e?.occupied && !e?.notDispatched && (text || previous)) {
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
      return serial(async (guard) => {
        if (!(await appRunning()) || shown()[0]?.id !== id) throw waiting("Open this chat in Claude to stop it.");
        guard();
        const result = await type({ title, session: sessionOf(id), waitMs: 0, stop: true }, guard);
        if (result?.stopped !== true) throw waiting("Claude didn't confirm Stop.");
        return { stopped: true };
      });
    },
    // A permission mode picked on the phone, picked in the app's own menu (so
    // both show the same one) when the chat is on screen; otherwise it goes
    // in with the chat's next message.
    mode(id, { title, mode }) {
      return serial(async (guard) => {
        const label = APP_MODES[mode];
        if (!label) throw Object.assign(new Error("Reach can't pick that mode in the Claude app."), { status: 400 });
        const session = sessionOf(id);
        if (!session || !(await appRunning()) || await screen() !== session)
          throw waiting("Changes in the Claude app when this chat is open there, or with your next message.");
        guard();
        const result = await type({ title, session, waitMs: 0, mode: label }, guard);
        if (result?.mode !== label || result.unconfirmed) throw settingUnknown("Claude didn't confirm the permission mode. Check it in Claude before trying again.");
        return { mode };
      });
    },
    // The catalog resolves an API model id to the exact name in the app's menu.
    // Never switch chats for a setting or accept an unconfirmed native click.
    model(id, { title, model }) {
      return serial(async (guard) => {
        if (typeof model !== "string" || !/^[A-Za-z][A-Za-z0-9 .()-]{0,79}$/.test(model))
          throw Object.assign(new Error("Reach can't identify that model in the Claude app."), { status: 400 });
        const session = sessionOf(id);
        if (!session || !(await appRunning()) || await screen() !== session)
          throw waiting("Open this chat in the Claude app on your Mac to change its model from here.");
        guard();
        const result = await type({ title, session, waitMs: 0, model }, guard);
        if (result?.model !== model || result.unconfirmed)
          throw waiting("Claude didn't confirm the model change. Check the model in Claude before trying again.");
        return { model };
      });
    },
    // An effort level picked on the phone, picked in the app's own menu (so
    // both show the same one) while the chat is on screen there.
    effort(id, { title, effort }) {
      return serial(async (guard) => {
        const label = APP_EFFORTS[effort];
        if (!label) throw Object.assign(new Error("Reach can't pick that effort level in the Claude app."), { status: 400 });
        const session = sessionOf(id);
        if (!session || !(await appRunning()) || await screen() !== session)
          throw waiting("Open this chat in the Claude app on your Mac to change its effort from here.");
        guard();
        const result = await type({ title, session, waitMs: 0, effort: label }, guard);
        return { effort, unconfirmed: !!result.unconfirmed };
      });
    },
    // `now`: sent with Send now from the phone, so it goes in even while
    // someone uses the Mac (the Claude window switches to this chat).
    deliver(id, { title, text = "", images = [], owner, now = false, mode = null }) {
      return serial(async (guard) => {
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
      if (showing !== target.session) {
        const elsewhere = !now && (await Promise.resolve(frontmost()).catch(() => null)) === false;
        const seconds = now ? Infinity : await Promise.resolve(idle()).catch(() => null);
        if (!now && (!Number.isFinite(seconds) || seconds < 0 || (!elsewhere && seconds * 1000 < awayMs)))
          throw Object.assign(
            waiting("Goes in when you open this chat in the Claude app, or step away from the app. Send now puts it in at once."),
            // You're in the Claude app: tried again when you leave it, or
            // once you'd count as away (no input for awayMs).
            { inApp: true, ...(!Number.isFinite(seconds) || seconds < 0 ? {} : { retryMs: Math.max(0, awayMs - seconds * 1000) }) },
          );
        if (await screen() !== showing)
          throw waiting("The Claude app changed chats before this message was sent. Trying again later.");
        back = showing || list[0]?.session || null;
        // Request background navigation. If the app still changes foreground,
        // the shared guard prevents the next native action or restoration.
        guard();
        await open(link(target.session), { background: true });
        switched = true;
      }
      const since = Date.now() - 2000;
      try {
        const draft = drafts.get(id);
        if (draft && draft.owner !== owner) throw waiting("Another device is editing this draft.");
        // The mode picked on the phone first, as one picked in the app's
        // composer applies to the message sent after it.
        // Typed only while the window shows this very chat, by its id; just
        // switched to, it's given switchMs to get there.
        const into = { title, session: target.session, ...(switched ? { waitMs: switchMs } : {}) };
        if (APP_MODES[mode]) {
          guard();
          await type({ ...into, mode: APP_MODES[mode] }, guard);
        }
        guard();
        await type({ ...into, text, images, ...(draft ? { expected: known(draft) } : {}) }, guard);
        if (drafts.delete(id)) keep();
      } catch (e) {
        // Switched to, but the window never showed it: back, and again later.
        if (switched && e?.otherChat) throw waiting("The Claude app didn't open this chat; trying again.");
        throw e;
      } finally {
        // Restore only the window this transaction still owns. A foreground
        // change or another chat selected during native work takes precedence.
        // Losing ownership after Send must not turn success into a retry.
        if (back) {
          try {
            if (await screen() === target.session) {
              guard();
              await open(link(back), { background: true });
            }
          } catch { /* leave the new foreground/chat alone */ }
        }
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
