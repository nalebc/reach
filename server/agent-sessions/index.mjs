import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { agentCommand } from "../app-shortcuts.mjs";
import { createCodexDaemon } from "./codex-daemon.mjs";
import { createCodexSessions } from "./codex.mjs";
import { createCodexLive } from "./codex-live.mjs";
import { createClaudeSessions } from "./claude.mjs";
import { liveClaudeSessions, readSessionRegistry } from "./processes.mjs";
import { createSignIn } from "./sign-in.mjs";
import { createClaudeHost } from "./claude-host.mjs";
import { createLogos } from "./logos.mjs";
import { claudeAppAccess, claudeAppRunning, createClaudeImports, createClaudeRefresh } from "./claude-import.mjs";
import { agentAskSocket, createAgentAsks } from "./agent-asks.mjs";
import { createClaudeConsent, pressClaudeConsent } from "./claude-consent.mjs";
import { createOutbox } from "./outbox.mjs";
import { createClaudeCompose, typeIntoClaude } from "./claude-compose.mjs";
import { createMacPrompts } from "../mac-prompts.mjs";
import { apps as platformApps } from "../platform.mjs";
import { desktopBinary } from "../desktop-native.mjs";
import { agentName, batches, codexHistoryItems, createMoves, handoff, moveTurns, openClawNotes } from "./move.mjs";
import { createGeminiSessions } from "./gemini.mjs";

const exec = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LOCAL = /^local_[A-Za-z0-9-]{1,64}$/;

// Deep links verified against the installed apps:
// - codex://threads/<id> opens a thread in the Codex app.
// - claude://code/continue?session=local_<id> opens a Claude app session.
// - claude://resume?session=<uuid> imports a CLI session into the Claude app
//   (creating its record) and opens it.
export function nativeLink(session) {
  if (session.agent === "codex" && UUID.test(session.id))
    return `codex://threads/${encodeURIComponent(session.id)}`;
  if (session.agent === "claude") {
    if (session.appSessionId && LOCAL.test(session.appSessionId))
      return `claude://code/continue?session=${encodeURIComponent(session.appSessionId)}`;
    if (UUID.test(session.id)) return `claude://resume?session=${encodeURIComponent(session.id)}`;
  }
  return null;
}

// Optional apps appear in Chat only when this computer has their app, CLI,
// or (for an independently running OpenClaw Gateway) local configuration.
export const KNOWN_AGENTS = [
  { agent: "openclaw", name: "OpenClaw", cli: "openclaw", supported: true },
  { agent: "gemini", name: "Gemini CLI", cli: "gemini" },
  { agent: "antigravity", name: "Antigravity", app: "/Applications/Antigravity.app" },
  { agent: "cursor", name: "Cursor", app: "/Applications/Cursor.app", cli: "cursor-agent" },
];
let detected = null;
export function detectAgents({ known = KNOWN_AGENTS, run = exec, exists = fs.existsSync, fresh = false, platform = process.platform, env = process.env, home = os.homedir() } = {}) {
  const cacheable = known === KNOWN_AGENTS && run === exec && exists === fs.existsSync && env === process.env;
  if (cacheable && !fresh && detected && Date.now() - detected.at < 60000) return detected.value;
  const value = Promise.all(
    known.map(async ({ agent, name, app, cli, supported = false }) => {
      let installed = !!app && platform === "darwin" && exists(app);
      if (agent === "openclaw") {
        const config = env.REACH_OPENCLAW_CONFIG || env.OPENCLAW_CONFIG_PATH || path.join(env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw"), "openclaw.json");
        installed ||= exists(config);
      }
      if (!installed && cli)
        installed = await run(platform === "win32" ? "where.exe" : env.SHELL || "/bin/sh", platform === "win32" ? [cli] : ["-lc", `command -v ${cli}`], { timeout: 5000 }).then(
          ({ stdout }) => !!stdout.trim(),
          () => false,
        );
      return { agent, name, installed, signedIn: false, supported };
    }),
  );
  if (cacheable) detected = { at: Date.now(), value };
  return value;
}

// The claude executable as the owner's login shell finds it (Reach may run
// with a shorter PATH than their terminal).
let claudeAt = null;
export function locateClaude(run = exec) {
  claudeAt ??= run(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], { timeout: 8000 })
    .then(({ stdout }) => stdout.trim().split("\n").pop() || null)
    .then((found) => (found?.startsWith("/") ? found : null))
    .catch(() => null)
    .then((found) => {
      if (!found) claudeAt = null; // look again next time
      return found;
    });
  return claudeAt;
}

