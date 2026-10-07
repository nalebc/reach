import { uncertainDelivery, probeAgent } from "./compatibility.mjs";
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
import { createConnectorLogos } from "./connector-logos.mjs";
import { createConnectors } from "./connectors.mjs";
import { findCodexExecutable } from "../capabilities.mjs";
import { createClaudeHost } from "./claude-host.mjs";
import { createLogos } from "./logos.mjs";
import { claudeAppAccess, claudeAppRunning, claudeAppShown, createClaudeImports, createClaudeRefresh } from "./claude-import.mjs";
import { createClaudeConsent, pressClaudeConsent } from "./claude-consent.mjs";
import { answerAppQuestion, cardExpect, cardId, createAppCards, pressAppCard, probeApp, questionId, readAppCard } from "./app-cards.mjs";
import { createTerminalCards } from "./terminal-cards.mjs";
import { createOutbox } from "./outbox.mjs";
import { createChatModes } from "./chat-modes.mjs";
import { CLAUDE_BUNDLE, claudeFrontmost, claudeOnScreen, createClaudeCompose, draftFile, typeIntoClaude } from "./claude-compose.mjs";
import { createMacPrompts } from "../mac-prompts.mjs";
import { apps as platformApps } from "../platform.mjs";
import { computerWord } from "../computer-word.mjs";
import { desktopBinary } from "../desktop-native.mjs";
import { agentName, createMoves, handoff, moveTurns, openClawNotes } from "./move.mjs";
import { createGeminiSessions } from "./gemini.mjs";
import { createAgentWatch } from "./agent-watch.mjs";
import { createCodexMethods, createSlashCommands } from "./commands.mjs";

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
  claude = createClaudeSessions({ locateCli: () => locateClaude() }),
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
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
  // The agents' real logos, from the apps installed here (logos.mjs).
  logos = createLogos({ dataDir }),
  // GitHub, Linear, … for each agent, in its own configuration
  // (connectors.mjs); none of this computer's in tests.
  connectors = createConnectors({
    logos: process.env.NODE_TEST_CONTEXT ? null : createConnectorLogos({ dir: path.join(dataDir, "connector-logos") }),
    daemon,
    locate: process.env.NODE_TEST_CONTEXT
      ? {}
      : {
          claude: () => locateClaude(),
          codex: () => findCodexExecutable(),
          gemini: () =>
            exec(process.env.SHELL || "/bin/zsh", ["-lc", "command -v gemini"], { timeout: 8000 })
              .then(({ stdout }) => String(stdout).trim().split("\n").pop() || null)
              .then((found) => (found?.startsWith("/") ? found : null)),
        },
    ...(process.env.NODE_TEST_CONTEXT ? { home: path.join(os.tmpdir(), "reach-no-connectors") } : {}),
  }),
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
  // How often one the Claude app hasn't taken tries again, when the Mac
  // doesn't say what it waits for (the app in front, see frontmost()).
  appRetryMs = 5000,
  // How long a chat must stay waiting before it counts as waiting on you
  // (tests that don't say count it at once, as before).
  settleMs = process.env.NODE_TEST_CONTEXT ? 0 : 6000,
  // Claude Code's own waits settle sooner: the Claude app answers what its
  // rules allow within milliseconds (Codex's reviewer takes seconds).
  claudeSettleMs = Math.min(settleMs, 1500),
  // The list is rebuilt when something in it changes, at most once per
  // listGapMs while agents write, and kept up to listMaxAgeMs otherwise
  // (tests that don't say: rebuilt for every look, as before).
  listGapMs = process.env.NODE_TEST_CONTEXT ? 0 : 1500,
  listMaxAgeMs = process.env.NODE_TEST_CONTEXT ? 0 : 30000,
  // Rebuilt as soon as something changes while anyone listens (never in
  // tests that don't ask: they'd reach for the Mac's real agents).
  proactive = !process.env.NODE_TEST_CONTEXT,
  // Agents Reach knows of beyond the two it drives today.
  detect = detectAgents,
  // Sessions started here, waiting to join the Claude app's list (claude-import.mjs).
  claudeImports = null,
  // The Claude app's window, reloaded once nobody is at the Mac after Reach
  // replies in a session it has shown (claude-import.mjs); never in tests.
  claudeRefresh = process.env.NODE_TEST_CONTEXT
    ? { add: async () => {}, close() {} }
    : createClaudeRefresh({
        file: path.join(dataDir, "claude-refresh.json"),
        open,
        asking: () => [...readSessionRegistry().values()].some((e) => e.where === "claude-app" && e.waiting),
      }),
  // Pressing a button on the Claude app's own consent card (claude-consent.mjs); never in tests.
  pressConsent = process.env.NODE_TEST_CONTEXT
    ? async () => {
        throw Object.assign(new Error("Not in tests."), { status: 409 });
      }
    : (choice, expect) => pressClaudeConsent(choice, { dataDir, expect }),
  // Reading the Claude app's or the Codex app's permission card, and
  // pressing one of its buttons on the person's tap (app-cards.mjs); never
  // in tests.
  readCard = process.env.NODE_TEST_CONTEXT
    ? async () => {
        throw Object.assign(new Error("Not in tests."), { status: 409 });
      }
    : (agent, expect) => readAppCard(agent, expect, { dataDir }),
  pressCard = process.env.NODE_TEST_CONTEXT
    ? async () => {
        throw Object.assign(new Error("Not in tests."), { status: 409 });
      }
    : (agent, label, expect) => pressAppCard(agent, label, expect, { dataDir }),
  // Claude's questions in the Claude app, answered on the person's taps.
  answerQuestion = process.env.NODE_TEST_CONTEXT
    ? async () => {
        throw Object.assign(new Error("Not in tests."), { status: 409 });
      }
    : (agent, answers) => answerAppQuestion(agent, answers, { dataDir }),
  claudeShown,
  // Reach's Mac terminals (desktop-terminals.mjs): a terminal's menu is read
  // and answered there.
  terminals = null,
  // Messages waiting for a busy Claude app session, kept until handed over
  // The chats the Claude app lists, the one on screen first (claude-import.mjs).
  appShown = claudeAppShown,
  // (outbox.mjs); in memory only in tests.
  outbox = createOutbox({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "agent-outbox.json") }),
  // Apps installed here, to show a consent card's apps with their icons.
  installedApps = platformApps,
  // Messages to chats the Claude app lists go into the app itself
  // (claude-compose.mjs); off in tests unless given.
  claudeCompose: givenCompose = null,
  claudeOpen = claudeAppRunning,
  listenForAsks = !process.env.NODE_TEST_CONTEXT,
  // Whether the Claude app is installed and signed in (it signs in apart
  // from the CLI Reach replies through).
  claudeApp = () => claudeAppAccess({ registry: readSessionRegistry }),
  // The Mac's own dialogs (privacy prompts, password requests), shown on the
  // phone and answered at the Mac (mac-prompts.mjs).
  macPrompts = createMacPrompts({ dataDir }),
  // OpenClaw's Gateway (../openclaw.mjs), when Reach has one: chats move to
  // and from it too.
  openClaw = null,
  // News the moment an agent's app writes it, from its own files
  // (agent-watch.mjs); never in tests.
  agentWatch = process.env.NODE_TEST_CONTEXT ? null : createAgentWatch(),
  claudeCompatibility = process.env.NODE_TEST_CONTEXT ? async () => null : () => locateClaude().then(file => probeAgent("claude", file)),
  // Chats continued with the other agent, both ways (move.mjs).
  moves = createMoves({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "agent-moves.json") }),
  // The permission mode picked for each Codex chat from Reach (chat-modes.mjs).
  chatModes = createChatModes({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "codex-modes.json") }),
  // What "/" offers in a chat, from each agent itself (commands.mjs); the
  // installed Codex isn't asked in tests.
  slash = createSlashCommands({
    claudeHost,
    daemon,
    codexLive,
    codex,
    claude,
    ...(process.env.NODE_TEST_CONTEXT ? { codexMethods: async () => new Set() } : { codexMethods: createCodexMethods() }),
  }),
} = {}) {
  // Chats joining the Claude app's list (claude-import.mjs): its record
  // written, or its import link when the app is open and out of the way;
  // never this Mac's app in tests.
  claudeImports ??= createClaudeImports({
    file: path.join(dataDir, "claude-imports.json"),
    open,
    resume: !process.env.NODE_TEST_CONTEXT,
    held: (id) => claudeHost.drives(id),
    frontmost: () => claudeFrontmost(),
    describe: async (id) => {
      const { session } = await claude.read(id, { limit: 1 });
      return {
        cwd: session.cwd,
        title: session.title,
        model: session.model,
        mode: claudeHost.modeOf?.(id) || session.mode,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      };
    },
    ...(process.env.NODE_TEST_CONTEXT ? { write: null, appRunning: async () => false } : {}),
  });
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
    platform,
    open,
    ...(claudeShown ? { shown: claudeShown } : {}),
    pending: async (id) => {
      const { session } = await claude.read(id, { limit: 1 });
      if (!session?.consent) return null;
      const running = await liveNow().catch(() => new Map());
      return running.get(id)?.where === "claude-app" ? session.consent : null;
    },
  });
  // A permission card the Claude app or the Codex app shows for one of its
  // chats, answered from the phone on the person's tap (app-cards.mjs).
  const appCards = createAppCards({
    read: readCard,
    platform,
    press: pressCard,
    answerQuestion,
    // The question a Claude app chat waits on (Claude's AskUserQuestion).
    pendingQuestion: async (agent, id) => {
      if (agent !== "claude") return null;
      const live = (await liveNow().catch(() => new Map())).get(id);
      if (live?.where !== "claude-app" || !live.waiting) return null;
      const { items } = await claude.read(id, { limit: 20 });
      const tool = [...(items || [])].reverse().find((i) => i.role === "tool");
      if (tool?.status !== "running" || !tool.questions?.length) return null;
      return { id: questionId(tool.id), questions: tool.questions, appSessionId: live.appSessionId || null };
    },
    ...(process.env.NODE_TEST_CONTEXT ? {} : { probe: (agent) => probeApp(agent, { dataDir }) }),
    terminal: terminals ? createTerminalCards({ terminals }) : null,
    open,
    ...(claudeShown ? { shown: claudeShown } : {}),
    pending: async (agent, id) => {
      if (agent === "codex") {
        // Read from the chat's file while the Codex app holds it (codex.mjs).
        const { session } = await codex.read(id, { limit: 1 });
        const asked = session?.asking;
        if (session?.held !== "codex-app" || asked?.kind !== "permission" || !asked.id || !asked.match) return null;
        return { id: asked.id, expect: cardExpect({ kind: "command", text: asked.match }) };
      }
      if (agent !== "claude") return null;
      const live = (await liveNow().catch(() => new Map())).get(id);
      const inTerminal = live?.where === "terminal" && !!live.tty && !!terminals;
      if ((live?.where !== "claude-app" && !inTerminal) || live.waiting !== "permission prompt") return null;
      const { items } = await claude.read(id, { limit: 20 });
      const tool = [...(items || [])].reverse().find((i) => i.role === "tool");
      if (tool?.status !== "running" || tool.consent || tool.questions) return null;
      return {
        id: cardId(tool.id),
        expect: cardExpect(tool),
        appSessionId: live.appSessionId || null,
        ...(inTerminal ? { tty: live.tty } : {}),
      };
    },
  });
  // Approval cards come only from live agent protocol requests. Desktop waits
  // without a reply connection are detected from agent state and use the screen.
  if (listenForAsks) macPrompts.start?.();
  // Working, not merely open: Reach's own turn, or an open process whose
  // transcript is mid-turn (recently) or just changed. The Claude app keeps a
  // process for every open session, so a process alone means nothing.
  // Claude sessions whose process Reach let go of, and when.
  const letGo = new Map();
  const claudeStatus = (s) => {
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
    // A process Reach has just let go of (after a turn, a Stop) is still
    // exiting: seen without Claude Code's word, it read as working for a few
    // seconds (the phone showed Working well after Stop). Not a guess then.
    if (Date.now() - (letGo.get(s.id) || 0) < 10000) return;
    const age = Date.now() - (s.updatedAt || 0);
    if (s.live && ((s.pending && age < 10 * 60 * 1000) || age < 30000)) s.status = "running";
  };
  // Turns Reach runs on Codex know their own state (approvals included).
  const codexStatus = (s) => {
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
  // A "signed in" answer is kept a while: asking Claude Code takes ~6 s, and
  // every message from the phone waited for it. Signed out is asked again.
  let signedInAt = 0;
  const signedInMs = 10 * 60 * 1000;
  const signedIn = async () => {
    if (Date.now() - signedInAt < signedInMs) return;
    const health = await claude.health().catch(() => null);
    if (health?.signedIn === true) signedInAt = Date.now();
    // Only a definite "signed out" stops it. A status Claude Code was too slow
    // to give (busy Mac, 10 s limit) isn't one: new chats failed with
    // "signed out" while Claude Code was signed in.
    if (health && health.signedIn === false && !health.error)
      throw blocked(`Claude Code is signed out on your ${computerWord(platform)}. Sign in to reply from here.`);
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
      throw blocked(`This session is open in a terminal on your ${computerWord(platform)}. Reply there or from the Terminal tab.`);
    if (holder.where !== "claude-app" || !holder.exact)
      throw blocked(`This session is open in another Claude Code process on your ${computerWord(platform)}. Reply there.`);
    return holder;
  };
  // The next piece of news from the agents' files that matches, or ms on
  // (whichever comes first).
  const agentNews = (matches, ms) =>
    new Promise((resolve) => {
      let off = () => {};
      const timer = setTimeout(() => {
        off();
        resolve(false);
      }, ms);
      timer.unref?.();
      off =
        agentWatch?.onChange((news) => {
          if (!matches(news)) return;
          clearTimeout(timer);
          off();
          resolve(true);
        }) || (() => {});
    });
  // The app in front on the Mac, as the menu bar's helper tells it (null:
  // not told; asked of macOS then).
  let front = null;
  const claudeCompose =
    givenCompose ||
    (process.env.NODE_TEST_CONTEXT
      ? null
      : createClaudeCompose({
          type: (message) => typeIntoClaude(message, { dataDir }),
          onScreen: () => claudeOnScreen({ dataDir }),
          open,
          arrived: (id, text, since, sent) => claude.arrived(id, text, since, sent),
          // Woken by the agents' files (agent-watch), with a slow look in
          // case a write goes unnoticed.
          transcriptNews: (id, ms) => agentNews((news) => news.agent === "claude" && news.id === id, Math.min(ms, 2000)),
          appNews: (ms) => agentNews((news) => news.agent === "claude" && news.kind === "app", Math.min(ms, 1000)),
          // What Reach last put in each chat's box, kept across restarts.
          store: draftFile(path.join(dataDir, "agent-drafts.json")),
          frontmost: () => (front === null ? claudeFrontmost() : front === CLAUDE_BUNDLE),
        }));
  // Messages waiting for the Claude app to finish its turn, in order, kept in
  // the outbox until each is handed to Claude Code: never dropped, and one
  // that can't go yet says why.
  let closed = false;
  const delivering = new Set();
  const deliveringMessage = new Map();
  const wakers = new Map();
  // Messages waiting for the Claude app try again now.
  const wakeAppMessages = () => {
    for (const [id, wake] of [...wakers]) if (outbox.list(id)[0]?.via === "app") wake();
  };
  const deliver = async (id) => {
    if (delivering.has(id)) return;
    delivering.add(id);
    const started = Date.now();
    // The last try put its message in: the next one goes on the usual beat
    // (what it says it waits for is from a try before that one).
    let wentIn = false;
    // The first try goes at once (a message just sent shouldn't sit idle).
    let tried = false;
    // What the last try waits for. When the Mac tells of it (the app in
    // front changing, the Claude app opening), that wakes the next try, and
    // otherwise it goes at its own time (when you'd count as away).
    let waitFor = null;
    const appPause = () => {
      if (front === null || !waitFor) return appRetryMs;
      if (waitFor.inApp) return waitFor.retryMs ?? appRetryMs;
      if (waitFor.appClosed) return 60000;
      return appRetryMs;
    };
    try {
      while (!closed && outbox.list(id).length) {
        // A deleted chat's messages wait for the phone, not for their chat.
        if (outbox.list(id)[0]?.stranded) break;
        // Waiting never keeps Reach from quitting; after two hours, less often.
        // One the Claude app hasn't taken: see appPause().
        const first = outbox.list(id)[0];
        const pause = !tried
          ? 0
          : Date.now() - started > 2 * 60 * 60 * 1000
            ? 30000
            : first?.via === "app" && first?.error && !wentIn
              ? appPause()
              : queueMs;
        tried = true;
        // Send now (or a new order) wakes it at once.
        await new Promise((r) => {
          const timer = setTimeout(r, outbox.list(id)[0]?.now ? 0 : pause);
          timer.unref?.();
          wakers.set(id, () => {
            clearTimeout(timer);
            r();
          });
        });
        wakers.delete(id);
        if (closed) break;
        const next = outbox.list(id)[0];
        if (!next || next.delivery === "paused" || next.delivery === "sending") break;
        try {
          deliveringMessage.set(id, next.id);
          if (next.via === "app") {
            if (!outbox.begin(id, next.id)) break;
            await claudeCompose.deliver(id, { title: next.title, text: next.text, images: next.images, ...(next.owner ? { owner: next.owner } : {}), ...(next.now ? { now: true } : {}), ...(next.mode ? { mode: next.mode } : {}) });
            outbox.remove(id, next.id);
            wentIn = true;
            continue;
          }
          const holder = await holderOf(id);
          if (holder && ((await busy(id, holder)) || !(await handOver(holder)))) {
            outbox.problem(id, next.id, null);
            continue;
          }
          const { id: messageId, at, error, ...message } = next;
          if (!outbox.begin(id, next.id)) break;
          await claudeHost.send(id, message);
          outbox.remove(id, messageId);
        } catch (e) {
          wentIn = false;
          waitFor = e;
          // Not in the Claude app's list, and Claude Code has no such chat
          // either: it was deleted. Its messages wait for the phone instead.
          if (e?.unlisted && claude.exists && !(await claude.exists(id).catch(() => true))) {
            outbox.strand(id);
            continue;
          }
          if (e?.retryable === false || (next.delivery === "sending" && !e?.waiting)) {
            outbox.pause(id, next.id, e?.retryable === false ? e.message : uncertainDelivery("claude").message);
            break;
          }
          outbox.retryLater(id, next.id);
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
  // Sessions the app already lists get its window reloaded instead (it
  // doesn't see what Reach added otherwise).
  claudeHost.onRelease?.((id, { wrote } = {}) => {
    letGo.set(id, Date.now());
    if (letGo.size > 200) letGo.delete(letGo.keys().next().value);
    // One waiting to join the app's list goes now; one the app lists and
    // Reach wrote to gets its window reloaded.
    if (claudeImports.pending?.().includes(id)) void claudeImports.check?.();
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
  // A chat written to on the Mac (a Claude Code transcript growing, as the
  // Claude app or a terminal writes it): counted for the chats the phone has
  // open, so their long poll wakes at once and the phone reads them again.
  const touched = new Map(); // "agent:id" -> writes seen
  const touchWaiters = new Map(); // "agent:id" -> long polls waiting
  // When each chat's long poll last came: a write in the instant between two
  // polls still counts (dropped, the phone showed Working until its 30 s look).
  const polled = new Map(); // "agent:id" -> ms
  const openMs = 60 * 1000;
  const chatOpen = (key) => !!touchWaiters.get(key)?.size || Date.now() - (polled.get(key) || 0) < openMs;
  const touch = (agent, id) => {
    const key = `${agent}:${id}`;
    if (!chatOpen(key)) return;
    touched.set(key, (touched.get(key) || 0) + 1);
    for (const wake of [...(touchWaiters.get(key) || [])]) wake();
  };
  // What each open Claude chat last saw of its own registry entry.
  const seenStatus = new Map(); // id -> "where busy waiting"
  const statusNews = async () => {
    // No Claude chat open on a phone: nothing to wake (the list itself is
    // rebuilt by listChanged, which every change calls).
    if (![...touchWaiters.keys(), ...polled.keys()].some((key) => key.startsWith("claude:"))) return;
    const running = await liveNow().catch(() => null);
    if (!running) return touchOpen("claude");
    for (const key of new Set([...touchWaiters.keys(), ...polled.keys()])) {
      if (!key.startsWith("claude:")) continue;
      const id = key.slice(7);
      const entry = running.get(id);
      const now = entry ? `${entry.where} ${!!entry.busy} ${entry.waiting || ""}` : "gone";
      if (seenStatus.get(id) === now) continue;
      seenStatus.set(id, now);
      if (seenStatus.size > 200) seenStatus.delete(seenStatus.keys().next().value);
      touch("claude", id);
    }
  };
  // Every chat of an agent the phone has open reads again.
  const touchOpen = (agent) => {
    for (const key of new Set([...touchWaiters.keys(), ...polled.keys()]))
      if (key.startsWith(`${agent}:`)) touch(agent, key.slice(agent.length + 1));
  };
  agentWatch?.onChange((news) => {
    // Whatever an agent wrote may change the list (its status, a new chat).
    if (news.agent === "codex") codexDirty = true;
    listChanged();
    if (news.agent === "codex") {
      // One Codex chat's own file: that chat, if open, reads again. The Codex
      // app's queue or history: the open chats read again. Its saved choices
      // (a permission mode picked in the app): the open Codex chats show it.
      if (news.kind === "rollout") touch("codex", news.id);
      else if (news.kind === "settings") touchOpen("codex");
      else codexLive.nudge?.(news.kind);
    } else if (news.agent === "claude" && news.kind === "app") {
      // The Claude app's records (the chat on screen changed): a message
      // waiting for its chat to show tries again now. A record says a chat's
      // permission mode too: the open Claude chats show one picked in the app.
      wakeAppMessages();
      touchOpen("claude");
    } else if (news.agent === "claude" && news.kind === "status") {
      // Claude Code's registry (a session busy, idle, waiting on you): read
      // afresh, not from the shared look at the processes (up to liveMs
      // old). Only the open Claude chats whose own entry changed read again
      // (any session on the Mac writes it, all the time, while it works).
      liveCache = null;
      void statusNews();
    } else if (news.agent === "claude" && news.id && !claudeHost.drives(news.id)) {
      // A Claude Code transcript: unless Reach is the one writing it.
      touch("claude", news.id);
    }
  });
  // Each agent's working/waiting status, from what its host knows.
  const statusOf = (agent) => (agent === "claude" ? claudeStatus : agent === "codex" ? codexStatus : () => {});
  // Agents mark a chat waiting for a moment while they decide by themselves
  // (Codex's "Approve for me" reviewer, a command a saved rule allows): it
  // flashed on the phone as "needs your answer" and was gone. Only a chat
  // still waiting settleMs later is waiting on you. Prompts in chats Reach
  // drives are real requests and count at once.
  const waitingSince = new Map();
  const settleWaiting = (s) => {
    const key = `${s.agent}:${s.id}`;
    if (s.status !== "waiting" || hosts[s.agent]?.drives(s.id)) return void waitingSince.delete(key);
    // Counted from when the agent began waiting, when it says (a Codex
    // request read from its file has already waited out its own settle).
    const since = Math.min(waitingSince.get(key) ?? Date.now(), s.waitingSince || Infinity);
    waitingSince.set(key, since);
    const left = (s.agent === "claude" ? claudeSettleMs : settleMs) - (Date.now() - since);
    if (left <= 0) return;
    s.status = "running";
    delete s.asking;
    delete s.waitingSince;
    // Nothing else would say it's still waiting (it writes nothing): look
    // again when its time is up.
    recheck(key, left, () => touch(s.agent, s.id));
  };
  // One look again per chat, at its deadline: the list rebuilt, and the chat
  // (if open on a phone) read again.
  const rechecks = new Map();
  const recheck = (key, ms, wake) => {
    if (rechecks.has(key)) return;
    const timer = setTimeout(() => {
      rechecks.delete(key);
      listChanged();
      wake?.();
    }, ms + 50);
    timer.unref?.();
    rechecks.set(key, timer);
  };
  codex.onLater?.((ms, id) =>
    recheck(`codex:${id}:request`, ms, () => {
      codexDirty = true;
      listChanged();
      touch("codex", id);
    }),
  );
  // Codex's own list costs its daemon a quarter of a second: kept from one
  // build to the next until Codex says something changed (copied for each
  // build, which marks statuses on its sessions).
  let codexKept = null;
  let codexDirty = true;
  const codexList = () => {
    if (codexDirty || !codexKept || !listMaxAgeMs) {
      codexDirty = false;
      codexKept = codex.list();
      codexKept.catch(() => {
        codexKept = null;
        codexDirty = true;
      });
    }
    return codexKept.then((list) => list.map((s) => ({ ...s })));
  };
  // One list for every phone and for the notifications. It's rebuilt when
  // something in it may have changed (an agent's files or status, Codex's
  // notices, the Mac's dialogs, a chat's deadline), at most once per
  // listGapMs, and kept otherwise: devices learn of a new one from its
  // revision on their live connection, instead of asking every few seconds.
  let listKept = null; // { value, json, at }
  let listBuilding = null;
  let listDirty = true;
  let listRevision = 0;
  let listBuiltAt = 0;
  let listTimer = null;
  const listListeners = new Set();
  const rebuildList = () => {
    listDirty = false;
    listBuiltAt = Date.now();
    listBuilding ||= buildList()
      .then((value) => {
        const json = JSON.stringify(value);
        const changed = json !== listKept?.json;
        listKept = { value, json, at: Date.now() };
        if (changed) {
          listRevision++;
          for (const listener of listListeners) listener(listRevision);
        }
        return value;
      })
      .finally(() => {
        listBuilding = null;
      });
    return listBuilding;
  };
  function listChanged() {
    listDirty = true;
    // Nobody listening: built when next asked for. Otherwise soon, at most
    // once a gap however fast the agents write.
    if (!proactive || !listListeners.size || listTimer) return;
    listTimer = setTimeout(
      () => {
        listTimer = null;
        void (listBuilding || Promise.resolve())
          .catch(() => {})
          .then(() => listDirty && rebuildList())
          .catch(() => {});
      },
      Math.max(0, listGapMs - (Date.now() - listBuiltAt)),
    );
    listTimer.unref?.();
  }
  // Codex's own notices (a chat's status, its turns, its name) and the Mac's
  // dialogs are in the list too.
  daemon.onNotification?.(() => {
    codexDirty = true;
    listChanged();
  });
  macPrompts.onChange?.(() => listChanged());
  // Chats Reach drives say their status and questions over the live
  // protocol, not in a file (a Codex approval is a request, not a notice):
  // the list hears of them at once too.
  codexLive.onChange?.((id) => {
    const mode = codexLive.currentMode?.(id);
    if (mode) chatModes.set(id, mode);
    listChanged();
  });
  claudeHost.onChange?.(() => listChanged());
  // A whole Codex chat, oldest first, kept a minute (a moved chat pages
  // through the one it continues).
  const codexWhole = new Map();
  const codexHistory = async (id) => {
    const kept = codexWhole.get(id);
    if (kept && Date.now() - kept.at < 60000) return kept.value;
    const pages = [];
    let cursor = null;
    let session = null;
    const seen = new Set();
    for (;;) {
      const page = await codex.read(id, { cursor, limit: 500, maxOutput: Infinity });
      session ??= page.session;
      pages.unshift(page.items);
      if (!page.before) break;
      if (seen.has(page.before)) throw new Error("Codex returned a repeated history page. The conversation was not moved.");
      seen.add(page.before);
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
  const history = async (agent, id) => {
    const result = await (agent === "claude"
      ? claude.history(id)
      : agent === "openclaw"
        ? clawHistory(id)
        : agent === "gemini"
          ? gemini.history(id)
          : codexHistory(id));
    return { ...result, items: result.items.map(item => item.images ? { ...item, imageOrigin: item.imageOrigin || { agent, id, item: item.id } } : item) };
  };
  // The apps a chat can move between.
  const movable = () => ["codex", "claude", ...(openClaw && openClaw.canMove?.() !== false ? ["openclaw"] : [])];
  // Where a chat was when it moved: up to its last item then (or as many
  // items as it had, should that one read differently now).
  const cutAt = (items, from) => {
    const at = from.upTo ? items.findIndex((i) => i.id === from.upTo) + 1 : 0;
    return at > 0 ? at : Math.min(Number(from.count) || items.length, items.length);
  };
  const word = computerWord(platform);
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
  const shown = async (agent, id, from = null, seen = new Set(), strict = false) => {
    const key = `${agent}:${id}`;
    if (seen.has(key)) throw new Error("The conversation's transfer history contains a loop.");
    seen = new Set([...seen, key]);
    if (strict && agent === "codex") codexWhole.delete(id);
    let { items } = await history(agent, id);
    if (from) items = items.slice(0, cutAt(items, from));
    const origin = moves.into(agent, id);
    if (!origin || origin.to.nativeHistory) return items;
    // A Claude Code chat begins with the history written for it: shown as
    // the original chat's own messages instead.
    if (origin.to.hidden) items = items.slice(origin.to.hidden);
    const before = await earlier(origin, seen, strict);
    return [...(before || []), joinLine(origin, agent, !!before), ...items];
  };
  // The chat a moved one continues, up to the move; null when it is no
  // longer on this Mac (Claude Code deletes old transcripts).
  const earlier = async (origin, seen = new Set(), strict = false) => {
    try {
      return await shown(origin.from.agent, origin.from.id, origin.from, seen, strict);
    } catch (error) {
      if (strict) throw error;
      return null;
    }
  };
  const moving = new Set();
  // Every chat on this computer, with its status (see list() below).
  const buildList = async () => {
    const [c, k, p, g] = await Promise.allSettled([codexList(), claude.list(), codex.projects?.() ?? [], gemini.list()]);
    const sessions = [...(c.value || []), ...(k.value || []), ...(g.value || [])];
    // Only live protocol requests have an answer channel. Transcript text
    // and pre-review checks never become actionable approval cards.
    for (const s of sessions) {
      const driven = !!hosts[s.agent]?.drives(s.id);
      const asked = driven ? hosts[s.agent].view(s.id).prompts || [] : [];
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
    for (const s of sessions) settleWaiting(s);
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
  };
  return {
    onPromptChange(listener) {
      const stops = Object.entries(hosts).map(([agent, h]) => h.onChange?.(id => listener(agent, id, h.view(id).prompts)));
      return () => stops.forEach(stop => stop?.());
    },
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
        if (agent === "codex") codexWhole.delete(id);
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
        let nativeHistory = false;
        // Export the entire visible history, including pre-compaction messages.
        // Resolve attachments before creating a target, so a missing image cannot
        // silently turn into a placeholder in an otherwise successful transfer.
        const complete = to === "codex" || to === "claude" ? (await shown(agent, id, null, new Set(), true)).map(item => ({ ...item })) : null;
        if (complete) for (const item of complete) {
          if (!item.images) continue;
          const source = item.imageOrigin || { agent, id, item: item.id };
          item.imageData = [];
          for (let n = 0; n < item.images; n++) {
            const image = await adapter(source.agent).image(source.id, source.item, n);
            item.imageData.push(`data:${image.type};base64,${image.data.toString("base64")}`);
          }
        }
        if (to === "codex") {
          ({ threadId: target } = await codexLive.forkHistory({
            cwd: session.cwd,
            name: title,
            items: complete,
            from,
          }));
          nativeHistory = true;
        } else if (to === "openclaw") {
          ({ key: target } = await openClaw.fork({ title, notes: openClawNotes(turns, { note, from }), label: `Moved from ${from}` }));
        } else {
          ({ id: target } = await claude.write({ cwd: session.cwd, title, items: complete, from, gitBranch: session.branch || "" }));
          nativeHistory = true;
          // In the Claude app's list too, once nobody is at the Mac.
          void claudeImports.add(target);
        }
        // A Claude Code target begins with the history written for it, which
        // Reach shows as the original chat's own messages instead.
        moves.add({
          from: { agent, id, title, upTo: items.at(-1)?.id || null, count: items.length },
          to: { agent: to, id: target, ...(nativeHistory ? { nativeHistory: true } : {}) },
        });
        return { agent: to, id: target };
      } finally {
        moving.delete(key);
      }
    },
    signIn,
    connectors,
    logos,
    // An agent's files changed (agent-watch): what a chat's status reads from.
    onActivity: (listener) => agentWatch?.onChange(listener) || (() => {}),
    // Sending, approving and stopping, exactly as in the agent's own app.
    async send(agent, id, body) {
      // Without a pick: the mode this chat was given from Reach; for a chat
      // Reach never set, the Codex app composer's current mode, as from the app.
      if (host(agent) === codexLive) {
        // A skill picked from "/": found in Codex's own list for the chat.
        const skill = typeof body.skill === "string" && body.skill ? await slash.skill(id, body.skill) : undefined;
        const sent = await codexLive.send(id, { ...body, skill, mode: body.mode || chatModes.get(id) || codex.appMode?.() || undefined });
        if (body.mode) chatModes.set(id, body.mode);
        return sent;
      }
      // Claude Code keeps sessions per folder: resume it where it began.
      const { session } = await claude.read(id, { limit: 1 });
      // Without a pick: the chat's own mode (its app's, else the one its
      // latest message ran in). Resumed without it, Claude Code fell back to
      // Manual and asked about everything in a chat set to Auto.
      // The mode Reach gave it comes first: the transcript keeps the mode of
      // the last message, so a pick of Auto went back to Manual on the next.
      const ours = !session.inApp || claudeHost.drives(id) ? claudeHost.modeOf?.(id) : null;
      const kept = body.mode || ours || session.mode;
      const message = { ...body, cwd: session.cwd, ...(kept ? { mode: kept } : {}) };
      const holder = await holderOf(id);
      // A chat the Claude app lists, with the app open: typed into the app
      // itself, so its window shows it at once (Reach's own Claude Code
      // process never showed there). The app signs in on its own.
      if (claudeCompose && session.inApp && (!holder || holder.where === "claude-app") && !claudeHost.drives(id) && (await claudeOpen())) {
        if ((body.model && body.model !== session.model) || (body.effort && body.effort !== session.effort))
          throw Object.assign(new Error("Choose the model or thinking level with this chat's settings before sending. This message hasn't been sent."), { status: 409 });
        const queued = outbox.add(id, { text: body.text || "", images: body.images || [], via: "app", title: session.appTitle || "Untitled", ...(body.owner ? { owner: body.owner } : {}), ...(body.mode ? { mode: body.mode } : {}) });
        // A loop already waiting tries again now, with this one in line.
        wakers.get(id)?.();
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
      // A chat the Claude app doesn't list (Reach's, or one from a
      // terminal): it joins the app's list once Reach lets go of it.
      if (!session.inApp) void claudeImports.add(id);
      return claudeHost.send(id, message);
    },
    async start(agent, body) {
      if (host(agent) === codexLive) {
        const started = await codexLive.start(body);
        // Its next messages keep the mode it started in.
        if (body.modeName) chatModes.set(started.threadId, body.modeName);
        return started;
      }
      await signedIn();
      const started = await claudeHost.start(body);
      void claudeImports.add(started.threadId);
      return started;
    },
    // A permission mode picked on the phone for a chat the Claude app holds:
    // picked in the app's own menu, so both show it. Elsewhere (chats Reach
    // runs, Codex) it goes with the next message, as before.
    async model(agent, id, { model, effort }) {
      adapter(agent);
      if (agent === "claude" && !claudeHost.drives(id) && claudeCompose && await claudeOpen()) {
        const { session } = await claude.read(id, { limit: 1 });
        if (session.inApp) {
          // Apply to the app's own visible chat; the CLI host cannot mutate a
          // desktop-owned process. Catalog IDs become exact native menu names.
          if (model && model !== session.model) {
            if (!claudeCompose.model)
              throw Object.assign(new Error("Reach can't change the model in this Claude app. Your current selection is unchanged."), { status: 409 });
            const catalog = await claudeHost.models();
            const entry = catalog.find((m) => m.value === model || m.resolvedModel === model);
            const name = entry && claudeModelName(entry.resolvedModel);
            if (!name)
              throw Object.assign(new Error("Claude didn't identify that desktop model. Your current selection is unchanged."), { status: 409 });
            const result = await claudeCompose.model(id, { title: session.appTitle || "Untitled", model: name });
            listChanged();
            if (result?.model !== name || result.unconfirmed)
              throw Object.assign(new Error("Claude didn't confirm the model change. Check the model in Claude before trying again."), { status: 409 });
          }
          if (effort && effort !== session.effort) {
            if (!claudeCompose.effort)
              throw Object.assign(new Error("Reach can't change the thinking level in this Claude app. Check its current settings."), { status: 409 });
            const result = await claudeCompose.effort(id, { title: session.appTitle || "Untitled", effort });
            listChanged();
            // A click alone is not acknowledgement. The app's own record can
            // confirm a chip that has not redrawn; otherwise keep uncertainty.
            if ((result?.effort !== effort || result.unconfirmed) && (await claude.read(id, { limit: 1 })).session.effort !== effort)
              throw Object.assign(new Error("Claude didn't confirm the thinking level. Check it in Claude before trying again."), { status: 409 });
          }
          return { model, effort, applied: true };
        }
      }
      if (agent !== "codex") return { model, effort, applied: false };
      return codexLive.model(id, { model, effort });
    },
    async mode(agent, id, { mode }) {
      adapter(agent);
      // Codex: kept for the chat at once (its next message from Reach goes
      // in it, whoever sends it), not only when this phone sends next.
      if (agent === "codex") {
        const applied = await codexLive.mode(id, mode);
        chatModes.set(id, mode);
        listChanged();
        return applied;
      }
      // A chat Reach runs: changed in its Claude Code right away.
      if (agent === "claude" && (await claudeHost.mode?.(id, mode))) return { mode, applied: true };
      if (agent !== "claude" || !claudeCompose?.mode) return { mode, applied: false };
      const { session } = await claude.read(id, { limit: 1 });
      if (!session.inApp || claudeHost.drives(id)) return { mode, applied: false };
      return { ...(await claudeCompose.mode(id, { title: session.appTitle || "Untitled", mode })), applied: true };
    },
    async draft(agent, id, { text, owner }) {
      adapter(agent);
      if (agent !== "claude" || !claudeCompose?.draft) return { synced: false, supported: false };
      if (outbox.list(id).length) throw Object.assign(new Error("Waiting for the previous message to send."), { status: 409 });
      const { session } = await claude.read(id, { limit: 1 });
      if (!session.inApp || claudeHost.drives(id)) return { synced: false, supported: false };
      return claudeCompose.draft(id, { title: session.appTitle || "Untitled", text, owner });
    },
    // Archived in the agent's own app (Codex's archive, the Claude app's
    // record), so the app and Reach show the same: it leaves both lists.
    async archive(agent, id, { archived = true } = {}) {
      const store = adapter(agent);
      if (!store.archive) throw Object.assign(new Error(`${agentName(agent)} chats can't be archived.`), { status: 400 });
      const done = await store.archive(id, archived !== false);
      listChanged();
      return done;
    },
    async stop(agent, id) {
      const current = host(agent);
      if (agent === "claude" && !claudeHost.drives(id) && claudeCompose?.stop) {
        const { session } = await claude.read(id, { limit: 1 });
        if (session.inApp) return claudeCompose.stop(id, { title: session.appTitle || "Untitled" });
      }
      return current.stop(id);
    },
    // Send now, as the agents' apps have it: first in line and in at once
    // (a Claude app chat switches to it even while the Mac is in use; Codex
    // steers it into the turn it's running, as the Codex app's Steer).
    async sendQueuedNow(agent, id, messageId) {
      if (host(agent) === codexLive) return codexLive.sendQueuedNow(id, messageId);
      const message = outbox.list(id).find((m) => m.id === messageId);
      if (!message) throw Object.assign(new Error("That message already left the queue."), { status: 409 });
      if (message.delivery) throw Object.assign(new Error("Delivery is in progress or uncertain. Check Claude before sending again."), { status: 409 });
      if (message.via !== "app")
        throw Object.assign(new Error("It goes as soon as Claude finishes where it's running."), { status: 409 });
      if (deliveringMessage.get(id) !== messageId) outbox.hurry(id, messageId);
      wakers.get(id)?.();
      void deliver(id);
      return { hurried: true };
    },
    // A new order for what waits, dragged on the phone (Claude's outbox only:
    // Codex keeps its own queue).
    async reorderQueued(agent, id, order) {
      if (host(agent) === codexLive) return codexLive.reorderQueued(id, order);
      if (!Array.isArray(order) || order.length > 100 || !order.every((m) => typeof m === "string"))
        throw Object.assign(new Error("Invalid order."), { status: 400 });
      if (!outbox.reorder(id, order, deliveringMessage.get(id) || null))
        throw Object.assign(new Error("The queue changed. Try again."), { status: 409 });
      return { reordered: true };
    },
    // Your last message edited and sent again, as the Codex app's Edit.
    async editLast(agent, id, body) {
      if (host(agent) !== codexLive) throw Object.assign(new Error("Edit your last message from the Claude app."), { status: 409 });
      return codexLive.editLast(id, body);
    },
    // A queued message edited where it waits, as in both apps.
    async editQueued(agent, id, messageId, text) {
      if (host(agent) === codexLive) return codexLive.editQueued(id, messageId, text);
      if (deliveringMessage.get(id) === messageId)
        throw Object.assign(new Error("That message is being sent. Wait for the chat to update."), { status: 409 });
      if (!outbox.edit(id, messageId, text))
        throw Object.assign(new Error("That message already left the queue."), { status: 409 });
      return { edited: true };
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
    // A message whose chat was deleted, sent to another chat from the phone:
    // it leaves the outbox only once the other chat has it.
    async sendStranded(messageId, to = {}, owner) {
      const found = outbox.stranded().find((m) => m.id === messageId);
      if (!found) throw Object.assign(new Error("That message is no longer waiting."), { status: 409 });
      if (typeof to.agent !== "string" || typeof to.id !== "string" || to.id === found.session)
        throw Object.assign(new Error("Pick another chat."), { status: 400 });
      const message = outbox.list(found.session).find((m) => m.id === messageId);
      const result = await this.send(to.agent, to.id, { text: message.text, images: message.images, ...(owner ? { owner } : {}) });
      outbox.remove(found.session, messageId);
      return result;
    },
    // Messages from the phone waiting for their Claude app chat to be on
    // screen (you use the Claude app in another chat, or the chat's box holds
    // your text): Reach's menu bar item lists them; a click opens the chat.
    waitingOnMac() {
      const records = appShown();
      return outbox.sessions().flatMap((id) => {
        const list = outbox.list(id);
        const head = list[0];
        const record = records.find((r) => r.id === id);
        if (!head || head.via !== "app" || head.stranded || !head.error || !record) return [];
        return [{ id, title: head.title || "Untitled", count: list.length, link: `claude://code/continue?session=${record.session}` }];
      });
    },
    onOutbox: (listener) => outbox.onChange(listener),
    // Messages from the phone whose chat was deleted, to send elsewhere.
    stranded: () => outbox.stranded(),
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
      if (agent === "codex") return codex.image(id, item, n);
      if (agent !== "claude") throw Object.assign(new Error("That picture isn't in this session."), { status: 404 });
      return claude.image(id, item, n);
    },
    // A permission card as its app shows it (its words and buttons), for the
    // phone to draw; brings that chat up in the app (app-cards.mjs).
    card: (agent, id) => appCards.card(agent, id),
    respond: async (agent, id, promptId, answer) =>
      agent === "claude" && claudeConsent.owns(promptId)
          ? claudeConsent.answer(id, promptId, answer)
          : (agent === "claude" || agent === "codex") && appCards.owns(promptId)
            ? appCards.answer(agent, id, promptId, answer)
            : host(agent).respond(id, promptId, answer),
    view(agent, id) {
      const view = liveHost(agent).view(id);
      const writes = touched.get(`${agent}:${id}`) || 0;
      return {
        ...view,
        // One version for all, so the long poll wakes on any; a write on the
        // Mac counts as something new to read.
        version: view.version + outbox.version() + writes,
        items: (view.items || 0) + writes,
        ...(agent === "claude"
          ? {
              queued: outbox.list(id).length,
              // Sent from the phone, waiting their turn (shown until they're in the transcript).
              outbox: outbox.list(id).map(({ id: messageId, text, images, at, error, via, now, delivery }) => ({
                id: messageId,
                text,
                images: images.length,
                at,
                ...(via ? { via } : {}),
                ...(error ? { error } : {}),
                ...(delivery === "paused" ? { delivery } : {}),
                ...(delivery !== "paused" && (now || deliveringMessage.get(id) === messageId) ? { sending: true } : {}),
              })),
            }
          : {}),
      };
    },
    // Long poll: resolves when the session changes, or after `ms`.
    changes(agent, id, since, ms, signal) {
      const hostVersion = liveHost(agent).view(id).version;
      const key = `${agent}:${id}`;
      polled.delete(key);
      polled.set(key, Date.now());
      if (polled.size > 200) polled.delete(polled.keys().next().value);
      if (hostVersion + outbox.version() + (touched.get(key) || 0) !== Number(since)) return Promise.resolve();
      return new Promise((resolve) => {
        const stops = [];
        const done = () => {
          for (const stop of stops) stop();
          resolve();
        };
        const waiting = touchWaiters.get(key) || new Set();
        touchWaiters.set(key, waiting.add(done));
        stops.push(() => {
          waiting.delete(done);
          if (!waiting.size) touchWaiters.delete(key);
        });
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
      // The helpers that read and press an app's card, built just after
      // start (2-5 s each, cached by their source), so the first card opened
      // on the phone doesn't wait for a build.
      if (listenForAsks && process.platform === "darwin")
        setTimeout(() => {
          if (closed) return;
          for (const kind of ["permission-card", "claude-consent"]) desktopBinary({ dataDir }, kind).catch(() => {});
        }, 2000).unref?.();
      return this.list().catch(() => null);
    },
    // Reach is quitting: end sign-ins and replies in progress, and let go of
    // the Codex daemon (its open socket would keep Reach running).
    close() {
      closed = true;
      connectors.close();
      for (const agent of ["claude", "codex"]) signIn?.cancel?.(agent);
      claudeHost?.close?.();
      claudeImports?.close?.();
      claudeRefresh?.close?.();
      macPrompts?.close?.();
      agentWatch?.close?.();
      daemon.close?.();
    },
    // The list as last built while nothing changed, or while its rebuild is
    // already on its way (devices hear of it then): one build per listGapMs
    // however many ask. Rebuilt when something changed, when it's older than
    // listMaxAgeMs (the safety net for what isn't watched), or when asked
    // fresh (Refresh on the phone).
    async list({ fresh = false } = {}) {
      if (fresh) {
        // Everything read again: Codex's list and the processes too.
        codexDirty = true;
        liveCache = null;
        await listBuilding?.catch(() => {});
      } else if (listKept && (!listDirty || listTimer) && Date.now() - listKept.at < listMaxAgeMs) return listKept.value;
      return listBuilding || rebuildList();
    },
    // Its revision, for devices' live connections (each new one is news).
    listRevision: () => listRevision,
    // The app in front on the Mac, from the menu bar's helper (null: it
    // stopped telling), and apps opening: a message waiting because you're
    // in the Claude app, or for the app to open, tries again at once.
    frontmost(bundle) {
      const was = front;
      front = bundle ?? null;
      if (front !== was && front !== CLAUDE_BUNDLE) wakeAppMessages();
    },
    launched(bundle) {
      if (bundle === CLAUDE_BUNDLE) wakeAppMessages();
    },
    onListChange(listener) {
      listListeners.add(listener);
      listChanged();
      return () => listListeners.delete(listener);
    },
    async read(agent, id, options) {
      // A moved chat shows the one it continues above its own messages, as
      // if forked in the same app: older pages go on into that chat.
      const origin = moves.into(agent, id);
      const limit = Math.min(Math.max(Number(options?.limit) || 200, 1), 500);
      if (origin && !origin.to.nativeHistory && typeof options?.before === "string" && options.before.startsWith("moved:")) {
        const items = (await earlier(origin)) || [];
        const end = Math.min(Math.max(Number(options.before.slice(6)) || 0, 0), items.length);
        const start = Math.max(0, end - limit);
        return { items: items.slice(start, end), before: start > 0 ? `moved:${start}` : null };
      }
      const result = await adapter(agent).read(id, options);
      // What its next message will use, shown as its mode.
      if (agent === "codex" && result.session && chatModes.get(id)) result.session.mode = chatModes.get(id);
      if (agent === "claude" && result.session && claudeHost.modeOf?.(id) && (!result.session.inApp || claudeHost.drives(id)))
        result.session.mode = claudeHost.modeOf(id);
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
        if (!origin.to.nativeHistory && !result.before) {
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
        // What Claude Code says it waits on: "permission prompt", "input
        // needed" (a question), or "dialog open" (something else of its own,
        // a notice to acknowledge), never shown as a permission for a tool.
        if (result.session.live.waiting === "dialog open")
          result.session.asking = { kind: "dialog", text: "Claude Code has something open for you to answer." };
        else if (tool?.status === "running")
          result.session.asking = tool.questions
            ? {
                kind: "question",
                questions: tool.questions,
                // In the Claude app: answered from the phone, its options
                // pressed there (app-cards.mjs).
                ...(result.session.live.where === "claude-app" ? { id: questionId(tool.id) } : {}),
              }
            : {
                kind: "permission",
                text: tool.text,
                command: tool.kind === "command",
                // The Claude app's card, answered from the phone (Allow once
                // or Deny): its id names this request.
                ...((result.session.live.where === "claude-app" ||
                  (result.session.live.where === "terminal" && result.session.live.tty && terminals)) &&
                result.session.live.waiting === "permission prompt" &&
                cardExpect(tool).length
                  ? { id: cardId(tool.id) }
                  : {}),
              };
      }
      // A card answerable from the phone: its helper built while it's read,
      // so the tap is quick (not at start: the compiler would hold up quitting).
      if (newest && result.session.asking?.id?.startsWith?.("app-permission:") && listenForAsks && process.platform === "darwin")
        desktopBinary({ dataDir }, "permission-card").catch(() => {});
      if (newest) settleWaiting(result.session);
      return result;
    },
    // The agents on this Mac: the two Reach drives, then others it knows of
    // (installed, not yet supported), so the phone can show where it's going.
    async health({ fresh = false } = {}) {
      const results = await Promise.allSettled([codex.health(), claude.health(), claudeApp()]);
      const compatibility = await Promise.allSettled([daemon.compatibility?.() || null, claudeCompatibility()]);
      const driven = results.slice(0, 2).map((r, i) => ({
        ...(r.status === "fulfilled"
          ? r.value
          : { agent: ["codex", "claude"][i], installed: false, signedIn: false, ...(["AGENT_NOT_INSTALLED", "ENOENT"].includes(r.reason?.code) ? {} : { error: r.reason?.message || "Could not check this app. Try again." }) }),
        compatibility: compatibility[i].status === "fulfilled" ? compatibility[i].value : { status: "unavailable", reason: "Compatibility check failed." },
        name: ["Codex", "Claude Code"][i],
        supported: true,
        // Claude: its app's own sign-in, shown next to the CLI's.
        ...(i === 1 && results[2].status === "fulfilled" ? { app: results[2].value } : {}),
      }));
      const others = await detect({ fresh }).catch(() => []);
      // Gemini CLI: its chats are read here (gemini.mjs), so it's one Reach
      // supports, whatever the generic detection says.
      const gem = await gemini.health().catch(() => null);
      const merged = others.map((o) =>
        o.agent === "gemini" && gem?.installed
          ? { ...o, ...gem, name: o.name || "Gemini CLI", supported: true }
          : // OpenClaw: whether its Gateway can take a moved chat (2026.3.13 can't).
            o.agent === "openclaw" && openClaw
            ? { ...o, canTakeMoves: openClaw.canMove?.() !== false }
            : o,
      );
      if (gem?.installed && !merged.some((o) => o.agent === "gemini")) merged.push({ ...gem, name: "Gemini CLI", supported: true });
      return [...driven, ...merged];
    },
    // Slash commands the agent offers after "/" (Claude Code's from its handshake).
    // (Claude Code's from its handshake in the chat's folder; Codex's own
    // commands its installed version answers, and its skills there.)
    async commands(agent, { id } = {}) {
      adapter(agent);
      return slash.list(agent, { id });
    },
    // One of Codex's own commands, run in the chat (Claude Code runs its
    // commands as the message itself).
    async runCommand(agent, id, name, args) {
      adapter(agent);
      return slash.run(agent, id, name, args);
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
