import { uncertainDelivery, probeAgent, reportTooOld, tooOldError } from "./compatibility.mjs";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { agentCommand } from "../app-shortcuts.mjs";
import { createCodexDaemon } from "./codex-daemon.mjs";
import { createCodexSessions, codexStartMode } from "./codex.mjs";
import { createCodexLive } from "./codex-live.mjs";
import { createCodexDesktop } from "./codex-desktop.mjs";
import { createClaudeSessions } from "./claude.mjs";
import { liveClaudeSessions, readSessionRegistry } from "./processes.mjs";
import { createSignIn } from "./sign-in.mjs";
import { createFileSearch } from "./file-search.mjs";
import { findCodexExecutable } from "../capabilities.mjs";
import { findWindowsCli } from "../agent-cli.mjs";
import { createClaudeHost, claudeMode, SWITCHABLE_MODES } from "./claude-host.mjs";
import { createLogos } from "./logos.mjs";
import { claudeAppAccess, claudeAppRunning, claudeAppShown, createClaudeImports, createClaudeRefresh, idleSeconds, screenLocked } from "./claude-import.mjs";
import { createClaudeConsent, pressClaudeConsent } from "./claude-consent.mjs";
import { createAppCards } from "./app-cards.mjs";
import { agentAskSocket, createAgentAsks, stillAsked } from "./agent-asks.mjs";
import { agentHookCommand, agentModeHookCommand, claudeHookState, installClaudeHook, uninstallClaudeHook } from "./agent-hook-install.mjs";
import { createOutbox } from "./outbox.mjs";
import { createChatModes } from "./chat-modes.mjs";
import { CLAUDE_BUNDLE, claudeOnScreen, createClaudeCompose, draftFile, openInBackground, typeIntoClaude } from "./claude-compose.mjs";
import { createMacPrompts } from "../mac-prompts.mjs";
import { apps as platformApps } from "../platform.mjs";
import { computerWord } from "../computer-word.mjs";
import { desktopBinary } from "../desktop-native.mjs";
import { prepareOwners, useOwnersFolder } from "../windows-owners.mjs";
import { agentName, createMoves, handoff, moveTurns, openClawNotes, resumeText } from "./move.mjs";
import { forkNotes } from "./portable-history.mjs";
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

// What Claude Code waits on besides a tool's permission (its registry's
// waitingFor), in its notifications' words (2.1.295); any other, its word.
const CLAUDE_WAITS = {
  "dialog open": "Claude Code has something open for you to answer.",
  "sandbox request": "A sandboxed command needs network access.",
  "goal proposal": "Claude proposed a session goal.",
};

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

// An agent that isn't on this computer: said so, never shown as an error.
const notInstalled = (reason) => ["AGENT_NOT_INSTALLED", "ENOENT"].includes(reason?.code);
// Too old for Reach (compatibility.mjs): installed (its version was read),
// never offered for new work (needs: an update), and the phone names the
// version to update to. Its own check's error is that, said there.
export function agedOut(entry, report = entry.compatibility) {
  const old = reportTooOld(report);
  if (!old) return entry;
  const { error, ...rest } = entry;
  return {
    ...rest,
    installed: true,
    tooOld: { version: old.version, to: old.to },
    needs: [...new Set([...(Array.isArray(rest.needs) ? rest.needs : []), "update"])],
  };
}

