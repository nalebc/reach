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
import { liveClaudeSessions } from "./processes.mjs";
import { createSignIn } from "./sign-in.mjs";
import { createClaudeHost } from "./claude-host.mjs";
import { createLogos } from "./logos.mjs";
import { createClaudeImports } from "./claude-import.mjs";
import { agentAskSocket, createAgentAsks } from "./agent-asks.mjs";

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

// Agents Reach knows of but doesn't drive yet. Shown when installed, so the
// phone's agent picker already has their place.
export const KNOWN_AGENTS = [
  { agent: "gemini", name: "Gemini CLI", cli: "gemini" },
  { agent: "antigravity", name: "Antigravity", app: "/Applications/Antigravity.app" },
  { agent: "cursor", name: "Cursor", app: "/Applications/Cursor.app", cli: "cursor-agent" },
];
let detected = null;
export function detectAgents({ known = KNOWN_AGENTS, run = exec, exists = fs.existsSync } = {}) {
  if (detected && Date.now() - detected.at < 10 * 60 * 1000) return detected.value;
  const value = Promise.all(
    known.map(async ({ agent, name, app, cli }) => {
      let installed = !!app && exists(app);
      if (!installed && cli)
        installed = await run(process.env.SHELL || "/bin/zsh", ["-lc", `command -v ${cli}`], { timeout: 5000 }).then(
          ({ stdout }) => !!stdout.trim(),
          () => false,
        );
      return { agent, name, installed, signedIn: false, supported: false };
    }),
  );
  detected = { at: Date.now(), value };
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
  // Claude Code's and Codex's prompts in any session (their apps' too),
  // answered from the phone through their PermissionRequest hooks
  // (agent-asks.mjs); made below when not given.
  agentAsks: givenAsks = null,
  listenForAsks = !process.env.NODE_TEST_CONTEXT,
  // Seconds since the Mac was last used (agent-asks.mjs reads it by default).
  macIdle,
} = {}) {
  const adapters = { codex, claude };
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
  // Prompts wait for the phone only in sessions it can show: the Claude app's
  // and terminals', and Codex threads in its list. Headless runs (claude -p,
  // codex exec) and sessions Reach drives itself step aside at once.
  const agentAsks =
    givenAsks ||
    createAgentAsks({
      socketPath: agentAskSocket(dataDir),
      ...(macIdle ? { idle: macIdle } : {}),
      skip: (agent, id) => (agent === "codex" ? codexLive.drives(id) : claudeHost.drives(id)),
      watching: (agent, id) => !!(agent === "codex" ? codexLive.watched?.(id) : claudeHost.watched?.(id)),
      shows: async (agent, id) => {
        if (agent === "claude") {
          const where = (await liveNow()).get(id)?.where;
          return where === "claude-app" || where === "terminal";
        }
        const thread = (await codex.list()).find((s) => s.id === id);
        return !!thread && !thread.headless;
      },
    });
  if (listenForAsks) agentAsks.listen?.().catch(() => {});
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
  // Messages waiting for the Claude app to finish its turn, in order.
  const waiting = new Map(); // id -> [message]
  let closed = false;
  const deliver = async (id) => {
    const until = Date.now() + 2 * 60 * 60 * 1000;
    while (!closed && waiting.get(id)?.length && Date.now() < until) {
      // Waiting never keeps Reach from quitting.
      await new Promise((r) => setTimeout(r, queueMs).unref?.());
      if (closed) break;
      try {
        const holder = await holderOf(id);
        if (holder && ((await busy(id, holder)) || !(await handOver(holder)))) continue;
        const list = waiting.get(id) || [];
        waiting.delete(id);
        for (const message of list) await claudeHost.send(id, message);
      } catch {
        /* try again on the next round */
      }
    }
    waiting.delete(id);
  };
  // Claude sessions started here join the Claude app's list once Reach lets
  // go of them, through the app's own import, when nobody is at the Mac (the
  // import switches the app's window), so they're there when you get to it.
  const startedHere = new Set();
  claudeHost.onRelease?.((id) => {
    if (startedHere.delete(id)) void claudeImports.add(id);
  });
  const host = (agent) => (adapter(agent), agent === "codex" ? codexLive : claudeHost);
  return {
    signIn,
    logos,
    // Sending, approving and stopping, exactly as in the agent's own app.
    async send(agent, id, body) {
      // As from the Codex app: without a pick, its composer's current mode.
      if (host(agent) === codexLive) return codexLive.send(id, { ...body, mode: body.mode || codex.appMode?.() || undefined });
      await signedIn();
      // Claude Code keeps sessions per folder: resume it where it began.
      const { session } = await claude.read(id, { limit: 1 });
      const message = { ...body, cwd: session.cwd };
      const holder = await holderOf(id);
      if (holder && ((await busy(id, holder)) || !(await handOver(holder)))) {
        const list = waiting.get(id) || [];
        list.push(message);
        if (list.length === 1) {
          waiting.set(id, list);
          void deliver(id);
        }
        return { queued: true, delivered: false };
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
    stop: async (agent, id) => host(agent).stop(id),
    respond: async (agent, id, promptId, answer) =>
      agentAsks.owns?.(promptId)
        ? agentAsks.answer(agent, id, promptId, answer)
        : host(agent).respond(id, promptId, answer),
    view(agent, id) {
      const view = host(agent).view(id);
      const asked = agentAsks.prompts?.(agent, id) || [];
      return {
        ...view,
        // One version for both, so the long poll wakes on either.
        version: view.version + (agentAsks.version?.(agent, id) || 0),
        ...(asked.length ? { status: "waiting", prompts: [...view.prompts, ...asked] } : {}),
        ...(agent === "claude" ? { queued: waiting.get(id)?.length || 0 } : {}),
      };
    },
    // Long poll: resolves when the session changes, or after `ms`.
    changes(agent, id, since, ms, signal) {
      if (!agentAsks.onChange) return host(agent).changes(id, since, ms, signal);
      const hostVersion = host(agent).view(id).version;
      if (hostVersion + agentAsks.version(agent, id) !== Number(since)) return Promise.resolve();
      return new Promise((resolve) => {
        let stop = () => {};
        const done = () => {
          stop();
          resolve();
        };
        stop = agentAsks.onChange((a, sessionId) => a === agent && sessionId === id && done());
        host(agent).changes(id, hostVersion, ms, signal).then(done);
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
      waiting.clear();
      for (const agent of ["claude", "codex"]) signIn?.cancel?.(agent);
      claudeHost?.close?.();
      claudeImports?.close?.();
      agentAsks?.close?.();
      daemon.close?.();
    },
    async list() {
      const [c, k, p] = await Promise.allSettled([codex.list(), claude.list(), codex.projects?.() ?? []]);
      const sessions = [...(c.value || []), ...(k.value || [])];
      try {
        const running = await liveNow();
        for (const s of sessions) if (s.agent === "claude" && running.has(s.id)) withLive(s, running.get(s.id));
      } catch {
        /* Live status is a hint; the list stands without it. */
      }
      for (const s of sessions) (s.agent === "claude" ? claudeStatus : codexStatus)(s);
      sessions.sort((a, b) => b.updatedAt - a.updatedAt);
      return {
        sessions,
        // The Codex app's projects, so its threads group as in its sidebar.
        projects: { codex: p.status === "fulfilled" ? p.value : [] },
        errors: {
          ...(c.status === "rejected" ? { codex: c.reason?.message || "Codex sessions are unavailable." } : {}),
          ...(k.status === "rejected" ? { claude: k.reason?.message || "Claude sessions are unavailable." } : {}),
        },
      };
    },
    async read(agent, id, options) {
      const result = await adapter(agent).read(id, options);
      if (agent === "codex" && codexLive.drives(id)) result.session.held = "reach";
      if (agent === "claude") {
        const running = await liveNow().catch(() => new Map());
        if (running.has(id)) withLive(result.session, running.get(id));
        if (claudeHost.drives(id)) result.session.held = "reach";
      }
      (agent === "claude" ? claudeStatus : codexStatus)(result.session);
      // Waiting on you in another app (the Claude app, a terminal): what it
      // asks, from the transcript, where it was written before you answer.
      // Only the newest page ends where Claude is now.
      const newest = options?.before == null;
      if (agent === "claude" && newest && result.session.held !== "reach" && result.session.live?.waiting) {
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
    async health() {
      const results = await Promise.allSettled([codex.health(), claude.health()]);
      const driven = results.map((r, i) => ({
        ...(r.status === "fulfilled"
          ? r.value
          : { agent: ["codex", "claude"][i], installed: false, signedIn: false, error: r.reason?.message }),
        name: ["Codex", "Claude Code"][i],
        supported: true,
      }));
      const others = await detect().catch(() => []);
      return [...driven, ...others];
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
