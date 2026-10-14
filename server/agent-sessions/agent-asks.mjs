// Claude Code's permissions and questions, in the Claude app or a terminal,
// answered from the phone through Claude Code's own PermissionRequest hook
// (scripts/agent-hook.mjs, in ~/.claude/settings.json): no button pressed, no
// key typed. Claude Code shows its dialog on the Mac and runs the hook at the
// same time; whichever answers first decides (verified Oct 8, 2.1.293: the
// hook's allow closes the dialog and runs the tool; once the Mac has
// answered, a later hook answer is ignored, allow or deny). So every ask is
// held for the phone, with nothing taken from the Mac. Claude Code doesn't
// end the hook when the Mac answers: Reach ends the ask itself once Claude
// Code no longer waits on a permission (its session registry), and the hook
// exits with no answer. Reach quitting (a restart) answers "retry": the hook
// asks the next Reach again, and Claude Code's dialog stays open meanwhile.
// Codex is not answered here: its PermissionRequest hook runs before its own
// review (not a person's decision); the Codex app's approvals are answered
// through its IPC (codex-desktop.mjs).
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { claudeAnswer, describeClaudePrompt } from "./claude-host.mjs";
import { askKey } from "./claude-transcript.mjs";
import { computerWord } from "../computer-word.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENTS = new Set(["claude"]);
// Claude Code's modes the phone may switch a session to with a hook's setMode
// (as its plan answers do: Manual is "default" there). Never Bypass.
const MODES = new Set(["default", "acceptEdits", "plan", "auto"]);
// Steps Claude Code takes without asking in any mode: reading or searching
// in the chat's own folder, its task list. A mode picked on the phone
// switches on one of these at once, answered by Reach itself (it asked only
// for the switch): no tap, and nothing allowed that the chat wouldn't have
// done anyway.
// Fails closed (audit, Oct 8): Reach can't see why Claude Code asked. It
// asks inside the folder too, for a file it holds sensitive (.claude/,
// .git/, a link out of the folder) or the person's own ask rules. So edits
// always go to the phone, and a read counts only when its whole input is
// one Reach reads exactly: the tool's own path field, absolute, really
// inside the folder (links followed), through no hidden file or folder, and
// no other field naming a path.
const READS = { Read: "file_path", NotebookRead: "notebook_path", Glob: "path", Grep: "path", LS: "path" };
const OPTIONAL = new Set(["Glob", "Grep", "LS"]);
const BOOKKEEPING = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "ToolSearch"]);
const realInside = (cwd, file, real = fs.realpathSync) => {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) return false;
  if (typeof file !== "string" || !path.isAbsolute(file)) return false;
  let root, target;
  try {
    root = real(cwd);
    target = real(file);
  } catch {
    return false;
  }
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel) || rel.split(path.sep).some((part) => part === ".." || part.startsWith("."))) return false;
  return true;
};
// Anything in another field that could name a place: not read whole. A
// Windows path counts too (C:\…, C:/…, \\server, a leading \ or a bare drive
// letter), so a mode never switches alone on a read with one hidden in
// another field on either platform.
const pathLike = (value) =>
  typeof value === "string"
    ? /^[/~]|^[A-Za-z]:|^\\|(^|[/\\])\.\.([/\\]|$)/.test(value)
    : value !== null && typeof value === "object";