// The claude executable as the owner's login shell finds it (Reach may run
// with a shorter PATH than their terminal).
let claudeAt = null;
let claudeFound = null;
// When it was last not found: a computer without Claude Code asked its login
// shell twice on every health check. Looked for again after a while, or at
// once when the phone checks again (forgetClaudeMiss).
let claudeMissedAt = 0;
const claudeMissMs = 30000;
// Where Claude Code lands without being on PATH: its installer's folder
// (~/.local/bin, which a fresh install often hasn't added to the shell yet),
// its older local install, and the copy the Claude desktop app keeps for
// itself (verified, newest version first). Oct 12: someone with only the
// Claude app, or a fresh install, was told Claude Code isn't installed, and
// installing from the phone looked like nothing happened.
export function claudeInstallLocations({ platform = process.platform, env = process.env, home = os.homedir(), readdir = (dir) => fs.readdirSync(dir), exists = fs.existsSync } = {}) {
  const win = platform === "win32";
  const paths = win ? path.win32 : path.posix;
  const at = (name) => Object.entries(env).find(([key]) => key.toUpperCase() === name)?.[1];
  const appData = win ? at("APPDATA") || paths.join(home, "AppData", "Roaming") : paths.join(home, "Library", "Application Support");
  const own = win ? [] : [paths.join(home, ".local", "bin", "claude"), paths.join(home, ".claude", "local", "claude")];
  const bundled = [];
  const root = paths.join(appData, "Claude", "claude-code");
  const version = (name) => name.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const newer = (a, b) => { const x = version(a), y = version(b); for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] || 0) !== (y[i] || 0)) return (y[i] || 0) - (x[i] || 0); return 0; };
  let versions = [];
  try { versions = readdir(root).filter((name) => /^\d+(\.\d+)*$/.test(name)).sort(newer); } catch {}
  for (const v of versions) {
    let builds = [];
    try { builds = readdir(paths.join(root, v)); } catch {}
    for (const build of builds) {
      // Only a copy the app finished checking (it writes .verified last).
      if (!exists(paths.join(root, v, build, ".verified"))) continue;
      bundled.push(win ? paths.join(root, v, build, "claude.exe") : paths.join(root, v, build, "claude.app", "Contents", "MacOS", "claude"));
    }
  }
  return [...own, ...bundled];
}
const runnable = (file, platform) => {
  try {
    fs.accessSync(file, platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};
export function locateClaude(run = exec, { now = Date.now, platform = process.platform, env = process.env, home = os.homedir(), locations = claudeInstallLocations, isRunnable = runnable } = {}) {
  // Gone from where it was (reinstalled elsewhere, an update that moved
  // it): looked for again rather than sent to a missing file.
  if (claudeFound && !fs.existsSync(claudeFound)) claudeAt = claudeFound = null;
  if (!claudeAt && now() - claudeMissedAt < claudeMissMs) return Promise.resolve(null);
  claudeAt ??= (platform === "win32"
    // No login shell to ask on Windows: PATH and the installers' folders,
    // as Node can start it, never npm's sh shim (agent-cli.mjs).
    ? findWindowsCli("claude", { env, home })
    : run(process.env.SHELL || "/bin/zsh", ["-lc", "command -v claude"], { timeout: 8000 })
        .then(({ stdout }) => stdout.trim().split("\n").pop() || null)
        .then((found) => (found?.startsWith("/") ? found : null)))
    .catch(() => null)
    // Not on PATH: where installers and the Claude app put it.
    .then((found) => found || locations({ platform, env, home }).find((file) => isRunnable(file, platform)) || null)
    .then((found) => {
      if (!found) claudeAt = null; // look again later
      claudeMissedAt = found ? 0 : now();
      claudeFound = found;
      return found;
    });
  return claudeAt;
}
export const forgetClaudeMiss = () => {
  claudeMissedAt = 0;
};

// "claude-opus-5-5" → "Opus 5.5", as the Claude app names models.
const claudeModelName = (id) => {
  const m = String(id || "").match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$|\[)/);
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ""}` : null;
};

// What a chat Reach was running hears when Reach comes back after cutting it off.
export const CONTINUE_AFTER_RESTART = "Reach restarted while you were working and cut off your last step. Continue where you left off.";

export function createAgentSessions({
  // A team's lead chat (teams.mjs): kept out of the Claude app (its process
  // wouldn't have the team's tools), and what it's launched or resumed with.
  keepOut = () => false,
  teamExtras = () => null,
  daemon = createCodexDaemon(),
  codex = createCodexSessions({ daemon }),
  // The Codex app's own IPC (codex-desktop.mjs): settings, turns and its
  // approvals for chats it holds.
  codexDesktop = createCodexDesktop(),
  codexLive = createCodexLive({ daemon, desktop: codexDesktop, resumeExtras: (id) => teamExtras("codex", id) }),
  claude = createClaudeSessions({ locateCli: () => locateClaude() }),
  // Gemini CLI's sessions, read from its own files (gemini.mjs); none of
  // this Mac's in tests.
  gemini = createGeminiSessions(
    process.env.NODE_TEST_CONTEXT ? { home: path.join(os.tmpdir(), "reach-no-gemini"), locate: async () => null } : {},
  ),
  live = liveClaudeSessions,
  // background: deliver the link without bringing the app forward.
  open = (url, { background = false } = {}) =>
    background ? openInBackground(url) : exec("/usr/bin/open", [url], { timeout: 10000 }),
  dataDir = path.join(os.homedir(), ".reach"),
  // Signing an agent in on the Mac from the phone (sign-in.mjs).
  signIn = createSignIn({
    dataDir,
    claudeCommand: () => agentCommand("claude"),
    claudeHealth: () => claude.health(),
    daemon,
  }),
  // Replies to Claude Code sessions (claude-host.mjs).
  claudeHost = createClaudeHost({
    locate: () => locateClaude(),
    rewindFile: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "claude-rewinds.json"),
    workingFile: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "claude-working.json"),
    extraArgs: (id) => {
      const team = teamExtras("claude", id);
      return team === false ? false : team?.extra || null;
    },
  }),
  // How long one look at the running claude processes is shared.
  liveMs = 2500,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
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
  // How soon after start the chats the last Reach cut off are continued.
  continueMs = 3000,
  // How often one the Claude app hasn't taken tries again, when the Mac
  // doesn't say what it waits for (the app in front, see frontmost()).
  appRetryMs = 5000,
  // Whether the Mac's screen is locked; tests that don't say: by the app in
  // front only.
  locked = process.env.NODE_TEST_CONTEXT || process.platform !== "darwin" ? () => false : () => screenLocked(),
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
  // Shared with agent/phone desktop control and all background Claude UI work.
  desktopAutomation = null,
  // The Claude app's window, reloaded once nobody is at the Mac after Reach
  // replies in a session it has shown (claude-import.mjs); never in tests.
  claudeRefresh = process.env.NODE_TEST_CONTEXT
    ? { add: async () => {}, close() {} }
    : createClaudeRefresh({
        file: path.join(dataDir, "claude-refresh.json"),
        open,
        desktopAutomation,
        asking: () => [...readSessionRegistry().values()].some((e) => e.where === "claude-app" && e.waiting),
      }),
  // Pressing a button on the Claude app's own consent card (claude-consent.mjs); never in tests.
  pressConsent = process.env.NODE_TEST_CONTEXT
    ? async () => {
        throw Object.assign(new Error("Not in tests."), { status: 409 });
      }
    : (choice, expect, guard) => pressClaudeConsent(choice, { dataDir, expect, beforeDispatch: guard }),
  claudeShown,
  // Messages waiting for a busy Claude app session, kept until handed over
  // The chats the Claude app lists, the one on screen first (claude-import.mjs).
  appShown = claudeAppShown,
  // (outbox.mjs); in memory only in tests.
  outbox = createOutbox({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "agent-outbox.json") }),
  // Apps installed here, to show a consent card's apps with their icons.
  installedApps = platformApps,
  // Drafts, Stop and settings for chats the Claude app lists, through the
  // app itself (claude-compose.mjs); off in tests unless given.
  claudeCompose: givenCompose = null,
  // Messages to those chats go through Claude Code (claudeHost), pictures
  // and words in one turn; the app's window reloads them (claudeRefresh).
  // Typing them into the app's box (the old way) dropped pictures without a
  // word (Oct 11): only when asked for.
  typeIntoApp = false,
  claudeOpen = claudeAppRunning,
  listenForAsks = !process.env.NODE_TEST_CONTEXT,
  // Claude Code's permissions and questions held for the phone by its own
  // PermissionRequest hook (agent-asks.mjs); made below when not given.
  agentAsks: givenAsks = null,
  // Where Claude Code keeps the user's settings (Reach's hook goes there),
  // and Reach's hook script.
  claudeSettingsPath = process.env.NODE_TEST_CONTEXT ? path.join(os.tmpdir(), "reach-no-claude-settings.json") : path.join(os.homedir(), ".claude", "settings.json"),
  hookScript = fileURLToPath(new URL("../../scripts/agent-hook.mjs", import.meta.url)),
  modeHookScript = fileURLToPath(new URL("../../scripts/agent-mode-hook.sh", import.meta.url)),
  // Claude Code's registry of running sessions (processes.mjs); none of this
  // Mac's in tests.
  registry = process.env.NODE_TEST_CONTEXT ? () => new Map() : readSessionRegistry,
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
  // The effort picked on the phone for each Claude app chat (same store).
  claudeEfforts = createChatModes({ file: process.env.NODE_TEST_CONTEXT ? null : path.join(dataDir, "claude-efforts.json") }),
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
  // Windows' owner checks (Codex's pipes, the files it holds) build their
  // helper in this data folder (windows-owners.mjs).
  useOwnersFolder(dataDir);
  if (process.platform === "win32" && !process.env.NODE_TEST_CONTEXT) void prepareOwners(dataDir).catch(() => {});
  // Chats joining the Claude app's list (claude-import.mjs): its record
  // written, or its import link when the app is open and out of the way;
  // never this Mac's app in tests.
  claudeImports ??= process.env.NODE_TEST_CONTEXT
    ? { add: async () => {}, close() {} }
    : createClaudeImports({
        file: path.join(dataDir, "claude-imports.json"),
        open,
        desktopAutomation,
        resume: true,
        held: (id) => claudeHost.drives(id),
        describe: async (id) => {
          const { session } = await claude.read(id, { limit: 1 });
          const origin = moves.into("claude", id);
          if (!session.inApp && session.updatedAt <= origin?.at) Object.assign(session, origin.to.settings || {});
          return {
            cwd: session.cwd,
            title: session.title,
            model: session.model,
            // The app resumes it at the record's effort: without one it ran at
            // the app's default (a Haiku · Low chat went on at Medium).
            effort: claudeHost.settingsOf?.(id)?.effort || session.effort,
            mode: claudeHost.modeOf?.(id) || session.mode,
            createdAt: session.createdAt,
            updatedAt: session.updatedAt,
          };
        },
      });
  const adapters = { codex, claude, gemini };
  const fileSearch = createFileSearch();
  const adapter = (agent) => {
    if (!Object.hasOwn(adapters, agent))
      throw Object.assign(new Error("Unknown agent."), { status: 404 });
    return adapters[agent];
  };
  const blocked = (message) => Object.assign(new Error(message), { status: 409 });
  // A model or effort pick the Mac couldn't take now: nothing retries it, so
  // never "It goes in by itself after" (a message's promise, not a pick's).
  const settingNotChanged = (e) => {
    if (e?.kind !== "busy") throw e;
    const said = String(e.message || "");
    const why = /^Waiting: (.+?)\.\s*It goes in by itself after\.$/.exec(said)?.[1];
    throw Object.assign(e, { message: why ? `Not changed: ${why}. Try again in a moment.` : `Not changed. ${said}` });
  };
  // Which Claude sessions have a process right now; shared for a moment so
  // the list and an open session don't each run ps.
  let liveCache = null;
  const liveNow = async () => {
    if (!liveCache || Date.now() - liveCache.at > liveMs)
      liveCache = { at: Date.now(), value: claude.starts().then((starts) => live(starts, { platform, ours: (pid) => !!claudeHost.ownsProcess?.(pid) })) };
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
    desktopAutomation,
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
  // The Codex app's approvals, answered from the phone through its IPC
  // (app-cards.mjs): the request a chat waits on is read from its file.
  const appCards = createAppCards({
    desktop: codexDesktop,
    platform,
    pending: async (agent, id) => {
      if (agent !== "codex") return null;
      const { session } = await codex.read(id, { limit: 1 });
      const asked = session?.asking;
      if (session?.held !== "codex-app" || asked?.kind !== "permission" || !asked.id || !asked.callId) return null;
      return { id: asked.id, callId: asked.callId };
    },
  });
  // Claude Code's permissions and questions in the Claude app and terminals,
  // held for the phone by Claude Code's own PermissionRequest hook
  // (agent-asks.mjs) while Claude Code shows its dialog on the Mac. Headless
  // runs and sessions Reach drives itself step aside at once.
  const hookCommand = () =>
    agentHookCommand({ script: hookScript, agent: "claude", socketPath: agentAskSocket(dataDir) });
  // A mode picked on the phone waits here until Claude Code next asks.
  const modesDir = path.join(dataDir, "pending-modes");
  const modeHookCommand = () => agentModeHookCommand({ script: modeHookScript, modesDir });
  const agentAsks =
    givenAsks ||
    createAgentAsks({
      socketPath: agentAskSocket(dataDir),
      modesDir,
      platform,
      skip: (agent, id) => !!hosts[agent]?.drives(id),
      shows: async (agent, id) => {
        if (agent !== "claude") return false;
        liveCache = null;
        const where = (await liveNow().catch(() => new Map())).get(id)?.where;
        return where === "claude-app" || where === "terminal";
      },
      // Claude Code's registry says at once when it stops waiting (the Mac
      // answered: busy again within a moment, verified with 2.1.293).
      waiting: async (agent, id) => {
        const entry = registry().get(id);
        return entry ? !!entry.waiting : null;
      },
      // Asked again after a restart: what Claude Code waits on, and the call
      // still running in its newest page (unread: the registry alone).
      asking: async (agent, id, request) => {
        const waitingFor = registry().get(id)?.waiting || null;
        if (!waitingFor) return false;
        const items = await claude.read(id, { limit: 20 }).then((r) => (Array.isArray(r?.items) ? r.items : null), () => null);
        return stillAsked(waitingFor, items, request);
      },
    });
  if (listenForAsks) agentAsks.listen?.().catch(() => {});
  // Whether Claude Code runs Reach's hook ("on", "outdated": an old command,
  // "off", or "unsupported" without Unix sockets), read from its settings at
  // most every few seconds.
  let hookSeen = { at: 0, state: "off" };
  const phoneAnswersState = () => {
    if (Date.now() - hookSeen.at > 5000)
      hookSeen = {
        at: Date.now(),
        state:
          process.platform === "win32"
            ? "unsupported"
            : claudeHookState({ settingsPath: claudeSettingsPath, command: hookCommand(), modeCommand: modeHookCommand() }),
      };
    return hookSeen.state;
  };
  const hookBackups = path.join(dataDir, "settings-backups");
  // Approval cards come only from live agent protocol requests. Desktop waits
  // without a reply connection are detected from agent state and use the screen.
  if (listenForAsks) macPrompts.start?.();
  // Working, not merely open: Reach's own turn, or an open process whose
  // transcript is mid-turn (recently) or just changed. The Claude app keeps a
  // process for every open session, so a process alone means nothing.
  // Claude sessions whose process Reach let go of, and when.
  const letGo = new Map();
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
  // The level a chat goes on at when none is picked: the one it last ran
  // at, only if the model it goes on with takes it (Claude Code's catalog;
  // the levels it knows when that can't be read in a moment). A chat Reach
  // runs, launched with none, runs at that level already: none, so it isn't
  // relaunched for it.
  const KNOWN_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
  const keptEffort = async (id, session, model) => {
    const level = session.effort;
    if (typeof level !== "string" || !/^[a-z][a-z0-9_-]{0,23}$/.test(level)) return null;
    if (claudeHost.drives(id) && claudeHost.settingsOf && !claudeHost.settingsOf(id)?.effort) return null;
    const catalog = await Promise.race([
      Promise.resolve().then(() => claudeHost.models?.()),
      new Promise((r) => setTimeout(r, 2000).unref?.()),
    ]).catch(() => null);
    const entry = Array.isArray(catalog) && model ? catalog.find((m) => m && (m.value === model || m.resolvedModel === model)) : null;
    const levels = !entry ? KNOWN_EFFORTS : entry.supportsEffort === true && Array.isArray(entry.supportedEffortLevels) ? entry.supportedEffortLevels : [];
    return levels.includes(level) ? level : null;
  };
  // A chat Reach runs: what it launched it with, from the first frame (it
  // read "Default · High" through a Haiku · Low turn). Its effort is what
  // the process runs at; its model (an alias, "haiku") only fills a gap.
  // A Claude app chat's effort picked on the phone: what it goes on at
  // from here (its messages from the phone carry it), shown as its level.
  const withPicked = (session) => {
    const picked = session.inApp && !claudeHost.drives(session.id) && claudeEfforts.get(session.id);
    if (picked) session.effort = picked;
  };
  const withHost = (session) => {
    const settings = claudeHost.settingsOf?.(session.id);
    if (!settings) return;
    session.model ||= settings.model;
    session.effort = settings.effort || session.effort;
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
    // Not there at all (only the Claude app, or nothing) is a different fix.
    if (health && health.installed === false && !health.error)
      throw blocked(`Claude Code isn't installed on your ${computerWord(platform)}. Install it from Chat to reply from here.`);
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
  const holderOf = async (id, { requireLive = false } = {}) => {
    liveCache = null;
    const holder = (await liveNow().catch((error) => {
      if (requireLive) throw error;
      return new Map();
    })).get(id);
    if (!holder || claudeHost.drives(id)) return null;
    // Reach's own process, exiting after it was let go: Reach's again once it's gone.
    if (holder.where === "reach") {
      const end = Date.now() + takeOverMs;
      while (alive(holder.pid) && Date.now() < end) await new Promise((r) => setTimeout(r, 100));
      if (!alive(holder.pid)) return null;
    }
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
  // The lock screen (or screen saver) in front, or the console session
  // locked (a window can come forward over a locked Mac): no app can be
  // typed into.
  const macLocked = async () =>
    front === "com.apple.loginwindow" || front === "com.apple.ScreenSaver.Engine" ||
    (await Promise.resolve(locked()).catch(() => false)) === true;
  const claudeCompose =
    givenCompose ||
    (process.env.NODE_TEST_CONTEXT
      ? null
      : createClaudeCompose({
          type: (message, guard) => typeIntoClaude(message, { dataDir, beforeDispatch: guard }),
          onScreen: () => claudeOnScreen({ dataDir }),
          open,
          desktopAutomation,
          arrived: (id, text, since, sent) => claude.arrived(id, text, since, sent),
          // Woken by the agents' files (agent-watch), with a slow look in
          // case a write goes unnoticed.
          transcriptNews: (id, ms) => agentNews((news) => news.agent === "claude" && news.id === id, Math.min(ms, 2000)),
          appNews: (ms) => agentNews((news) => news.agent === "claude" && news.kind === "app", Math.min(ms, 1000)),
          // What Reach last put in each chat's box, kept across restarts.
          store: draftFile(path.join(dataDir, "agent-drafts.json")),
          // Text typed on the Mac that a message set aside and couldn't put
          // back: in the log and on disk, never lost.
          keepText: (id, text) => {
            console.warn(`Reach: text set aside from the Claude app's box (chat ${id}) is saved in claude-box-kept.jsonl.`);
            try {
              fs.appendFileSync(path.join(dataDir, "claude-box-kept.jsonl"), `${JSON.stringify({ id, text, at: Date.now() })}\n`, { mode: 0o600 });
            } catch {
              // Quoted: kept whole, and its lines can't pass for Reach's own.
              console.warn(JSON.stringify(String(text)));
            }
          },
        }));
  // Messages waiting for the Claude app to finish its turn, in order, kept in
  // the outbox until each is handed to Claude Code: never dropped, and one
  // that can't go yet says why.
  let closed = false;
  let recoveryChats = claudeHost.interrupted?.() || [];
  const preparingHelpers = new AbortController();
  const delivering = new Set();
  const deliveringMessage = new Map();
  // App messages handed to Claude Code instead (their chat wasn't on screen).
  const direct = new Set();
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
          if (typeIntoApp && next.via === "app" && !direct.has(next.id) && !(await macLocked())) {
            // Marked on its way only once the app is about to be typed into:
            // marked while it still queued behind other Claude app work, a
            // Reach restart paused it as maybe sent when it never was.
            const begin = () => {
              if (!outbox.begin(id, next.id)) throw Object.assign(new Error("This message is no longer waiting."), { waiting: true });
            };
            // A mode sent with it goes with Claude Code's next request (its
            // hook), never picked in the app's menu.
            if (next.mode)
              try {
                agentAsks.queueMode?.("claude", id, next.mode === "manual" ? "default" : next.mode);
              } catch {
                /* a mode the hook can't switch to (Bypass) stays as it is */
              }
            await claudeCompose.deliver(id, { title: next.title, text: next.text, images: next.images, ...(next.owner ? { owner: next.owner } : {}), ...(next.now ? { now: true } : {}), begin });
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
          // One for the Claude app while the Mac is locked: nothing can be
          // typed into the app then (each try failed, for as long as the Mac
          // stayed locked), so Claude Code continues the chat itself, as above
          // (the app's window reloads it later, claudeRefresh).
          if (next.via === "app") {
            const { session } = await claude.read(id, { limit: 1 });
            message.cwd = session.cwd;
            if (!message.mode && session.mode && !(["bypassPermissions", "dontAsk"].includes(session.mode))) message.mode = session.mode;
          }
          if (!outbox.begin(id, next.id)) break;
          // Reach's own Claude Code runs it in the mode queued for the chat:
          // taken now (kept while it waited, for the app's next request).
          if (message.mode && claudeMode(agentAsks.queuedMode?.("claude", id)) === claudeMode(message.mode)) agentAsks.clearMode?.("claude", id);
          await claudeHost.send(id, message);
          outbox.remove(id, messageId);
          direct.delete(messageId);
        } catch (e) {
          wentIn = false;
          waitFor = e;
          // Not in the Claude app's list, and Claude Code has no such chat
          // either: it was deleted. Its messages wait for the phone instead.
          if (e?.unlisted && claude.exists && !(await claude.exists(id).catch(() => true))) {
            direct.delete(next.id);
            outbox.strand(id);
            continue;
          }
          // Its chat isn't on screen and the window won't be switched now
          // (you're at the Mac, or the app didn't open it): Claude Code
          // continues the chat at once, as on a locked Mac, never typed.
          if (next.via === "app" && e?.elsewhere && next.delivery !== "sending") {
            direct.add(next.id);
            tried = false;
            continue;
          }
          if (e?.retryable === false || (next.delivery === "sending" && !e?.waiting)) {
            direct.delete(next.id);
            outbox.pause(id, next.id, e?.retryable === false ? e.message : uncertainDelivery("claude").message);
            break;
          }
          outbox.retryLater(id, next.id);
          if (!(e?.collision && next.error)) outbox.problem(id, next.id, e?.message || "It couldn't be sent yet.");
        } finally {
          deliveringMessage.delete(id);
        }
      }
    } finally {
      delivering.delete(id);
      // Cancelled, stranded or paused messages no longer go direct.
      const left = new Set(outbox.sessions().flatMap((sid) => outbox.list(sid).map((m) => m.id)));
      for (const m of [...direct]) if (!left.has(m)) direct.delete(m);
    }
  };
  // Paused by a restart while going into the Claude app: the chat says
  // whether it got in. In it: done. Not in it: it goes again by itself (a
  // restart mid-delivery left it paused until someone tapped Send).
  const recheckRestarted = async (id) => {
    for (const m of [...outbox.list(id)]) {
      if (!m.restarted || m.via !== "app") continue;
      try {
        if (await claude.arrived(id, m.text, m.at, { images: m.images.length })) outbox.remove(id, m.id);
        else outbox.resume(id, m.id);
      } catch {
        /* the chat can't be read: it stays paused for the phone */
      }
    }
  };
  // Left waiting when Reach last stopped: on their way again.
  for (const id of outbox.sessions())
    if (!recoveryChats.some((chat) => chat.id === id)) void recheckRestarted(id).then(() => deliver(id));
  // Claude sessions started here join the Claude app's list once Reach lets
  // go of them, through the app's own import, when nobody is at the Mac (the
  // import switches the app's window), so they're there when you get to it.
  // Sessions the app already lists get its window reloaded instead (it
  // doesn't see what Reach added otherwise).
  claudeHost.onRelease?.((id, { wrote } = {}) => {
    letGo.set(id, Date.now());
    if (letGo.size > 200) letGo.delete(letGo.keys().next().value);
    // A team's lead stays Reach's (the Claude app's process wouldn't have its tools).
    if (keepOut("claude", id)) return;
    // One waiting to join the app's list goes now; one the app lists and
    // Reach wrote to gets its window reloaded.
    const joining = claudeImports.pending?.().includes(id);
    if (joining) void claudeImports.check?.();
    else if (wrote) void claudeRefresh.add(id);
    // A mode it switched to mid-turn (a plan approved into Manual) is in no
    // line of its transcript, and the Claude app takes the transcript's when
    // it adopts the chat: it goes with Claude Code's next request there, as
    // a pick from the phone does (never through the app's menu).
    const mode = claudeMode(claudeHost.modeOf?.(id));
    if (mode)
      void Promise.resolve()
        .then(() => claude.read(id, { limit: 1 }))
        .then(({ session }) => {
          if (!session || (!session.inApp && !joining) || claudeMode(session.mode) === mode) return;
          agentAsks.queueMode?.("claude", id, mode === "manual" ? "default" : mode);
        })
        .catch(() => {});
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
      // History news says no chat's id: every open one reads again, those
      // between two polls too (nudge woke only polls waiting that instant,
      // and a reply the Codex app wrote then showed up to 25 s late).
      if (news.kind === "rollout") {
        codexWhole.delete(news.id);
        touch("codex", news.id);
      } else if (news.kind === "settings" || news.kind === "history") touchOpen("codex");
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
    } else if (news.agent === "claude" && news.id) {
      // A Claude Code transcript, Reach's own included: its process says a
      // reply before the file has it, and the app or a terminal can write
      // to it while Reach's process idles (both waited for the 30 s look).
      touch("claude", news.id);
    } else if (news.agent === "gemini") {
      touchOpen("gemini");
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
    if (s.status !== "waiting" || hosts[s.agent]?.drives(s.id) || agentAsks.has?.(s.agent, s.id)) return void waitingSince.delete(key);
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
  // A permission or question Claude Code holds through Reach's hook
  // (agent-asks.mjs) writes nothing to a file: the list (Needs you, a chat's
  // Waiting) hears of it, and of its answer, at once.
  agentAsks.onChange?.(() => listChanged());
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
      incomplete: h.mayHaveOlder === true || h.incompleteForFork === true,
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
      const asked = [...(driven ? hosts[s.agent].view(s.id).prompts || [] : []), ...(agentAsks.prompts?.(s.agent, s.id) || [])];
      if (asked.length) s.prompts = asked;
    }
    try {
      const running = await liveNow();
      // Reach's own reply process isn't where a session lives (it showed as "Terminal").
      for (const s of sessions)
        if (s.agent === "claude" && running.has(s.id) && !claudeHost.drives(s.id) && running.get(s.id).where !== "reach") withLive(s, running.get(s.id));
    } catch {
      /* Live status is a hint; the list stands without it. */
    }
    for (const s of sessions) if (s.agent === "claude" && claudeHost.drives(s.id)) withHost(s);
    for (const s of sessions) if (s.agent === "claude") withPicked(s);
    for (const s of sessions) statusOf(s.agent)(s);
    for (const s of sessions) settleWaiting(s);
    // Continued from the other agent: said in the list, with its app.
    for (const s of sessions) {
      const origin = moves.into(s.agent, s.id);
      if (origin) {
        s.movedFrom = { agent: origin.from.agent, id: origin.from.id, title: origin.from.title || "" };
        if (origin.fork) { s.createdAt = origin.at; s.updatedAt = Math.max(s.updatedAt || 0, origin.at); }
      }
    }
    sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    return {
      sessions,
      // The Codex app's projects, so its threads group as in its sidebar.
      projects: { codex: p.status === "fulfilled" ? p.value : [] },
      // What the Mac itself is asking right now (answered at the Mac).
      macPrompts: macPrompts.current?.().prompts || [],
      // An agent that isn't installed has no chats, which isn't an error:
      // Chat offers to install it instead (as health() says).
      errors: {
        ...(c.status === "rejected" && !notInstalled(c.reason) ? { codex: c.reason?.message || "Codex sessions are unavailable." } : {}),
        ...(k.status === "rejected" && !notInstalled(k.reason) ? { claude: k.reason?.message || "Claude sessions are unavailable." } : {}),
        ...(g.status === "rejected" && !notInstalled(g.reason) ? { gemini: g.reason?.message || "Gemini CLI sessions are unavailable." } : {}),
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
    // resume: the new agent is also told to keep going (an agent out of
    // usage, continued in another with one tap); a move that worked stays
    // done if that message can't go, and says why.
    async move(agent, id, { to, authorize = () => {}, resume = false, owner, cwd = "" } = {}) {
      const moved = await this.moveOnly(agent, id, { to, authorize, cwd });
      if (!resume || (to !== "codex" && to !== "claude")) return moved;
      try {
        authorize();
        await this.send(to, moved.id, { text: resumeText(agentName(agent)), images: [], ...(owner ? { owner } : {}) });
        return { ...moved, resumed: true };
      } catch (e) {
        return { ...moved, resumed: false, resumeError: e?.message || "The message to continue couldn't be sent." };
      }
    },
    async fork(agent, id, { to = agent, through = null, authorize = () => {} } = {}) {
      if (through !== null && (typeof through !== "string" || !through || through.length > 500))
        throw Object.assign(new Error("Choose a message to fork from."), { status: 400 });
      return this.moveOnly(agent, id, { to, through, fork: true, authorize });
    },
    async moveOnly(agent, id, { to, authorize = () => {}, cwd = "", through = null, fork = false } = {}) {
      authorize();
      if (!movable().includes(agent)) adapter(agent);
      // Never into an agent too old for Reach (a Claude Code chat would be
      // written, then refuse to go on): said with the version to update to.
      const report =
        to === agent ? null
        : to === "codex" ? await Promise.resolve(daemon.compatibility?.()).catch(() => null)
        : to === "claude" ? await Promise.resolve(claudeCompatibility()).catch(() => null)
        : null;
      const aged = to === "openclaw" ? openClaw?.tooOld?.() : reportTooOld(report);
      if (aged?.to) throw tooOldError({ agent: to, version: aged.version, to: aged.to });
      if ((!fork && to === agent) || !movable().includes(to)) throw Object.assign(new Error("Choose an app that can continue chats."), { status: 400 });
      const key = `${agent}:${id}`;
      if (moving.has(key)) throw Object.assign(new Error("This chat is already moving."), { status: 409 });
      moving.add(key);
      try {
        if (agent === "codex") codexWhole.delete(id);
        const source = await history(agent, id);
        if (fork && source.incomplete) throw Object.assign(new Error("OpenClaw hasn't provided the complete history. This chat cannot be forked without losing context."), { status: 409 });
        authorize();
        let { items, memory } = source;
        if (through) {
          const point = items.findIndex(item => item.id === through);
          if (point < 0) throw Object.assign(new Error("That message isn't in this chat."), { status: 404 });
          items = items.slice(0, point + 1);
          if (memory && memory.from > point) memory = null;
        }
        // A priority continuation remembers the original project even while
        // passing through OpenClaw, whose chats have no project folder.
        const session = agent === "openclaw" && cwd ? { ...source.session, cwd } : source.session;
        const from = agentName(agent);
        const title = session.title || "";
        if (fork && to === agent && (agent === "codex" || agent === "claude")) {
          let target;
          let settings;
          if (agent === "codex") {
            const turnId = through ? items.at(-1)?.turnId : null;
            if (through && !turnId) throw Object.assign(new Error("Codex cannot fork this message without its turn ID."), { status: 409 });
            if (through && source.items.slice(items.length).some(item => item.turnId === turnId))
              throw Object.assign(new Error("Codex forks complete turns. Choose the last reply in this turn, or fork into another app."), { status: 409 });
            authorize();
            const result = await daemon.rpc("thread/fork", { threadId: id, excludeTurns: true, ...(turnId ? { lastTurnId: turnId } : {}) });
            target = result?.thread?.id;
            if (!target || target === id) throw new Error("Codex didn't confirm a new fork.");
            daemon.rpc("thread/unsubscribe", { threadId: target }).catch(() => {});
            const mode = chatModes.get(id) || session.mode;
            if (mode) chatModes.set(target, mode);
          } else {
            ({ id: target } = await claude.fork(id, { through, authorize }));
            const current = (await (through ? claude.read(target, { limit: 1 }) : this.read(agent, id, { limit: 1 }))).session;
            settings = Object.fromEntries(["model", "mode", "effort", "ultracode"].filter(key => current[key] != null).map(key => [key, current[key]]));
            const effort = current.effort;
            if (effort) claudeEfforts.set(target, effort);
          }
          authorize();
          moves.add({ from: { agent, id, title, upTo: items.at(-1)?.id || null, count: items.length }, to: { agent: to, id: target, nativeHistory: true, ...(settings ? { settings } : {}) }, fork: true });
          if (agent === "claude") void claudeImports.add(target);
          listChanged();
          return { agent: to, id: target };
        }
        // A Codex thread doesn't list the history it was given: a chat moved
        // into Codex brings what it continues along again (a Claude Code
        // chat holds its copy in its own transcript).
        const carried = agent === "codex" && moves.into(agent, id) ? await shown(agent, id) : memory ? items.slice(memory.from) : items;
        authorize();
        const turns = moveTurns(carried, { summary: memory?.summary || "", from });
        const note = handoff({ from, title, cwd: session.cwd });
        let target;
        let nativeHistory = false;
        // Export the entire visible history, including pre-compaction messages.
        // Resolve attachments before creating a target, so a missing image cannot
        // silently turn into a placeholder in an otherwise successful transfer.
        let complete = to === "codex" || to === "claude" || fork ? (await shown(agent, id, null, new Set(), true)).map(item => ({ ...item })) : null;
        if (complete && through) {
          const point = complete.findIndex(item => item.id === through);
          if (point < 0) throw Object.assign(new Error("That message isn't in this chat."), { status: 404 });
          complete = complete.slice(0, point + 1);
        }
        authorize();
        if (complete) for (const item of complete) {
          if (!item.images) continue;
          const source = item.imageOrigin || { agent, id, item: item.id };
          item.imageData = [];
          for (let n = 0; n < item.images; n++) {
            const image = await adapter(source.agent).image(source.id, source.item, n);
            authorize();
            item.imageData.push(`data:${image.type};base64,${image.data.toString("base64")}`);
          }
        }
        authorize();
        // The working context must stop at the same selected fork point as
        // the archive. A moved Codex chat's full shown history can extend past it.
        const context = { items: memory ? items.slice(memory.from) : complete, summary: memory?.summary || "" };
        if (to === "codex") {
          ({ threadId: target } = await codexLive.forkHistory({
            cwd: session.cwd,
            name: title,
            items: complete,
            from,
            context,
            authorize,
          }));
          nativeHistory = true;
        } else if (to === "openclaw") {
          if (fork && complete.some(item => item.images)) throw Object.assign(new Error("OpenClaw cannot preserve these attachments in a fork. Choose Codex or Claude Code."), { status: 409 });
          const notes = fork ? forkNotes(complete, from) : openClawNotes(turns, { note, from });
          ({ key: target } = await openClaw.fork({ title, notes, label: `${fork ? "Forked" : "Moved"} from ${from}` }, authorize));
        } else {
          ({ id: target } = await claude.write({ cwd: session.cwd, title, items: complete, from, context, gitBranch: session.branch || "", authorize }));
          nativeHistory = true;
          // In the Claude app's list too, once nobody is at the Mac.
          authorize();
          void claudeImports.add(target);
        }
        // A Claude Code target begins with the history written for it, which
        // Reach shows as the original chat's own messages instead.
        authorize();
        moves.add({
          from: { agent, id, title, upTo: items.at(-1)?.id || null, count: items.length },
          to: { agent: to, id: target, ...(nativeHistory ? { nativeHistory: true } : {}) },
          ...(fork ? { fork: true } : {}),
        });
        listChanged();
        return { agent: to, id: target };
      } finally {
        moving.delete(key);
      }
    },
    signIn,
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
        const sent = await codexLive.send(id, { ...body, skill, mode: body.mode || chatModes.get(id) || (codex.modeFor ? codex.modeFor(id) : codex.appMode?.()) || undefined });
        if (body.mode) chatModes.set(id, body.mode);
        return sent;
      }
      // Claude Code keeps sessions per folder: resume it where it began.
      const { session } = await claude.read(id, { limit: 1 });
      const origin = moves.into("claude", id);
      if (!session.inApp && !claudeHost.drives(id) && session.updatedAt <= origin?.at) Object.assign(session, origin.to.settings || {});
      // Without a pick: the chat's own mode (its app's, else the one its
      // latest message ran in). Resumed without it, Claude Code fell back to
      // Manual and asked about everything in a chat set to Auto.
      // The mode Reach gave it comes first: the transcript keeps the mode of
      // the last message, so a pick of Auto went back to Manual on the next.
      const ours = !session.inApp || claudeHost.drives(id) ? claudeHost.modeOf?.(id) : null;
      // A pick waiting for Claude Code's next request elsewhere (the app, a
      // terminal): a turn Reach runs itself goes in it (and takes it).
      const queuedMode = claudeMode(agentAsks.queuedMode?.("claude", id));
      // Never a Bypass or dontAsk the transcript last recorded: those only
      // ever come from an explicit pick, never carried over on resume.
      const recorded = ["bypassPermissions", "dontAsk"].includes(session.mode) ? null : session.mode;
      const kept = body.mode || queuedMode || ours || recorded;
      // Its effort too (the app's pick, else what it last ran at): resumed
      // without it, a chat set to Max went on at Claude Code's default.
      // One picked on the phone for a Claude app chat comes before both.
      const picked = session.inApp && !claudeHost.drives(id) ? claudeEfforts.get(id) : null;
      const effort = body.effort || picked || (await keptEffort(id, session, body.model || session.model));
      const message = {
        ...body, cwd: session.cwd, ...(kept ? { mode: kept } : {}), ...(effort ? { effort } : {}),
        // The app's Ultracode, on or off as its record has it.
        ...(session.inApp ? { ultracode: session.ultracode === true } : {}),
      };
      const holder = await holderOf(id);
      // A chat the Claude app lists, with the app open: typed into the app
      // itself, so its window shows it at once (Reach's own Claude Code
      // process never showed there). The app signs in on its own.
      // Not one with an effort picked on the phone: the app's process runs
      // at the level it was started with, and nothing outside it changes
      // that but a click in its menu (never, Oct 10). Claude Code continues
      // it at that level instead, as for a locked Mac.
      if (typeIntoApp && claudeCompose && session.inApp && !picked && (!holder || holder.where === "claude-app") && !claudeHost.drives(id) && (await claudeOpen())) {
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
      // terminal): it joins the app's list once Reach lets go of it; never
      // a team's lead.
      if (!session.inApp && !keepOut(agent, id)) void claudeImports.add(id);
      // Reach's own Claude Code runs it in that mode: no longer queued, so
      // the PreToolUse hook doesn't make every step of the run ask for it.
      // Only now: one waiting in the outbox (or taken back) keeps it.
      if (queuedMode) agentAsks.clearMode?.("claude", id);
      return claudeHost.send(id, message);
    },
    async start(agent, body) {
      if (host(agent) === codexLive) {
        // Apply the same default for every caller, including API and team starts.
        // Explicit modes and custom permission settings remain authoritative.
        if (!body.modeName && !body.approvalPolicy && !body.sandbox && !body.approvalsReviewer && !body.config) {
          const catalog = await codex.models?.();
          const modeName = !catalog?.modes?.length || catalog.modes.some((m) => m.id === "guardian-approvals")
            ? "guardian-approvals" : "auto";
          body = { ...body, ...codexStartMode(modeName), modeName };
        }
        const started = await codexLive.start(body);
        // Its next messages keep the mode it started in.
        if (body.modeName) chatModes.set(started.threadId, body.modeName);
        return started;
      }
      await signedIn();
      const started = await claudeHost.start(body);
      if (!body.keepOut) void claudeImports.add(started.threadId);
      return started;
    },
    // A permission mode picked on the phone for a chat the Claude app holds:
    // picked in the app's own menu, so both show it. Elsewhere (chats Reach
    // runs, Codex) it goes with the next message, as before.
    async model(agent, id, { model, effort, speed }) {
      adapter(agent);
      if (agent === "claude" && !claudeHost.drives(id)) {
        const { session } = await claude.read(id, { limit: 1 });
        const appOpen = !!claudeCompose && (await claudeOpen());
        if (session.inApp && (appOpen || effort)) {
          // Apply to the app's own visible chat; the CLI host cannot mutate a
          // desktop-owned process. Catalog IDs become exact native menu names.
          if (model && model !== session.model && appOpen) {
            if (!claudeCompose.model)
              throw Object.assign(new Error("Reach can't change the model in this Claude app. Your current selection is unchanged."), { status: 409 });
            const catalog = await claudeHost.models();
            const entry = catalog.find((m) => m.value === model || m.resolvedModel === model);
            const name = entry && claudeModelName(entry.resolvedModel);
            if (!name)
              throw Object.assign(new Error("Claude didn't identify that desktop model. Your current selection is unchanged."), { status: 409 });
            const result = await claudeCompose.model(id, { title: session.appTitle || "Untitled", model: name }).catch(settingNotChanged);
            listChanged();
            if (result?.model !== name || result.unconfirmed)
              throw Object.assign(new Error("Claude didn't confirm the model change. Check the model in Claude before trying again."), { status: 409 });
          }
          // Its effort: never picked in the app's menu (no UI clicks, Oct 10).
          // Kept for the chat: its next messages from the phone run at it in
          // Claude Code (--effort), and the app's record says it for when the
          // app next loads the chat.
          if (effort) {
            claudeEfforts.set(id, effort);
            await claude.appEffort?.(id, effort).catch(() => {});
            listChanged();
          }
          return { model, effort, applied: appOpen || !model };
        }
      }
      if (agent !== "codex") return { model, effort, applied: false };
      return codexLive.model(id, { model, effort, ...(speed ? { speed } : {}) });
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
      if (agent !== "claude") return { mode, applied: false };
      // One Reach ran and let go of between turns, that no other app holds
      // now: Reach's own Claude Code runs its next turn, in this mode (kept
      // for it above). Queued for a hook, it waited on a step that never came
      // and made each step of Reach's own run ask.
      if (claudeHost.modeOf?.(id) === mode) {
        liveCache = null;
        const live = await liveNow().catch(() => null);
        const { session } = await claude.read(id, { limit: 1 });
        if (live && !live.has(id) && !session.inApp) {
          // An older pick queued for another app's next request: not that.
          agentAsks.clearMode?.("claude", id);
          return { mode, applied: true };
        }
      }
      // The Claude app or a terminal: Claude Code takes a mode from outside
      // only with a hook's answer (setMode), so it's switched with the next
      // request the phone allows there. Never by clicking the app's menu.
      const target = mode === "manual" ? "default" : mode;
      agentAsks.queueMode?.("claude", id, target);
      return { mode, applied: false, next: "request" };
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
      // The Codex app keeps its own list: told, or it shows the chat until
      // it restarts. Archived either way, so a closed app is no failure.
      if (agent === "codex") await codexDesktop.archived?.(id, archived !== false).catch(() => {});
      // A mode still waiting for it is let go of with it.
      if (agent === "claude" && archived !== false) agentAsks.clearMode?.("claude", id);
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
    // Rewind to before a message, as Claude Code's own: what would change
    // first (dryRun), then the code, the conversation, or both.
    async rewind(agent, id, { messageId, code = false, conversation = false, dryRun = false, authorize = () => {} } = {}) {
      authorize();
      if (agent !== "claude") throw Object.assign(new Error("Codex rewinds from your last message: edit it."), { status: 409 });
      const holder = await holderOf(id);
      authorize();
      if (holder && holder.where !== "reach") throw Object.assign(new Error(`Claude is running this chat in ${holder.where === "claude-app" ? "the Claude app" : "a terminal"}: rewind it there.`), { status: 409 });
      const { session } = await claude.read(id, { limit: 1 });
      authorize();
      if (dryRun) {
        // The chat's first message: only its code can go back (Restore conversation is refused below).
        const first = (await claude.rewindPoint(id, messageId).catch(() => undefined)) === null;
        authorize();
        const preview = await claudeHost.rewindFiles(id, { messageId, cwd: session.cwd, dryRun: true, authorize });
        return first ? { ...preview, conversation: false } : preview;
      }
      if (!code && !conversation) throw Object.assign(new Error("Choose what to rewind."), { status: 400 });
      const entry = conversation ? await claude.rewindPoint(id, messageId) : undefined;
      authorize();
      if (conversation && entry === null) throw Object.assign(new Error("That's the chat's first message: start a new chat instead."), { status: 409 });
      const files = code ? await claudeHost.rewindFiles(id, { messageId, cwd: session.cwd, authorize }) : null;
      authorize();
      if (files && !files.canRewind) throw Object.assign(new Error(files.error || "Claude Code can't restore the code from there."), { status: 409 });
      if (conversation) claudeHost.rewindConversation(id, entry);
      listChanged();
      return { rewound: true, ...(files ? { files: files.files, insertions: files.insertions, deletions: files.deletions } : {}) };
    },
    // One sub-agent stopped, as the Claude app's stop on a task (stop_task).
    async stopSubagent(agent, id, taskId) {
      if (agent !== "claude") throw Object.assign(new Error("Stop it from Codex."), { status: 409 });
      return claudeHost.stopTask(id, taskId);
    },
    // A chat deleted, as in its app: Codex's own delete; a Claude chat's
    // transcript and record to the Trash (claude.mjs remove).
    async deleteChat(agent, id) {
      adapter(agent);
      if (agent === "codex") {
        await daemon.rpc("thread/delete", { threadId: id });
        listChanged();
        return { deleted: true };
      }
      if (agent !== "claude") throw Object.assign(new Error("This chat can't be deleted here."), { status: 409 });
      if (claudeHost.drives(id)) throw Object.assign(new Error("Claude is working in this chat. Stop it first."), { status: 409 });
      const done = await claude.remove(id, { appOpen: await claudeOpen() });
      listChanged();
      return done;
    },
    // Files in a chat's folder for "@" in its composer: Codex's own search
    // for Codex, the folder's files for Claude Code (file-search.mjs).
    async findFiles(agent, id, query) {
      adapter(agent);
      if (agent === "codex") {
        const { thread } = await daemon.rpc("thread/read", { threadId: id, includeTurns: false });
        if (!thread?.cwd) return [];
        const r = await daemon.rpc("fuzzyFileSearch", { query: String(query || ""), roots: [thread.cwd], cancellationToken: null }).catch(() => null);
        if (r && Array.isArray(r.files))
          return r.files.slice(0, 30).map((f) => ({ path: String(f.path), name: String(f.file_name || path.basename(String(f.path))) }));
        return fileSearch.search(thread.cwd, query);
      }
      const { session } = await adapters[agent].read(id, { limit: 1 });
      return fileSearch.search(session.cwd, query);
    },
    // A chat renamed, as in its app: Codex's thread name, Claude Code's
    // custom title (and the Claude app's record).
    async rename(agent, id, title) {
      adapter(agent);
      const name = String(title ?? "").replace(/[\x00-\x1f\x7f]+/g, " ").trim().slice(0, 200);
      if (!name) throw Object.assign(new Error("Name the chat."), { status: 400 });
      if (agent === "codex") {
        await daemon.rpc("thread/name/set", { threadId: id, name });
        listChanged();
        return { title: name };
      }
      if (agent !== "claude") throw Object.assign(new Error("This chat can't be renamed here."), { status: 409 });
      const done = await claude.rename(id, name);
      listChanged();
      return done;
    },
    // Answers to what Codex asked while working, as the Codex app sends them.
    async answerQuestions(agent, id, body) {
      if (host(agent) !== codexLive) throw Object.assign(new Error("Only Codex asks these."), { status: 400 });
      return codexLive.answerQuestions(id, body);
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
    // Reach paused or resumed (server/index.mjs setPaused).
    pauseMacPrompts: (value) => macPrompts.pause?.(value),
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
    // A Codex app approval as the phone draws it (its words and buttons),
    // read through the Codex app's IPC (app-cards.mjs).
    card: (agent, id) => appCards.card(agent, id),
    // Claude Code's permissions and questions answered from the phone: Reach's
    // PermissionRequest hook in Claude Code's user settings (agent-asks.mjs),
    // put there or taken out on the owner's tap; other hooks stay as they are
    // and a copy of the file is kept first.
    phoneAnswers: {
      state: () => phoneAnswersState(),
      enable() {
        if (phoneAnswersState() === "unsupported")
          throw Object.assign(new Error(`Answering Claude Code from the phone isn't available on this ${computerWord(platform)}.`), { status: 501 });
        const result = installClaudeHook({ settingsPath: claudeSettingsPath, backupDir: hookBackups, command: hookCommand(), modeCommand: modeHookCommand() });
        hookSeen.at = 0;
        listChanged();
        return { ...result, state: phoneAnswersState() };
      },
      disable() {
        const result = uninstallClaudeHook({ settingsPath: claudeSettingsPath, backupDir: hookBackups });
        hookSeen.at = 0;
        listChanged();
        return { ...result, state: phoneAnswersState() };
      },
    },
    respond: async (agent, id, promptId, answer) =>
      agent === "claude" && agentAsks.owns?.(promptId)
        ? agentAsks.answer(agent, id, promptId, answer)
        : agent === "claude" && claudeConsent.owns(promptId)
          ? claudeConsent.answer(id, promptId, answer)
          : agent === "codex" && appCards.owns(promptId)
            ? appCards.answer(agent, id, promptId, answer)
            : host(agent).respond(id, promptId, answer),
    view(agent, id) {
      const view = liveHost(agent).view(id);
      const writes = touched.get(`${agent}:${id}`) || 0;
      // Asked through Claude Code's hook (agent-asks.mjs): the same cards.
      const asked = agentAsks.prompts?.(agent, id) || [];
      return {
        ...view,
        ...(asked.length ? { status: "waiting", prompts: [...(view.prompts || []), ...asked] } : {}),
        // One version for all, so the long poll wakes on any; a write on the
        // Mac counts as something new to read.
        version: view.version + outbox.version() + writes + (agentAsks.version?.(agent, id) || 0),
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
      if (hostVersion + outbox.version() + (touched.get(key) || 0) + (agentAsks.version?.(agent, id) || 0) !== Number(since)) return Promise.resolve();
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
        if (agentAsks.onChange) stops.push(agentAsks.onChange((a, sessionId) => a === agent && sessionId === id && done()));
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
      // No default effort: Claude Code names none in its catalog, and the
      // settings' effortLevel ("high") wasn't it (chats that named none ran
      // at medium, Oct 9). A chat shows the level it ran at, else nothing.
      // Read field by field: a field a newer Claude Code shapes otherwise is
      // left out (an entry without an id, a level that isn't a word), never
      // the whole picker lost or a substring taken for a level.
      const words = (v) => (Array.isArray(v) ? v.filter((e) => typeof e === "string" && /^[a-z][a-z0-9_-]{0,23}$/.test(e)) : []);
      const text = (v) => (typeof v === "string" ? v : "");
      return {
        models: list.filter((m) => m && typeof m.value === "string" && m.value).map((m) => ({
          id: m.value,
          ...(typeof m.resolvedModel === "string" ? { resolvedModel: m.resolvedModel } : {}),
          name: m.value === "default" ? text(m.displayName) || m.value : claudeModelName(m.resolvedModel) || text(m.displayName) || m.value,
          description: text(m.description),
          efforts: m.supportsEffort === true ? words(m.supportedEffortLevels) : [],
          defaultEffort: null,
          images: true,
          isDefault: m.value === "default",
          // Auto mode only on models that support it, as Claude Code offers it.
          autoMode: !!m.supportsAutoMode,
          fast: !!m.supportsFastMode,
        })),
        // Shown as Claude Code lists them; one an open chat can't switch to
        // from the phone is said so (the mode route refuses it).
        modes: modes.map((m) => (SWITCHABLE_MODES.includes(m?.id) ? m : { ...m, switchable: false })),
        mode: null,
      };
    },
    // The Claude chats Reach runs that are mid-turn now, by title: a restart
    // would cut them off (restart-requests.mjs waits for them).
    working() {
      const ids = claudeHost.working?.() || [];
      const known = listKept?.value?.sessions || [];
      return ids.map((id) => ({ id, title: known.find((s) => s.agent === "claude" && s.id === id)?.title || "A Claude chat" }));
    },
    // The Codex chats Reach drives that are mid-turn now (an update to
    // Codex's service may stop them).
    codexWorking: () => codexLive.working?.() || [],
    // Codex's service against its CLI, and updating it (keep-in-sync.mjs).
    codexService: () => daemon.serviceStatus?.() ?? null,
    updateCodexService: () => daemon.updateService(),
    // Connects to Codex and indexes Claude transcripts before the phone asks.
    warm() {
      // Chats the last Reach left mid-turn (a restart, a crash) go on: told
      // so the way any message reaches them, into the Claude app when it
      // lists the chat, else Reach's own Claude Code.
      const left = recoveryChats;
      recoveryChats = [];
      if (left.length) {
        const resume = async (chat, tries = 0) => {
          if (closed) return;
          try {
            const { session } = await claude.read(chat.id, { limit: 1 });
            const holder = await holderOf(chat.id, { requireLive: true });
            if (closed) return;
            // Someone may already have continued in the native app. Never
            // send a second continuation into their running turn.
            const running = claudeHost.running(chat.id) || (holder && await busy(chat.id, holder));
            if (closed) return;
            if (!running && !outbox.list(chat.id).length) {
              const { recovery, model, effort, mode } = chat;
              const native = session.inApp && claudeCompose && !keepOut("claude", chat.id);
              outbox.add(chat.id, {
                text: CONTINUE_AFTER_RESTART, recovery,
                ...(native
                  // Native chats retain the app's current settings and wait
                  // for it to open, rather than silently switching owners.
                  ? { via: "app", title: session.appTitle || session.title || "Untitled" }
                  : { cwd: session.cwd || chat.cwd, model, effort, mode: mode || session.mode }),
              });
              if (!native && !session.inApp && !keepOut("claude", chat.id)) void claudeImports.add(chat.id);
            }
            try { claudeHost.recovered?.(chat.id); }
            catch (error) {
              // If the handoff can't be committed, don't risk sending the
              // same continuation again on the next restart.
              for (const message of outbox.list(chat.id))
                if (message.recovery === chat.recovery) outbox.pause(chat.id, message.id, "Recovery could not be saved. Check the chat before continuing.");
              throw error;
            }
            void deliver(chat.id);
          } catch {
            // No send occurs here: the durable outbox owns delivery and
            // pauses uncertain writes. Only read/save failures retry here.
            if (!closed && tries < 4) setTimeout(() => void resume(chat, tries + 1), 30000).unref?.();
          }
        };
        setTimeout(() => left.forEach((chat) => void resume(chat)), continueMs).unref?.();
      }
      // The helpers that read and press an app's card, built just after
      // start (2-5 s each, cached by their source), so the first card opened
      // on the phone doesn't wait for a build.
      if (listenForAsks && process.platform === "darwin")
        setTimeout(() => {
          if (closed) return;
          for (const kind of ["claude-consent"]) desktopBinary({ dataDir }, kind, { signal: preparingHelpers.signal }).catch(() => {});
        }, 2000).unref?.();
      return this.list().catch(() => null);
    },
    // Reach is quitting: end sign-ins and replies in progress, and let go of
    // the Codex daemon (its open socket would keep Reach running).
    close() {
      closed = true;
      preparingHelpers.abort();
      for (const agent of ["claude", "codex"]) signIn?.cancel?.(agent);
      claudeHost?.close?.();
      claudeImports?.close?.();
      claudeRefresh?.close?.();
      macPrompts?.close?.();
      agentAsks?.close?.();
      agentWatch?.close?.();
      codexLive.close?.();
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
      // A rewind waiting for its next message: the chat as it stood then.
      const rewound = agent === "claude" ? claudeHost.rewoundTo?.(id) : null;
      const result = await adapter(agent).read(id, rewound ? { ...options, at: rewound === "start" ? null : rewound } : options);
      if (agent === "claude" && result.session && !result.session.inApp && !claudeHost.drives(id) && result.session.updatedAt <= origin?.at)
        Object.assign(result.session, origin.to.settings || {});
      if (rewound && result.session) result.session.rewound = true;
      // What its next message will use, shown as its mode.
      if (agent === "codex" && result.session && chatModes.get(id)) result.session.mode = chatModes.get(id);
      if (agent === "codex" && result.session && codexLive.contextOf?.(id)) result.session.context = codexLive.contextOf(id);
      if (agent === "claude" && result.session && claudeHost.modeOf?.(id) && (!result.session.inApp || claudeHost.drives(id)))
        result.session.mode = claudeHost.modeOf(id);
      // Its sub-agents can be stopped one by one while Reach's own Claude
      // Code runs the chat (stop_task).
      if (agent === "claude" && result.session?.subagents?.length && claudeHost.drives(id))
        result.session.subagents = result.session.subagents.map((s) => (s.status === "running" && !s.workflow ? { ...s, stoppable: true } : s));
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
        if (origin.fork) { result.session.createdAt = origin.at; result.session.updatedAt = Math.max(result.session.updatedAt || 0, origin.at); }
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
      if (out.length) result.session.movedTo = out.map((m) => ({ agent: m.to.agent, id: m.to.id, at: m.at, ...(m.fork ? { fork: true, upTo: m.from.upTo } : {}) }));
      if (agent === "codex" && codexLive.drives(id)) result.session.held = "reach";
      if (agent === "claude") {
        const running = await liveNow().catch(() => new Map());
        if (claudeHost.drives(id)) {
          result.session.held = "reach";
          withHost(result.session);
        } else if (running.has(id) && running.get(id).where !== "reach") withLive(result.session, running.get(id));
        withPicked(result.session);
        // Waiting in Claude Code's queue only while another app's Claude Code
        // holds it: a crashed app's would show for good (Reach's own: view()).
        if (result.session.waiting?.length && (claudeHost.drives(id) || running.get(id)?.where === "reach" || !running.has(id))) result.session.waiting = [];
        // Its context window as Claude Code reported it for this chat's model.
        const window = result.session.context && !result.session.context.window && claudeHost.contextWindow?.(id, result.session.model);
        if (window) result.session.context = { ...result.session.context, window };
        // A mode picked on the phone, taken with Claude Code's next request.
        const pending = !claudeHost.drives(id) && agentAsks.queuedMode?.("claude", id);
        if (pending) result.session.pendingMode = pending;
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
        if (listenForAsks && process.platform === "darwin") desktopBinary({ dataDir }, "claude-consent", { signal: preparingHelpers.signal }).catch(() => {});
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
      } else if (
        agent === "claude" &&
        newest &&
        result.session.held !== "reach" &&
        result.session.live?.waiting &&
        !agentAsks.has?.("claude", id)
      ) {
        const tool = [...(result.items || [])].reverse().find((i) => i.role === "tool");
        // What Claude Code says it waits on: "permission prompt", "input
        // needed" (a question), or "dialog open" (something else of its own,
        // a notice to acknowledge), never shown as a permission for a tool.
        // Answered from the phone only through Claude Code's hook (the
        // prompts above): never by pressing or typing in the app.
        // Anything else it waits on (an MCP server's request for input, a
        // sandboxed command's network access, a word a newer Claude Code
        // adds) is said in its words, never as the last tool's permission.
        const waitsOn = result.session.live.waiting;
        if (tool?.status === "running" && (waitsOn === "permission prompt" || (waitsOn === "input needed" && tool.questions)))
          result.session.asking = tool.questions
            ? { kind: "question", questions: tool.questions }
            : { kind: "permission", text: tool.text, command: tool.kind === "command" };
        else if (waitsOn !== "permission prompt")
          result.session.asking = { kind: "dialog", text: (Object.hasOwn(CLAUDE_WAITS, waitsOn) && CLAUDE_WAITS[waitsOn]) || `Claude Code is waiting: ${String(waitsOn).slice(0, 80)}.` };
        // Not answerable from the phone yet: Reach's hook isn't in Claude
        // Code's settings (or points at an old place); one tap puts it there.
        const hook = result.session.asking && result.session.asking.kind !== "dialog" ? phoneAnswersState() : "on";
        if (hook !== "on") result.session.phoneAnswers = hook;
      }
      if (newest) settleWaiting(result.session);
      return result;
    },
    // The agents on this Mac: the two Reach drives, then others it knows of
    // (installed, not yet supported), so the phone can show where it's going.
    async health({ fresh = false } = {}) {
      // Check again (an agent just installed): Claude Code is looked for anew.
      if (fresh) forgetClaudeMiss();
      // open: the Claude app is running, so a chat archived here leaves its
      // sidebar when it next opens (claude.mjs archive); the phone says so.
      const results = await Promise.allSettled([
        codex.health(),
        claude.health(),
        Promise.all([claudeApp(), Promise.resolve(claudeOpen()).catch(() => false)]).then(([app, open]) => (app.installed ? { ...app, open: !!open } : app)),
      ]);
      const compatibility = await Promise.allSettled([daemon.compatibility?.() || null, claudeCompatibility()]);
      const driven = results.slice(0, 2).map((r, i) => agedOut({
        ...(r.status === "fulfilled"
          ? r.value
          : { agent: ["codex", "claude"][i], installed: false, signedIn: false, ...(notInstalled(r.reason) ? {} : { error: r.reason?.message || "Could not check this app. Try again." }) }),
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
          : // OpenClaw: whether its Gateway can take a moved chat (2026.3.13 can't),
            // and one too old for Reach to join (older than 2026.2.26).
            o.agent === "openclaw" && openClaw
            ? (() => {
                const old = openClaw.tooOld?.();
                return {
                  ...o,
                  canTakeMoves: openClaw.canMove?.() !== false,
                  connected: openClaw.connected?.() === true,
                  ...(old?.to ? { tooOld: { ...(old.version ? { version: old.version } : {}), to: old.to }, needs: ["update"] } : {}),
                };
              })()
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
      if (keepOut(agent, id))
        throw blocked("This chat is part of a team at work, and the team works only in Reach. Stop the team to open it in its app.");
      const work = async (guard) => {
        const { session } = await adapter(agent).read(id, { limit: 1 });
        const url = nativeLink(session);
        if (!url) throw Object.assign(new Error("This session cannot be opened in its app."), { status: 400 });
        guard();
        // One writer at a time: Reach lets go before the Claude app takes it.
        if (agent === "claude") claudeHost.release(id);
        guard();
        await open(url);
        // Opening the requested app is intentional. A resulting foreground
        // change must not erase the completed navigation acknowledgement.
        return { opened: url.split(":")[0] };
      };
      return desktopAutomation ? desktopAutomation.run(work) : work(() => {});
    },
  };
}