// "claude-opus-5-5" → "Opus 5.5", as the Claude app names models.
const claudeModelName = (id) => {
  const m = String(id || "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$|\[)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : null;
};

export function createAgentSessions({
  daemon = createCodexDaemon(),
  codex = createCodexSessions({ daemon }),
  codexLive = createCodexLive({ daemon }),
  claude = createClaudeSessions(),
  // Gemini CLI's sessions, read from its own files (gemini.mjs); none of
  // this Mac's in tests.
  gemini = createGeminiSessions(
    process.env.NODE_TEST_CONTEXT ? { home: path.join(os.tmpdir(), "reach-no-gemini"), locate: async () => null } : {},
  ),
  live = liveClaudeSessions,
  // background: deliver the link without bringing the app forward.
  open = (url, { background = false } = {}) =>
    exec("/usr/bin/open", [...(background ? ["-g"] : []), url], { timeout: 10000 }),
  dataDir = path.join(os.homedir(), ".reach"),
  // Signing an agent in on the Mac from the phone (sign-in.mjs).
  signIn = createSignIn({
    dataDir,
    claudeCommand: () => agentCommand("claude"),
    claudeHealth: () => claude.health(),
    daemon,
  }),
  // Replies to Claude Code sessions (claude-host.mjs).
  claudeHost = createClaudeHost({ locate: () => locateClaude() }),
  // How long one look at the running claude processes is shared.
  liveMs = 2500,
  // The agents' real logos, from the apps installed here (logos.mjs).
  logos = createLogos({ dataDir }),
  // Ending another process's hold on a session (the Claude app's).
  kill = (pid, signal) => process.kill(pid, signal),
  alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  takeOverMs = 3000,
  // How often a message waiting for the Claude app checks again.
  queueMs = 1500,
  // Agents Reach knows of beyond the two it drives today.
  detect = detectAgents,
  // Sessions started here, waiting to join the Claude app's list (claude-import.mjs).
  claudeImports = createClaudeImports({
    file: path.join(dataDir, "claude-imports.json"),
    open,
    resume: !process.env.NODE_TEST_CONTEXT,
  }),
  // The Claude app's window, reloaded once nobody is at the Mac after Reach
  // replies in a session it has shown (claude-import.mjs); never in tests.
  claudeRefresh = process.env.NODE_TEST_CONTEXT
    ? { add: async () => {}, close() {} }
    : createClaudeRefresh({
        file: path.join(dataDir, "claude-refresh.json"),
        open,
        asking: () => [...readSessionRegistry().values()].some((e) => e.where === "claude-app" && e.waiting),
      }),
  // Claude Code's and Codex's prompts in any session (their apps' too),
  // answered from the phone through their PermissionRequest hooks
  // (agent-asks.mjs); made below when not given.
  agentAsks: givenAsks = null,
  // Pressing a button on the Claude app's own consent card (claude-consent.mjs); never in tests.
  pressConsent = process.env.NODE_TEST_CONTEXT
    ? async () => {
        throw Object.assign(new Error("Not in tests."), { status: 409 });
      }
    : (choice, expect) => pressClaudeConsent(choice, { dataDir, expect }),
  claudeShown,
  // Messages waiting for a busy Claude app session, kept until handed over
  // (outbox.mjs); in memory only in tests.
  outbox = createOutbox({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "agent-outbox.json") }),
  // Apps installed here, to show a consent card's apps with their icons.
  installedApps = platformApps,
  // Messages to chats the Claude app lists go into the app itself
  // (claude-compose.mjs); off in tests unless given.
  claudeCompose: givenCompose = null,
  claudeOpen = claudeAppRunning,
  listenForAsks = !process.env.NODE_TEST_CONTEXT,
  // Seconds since the Mac was last used (agent-asks.mjs reads it by default).
  macIdle,
  // Whether the Claude app is installed and signed in (it signs in apart
  // from the CLI Reach replies through).
  claudeApp = () => claudeAppAccess({ registry: readSessionRegistry }),
  // The Mac's own dialogs (privacy prompts, password requests), shown on the
  // phone and answered at the Mac (mac-prompts.mjs).
  macPrompts = createMacPrompts({ dataDir }),
  // OpenClaw's Gateway (../openclaw.mjs), when Reach has one: chats move to
  // and from it too.
  openClaw = null,
  // Chats continued with the other agent, both ways (move.mjs).
  moves = createMoves({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "agent-moves.json") }),
} = {}) {
  const adapters = { codex, claude, gemini };
  const adapter = (agent) => {
    const a = adapters[agent];
    if (!a) throw Object.assign(new Error("Unknown agent."), { status: 404 });
    return a;
  };
  const blocked = (message) => Object.assign(new Error(message), { status: 409 });
  // Which Claude sessions have a process right now; shared for a moment so
  // the list and an open session don't each run ps.
  let liveCache = null;
  const liveNow = async () => {
    if (!liveCache || Date.now() - liveCache.at > liveMs)
      liveCache = { at: Date.now(), value: claude.starts().then(live) };
    try {
      return await liveCache.value;
    } catch (e) {
      liveCache = null;
      throw e;
    }
  };
  // The Claude app's own consent card, answered from the phone when the app
  // holds the session and its transcript still waits on the card.
  const claudeConsent = createClaudeConsent({
    press: pressConsent,
    open,
    ...(claudeShown ? { shown: claudeShown } : {}),
    pending: async (id) => {
      const { session } = await claude.read(id, { limit: 1 });
      if (!session?.consent) return null;
      const running = await liveNow().catch(() => new Map());
      return running.get(id)?.where === "claude-app" ? session.consent : null;
    },
  });
  // Prompts wait for the phone only in sessions it can show: the Claude app's
  // and terminals', and Codex threads in its list. Headless runs (claude -p,
  // codex exec) and sessions Reach drives itself step aside at once.
  const agentAsks =
    givenAsks ||
    createAgentAsks({
      socketPath: agentAskSocket(dataDir),
      ...(macIdle ? { idle: macIdle } : {}),
      skip: (agent, id) => !!hosts[agent]?.drives(id),
      watching: (agent, id) => !!hosts[agent]?.watched?.(id),
      shows: async (agent, id) => {
        if (agent === "claude") {
          const where = (await liveNow()).get(id)?.where;
          return where === "claude-app" || where === "terminal";
        }
        const thread = (await codex.list()).find((s) => s.id === id);
        return !!thread && !thread.headless;
      },
    });
  if (listenForAsks) {
    agentAsks.listen?.().catch(() => {});
    macPrompts.start?.();
  }
  // Working, not merely open: Reach's own turn, or an open process whose
  // transcript is mid-turn (recently) or just changed. The Claude app keeps a
  // process for every open session, so a process alone means nothing.
  const claudeStatus = (s) => {
    if (agentAsks.has?.("claude", s.id)) {
      s.status = "waiting";
      return;
    }
    if (claudeHost.running(s.id)) {
      s.status = claudeHost.view(s.id).status === "waiting" ? "waiting" : "running";
      return;
    }
    // The Claude app's own consent card (its computer use, a folder): the
    // registry says busy, the transcript's open call says what it waits on.
    if (s.consent && s.live?.where === "claude-app") {
      s.status = "waiting";
      return;
    }
    // Claude Code's own registry knows (busy, waiting on you, or idle).
    if (typeof s.live?.busy === "boolean") {
      if (s.live.waiting) s.status = "waiting";
      else if (s.live.busy) s.status = "running";
      return;
    }
    const age = Date.now() - (s.updatedAt || 0);
    if (s.live && ((s.pending && age < 10 * 60 * 1000) || age < 30000)) s.status = "running";
  };
  // Turns Reach runs on Codex know their own state (approvals included).
  const codexStatus = (s) => {
    if (agentAsks.has?.("codex", s.id)) {
      s.status = "waiting";
      return;
    }
    if (!codexLive.drives(s.id)) return;
    const status = codexLive.view(s.id).status;
    if (status === "running" || status === "waiting") s.status = status;
  };
  // Settings the process was started with fill what the app's record lacks.
  const withLive = (session, running) => {
    const { model, effort, mode, ...where } = running;
    session.live = where;
    session.model ||= model;
    session.effort ||= effort;
    session.mode ||= mode;
  };
  // One Claude Code session, wherever it's used. Claude Code lets one process
  // write a session at a time (a second --resume would start a copy), and the
  // Claude app keeps a process only for sessions you've looked at in the last
  // 30 minutes (its log: "Starting idle timeout … 1800s"). So:
  // - Nobody holds it: Reach continues it, the same session, same file.
  // - The Claude app holds it, idle: Reach ends that process the way the app's
  //   own idle timeout does (SIGINT → exit 0, verified: the app logs no error)
  //   and continues it. The app's next process loads it; but a Claude window
  //   that already showed the session doesn't redraw it (verified Oct 4).
  // - The app holds it, busy or waiting on you (Claude Code's registry says
  //   so): the message waits and goes next, as one typed in the app.
  // Never a second writer, never a copy.
  const signedIn = async () => {
    const health = await claude.health().catch(() => null);
    if (health && !health.signedIn) throw blocked("Claude Code is signed out on your Mac. Sign in to reply from here.");
  };
  // Working, or stopped on a question or permission in the app: either way
  // the app's process is mid-turn and must not be ended.
  const busy = async (id, holder) => {
    if (typeof holder.busy === "boolean") return holder.busy || !!holder.waiting;
    const { session } = await claude.read(id, { limit: 1 });
    session.live = holder;
    claudeStatus(session);
    return session.status === "running" || session.status === "waiting";
  };
  // Ends the app's idle process the way its idle timeout does; false if it's still there.
  const handOver = async (holder) => {
    try {
      kill(holder.pid, "SIGINT");
    } catch {
      return true; // already gone
    }
    const end = Date.now() + takeOverMs;
    while (alive(holder.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
    liveCache = null;
    return !alive(holder.pid);
  };
  const holderOf = async (id) => {
    liveCache = null;
    const holder = (await liveNow().catch(() => new Map())).get(id);
    if (!holder || claudeHost.drives(id)) return null;
    if (holder.where === "terminal")
      throw blocked("This session is open in a terminal on your Mac. Reply there or from the Terminal tab.");
    if (holder.where !== "claude-app" || !holder.exact)
      throw blocked("This session is open in another Claude Code process on your Mac. Reply there.");
    return holder;
  };
  const claudeCompose =
    givenCompose ||
    (process.env.NODE_TEST_CONTEXT
      ? null
      : createClaudeCompose({
          type: (message) => typeIntoClaude(message, { dataDir }),
          open,
          arrived: (id, text, since) => claude.arrived(id, text, since),
        }));
  // Messages waiting for the Claude app to finish its turn, in order, kept in
  // the outbox until each is handed to Claude Code: never dropped, and one
  // that can't go yet says why.
  let closed = false;
  const delivering = new Set();
  const deliveringMessage = new Map();
  const deliver = async (id) => {
    if (delivering.has(id)) return;
    delivering.add(id);
    const started = Date.now();
    try {
      while (!closed && outbox.list(id).length) {
        // Waiting never keeps Reach from quitting; after two hours, less often.
        // One waiting for the Claude app's window looks again every 5 s.
        const pause = Date.now() - started > 2 * 60 * 60 * 1000 ? 30000 : outbox.list(id)[0]?.via === "app" && outbox.list(id)[0]?.error ? 5000 : queueMs;
        await new Promise((r) => setTimeout(r, pause).unref?.());
        if (closed) break;
        const next = outbox.list(id)[0];
        if (!next) break;
        try {
          deliveringMessage.set(id, next.id);
          if (next.via === "app") {
            await claudeCompose.deliver(id, { title: next.title, text: next.text, images: next.images, ...(next.owner ? { owner: next.owner } : {}) });
            outbox.remove(id, next.id);
            continue;
          }
          const holder = await holderOf(id);
          if (holder && ((await busy(id, holder)) || !(await handOver(holder)))) {
            outbox.problem(id, next.id, null);
            continue;
          }
          const { id: messageId, at, error, ...message } = next;
          await claudeHost.send(id, message);
          outbox.remove(id, messageId);
        } catch (e) {
          outbox.problem(id, next.id, e?.message || "It couldn't be sent yet.");
        } finally {
          deliveringMessage.delete(id);
        }
      }
    } finally {
      delivering.delete(id);
    }
  };
  // Left waiting when Reach last stopped: on their way again.
  for (const id of outbox.sessions()) void deliver(id);
  // Claude sessions started here join the Claude app's list once Reach lets
  // go of them, through the app's own import, when nobody is at the Mac (the
  // import switches the app's window), so they're there when you get to it.
  const startedHere = new Set();
  // Sessions the app already lists get its window reloaded instead (it
  // doesn't see what Reach added otherwise).
  claudeHost.onRelease?.((id, { wrote } = {}) => {
    if (startedHere.delete(id)) void claudeImports.add(id);
    else if (wrote) void claudeRefresh.add(id);
  });
  // Who replies in each agent's chats from Reach. Gemini CLI's are read
  // only: Google stopped serving it to personal accounts (verified Oct 5,
  // its own answer: "no longer supported … migrate to … Antigravity").
  const hosts = { codex: codexLive, claude: claudeHost };
  const host = (agent) => {
    adapter(agent);
    if (!hosts[agent])
      throw Object.assign(
        new Error(
          agent === "gemini"
            ? "Gemini CLI no longer answers personal Google accounts (Google moved them to Antigravity). Continue this chat in another app."
            : `Reach can't reply in ${agentName(agent)} chats yet.`,
        ),
        { status: 409 },
      );
    return hosts[agent];
  };
  // An agent's live state; one Reach doesn't reply in yet is idle, and its
  // long poll just waits (an instant answer would spin the phone's poll).
  const quiet = {
    view: () => ({ version: 0, status: "idle", error: null, prompts: [], streaming: "", activity: null, items: 0 }),
    changes: (id, version, ms, signal) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0));
        signal?.addEventListener?.("abort", () => (clearTimeout(timer), resolve()));
      }),
  };
  const liveHost = (agent) => (adapter(agent), hosts[agent] || quiet);
  // Each agent's working/waiting status, from what its host knows.
  const statusOf = (agent) => (agent === "claude" ? claudeStatus : agent === "codex" ? codexStatus : () => {});
  // A whole Codex chat, oldest first, kept a minute (a moved chat pages
  // through the one it continues).
  const codexWhole = new Map();
  const codexHistory = async (id) => {
    const kept = codexWhole.get(id);
    if (kept && Date.now() - kept.at < 60000) return kept.value;
    const pages = [];
    let cursor = null;
    let session = null;
    for (let n = 0; n < 200; n++) {
      const page = await codex.read(id, { cursor, limit: 500 });
      session ??= page.session;
      pages.unshift(page.items);
      if (!page.before) break;
      cursor = page.before;
    }
    const value = { session, items: pages.flat(), memory: null };
    codexWhole.set(id, { at: Date.now(), value });
    for (const [key, v] of codexWhole) if (Date.now() - v.at > 60000) codexWhole.delete(key);
    return value;
  };
  // An OpenClaw chat as the others' items (the OpenClaw space shows its own).
  const clawHistory = async (key) => {
    if (!openClaw) throw Object.assign(new Error("OpenClaw isn't connected to Reach."), { status: 404 });
    const h = await openClaw.history(key, 1000);
    return {
      session: { title: h.session?.title || "", cwd: os.homedir(), model: h.session?.model || "" },
      items: (h.items || []).map((m) => ({
        id: String(m.id),
        role: m.tool ? "tool" : ["user", "assistant"].includes(m.role) ? m.role : "system",
        kind: m.tool ? "tool" : "text",
        text: String(m.text || ""),
        at: m.at,
      })),
      memory: null,
    };
  };
  const history = (agent, id) =>
    agent === "claude"
      ? claude.history(id)
      : agent === "openclaw"
        ? clawHistory(id)
        : agent === "gemini"
          ? gemini.history(id)
          : codexHistory(id);
  // The apps a chat can move between.
  const movable = () => ["codex", "claude", ...(openClaw ? ["openclaw"] : [])];
  // Where a chat was when it moved: up to its last item then (or as many
  // items as it had, should that one read differently now).
  const cutAt = (items, from) => {
    const at = from.upTo ? items.findIndex((i) => i.id === from.upTo) + 1 : 0;
    return at > 0 ? at : Math.min(Number(from.count) || items.length, items.length);
  };
  const word = process.platform === "darwin" ? "Mac" : "computer";
  // The quiet line where a chat switched agents.
  const joinLine = (origin, agent, found) => ({
    id: `moved:${origin.from.agent}:${origin.from.id}`,
    role: "system",
    kind: "notice",
    text: found
      ? `Continued with ${agentName(agent)} · earlier messages are from ${agentName(origin.from.agent)}`
      : `Continued with ${agentName(agent)} · the earlier messages from ${agentName(origin.from.agent)} are no longer on this ${word}`,
    at: origin.at,
  });
  // A chat as shown: the one it continues (and that one's, a few deep), the
  // line where it switched agents, then its own items; up to `from` if given.
  const shown = async (agent, id, from = null, depth = 0) => {
    let { items } = await history(agent, id);
    if (from) items = items.slice(0, cutAt(items, from));
    const origin = moves.into(agent, id);
    if (!origin || depth >= 4) return items;
    // A Claude Code chat begins with the history written for it: shown as
    // the original chat's own messages instead.
    if (origin.to.hidden) items = items.slice(origin.to.hidden);
    const before = await earlier(origin, depth + 1);
    return [...(before || []), joinLine(origin, agent, !!before), ...items];
  };
  // The chat a moved one continues, up to the move; null when it is no
  // longer on this Mac (Claude Code deletes old transcripts).
  const earlier = async (origin, depth = 1) => {
    try {
      return await shown(origin.from.agent, origin.from.id, origin.from, depth);
    } catch {
      return null;
    }
  };
  const moving = new Set();
  return {
    // Continues a chat with the other agent, as if it had been forked in the
    // same app (move.mjs): a new chat there with what this one's agent knows
    // so far (its latest summary, then the messages since); this one stays
    // as it is. Settings are the new app's own (never more permission).
    async move(agent, id, { to } = {}) {
      if (!movable().includes(agent)) adapter(agent);
      if (to === agent || !movable().includes(to)) throw Object.assign(new Error("Choose another app."), { status: 400 });
      const key = `${agent}:${id}`;
      if (moving.has(key)) throw Object.assign(new Error("This chat is already moving."), { status: 409 });
      moving.add(key);
      try {
        const source = await history(agent, id);
        const { session, items, memory } = source;
        const from = agentName(agent);
        const title = session.title || "";
        // A Codex thread doesn't list the history it was given: a chat moved
        // into Codex brings what it continues along again (a Claude Code
        // chat holds its copy in its own transcript).
        const carried = agent === "codex" && moves.into(agent, id) ? await shown(agent, id) : memory ? items.slice(memory.from) : items;
        const turns = moveTurns(carried, { summary: memory?.summary || "", from });
        const note = handoff({ from, title, cwd: session.cwd });
        let target;
        let written = 0;
        if (to === "codex") {
          ({ threadId: target } = await codexLive.fork({
            cwd: session.cwd,
            name: title,
            batches: batches(codexHistoryItems(turns)),
            developerInstructions: note,
          }));
        } else if (to === "openclaw") {
          ({ key: target } = await openClaw.fork({ title, notes: openClawNotes(turns, { note, from }), label: `Moved from ${from}` }));
        } else {
          ({ id: target, entries: written } = await claude.write({ cwd: session.cwd, title, turns, note, model: session.model || "", gitBranch: session.branch || "" }));
          // In the Claude app's list too, once nobody is at the Mac.
          void claudeImports.add(target);
        }
        // A Claude Code target begins with the history written for it, which
        // Reach shows as the original chat's own messages instead.
        moves.add({
          from: { agent, id, title, upTo: items.at(-1)?.id || null, count: items.length },
          to: { agent: to, id: target, ...(written ? { hidden: written } : {}) },
        });
        return { agent: to, id: target };
      } finally {
        moving.delete(key);
      }
    },
    signIn,
    logos,
    // Asks held for the phone (agent-asks.mjs): Reach notifies your phone.
    asks: agentAsks,
    // Sending, approving and stopping, exactly as in the agent's own app.
    async send(agent, id, body) {
      // As from the Codex app: without a pick, its composer's current mode.
      if (host(agent) === codexLive) return codexLive.send(id, { ...body, mode: body.mode || codex.appMode?.() || undefined });
      // Claude Code keeps sessions per folder: resume it where it began.
      const { session } = await claude.read(id, { limit: 1 });
      const message = { ...body, cwd: session.cwd };
      const holder = await holderOf(id);
      // A chat the Claude app lists, with the app open: typed into the app
      // itself, so its window shows it at once (Reach's own Claude Code
      // process never showed there). The app signs in on its own.
      if (claudeCompose && session.inApp && (!holder || holder.where === "claude-app") && !claudeHost.drives(id) && (await claudeOpen())) {
        const queued = outbox.add(id, { text: body.text || "", images: body.images || [], via: "app", title: session.appTitle || "Untitled", ...(body.owner ? { owner: body.owner } : {}) });
        void deliver(id);
        return { queued: true, delivered: false, messageId: queued.id, via: "app" };
      }
      await signedIn();
      // After any still waiting, or while the app is busy: into the outbox.
      if (outbox.list(id).length || (holder && ((await busy(id, holder)) || !(await handOver(holder))))) {
        const queued = outbox.add(id, message);
        void deliver(id);
        return { queued: true, delivered: false, messageId: queued.id };
      }
      return claudeHost.send(id, message);
    },
    async start(agent, body) {
      if (host(agent) === codexLive) return codexLive.start(body);
      await signedIn();
      const started = await claudeHost.start(body);
      startedHere.add(started.threadId);
      return started;
    },
    async draft(agent, id, { text, owner }) {
      adapter(agent);
      if (agent !== "claude" || !claudeCompose?.draft) return { synced: false, supported: false };
      if (outbox.list(id).length) throw Object.assign(new Error("Waiting for the previous message to send."), { status: 409 });
      const { session } = await claude.read(id, { limit: 1 });
      if (!session.inApp || claudeHost.drives(id)) return { synced: false, supported: false };
      return claudeCompose.draft(id, { title: session.appTitle || "Untitled", text, owner });
    },
    async stop(agent, id) {
      const current = host(agent);
      if (agent === "claude" && !claudeHost.drives(id) && claudeCompose?.stop) {
        const { session } = await claude.read(id, { limit: 1 });
        if (session.inApp) return claudeCompose.stop(id, { title: session.appTitle || "Untitled" });
      }
      return current.stop(id);
    },
    async cancelQueued(agent, id, messageId) {
      if (host(agent) === codexLive) return codexLive.cancelQueued(id, messageId);
      if (deliveringMessage.get(id) === messageId)
        throw Object.assign(new Error("That message is being sent. Wait for the chat to update."), { status: 409 });
      if (!outbox.list(id).some((m) => m.id === messageId))
        throw Object.assign(new Error("That message already left the queue."), { status: 409 });
      outbox.remove(id, messageId);
      return { deleted: true };
    },
    // A Mac dialog answered from the phone: one of its own buttons, or the
    // Mac's password typed into its password dialog.
    pressMacPrompt: async (id, button) => {
      if (!macPrompts.press) throw Object.assign(new Error("That Mac prompt was already answered."), { status: 404 });
      return macPrompts.press(id, button);
    },
    typeMacPassword: async (id, password) => {
      if (!macPrompts.password) throw Object.assign(new Error("That Mac prompt was already answered."), { status: 404 });
      return macPrompts.password(id, password);
    },
    // The Mac's own dialogs on screen now (screen control holds others'
    // pointers and keys while one is up).
    macDialogs: () => macPrompts.current?.().prompts || [],
    // The System Settings page a Mac prompt belongs to, opened on the Mac.
    openMacSetting: async (id) => {
      if (!macPrompts.openSetting) throw Object.assign(new Error("That Mac prompt was already answered."), { status: 404 });
      return macPrompts.openSetting(id, open);
    },
    // A picture sent in a Claude session (the phone shows it in its message).
    async image(agent, id, item, n) {
      if (agent !== "claude") throw Object.assign(new Error("That picture isn't in this session."), { status: 404 });
      return claude.image(id, item, n);
    },
    respond: async (agent, id, promptId, answer) =>
      agentAsks.owns?.(promptId)
        ? agentAsks.answer(agent, id, promptId, answer)
        : agent === "claude" && claudeConsent.owns(promptId)
          ? claudeConsent.answer(id, promptId, answer)
          : host(agent).respond(id, promptId, answer),
    view(agent, id) {
      const view = liveHost(agent).view(id);
      const asked = agentAsks.prompts?.(agent, id) || [];
      return {
        ...view,
        // One version for both, so the long poll wakes on either.
        version: view.version + (agentAsks.version?.(agent, id) || 0) + outbox.version(),
        ...(asked.length ? { status: "waiting", prompts: [...view.prompts, ...asked] } : {}),
        ...(agent === "claude"
          ? {
              queued: outbox.list(id).length,
              // Sent from the phone, waiting their turn (shown until they're in the transcript).
              outbox: outbox.list(id).map(({ id: messageId, text, images, at, error, via }) => ({
                id: messageId,
                text,
                images: images.length,
                at,
                ...(via ? { via } : {}),
                ...(error ? { error } : {}),
              })),
            }
          : {}),
      };
    },
    // Long poll: resolves when the session changes, or after `ms`.
    changes(agent, id, since, ms, signal) {
      const hostVersion = liveHost(agent).view(id).version;
      if (hostVersion + (agentAsks.version?.(agent, id) || 0) + outbox.version() !== Number(since)) return Promise.resolve();
      return new Promise((resolve) => {
        const stops = [];
        const done = () => {
          for (const stop of stops) stop();
          resolve();
        };
        if (agentAsks.onChange) stops.push(agentAsks.onChange((a, sessionId) => a === agent && sessionId === id && done()));
        stops.push(outbox.onChange((sessionId) => agent === "claude" && sessionId === id && done()));
        liveHost(agent).changes(id, hostVersion, ms, signal).then(done);
      });
    },
    // The Codex app's "Reset usage": spends one of the account's resets.
    async resetUsage(agent) {
      if (agent !== "codex") throw Object.assign(new Error("Only Codex has usage resets."), { status: 400 });
      return codex.resetUsage();
    },
    async models(agent) {
      adapter(agent);
      if (agent === "codex") return codex.models();
      if (agent === "gemini") return { models: [], modes: [], mode: null };
      const [list, modes] = await Promise.all([claudeHost.models(), claudeHost.modes?.().catch(() => []) || []]);
      return {
        models: list.map((m) => ({
          id: m.value,
          name: m.value === "default" ? m.displayName : claudeModelName(m.resolvedModel) || m.displayName || m.value,
          description: m.description || "",
          efforts: m.supportsEffort ? m.supportedEffortLevels || [] : [],
          defaultEffort: null,
          images: true,
          isDefault: m.value === "default",
          // Auto mode only on models that support it, as Claude Code offers it.
          autoMode: !!m.supportsAutoMode,
          fast: !!m.supportsFastMode,
        })),
        modes,
        mode: null,
      };
    },
    // Connects to Codex and indexes Claude transcripts before the phone asks.
    warm() {
      return this.list().catch(() => null);
    },
    // Reach is quitting: end sign-ins and replies in progress, and let go of
    // the Codex daemon (its open socket would keep Reach running).
    close() {
      closed = true;
      for (const agent of ["claude", "codex"]) signIn?.cancel?.(agent);
      claudeHost?.close?.();
      claudeImports?.close?.();
      claudeRefresh?.close?.();
      agentAsks?.close?.();
      macPrompts?.close?.();
      daemon.close?.();
    },
    async list() {
      const [c, k, p, g] = await Promise.allSettled([codex.list(), claude.list(), codex.projects?.() ?? [], gemini.list()]);
      const sessions = [...(c.value || []), ...(k.value || []), ...(g.value || [])];
      // The prompts each waits on (answerable from the Needs-you strip): Reach's
      // own turns' and the agents' hooks'.
      for (const s of sessions) {
        const driven = !!hosts[s.agent]?.drives(s.id);
        const asked = [...(driven ? hosts[s.agent].view(s.id).prompts || [] : []), ...(agentAsks.prompts?.(s.agent, s.id) || [])];
        if (asked.length) s.prompts = asked;
      }
      try {
        const running = await liveNow();
        // Reach's own reply process isn't where a session lives (it showed as "Terminal").
        for (const s of sessions)
          if (s.agent === "claude" && running.has(s.id) && !claudeHost.drives(s.id)) withLive(s, running.get(s.id));
      } catch {
        /* Live status is a hint; the list stands without it. */
      }
      for (const s of sessions) statusOf(s.agent)(s);
      // Continued from the other agent: said in the list, with its app.
      for (const s of sessions) {
        const origin = moves.into(s.agent, s.id);
        if (origin) s.movedFrom = { agent: origin.from.agent, id: origin.from.id, title: origin.from.title || "" };
      }
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        sessions,
        // The Codex app's projects, so its threads group as in its sidebar.
        projects: { codex: p.status === "fulfilled" ? p.value : [] },
        // What the Mac itself is asking right now (answered at the Mac).
        macPrompts: macPrompts.current?.().prompts || [],
        errors: {
          ...(c.status === "rejected" ? { codex: c.reason?.message || "Codex sessions are unavailable." } : {}),
          ...(k.status === "rejected" ? { claude: k.reason?.message || "Claude sessions are unavailable." } : {}),
          ...(g.status === "rejected" ? { gemini: g.reason?.message || "Gemini CLI sessions are unavailable." } : {}),
        },
      };
    },
    async read(agent, id, options) {
      // A moved chat shows the one it continues above its own messages, as
      // if forked in the same app: older pages go on into that chat.
      const origin = moves.into(agent, id);
      const limit = Math.min(Math.max(Number(options?.limit) || 200, 1), 500);
      if (origin && typeof options?.before === "string" && options.before.startsWith("moved:")) {
        const items = (await earlier(origin)) || [];
        const end = Math.min(Math.max(Number(options.before.slice(6)) || 0, 0), items.length);
        const start = Math.max(0, end - limit);
        return { items: items.slice(start, end), before: start > 0 ? `moved:${start}` : null };
      }
      const result = await adapter(agent).read(id, options);
      if (origin?.to.hidden) {
        // Its first messages are the history written for it: shown once,
        // as the original chat's (Claude pages count from its start).
        const start = result.before ? Number(result.before) : 0;
        if (start < origin.to.hidden) {
          result.items = result.items.slice(origin.to.hidden - start);
          result.before = null;
        }
      }
      if (origin) {
        result.session.movedFrom = { agent: origin.from.agent, id: origin.from.id, title: origin.from.title || "" };
        if (!result.before) {
          const items = await earlier(origin);
          const join = joinLine(origin, agent, !!items);
          const room = Math.max(0, limit - result.items.length);
          const start = items ? Math.max(0, items.length - room) : 0;
          result.items = [...(items ? items.slice(start) : []), join, ...result.items];
          result.before = items && start > 0 ? `moved:${start}` : null;
        }
      }
      // Continued with the other agent: where (the chat ends with a way there).
      const out = moves.outOf(agent, id);
      if (out.length) result.session.movedTo = out.map((m) => ({ agent: m.to.agent, id: m.to.id, at: m.at }));
      if (agent === "codex" && codexLive.drives(id)) result.session.held = "reach";
      if (agent === "claude") {
        const running = await liveNow().catch(() => new Map());
        if (claudeHost.drives(id)) result.session.held = "reach";
        else if (running.has(id)) withLive(result.session, running.get(id));
      }
      statusOf(agent)(result.session);
      // Waiting on you in another app (the Claude app, a terminal): what it
      // asks, from the transcript, where it was written before you answer.
      // Only the newest page ends where Claude is now.
      const newest = options?.before == null;
      if (agent === "claude" && newest && result.session.status === "waiting" && result.session.consent) {
        const { id: consentId, kind: about, title, reason, options, apps: names = [] } = result.session.consent;
        // Built while the card is read (not at start: the compiler would hold
        // up quitting), so the answer is quick.
        if (listenForAsks && process.platform === "darwin") desktopBinary({ dataDir }, "claude-consent").catch(() => {});
        const installed = names.length ? await Promise.resolve(installedApps()).catch(() => []) : [];
        result.session.asking = {
          kind: "consent",
          id: consentId,
          about,
          title,
          reason,
          // As the app lists them, with the installed app's icon when found.
          ...(names.length
            ? {
                apps: names.map((name) => {
                  const app = installed.find((a) => [a.name, a.id].some((n) => n?.toLowerCase() === name.toLowerCase()));
                  return { name: app?.name || name, ...(app ? { appId: app.id } : {}) };
                }),
              }
            : {}),
          ...(options ? { options } : {}),
        };
      } else if (agent === "claude" && newest && result.session.held !== "reach" && result.session.live?.waiting) {
        const tool = [...(result.items || [])].reverse().find((i) => i.role === "tool");
        if (tool?.status === "running")
          result.session.asking = tool.questions
            ? { kind: "question", questions: tool.questions }
            : { kind: "permission", text: tool.text, command: tool.kind === "command" };
      }
      return result;
    },
    // The agents on this Mac: the two Reach drives, then others it knows of
    // (installed, not yet supported), so the phone can show where it's going.
    async health({ fresh = false } = {}) {
      const results = await Promise.allSettled([codex.health(), claude.health(), claudeApp()]);
      const driven = results.slice(0, 2).map((r, i) => ({
        ...(r.status === "fulfilled"
          ? r.value
          : { agent: ["codex", "claude"][i], installed: false, signedIn: false, ...(["AGENT_NOT_INSTALLED", "ENOENT"].includes(r.reason?.code) ? {} : { error: r.reason?.message || "Could not check this app. Try again." }) }),
        name: ["Codex", "Claude Code"][i],
        supported: true,
        // Claude: its app's own sign-in, shown next to the CLI's.
        ...(i === 1 && results[2].status === "fulfilled" ? { app: results[2].value } : {}),
      }));
      const others = await detect({ fresh }).catch(() => []);
      // Gemini CLI: its chats are read here (gemini.mjs), so it's one Reach
      // supports, whatever the generic detection says.
      const gem = await gemini.health().catch(() => null);
      const merged = others.map((o) => (o.agent === "gemini" && gem?.installed ? { ...o, ...gem, name: o.name || "Gemini CLI", supported: true } : o));
      if (gem?.installed && !merged.some((o) => o.agent === "gemini")) merged.push({ ...gem, name: "Gemini CLI", supported: true });
      return [...driven, ...merged];
    },
    // Slash commands the agent offers after "/" (Claude Code's from its handshake).
    async commands(agent) {
      adapter(agent);
      if (agent !== "claude") return [];
      return (await claudeHost.commands()).map((c) => ({
        name: c.name,
        description: c.description || "",
        hint: c.argumentHint || "",
      }));
    },
    // Brings the session up in its own app on the Mac.
    async openInApp(agent, id) {
      const { session } = await adapter(agent).read(id, { limit: 1 });
      // One writer at a time: Reach lets go before the Claude app takes it.
      if (agent === "claude") claudeHost.release(id);
      const url = nativeLink(session);
      if (!url) throw Object.assign(new Error("This session cannot be opened in its app."), { status: 400 });
      await open(url);
      return { opened: url.split(":")[0] };
    },
  };
}