// The person's own ask rules (permissions.ask in any Claude settings file
// for this folder) make Claude Code ask inside the folder too, and its hook
// doesn't say which ask was Reach's: with any (or a file Reach can't read),
// nothing switches alone. Windows keeps the organisation's managed file in
// Program Files (code.claude.com/docs/managed-settings); its registry policy
// (HKLM/HKCU Software\Policies\ClaudeCode) isn't read here, so a managed ask
// rule set only in the registry wouldn't hold back an auto-switch on a read
// Reach already reads as safe (noted in the security review).
export function hasAskRules(cwd, { read = fs.readFileSync, home = os.homedir(), platform = process.platform } = {}) {
  const managed =
    platform === "win32"
      ? [path.win32.join(process.env.ProgramFiles || "C:\\Program Files", "ClaudeCode", "managed-settings.json")]
      : ["/Library/Application Support/ClaudeCode/managed-settings.json"];
  const files = [
    ...managed,
    path.join(home, ".claude", "settings.json"),
    ...(typeof cwd === "string" && path.isAbsolute(cwd) ? [path.join(cwd, ".claude", "settings.json"), path.join(cwd, ".claude", "settings.local.json")] : []),
  ];
  for (const file of files) {
    let text;
    try {
      text = read(file, "utf8");
    } catch (e) {
      if (e?.code === "ENOENT" || e?.code === "ENOTDIR") continue;
      return true;
    }
    try {
      const ask = JSON.parse(text)?.permissions?.ask;
      if (ask != null && (!Array.isArray(ask) || ask.length)) return true;
    } catch {
      return true;
    }
  }
  return false;
}
export function switchesAlone(tool, input, cwd, mode, { real, askRules = hasAskRules } = {}) {
  if (askRules(cwd)) return false;
  if (BOOKKEEPING.has(tool)) return true;
  if (!Object.hasOwn(READS, tool) || input === null || typeof input !== "object" || Array.isArray(input)) return false;
  const field = READS[tool];
  if (Object.entries(input).some(([k, v]) => k !== field && pathLike(v))) return false;
  if (input[field] == null) return OPTIONAL.has(tool) && realInside(cwd, cwd, real);
  return realInside(cwd, input[field], real);
}
// A request asked again after Reach was away (a restart) is still the one
// Claude Code waits on: its registry waits on a permission (a question:
// "input needed"), and a call still running in its transcript is this one
// (by Claude Code's id for it, else its tool and whole input). A transcript
// Reach can't read (null) leaves the registry alone to say. Anything else
// (a dialog of Claude Code's own, another call since): not shown again.
export function stillAsked(waitingFor, items, request) {
  if (waitingFor !== "permission prompt" && !(waitingFor === "input needed" && request?.tool_name === "AskUserQuestion")) return false;
  if (items == null) return true;
  if (!Array.isArray(items)) return false;
  return items.some(
    (i) => i?.role === "tool" && i.status === "running" && (typeof request.tool_use_id === "string" ? i.id === request.tool_use_id : !!i.key && i.key === request.key),
  );
}
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
const key = (agent, sessionId) => `${agent}:${sessionId}`;

// Unix socket paths are short (104 bytes on macOS): a deep data folder gets a
// stable private path in the temp folder instead.
export function agentAskSocket(dataDir) {
  const preferred = path.join(dataDir, "agent-hook.sock");
  if (Buffer.byteLength(preferred) < 100) return preferred;
  const tag = crypto.createHash("sha256").update(dataDir).digest("hex").slice(0, 12);
  return path.join(os.tmpdir(), `reach-agent-${tag}.sock`);
}

// Windows has no socket files, only named pipes in one namespace every
// account sees (as Codex's and the team bridge's do: trusted-socket.mjs,
// team-bridge.mjs). So the phone answers Claude Code's prompts over a named
// pipe of a name no other account could guess, made new each launch. Reach
// can't take a name another program holds (Node makes the first instance or
// none), so a squatter can't own the name and hand Claude Code a forged
// "allow"; the hook (scripts/agent-hook.mjs) also checks the pipe's server is
// this account's own process before it trusts any answer. The chosen name is
// kept in an owner-only file the hook reads, never in Claude Code's settings,
// so a name freed by a restart leaves nothing stale behind.
const PIPE_NAME = /^reach-agent-hook-[0-9a-f]{32}$/;
const AGENT_PIPE_FILE = "agent-hook-pipe";
export const newAgentAskPipe = () => `\\\\.\\pipe\\reach-agent-hook-${crypto.randomBytes(16).toString("hex")}`;
// The pipe name this launch chose, as the hook reads it: owner-only, validated.
export function readAgentAskPipe(dataDir) {
  let name = "";
  try {
    name = fs.readFileSync(path.join(dataDir, AGENT_PIPE_FILE), "utf8").trim();
  } catch {
    return null;
  }
  return PIPE_NAME.test(name) ? `\\\\.\\pipe\\${name}` : null;
}
function writeAgentAskPipe(dataDir, pipe) {
  const name = pipe.slice("\\\\.\\pipe\\".length);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = path.join(dataDir, AGENT_PIPE_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, name, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function createAgentAsks({
  socketPath,
  // How often a held ask checks whether Claude Code still waits on it.
  everyMs = 1000,
  // Claude Code's registry says it waits a moment after the hook starts: an
  // ask it hasn't been seen waiting on ends only after this long not waiting.
  unseenMs = 10 * 1000,
  // (agent, session): prompts already reaching the phone another way (Reach's own sessions).
  skip = () => false,
  // (agent, session): the phone can show this session (the Claude app's or a
  // terminal's, not a headless run or a subagent). Anything else steps aside.
  shows = async () => true,
  // (agent, session): Claude Code still waits on a permission or question
  // there (true), no longer (false), or can't tell (null).
  waiting = async () => null,
  // (agent, session, { tool_name, tool_use_id?, key }): a request asked again
  // after Reach was away is still the one Claude Code waits on (true); else
  // it steps aside (stillAsked).
  asking = async () => null,
  // Where a mode picked on the phone waits, one file per session (named by
  // it, holding the mode): Reach's PreToolUse hook (scripts/agent-mode-hook.sh
  // on a Mac, scripts/agent-mode-hook.mjs on Windows) looks there before each
  // tool call. None: kept in memory only.
  modesDir = null,
  // Reach's own folder, owner-only: on Windows the chosen pipe name is kept
  // here for the hook to read (the socket path carries it on a Mac).
  dataDir = null,
  // How a fresh Windows pipe name is made (tests force a clash with it).
  newPipe = newAgentAskPipe,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
}) {
  const asks = new Map(); // id -> ask
  const ended = new Map(); // id -> why, for a late answer from the phone
  const versions = new Map(); // agent:session -> changes
  let changes = 0;
  // A mode picked on the phone for a session Reach doesn't run, switched to
  // with the next answer the phone gives there (agent:session -> mode).
  const modes = new Map();
  if (modesDir)
    try {
      for (const name of fs.readdirSync(modesDir)) {
        const mode = fs.readFileSync(path.join(modesDir, name), "utf8").trim();
        if (UUID.test(name) && MODES.has(mode)) modes.set(key("claude", name), mode);
      }
    } catch {
      /* none waiting */
    }
  // The file the PreToolUse hook sees: written whole, removed once applied.
  const keepMode = (sessionId, mode) => {
    if (!modesDir) return;
    const file = path.join(modesDir, sessionId);
    if (!mode) return fs.rmSync(file, { force: true });
    fs.mkdirSync(modesDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${file}.tmp`, `${mode}\n`, { mode: 0o600 });
    fs.renameSync(`${file}.tmp`, file);
  };
  // Handed to Claude Code: no longer waiting.
  const applied = (agent, sessionId, tell = true) => {
    modes.delete(key(agent, sessionId));
    try {
      keepMode(sessionId, null);
    } catch {
      /* asked once more on the next tool call: the same mode again */
    }
    if (tell) changed(agent, sessionId);
  };
  const listeners = new Set();
  const changed = (agent, sessionId) => {
    // One count for all, so a chat's never repeats; the newest 1,000 chats'
    // are kept (they grew with every chat ever asked about). A chat whose
    // count went reads as changed: the phone just reads it again.
    const k = key(agent, sessionId);
    versions.delete(k);
    versions.set(k, ++changes);
    if (versions.size > 1000) versions.delete(versions.keys().next().value);
    for (const listener of listeners) listener(agent, sessionId);
  };
  const remember = (id, why) => {
    ended.set(id, why);
    if (ended.size > 200) ended.delete(ended.keys().next().value);
  };
  const of = (agent, sessionId) => [...asks.values()].filter((a) => a.agent === agent && a.sessionId === sessionId);

  function serve(socket) {
    let buffer = "";
    let ask = null;
    let done = false;
    // Ends the ask once: a decision for the agent, or none (answered on the
    // Mac, or the hook gone), or "ask again" (Reach is quitting).
    // after: runs only once the answer was written to the hook.
    const finish = (decision, why, after) => {
      if (done) return;
      done = true;
      if (ask) {
        asks.delete(ask.id);
        clearInterval(ask.watch);
        remember(ask.id, why);
        changed(ask.agent, ask.sessionId);
        // Answered on the Mac: a mode waiting there wasn't taken with it, and
        // the next tool call would be made to ask again for it, reads too.
        // Not for one asked again: it may be an older request than the pick.
        if (why === "mac" && !ask.again && modes.has(key(ask.agent, ask.sessionId))) applied(ask.agent, ask.sessionId);
      }
      try {
        // Only a hook still there gets it (and the mode is then spent).
        const open = socket.writable !== false && !socket.destroyed;
        socket.end(`${JSON.stringify(decision ? { decision } : why === "restart" ? { retry: true } : {})}\n`);
        if (open) after?.();
      } catch {
        /* the hook is gone */
      }
    };
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("close", () => finish(null, "ended"));
    socket.on("data", async (chunk) => {
      if (ask || done) return;
      buffer += chunk;
      if (buffer.length > 9 * 1024 * 1024) return socket.destroy();
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      let input;
      try {
        input = JSON.parse(buffer.slice(0, at));
      } catch {
        return finish(null);
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) return finish(null);
      const agent = input.agent;
      if (
        !AGENTS.has(agent) ||
        !UUID.test(String(input.session_id)) ||
        typeof input.tool_name !== "string" ||
        skip(agent, input.session_id)
      )
        return finish(null);
      // Asked again after Reach was away (a restart, or not running yet):
      // only while Claude Code still waits on this very request, never one
      // the Mac has answered meanwhile. It never takes a mode picked on the
      // phone (nor switches one alone): it may be from before the pick.
      const again = input.again === true;
      if (again) {
        const request = {
          tool_name: input.tool_name,
          key: askKey(input.tool_name, input.tool_input),
          ...(typeof input.tool_use_id === "string" ? { tool_use_id: input.tool_use_id } : {}),
        };
        const still = await Promise.resolve()
          .then(() => asking(agent, input.session_id, request))
          .catch(() => null);
        if (still !== true || done) return finish(null);
      }
      const queued = !again && modes.get(key(agent, input.session_id));
      if (queued && switchesAlone(input.tool_name, input.tool_input, input.cwd, queued)) {
        return finish({ behavior: "allow", updatedPermissions: [{ type: "setMode", mode: queued, destination: "session" }] }, "mode", () => applied(agent, input.session_id));
      }
      const shown = await Promise.resolve()
        .then(() => shows(agent, input.session_id))
        .catch(() => false);
      if (!shown || done) return finish(null);
      const id = crypto.randomBytes(6).toString("hex");
      const tool_input = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
      let prompt;
      try {
        prompt = describeClaudePrompt(id, {
          tool_name: input.tool_name,
          input: tool_input,
          ...(Array.isArray(input.permission_suggestions) ? { permission_suggestions: input.permission_suggestions } : {}),
        });
      } catch {
        return finish(null, "mac");
      }
      ask = { id, agent, sessionId: input.session_id, prompt, finish, at: Date.now(), seen: again, again, notWaiting: 0 };
      asks.set(id, ask);
      changed(agent, ask.sessionId);
      // Answered on the Mac: Claude Code stops waiting, and says so. Twice
      // in a row (a can't-tell read between starts over): one odd read
      // doesn't take the request off the phone.
      let checking = false;
      ask.watch = setInterval(async () => {
        if (checking || done) return;
        checking = true;
        try {
          const now = await Promise.resolve()
            .then(() => waiting(agent, ask.sessionId))
            .catch(() => null);
          if (done) return;
          if (now === true) {
            ask.seen = true;
            ask.notWaiting = 0;
          } else if (now === null) ask.notWaiting = 0;
          else if (now === false && ++ask.notWaiting >= 2 && (ask.seen || Date.now() - ask.at > unseenMs)) finish(null, "mac");
        } finally {
          checking = false;
        }
      }, everyMs);
      ask.watch.unref?.();
    });
  }

  const server = net.createServer(serve);
  const windows = platform === "win32";
  let listening = false;
  // The pipe name Reach ended up on (Windows): the one it took first, and the
  // one the hook reads. On a Mac it's the socket path, as before.
  let endpoint = socketPath;
  const listenOnce = (target) =>
    new Promise((resolve, reject) => {
      const onError = (error) => (server.off("listening", onListening), reject(error));
      const onListening = () => (server.off("error", onError), resolve());
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(target);
    });
  return {
    get socketPath() {
      return endpoint;
    },
    async listen() {
      if (!windows) {
        fs.rmSync(socketPath, { force: true });
        await listenOnce(socketPath);
        fs.chmodSync(socketPath, 0o600);
        endpoint = socketPath;
        listening = true;
        return;
      }
      // Windows: take a pipe name no one else holds. Another local account
      // squatting the name can't win — Node makes the first instance or
      // none, so a clash means Reach picks a new name and says so once, and
      // Claude Code's hook is never handed a forged answer on it.
      if (!dataDir) throw bad("Reach's data folder isn't known, so the phone can't answer Claude Code here.", 500);
      let warned = false;
      for (let tries = 0; tries < 8; tries++) {
        const pipe = newPipe();
        try {
          await listenOnce(pipe);
        } catch (error) {
          if (["EADDRINUSE", "EACCES"].includes(error?.code)) {
            if (!warned) {
              warned = true;
              console.warn(`Reach: a permission-hook pipe name was already taken (${error.code}); using another. If Claude Code's prompts don't reach your phone, restart Reach.`);
            }
            continue;
          }
          throw error;
        }
        endpoint = pipe;
        writeAgentAskPipe(dataDir, pipe);
        listening = true;
        return;
      }
      throw bad("Reach couldn't open a private pipe for Claude Code's prompts.", 500);
    },
    // What the phone shows: the same prompt cards as Reach's own sessions.
    prompts: (agent, sessionId) => of(agent, sessionId).map(({ prompt: { input, suggestions, ...shown } }) => shown),
    has: (agent, sessionId) => of(agent, sessionId).length > 0,
    owns: (promptId) => asks.has(String(promptId)) || ended.has(String(promptId)),
    answer(agent, sessionId, promptId, answer) {
      const ask = asks.get(String(promptId));
      if (!ask || ask.agent !== agent || ask.sessionId !== sessionId)
        throw bad(
          ended.get(String(promptId)) === "mac" ? `Answered on your ${computerWord(platform)}.` : "This prompt was already answered.",
          409,
        );
      const decision = claudeAnswer(ask.prompt, answer, platform); // 400 for anything not offered
      // A mode picked on the phone goes in with this answer (Claude Code
      // takes setMode only with an allow). A plan's own pick wins.
      const mode = !ask.again && modes.get(key(agent, sessionId));
      if (mode && decision.behavior === "allow" && !decision.updatedPermissions?.some((p) => p?.type === "setMode")) {
        decision.updatedPermissions = [...(decision.updatedPermissions || []), { type: "setMode", mode, destination: "session" }];
      }
      ask.finish(decision, "phone", mode && decision.updatedPermissions?.some((p) => p?.mode === mode) ? () => applied(agent, sessionId, false) : undefined);
      return { answered: true };
    },
    // A mode for a session Reach doesn't run: Claude Code has no way in for it
    // but a hook's answer, so it's switched with the phone's next allow there.
    // Until then Reach's PreToolUse hook makes Claude Code ask before its next
    // tool call (even in a mode that wouldn't ask), so that answer comes.
    queueMode(agent, sessionId, mode) {
      if (!AGENTS.has(agent) || !UUID.test(String(sessionId)) || !MODES.has(mode)) throw bad("Reach can't pick that mode.", 400);
      keepMode(sessionId, mode);
      modes.set(key(agent, sessionId), mode);
      changed(agent, sessionId);
    },
    queuedMode: (agent, sessionId) => modes.get(key(agent, sessionId)) || null,
    // Taken another way (Reach runs the chat's next turn in it, or it's
    // archived): Claude Code there is no longer made to ask for it.
    clearMode(agent, sessionId) {
      if (modes.has(key(agent, sessionId))) applied(agent, sessionId);
    },
    version: (agent, sessionId) => versions.get(key(agent, sessionId)) || 0,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Reach is quitting: every held ask stays with the Mac's dialog, and its
    // hook asks the next Reach again.
    close() {
      for (const ask of [...asks.values()]) ask.finish(null, "restart");
      if (listening) {
        server.close();
        // A Mac socket is a file to remove; a Windows pipe vanishes with the
        // server. Its name file is left for the hook to notice it's stale (it
        // checks the pipe's server before trusting an answer either way).
        if (!windows) fs.rmSync(socketPath, { force: true });
        else if (dataDir) fs.rmSync(path.join(dataDir, AGENT_PIPE_FILE), { force: true });
        listening = false;
      }
    },
  };
}
