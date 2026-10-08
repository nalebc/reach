// Driving Claude Code sessions from Reach: one `claude -p` process per
// session in stream-json mode, resumed by its own id (never a fork) or started
// with a new one, with permission prompts answered on the phone
// (--permission-prompts host). Verified with claude 2.1.289, signed out: the
// flags, the initialize handshake (models, commands), system/init with our
// session id, replayed user messages, API errors, results, set_model and
// set_permission_mode. Permission requests (can_use_tool) and their answers
// follow the shapes in the CLI's own code; they need a signed-in turn to see.
import { uncertainDelivery, object, validateQuestions, compatibilityError, probeAgent } from "./compatibility.mjs";
import { elicitationPrompt, elicitationAnswer } from "./elicitation.mjs";
import { createClaudeRewinds } from "./claude-rewinds.mjs";
import { computerWord } from "../computer-word.mjs";
import { execFile, spawn as spawnChild } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Claude Code's permission modes as it lists them in --help, in the order and
// with the names its own code gives them (default is "Manual"). A mode it adds
// later shows under its own id; "dontAsk" is for scripts, not a person.
const MODE_NAMES = { manual: "Manual", plan: "Plan", acceptEdits: "Accept edits", bypassPermissions: "Bypass Permissions", auto: "Auto" };
export function claudeModes(help = "") {
  // No help at all (it didn't run): nothing, asked again next time.
  if (!String(help).trim()) return [];
  const choices = help.match(/--permission-mode[\s\S]*?\(choices:([^)]*)\)/)?.[1] || "";
  const order = Object.keys(MODE_NAMES);
  // Help worded differently one day: the modes Reach knows, not none.
  const listed = [...choices.matchAll(/"([\w-]+)"/g)].map((m) => m[1]);
  const ids = (listed.length ? listed : order).filter((id) => id !== "dontAsk");
  const rank = (id) => (order.includes(id) ? order.indexOf(id) : order.length);
  return ids.sort((a, b) => rank(a) - rank(b)).map((id) => ({ id, label: MODE_NAMES[id] || id }));
}
const bad = (message, status = 400) => Object.assign(new Error(message), { status });
// --permission-mode choices in 2.1.289; the Claude app records "default" for Manual.
const MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);
export const claudeMode = (mode) => (mode === "default" ? "manual" : MODES.has(mode) ? mode : null);
const MEDIA = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };

// A message in the Anthropic format: text, then images inline.
export function claudeContent({ text = "", images = [] } = {}, readFile = fs.readFileSync) {
  if (typeof text !== "string" || text.length > 50000) throw bad("Messages can be up to 50,000 characters.");
  const content = [];
  if (text.trim()) content.push({ type: "text", text });
  for (const file of images) {
    const media = MEDIA[path.extname(file).toLowerCase()];
    if (!media) throw bad("Unknown image.");
    content.push({ type: "image", source: { type: "base64", media_type: media, data: readFile(file).toString("base64") } });
  }
  if (!content.length) throw bad("Write a message or add an image.");
  return content;
}

// What Claude Code is doing, in the words its app uses.
export function claudeActivity(block) {
  const input = block?.input || {};
  const file = (p) => path.basename(String(p || ""));
  switch (block?.name) {
    case "Bash":
      return `Running ${String(input.command ?? "").slice(0, 80)}`;
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return `Editing ${file(input.file_path || input.notebook_path)}`;
    case "Read":
      return `Reading ${file(input.file_path)}`;
    case "Grep":
    case "Glob":
      return "Searching";
    case "WebFetch":
    case "WebSearch":
      return "Searching the web";
    case "Task":
    case "Agent":
      return String(input.description || "Running an agent").slice(0, 80);
    default:
      return block?.name ? `Using ${block.name}` : null;
  }
}

// One permission request as the phone shows it.
export function describeClaudePrompt(id, request = {}) {
  if (!object(request) || typeof request.tool_name !== "string" || !request.tool_name || (request.input != null && !object(request.input)))
    throw compatibilityError("claude", "tool approval");
  const input = request.input || {};
  if (request.tool_name === "AskUserQuestion") {
    validateQuestions(input.questions, "claude");
    return {
      id,
      kind: "question",
      title: "Claude has a question",
      input,
      questions: input.questions.map((q) => ({
        id: String(q.question ?? ""),
        header: q.header || "",
        question: q.question || "",
        options: (q.options || []).map((o) => ({ label: o.label, description: o.description || "" })),
        other: true,
        secret: false,
        multiSelect: !!q.multiSelect,
      })),
    };
  }
  // A plan ready to go: shown whole, approved into the mode to work in (as
  // Claude Code offers it: auto when it can, accept edits, ask each edit), or
  // sent back with what to change (verified with 2.1.291's plan card).
  if (request.tool_name === "ExitPlanMode") {
    const offered = (Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [])
      .filter((p) => p?.type === "setMode" && PLAN_MODES.includes(p.mode))
      .map((p) => p.mode);
    const modes = PLAN_MODES.filter((m) => offered.includes(m) || (m !== "auto" && !offered.length) || (m === "default"));
    return {
      id,
      kind: "plan",
      title: "Ready to start?",
      plan: String(input.plan ?? "").slice(0, 100000),
      input,
      decisions: [...new Set(modes)].map((m) => `plan:${m}`).concat("keepPlanning"),
    };
  }
  const name = request.display_name || request.tool_name || "a tool";
  const suggestions = !request.suppress_always_allow_rule && Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  const shown = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.host;
  return {
    id,
    kind: "tool",
    tool: request.tool_name || "",
    title: typeof request.description === "string" ? request.description : `Allow ${String(name)}?`,
    command: shown !== undefined ? String(shown) : JSON.stringify(input).slice(0, 600),
    reason: typeof request.decision_reason === "string" ? request.decision_reason : "",
    input,
    suggestions,
    decisions: ["allow", ...(suggestions.length ? ["allowAlways"] : []), "deny"],
  };
}

// The modes a plan can be approved into, in Claude Code's order.
const PLAN_MODES = ["auto", "acceptEdits", "default"];

// The phone's answer as Claude Code expects it; only what was offered.
export function claudeAnswer(prompt, answer, platform = process.platform) {
  if (prompt.kind === "plan") {
    if (!prompt.decisions.includes(answer?.decision)) throw bad("That choice is not available for this plan.");
    if (answer.decision === "keepPlanning") {
      const feedback = typeof answer.message === "string" ? answer.message.trim().slice(0, 4000) : "";
      return { behavior: "deny", message: feedback || "Keep planning. The user wants changes before you start." };
    }
    const mode = answer.decision.slice("plan:".length);
    return { behavior: "allow", updatedInput: prompt.input, updatedPermissions: [{ type: "setMode", mode, destination: "session" }] };
  }
  if (prompt.kind === "elicitation") return elicitationAnswer(prompt, answer);
  if (prompt.kind === "dialog") {
    if (answer?.decision !== "cancel") throw bad(`Answer this one on your ${computerWord(platform)}.`, 409);
    return { behavior: "cancelled" };
  }
  if (prompt.kind === "question") {
    const answers = {};
    for (const q of prompt.questions) {
      const given = answer?.answers?.[q.id];
      if (!Array.isArray(given) || !given.length || (!q.multiSelect && given.length > 1) ||
          given.some((g) => typeof g !== "string" || !g.trim() || g.length > 2000))
        throw bad("Answer every question.");
      answers[q.question] = given.join(", ");
    }
    return { behavior: "allow", updatedInput: { ...prompt.input, answers } };
  }
  if (!prompt.decisions.includes(answer?.decision)) throw bad("That choice is not available for this prompt.");
  if (answer.decision === "deny") return { behavior: "deny", message: "The user declined this from Reach." };
  return {
    behavior: "allow",
    updatedInput: prompt.input,
    ...(answer.decision === "allowAlways" ? { updatedPermissions: prompt.suggestions } : {}),
  };
}

// The chats a Reach left working, if it stopped lately: older ones were left
// long enough ago that continuing them would surprise. A Reach that crashed
// never said when: the last turn it recorded counts, with more room.
const CONTINUE_WITHIN = 15 * 60 * 1000;
const CONTINUE_AFTER_CRASH = 6 * 60 * 60 * 1000;
export function readWorking(file, at = Date.now()) {
  if (!file) return [];
  try {
    const written = fs.statSync(file).mtimeMs;
    const kept = JSON.parse(fs.readFileSync(file, "utf8"));
    const chats = Array.isArray(kept?.chats) ? kept.chats : [];
    if (Number.isFinite(kept?.stoppedAt) ? at - kept.stoppedAt > CONTINUE_WITHIN : at - written > CONTINUE_AFTER_CRASH) {
      fs.rmSync(file, { force: true });
      return [];
    }
    return chats.filter((c) => c && UUID.test(String(c.id))).map((c) => ({
      id: c.id, cwd: typeof c.cwd === "string" ? c.cwd : null,
      recovery: c.recovery || `${c.id}:${c.since || kept.stoppedAt || written}`,
      ...Object.fromEntries(["model", "effort", "mode"].flatMap((key) => typeof c[key] === "string" ? [[key, c[key]]] : [])),
    }));
  } catch {
    return [];
  }
}

export function createClaudeHost({
  locate, // async () => absolute path of the claude CLI, or null
  spawn = spawnChild,
  check = spawn === spawnChild ? (file) => probeAgent("claude", file) : async () => ({ status: "available" }),
  env = process.env,
  now = Date.now,
  // After a turn, Reach keeps its process this long while the phone shows the
  // session, and only `graceMs` otherwise: an idle process left behind would
  // let the Claude app open the session as a second writer.
  idleMs = 60 * 1000,
  graceMs = 5000,
  readFile = fs.readFileSync,
  requestTimeout = 15000,
  rewindFile = null,
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
  // More flags for a session on every launch (a team's lead: its tools and
  // standing instructions, teams.mjs); false when it must have none any more.
  extraArgs = () => null,
  // The chats mid-turn, kept on disk at each turn's start and end: a restart
  // (or a crash) ends their processes, and the next Reach continues them.
  workingFile = null,
}) {
  const sessions = new Map();
  const rewinds = createClaudeRewinds({ file: rewindFile });
  const rewindUncertain = () => Object.assign(uncertainDelivery("claude"), { message: "Claude may already have continued this rewind. Check the chat in Claude, then choose a rewind again before sending." });
  let closed = false;
  const catalogs = new Map(); // folder → its handshake
  let modeList = null;
  // Reach's own environment, never a host app's (a terminal inside Claude Code
  // sets CLAUDECODE) or its own pairing settings.
  const clean = Object.fromEntries(
    Object.entries(env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|REACH_)/.test(k) && k !== "CLAUDECODE"),
  );
  const state = (id) => {
    if (!sessions.has(id))
      sessions.set(id, {
        id,
        cwd: null,
        proc: null,
        status: "idle",
        turns: 0,
        prompts: new Map(),
        streaming: "",
        activity: null,
        error: null,
        items: 0,
        version: 0,
        waiters: new Set(),
        settings: {},
        pending: new Map(),
        idle: null,
        background: 0,
      });
    return sessions.get(id);
  };
  // Told of each change to a session (the chat list hears of its status and
  // questions this way).
  const changeListeners = new Set();
  // What the last Reach left working, read once before this one writes.
  const recoveries = new Map(readWorking(workingFile, now()).map((chat) => [chat.id, chat]));
  let interrupted = [...recoveries.values()];
  let recorded = null;
  // A process that died mid-turn (a restart's signal can reach it before
  // Reach's own close) stays on record until its chat gets a message again.
  const busy = () => [...sessions.values()].filter((s) => !s.stopping && ((s.proc && (s.turns || s.background)) || s.cutOff));
  const record = (stoppedAt, strict = false) => {
    if (!workingFile || (closed && !stoppedAt)) return;
    const chats = [...new Map([
      ...recoveries,
      ...busy().map((s) => [s.id, { id: s.id, cwd: s.cwd || null, since: s.busySince || now(),
        ...Object.fromEntries(["model", "effort", "mode"].flatMap((key) => typeof s.settings[key] === "string" ? [[key, s.settings[key]]] : [])),
      }]),
    ]).values()];
    const json = JSON.stringify(chats);
    if (json === recorded && !stoppedAt) return;
    try {
      if (!chats.length) {
        fs.rmSync(workingFile, { force: true });
        recorded = json;
        return;
      }
      fs.mkdirSync(path.dirname(workingFile), { recursive: true, mode: 0o700 });
      const tmp = `${workingFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ chats, ...(stoppedAt ? { stoppedAt } : {}) }), { mode: 0o600 });
      fs.renameSync(tmp, workingFile);
      recorded = json;
    } catch (error) {
      if (strict) throw error;
      /* continued by hand then */
    }
  };
  const changed = (s) => {
    if (s.turns || s.background) s.busySince ||= now();
    else s.busySince = 0;
    record();
    s.version++;
    for (const wake of [...s.waiters]) wake();
    for (const listener of changeListeners) { try { listener(s.id); } catch {} }
  };
  const write = (s, message) => new Promise((resolve, reject) => {
    const proc = s.proc;
    if (!proc || proc.stdin.destroyed || proc.stdin.writableEnded || proc.stdin.writable === false)
      return reject(uncertainDelivery("claude"));
    let settled = false;
    const stopped = () => finish(uncertainDelivery("claude"));
    const finish = (error) => {
      if (settled) return; settled = true;
      clearTimeout(timer);
      proc.off("exit", stopped); proc.off("error", stopped); proc.off("reach-release", stopped);
      error || s.proc !== proc ? reject(uncertainDelivery("claude")) : resolve();
    };
    const timer = setTimeout(stopped, requestTimeout);
    proc.once("exit", stopped); proc.once("error", stopped); proc.once("reach-release", stopped);
    try { proc.stdin.write(`${JSON.stringify(message)}\n`, finish); }
    catch { stopped(); }
  });
  const refuse = (s, message) => { void write(s, message).catch(() => {
    s.error = uncertainDelivery("claude").message;
    end(s);
    changed(s);
  }); };
  const control = (s, request) =>
    new Promise((resolve, reject) => {
      const id = `reach-${randomUUID()}`;
      const timer = setTimeout(() => {
        if (s.pending.delete(id)) reject(uncertainDelivery("claude"));
      }, requestTimeout);
      s.pending.set(id, { resolve, reject, timer });
      write(s, { type: "control_request", request_id: id, request }).catch((error) => {
        clearTimeout(timer);
        if (s.pending.delete(id)) reject(error);
      });
    });
  // Let the process go after a quiet while; the next message resumes it.
  // Never while its background agents work: they end with it.
  const rest = (s) => {
    clearTimeout(s.idle);
    if (!s.proc || s.turns || s.background) return;
    // Still naming the session: its name goes in first.
    if (s.naming) return void s.naming.then(() => rest(s));
    s.idle = setTimeout(() => !s.turns && !s.background && end(s), s.waiters.size ? idleMs : graceMs);
    s.idle.unref?.();
  };
  const released = new Set();
  const end = (s) => {
    clearTimeout(s.idle);
    const proc = s.proc;
    if (!proc) return;
    s.proc = null;
    proc.emit("reach-release");
    for (const waiting of s.pending.values()) { clearTimeout(waiting.timer); waiting.reject(uncertainDelivery("claude")); }
    s.pending.clear();
    s.prompts.clear();
    s.turns = 0;
    s.background = 0;
    s.unread = 0;
    s.status = "idle";
    s.streaming = "";
    s.activity = null;
    s.busySince = 0;
    record();
    try {
      proc.stdin.end();
    } catch {}
    setTimeout(() => proc.exitCode === null && proc.kill(), 3000).unref?.();
    // wrote: Reach added to the session's transcript while it held it.
    const wrote = !!s.wrote;
    s.wrote = false;
    for (const listener of released) listener(s.id, { wrote });
  };

  function handle(s, m) {
    if (!object(m) || typeof m.type !== "string") throw compatibilityError("claude", "stream");
    switch (m.type) {
      case "control_request": {
        if (typeof m.request_id !== "string" || !m.request_id || !object(m.request)) {
          s.error = compatibilityError("claude", "control request").message;
          changed(s);
          end(s);
          return;
        }
        const request = m.request || {};
        if (request.subtype === "can_use_tool") {
          try {
            s.prompts.set(m.request_id, describeClaudePrompt(m.request_id, request));
          } catch (e) {
            s.error = e.message;
            refuse(s, { type: "control_response", response: { subtype: "error", request_id: m.request_id, error: e.message } });
            changed(s);
            return;
          }
          s.status = "waiting";
        } else if (request.subtype === "elicitation") {
          s.prompts.set(m.request_id, {
            id: m.request_id,
            ...elicitationPrompt({
              serverName: request.mcp_server_name,
              mode: request.mode || "form",
              requestedSchema: request.requested_schema,
              message: request.message,
              description: request.description,
              title: request.title,
            }, "Claude", platform),
          });
          s.status = "waiting";
        } else if (request.subtype === "request_user_dialog") {
          s.prompts.set(m.request_id, {
            id: m.request_id,
            kind: "dialog",
            title: `Claude Code needs your answer on your ${computerWord(platform)}`,
            reason: `This dialog needs Claude on your ${computerWord(platform)}. Cancel request dismisses it; it does not open Claude.`,
            decisions: ["cancel"],
          });
          s.status = "waiting";
        } else {
          // Hooks, MCP and the like have no place on the phone; say so at once.
          refuse(s, {
            type: "control_response",
            response: { subtype: "error", request_id: m.request_id, error: "Not supported by Reach." },
          });
          return;
        }
        break;
      }
      case "control_cancel_request":
        if (!s.prompts.delete(m.request_id)) return;
        if (!s.prompts.size && s.status === "waiting") s.status = "running";
        break;
      case "control_response": {
        const r = m.response || {};
        const waiting = s.pending.get(r.request_id);
        if (!waiting) return;
        s.pending.delete(r.request_id);
        clearTimeout(waiting.timer);
        if (r.subtype === "error") waiting.reject(bad(r.error || "Claude Code refused that.", 409));
        else if (r.subtype === "success") waiting.resolve(r.response || {});
        else waiting.reject(compatibilityError("claude", "control response"));
        return;
      }
      case "system":
        if (m.subtype === "status" && m.permissionMode) s.settings.mode = m.permissionMode;
        else if (m.subtype === "background_tasks_changed" && Array.isArray(m.tasks)) {
          // Every live background task (agents, shells), the whole set each
          // time (2.1.291). Ambient ones (monitors) last the session; they
          // don't keep it.
          s.background = m.tasks.filter((t) => t && !t.ambient).length;
          s.busySince = s.turns || s.background ? s.busySince || now() : 0;
          record();
          if (s.background) clearTimeout(s.idle);
          else rest(s);
          return;
        } else if (m.subtype !== "init") return;
        break;
      case "stream_event": {
        const e = m.event || {};
        if (m.parent_tool_use_id) return; // a sub-agent's text
        if (e.type === "message_start") s.streaming = "";
        else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
          if (typeof e.delta.text !== "string") throw compatibilityError("claude", "stream text");
          s.streaming += e.delta.text;
        }
        else return;
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) return;
        s.streaming = "";
        s.items++;
        if (!Array.isArray(m.message?.content)) throw compatibilityError("claude", "assistant message");
        const tools = m.message.content.filter((b) => b?.type === "tool_use");
        if (tools.length) s.activity = claudeActivity(tools.at(-1));
        if (m.error) {
          const text = (m.message?.content || []).find((b) => b?.type === "text")?.text;
          s.error = text || String(m.error);
        }
        break;
      }
      case "user":
        if (m.parent_tool_use_id) return;
        s.items++;
        // Claude Code echoes each message as it picks it up, even one sent
        // mid-turn that it folds into the turn already running.
        if (m.isReplay) {
          s.replays = true;
          s.unread = Math.max(0, (s.unread || 0) - 1);
        }
        if ((m.message?.content || []).some?.((b) => b?.type === "tool_result")) s.activity = null;
        break;
      case "result":
        // A result ends all it has picked up: a message sent mid-turn often
        // gets no result of its own (the chat read Working for good). Only
        // one it hasn't picked up yet starts another turn.
        s.turns = s.replays ? Math.min(s.turns, s.unread || 0) : Math.max(0, s.turns - 1);
        s.streaming = "";
        s.activity = null;
        s.items++;
        // A stop ends the turn as an error with no words ("aborted_streaming"
        // or "aborted_tools"); it is a stop, not a failure.
        if (m.is_error && !s.stopping && !/^aborted/.test(m.terminal_reason || ""))
          s.error = String(m.result || "Claude Code stopped with an error.");
        if (!s.turns) {
          s.stopping = false;
          s.status = "idle";
          s.prompts.clear();
          rest(s);
        }
        break;
      default:
        return;
    }
    changed(s);
  }

  async function launch(s, { resume, authorize = () => {} }) {
    authorize();
    const pendingRewind = resume ? rewinds.get(s.id) : null;
    if (pendingRewind?.phase === "dispatching") throw rewindUncertain();
    if (pendingRewind) s.resumeAt = pendingRewind.target === "start" ? null : pendingRewind.target;
    const claude = await locate();
    authorize();
    if (closed) throw bad("Claude session service is closed.", 503);
    if (!claude) throw bad(`Claude Code isn't installed on this ${computerWord(platform)}.`, 404);
    const compatible = await check(claude);
    authorize();
    if (compatible.status === "incompatible") throw compatibilityError("claude", "CLI");
    if (compatible.status !== "available")
      throw bad("Couldn’t check Claude Code’s connection. Try again in a moment, or use the screen or terminal.", 503);
    if (closed) throw bad("Claude session service is closed.", 503);
    const mode = claudeMode(s.settings.mode);
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--permission-prompts",
      "host",
      // Without it, Claude Code 2.1.291 denies on its own whatever would
      // prompt (a file write, an edit) and the phone never sees the question;
      // with it, each one comes to Reach as a can_use_tool request.
      "--permission-prompt-tool",
      "stdio",
      "--include-partial-messages",
      "--replay-user-messages",
      ...(resume ? ["--resume", s.id] : ["--session-id", s.id]),
      // A rewind: the conversation goes on from that entry, as Claude Code's
      // own rewind (the SDK's resumeSessionAt).
      ...(resume && s.resumeAt ? ["--resume-session-at", s.resumeAt] : []),
      ...(s.settings.model ? ["--model", s.settings.model] : []),
      ...(s.settings.effort ? ["--effort", s.settings.effort] : []),
      ...(mode ? ["--permission-mode", mode] : []),
      // The hook knows (a team's lead now; false: its team stopped); what
      // the start gave covers its first launch.
      ...((() => {
        const hooked = extraArgs(s.id);
        return hooked === false ? [] : hooked || s.settings.extra || [];
      })()),
    ];
    const proc = spawn(claude, args, { cwd: s.cwd || os.homedir(), env: clean, stdio: ["pipe", "pipe", "pipe"] });
    s.proc = proc;
    // Starting a preview/helper does not consume a pending continuation.
    // It is cleared only after its user message is accepted below.
    s.launchedEffort = s.settings.effort || null;
    let buffer = "";
    proc.stdout.setEncoding?.("utf8");
    proc.stdout.on("data", (chunk) => {
      if (s.proc !== proc) return;
      buffer += chunk;
      if (buffer.length > 8 * 1024 * 1024) {
        s.error = compatibilityError("claude", "stream size").message;
        end(s); changed(s); return;
      }
      for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          handle(s, JSON.parse(line));
        } catch (error) {
          // Preserve the specific checked feature; a malformed JSON line is
          // a stream mismatch. Never expose arbitrary provider payloads.
          s.error = error?.code === "AGENT_INCOMPATIBLE" ? error.message : compatibilityError("claude", "stream").message;
          end(s); changed(s); return;
        }
      }
    });
    proc.stderr?.on("data", () => {});
    proc.stdin.on?.("error", () => {});
    proc.on("error", (e) => {
      if (s.proc !== proc) return;
      s.error = e.message;
      changed(s);
    });
    proc.on("exit", () => {
      if (s.proc !== proc) return;
      s.proc = null;
      if (!s.stopping && (s.turns || s.background)) s.cutOff = true;
      for (const waiting of s.pending.values()) { clearTimeout(waiting.timer); waiting.reject(uncertainDelivery("claude")); }
      s.pending.clear();
      if (s.turns) s.error ||= "Claude Code stopped before finishing.";
      s.turns = 0;
      s.unread = 0;
      s.status = "idle";
      s.prompts.clear();
      s.streaming = "";
      s.activity = null;
      changed(s);
    });
    // The handshake the SDK host makes; it also loads the session.
    // Never send the user's message before the host accepts the handshake.
    try { await control(s, { subtype: "initialize" }); authorize(); }
    catch (e) { end(s); throw Object.assign(e, { retryable: false }); }
  }

  // A new session is named from its first message as the Claude app names
  // its own: Claude Code proposes a title (generate_session_title), then
  // rename_session writes it to the transcript as a custom-title line, which
  // is what the app reads when it imports the session (without one it lists
  // it as "General coding session"). Verified with claude 2.1.291: both
  // answer in about a second, mid-turn. If no title comes, the message's
  // first line is used.
  async function name(s, text) {
    const message = String(text || "").trim();
    if (!message) return;
    const oneLine = (value) => String(value || "").replace(/\s+/g, " ").trim();
    let title = "";
    try {
      const proposed = await control(s, { subtype: "generate_session_title", description: message.slice(0, 2000), persist: false });
      title = oneLine(proposed?.title).slice(0, 200);
    } catch {
      /* the first line instead */
    }
    if (!title) {
      const first = oneLine(message.split("\n").find((line) => line.trim()));
      title = first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
    }
    await control(s, { subtype: "rename_session", title, source: "host", session_id: s.id }).catch(() => {});
  }

  async function turn(s, input) {
    s.cutOff = false;
    s.turns++;
    s.unread = (s.unread || 0) + 1;
    s.wrote = true;
    s.status = s.status === "waiting" ? "waiting" : "running";
    s.error = null;
    clearTimeout(s.idle);
    changed(s);
    try { await write(s, { type: "user", message: { role: "user", content: input }, parent_tool_use_id: null, session_id: s.id }); }
    catch (error) { s.error = error.message; end(s); changed(s); throw error; }
  }

  return {
    drives: (id) => !!sessions.get(id)?.proc,
    onChange(listener) {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
    // Called with a session id (and whether Reach wrote to it) each time
    // Reach lets go of its process.
    onRelease(listener) {
      released.add(listener);
    },
    running: (id) => !!sessions.get(id)?.turns,
    // Chats mid-turn (or with background agents at work) right now.
    working: () => busy().filter((s) => s.proc).map((s) => s.id),
    // The chats the last Reach left mid-turn, once: [{ id, cwd }].
    interrupted() {
      const chats = interrupted;
      interrupted = [];
      return chats;
    },
    // Remove only after a durable outbox entry exists or another owner is
    // already running the chat. Reading the journal never consumes it.
    recovered(id) {
      const chat = recoveries.get(id);
      if (!chat) return;
      recoveries.delete(id);
      try { record(undefined, true); }
      catch (error) { recoveries.set(id, chat); throw error; }
    },
    // The mode Reach last gave this chat's Claude Code (or it reported).
    modeOf: (id) => sessions.get(id)?.settings?.mode || null,
    // A phone has the session open right now (its live view is waiting).
    watched: (id) => {
      const s = sessions.get(id);
      return !!s && (!!s.waiters.size || now() < (s.watchedUntil || 0));
    },
    async send(id, { text, images, model, effort, mode, cwd } = {}) {
      if (!UUID.test(id)) throw bad("Unknown session.", 404);
      const input = claudeContent({ text, images }, readFile);
      const s = state(id);
      const previous = s.sending || Promise.resolve();
      s.pendingSends = (s.pendingSends || 0) + 1;
      const operation = previous.catch(() => {}).then(async () => {
      if (s.rewinding) throw bad("A rewind is in progress. Wait for it to finish before sending.", 409);
      const pendingRewind = rewinds.get(id);
      if (pendingRewind?.phase === "dispatching") throw rewindUncertain();
      if (pendingRewind) s.resumeAt = pendingRewind.target === "start" ? null : pendingRewind.target;
      if (cwd) s.cwd = cwd;
      if (effort) s.settings.effort = effort;
      // A thinking level is a launch setting: change it between turns.
      if (s.proc && !s.turns && !s.background && effort && effort !== s.launchedEffort) end(s);
      if (!s.proc) {
        if (model) s.settings.model = model;
        if (mode) s.settings.mode = mode;
        await launch(s, { resume: true });
      }
      else {
        if (model) {
          await control(s, { subtype: "set_model", model });
          s.settings.model = model;
        }
        if (mode && claudeMode(mode)) {
          await control(s, { subtype: "set_permission_mode", mode: claudeMode(mode) });
          s.settings.mode = mode;
        }
      }
      if (pendingRewind) rewinds.set(id, { ...pendingRewind, phase: "dispatching" });
      await turn(s, input);
      // Persist consumption only after sending; an uncertain write leaves the
      // dispatch marker in place, including after a Reach restart.
      if (pendingRewind) {
        try { rewinds.delete(id); }
        catch { s.error = rewindUncertain().message; throw rewindUncertain(); }
      }
      s.resumeAt = null;
      s.rewound = null;
      return { turnId: null };
      });
      s.sending = operation;
      return operation.finally(() => { s.pendingSends--; });
    },
    // A mode picked on the phone while Reach runs the chat: at once, even
    // mid-turn (its next tool use follows it), as the app's menu does.
    async mode(id, mode) {
      const s = sessions.get(id);
      if (!claudeMode(mode)) return false;
      // Between turns: kept for its next launch.
      if (s && !s.proc) s.settings.mode = mode;
      if (!s?.proc) return false;
      await control(s, { subtype: "set_permission_mode", mode: claudeMode(mode) });
      s.settings.mode = mode;
      record();
      return true;
    },
    async start({ cwd, text, images, model, effort, mode, extra }) {
      if (typeof cwd !== "string" || !cwd.startsWith("/")) throw bad("Choose a folder.");
      const input = claudeContent({ text, images }, readFile);
      const id = randomUUID();
      const s = state(id);
      s.cwd = cwd;
      s.settings = { model: model || null, effort: effort || null, mode: mode || null, ...(Array.isArray(extra) ? { extra } : {}) };
      await launch(s, { resume: false });
      await turn(s, input);
      s.naming = name(s, text).finally(() => (s.naming = null));
      return { threadId: id, turnId: null };
    },
    async stop(id) {
      const s = sessions.get(id);
      if (!s?.proc || !s.turns) throw bad(`Reach isn't running anything here. Stop it on your ${computerWord(platform)}.`, 409);
      s.stopping = true;
      // Not stopped after all: a later error in this turn is a real one.
      await control(s, { subtype: "interrupt" }).catch((error) => {
        s.stopping = false;
        throw error;
      });
      record();
      return { stopped: true };
    },
    async respond(id, promptId, answer) {
      const s = sessions.get(id);
      const prompt = s?.prompts.get(String(promptId));
      if (!prompt) throw bad("This prompt was already answered.", 409);
      if (prompt.attempted) throw bad(`This answer was already attempted. Check Claude on your ${computerWord(platform)}.`, 409);
      const response = claudeAnswer(prompt, answer, platform);
      prompt.attempted = true;
      try { await write(s, { type: "control_response", response: { subtype: "success", request_id: prompt.id, response } }); }
      catch (error) { s.error = error.message; changed(s); throw error; }
      s.prompts.delete(String(promptId));
      if (!s.prompts.size && s.status === "waiting") s.status = "running";
      changed(s);
      return { answered: true };
    },
    // Rewind, as Claude Code's own: files back as they were before a
    // message (rewind_files; dryRun: what would change, nothing done), and
    // the conversation going on from before it (on its next message).
    async rewindFiles(id, { messageId, cwd, dryRun = false, authorize = () => {} }) {
      authorize();
      if (!UUID.test(id) || typeof messageId !== "string" || !UUID.test(messageId)) throw bad("Unknown message.", 404);
      const s = state(id);
      if (s.turns || s.pendingSends || s.rewinding) throw bad("Claude is working in this chat. Stop it first.", 409);
      s.rewinding = true;
      try {
        if (cwd) s.cwd = cwd;
        if (!s.proc) await launch(s, { resume: true, authorize });
        authorize();
        const r = await control(s, { subtype: "rewind_files", user_message_id: messageId, ...(dryRun ? { dry_run: true } : {}) });
        return {
          canRewind: r?.canRewind !== false,
          ...(typeof r?.error === "string" ? { error: r.error } : {}),
          files: Array.isArray(r?.filesChanged) ? r.filesChanged.slice(0, 200) : [],
          insertions: Number(r?.insertions) || 0,
          deletions: Number(r?.deletions) || 0,
        };
      } finally { s.rewinding = false; }
    },
    rewindConversation(id, entry) {
      if (!UUID.test(id)) throw bad("Unknown session.", 404);
      const s = state(id);
      if (s.turns || s.pendingSends || s.rewinding) throw bad("Claude is working in this chat. Stop it first.", 409);
      // Save before accepting the choice or ending the existing helper.
      rewinds.set(id, { target: entry === null ? "start" : entry, phase: "pending" });
      // The next launch resumes there; a process running now ends first.
      if (s.proc) end(s);
      s.resumeAt = entry || null;
      s.rewound = entry === null ? "start" : entry;
      changed(s);
      return { rewound: true };
    },
    // Where a rewind waits for the next message: an entry, "start", or null.
    rewoundTo: (id) => rewinds.get(id)?.target || null,
    // One background task or sub-agent stopped, the rest going on
    // (Claude Code's stop_task, as the Claude app's per-task stop).
    async stopTask(id, taskId) {
      const s = sessions.get(id);
      if (typeof taskId !== "string" || !/^[\w-]{1,80}$/.test(taskId)) throw bad("Unknown task.", 404);
      if (!s?.proc) throw bad(`Reach isn't running this chat. Stop it on your ${computerWord(platform)}.`, 409);
      await control(s, { subtype: "stop_task", task_id: taskId });
      return { stopped: true };
    },
    // Ends Reach's process for a session (before the Claude app takes it).
    release(id) {
      const s = sessions.get(id);
      if (!s?.proc) return false;
      if (s.turns) throw bad("Reach is running this session. Stop it or let it finish first.", 409);
      end(s);
      return true;
    },
    view(id) {
      const s = sessions.get(id);
      if (!s) return { version: 0, status: null, error: null, prompts: [], streaming: "", activity: null, items: 0 };
      return {
        version: s.version,
        status: s.status,
        error: s.error,
        prompts: [...s.prompts.values()].map(({ input, suggestions, ...p }) => p),
        streaming: s.streaming,
        activity: s.activity,
        items: s.items,
      };
    },
    changes(id, since, ms = 25000, signal) {
      const s = state(id);
      s.watchedUntil = now() + graceMs;
      if (s.version !== Number(since)) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          s.waiters.delete(done);
          s.watchedUntil = now() + graceMs;
          signal?.removeEventListener?.("abort", done);
          // The phone left the session: let go soon.
          if (!s.waiters.size && signal?.aborted) rest(s);
          resolve();
        };
        const timer = setTimeout(done, ms);
        s.waiters.add(done);
        signal?.addEventListener?.("abort", done);
      });
    },
    async models() {
      return (await this.catalog()).models;
    },
    // The permission modes this Claude Code offers (from its --help), kept.
    async modes() {
      if (modeList) return modeList;
      const cli = await locate();
      if (!cli) return [];
      const help = await new Promise((resolve) =>
        execFile(cli, ["--help"], { timeout: 15000, env: clean, maxBuffer: 1024 * 1024 }, (e, stdout) =>
          resolve(String(stdout || "")),
        ),
      );
      const modes = claudeModes(help);
      if (modes.length) modeList = modes;
      return modes;
    },
    // Slash commands, as the composer offers them after "/": those of the
    // chat's folder (its own commands and skills join Claude Code's).
    async commands(cwd) {
      return (await this.catalog(cwd)).commands;
    },
    // What this Claude Code offers (models, commands), from a handshake that
    // starts no session, in a folder (the chat's, or none); kept half an hour.
    async catalog(cwd) {
      const where = typeof cwd === "string" && path.isAbsolute(cwd) && fs.existsSync(cwd) ? cwd : os.tmpdir();
      const kept = catalogs.get(where);
      if (kept && now() - kept.at < 30 * 60 * 1000) return kept.value;
      const claude = await locate();
      if (!claude) return { models: [], commands: [] };
      const value = await new Promise((resolve) => {
        const proc = spawn(claude, ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"], {
          cwd: where,
          env: clean,
          stdio: ["pipe", "pipe", "pipe"],
        });
        let buffer = "";
        let done = false;
        const finish = (found) => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try {
            proc.kill();
          } catch {}
          resolve(found);
        };
        const empty = { models: [], commands: [] };
        const timer = setTimeout(() => finish(empty), 15000);
        proc.on("error", () => finish(empty));
        proc.on("exit", () => finish(empty));
        proc.stderr?.on("data", () => {});
        proc.stdin.on?.("error", () => finish(empty));
        proc.stdout.on("data", (chunk) => {
          buffer += chunk;
          for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            try {
              const m = JSON.parse(line);
              if (m?.type === "control_response" && m.response?.request_id === "models") {
                const r = m.response;
                const data = r.response;
                if (r.subtype !== "success" || !object(data) || ![data.models, data.commands ?? []].every(v => Array.isArray(v) && v.every(object))) return finish(empty);
                finish({ models: data.models, commands: data.commands || [] });
              }
            } catch {}
          }
        });
        proc.stdin.write(`${JSON.stringify({ type: "control_request", request_id: "models", request: { subtype: "initialize" } })}\n`);
      });
      if (value.models.length) catalogs.set(where, { at: now(), value });
      return value;
    },
    // Reach is quitting: let every Claude Code process go.
    close() {
      // What was working stays on record (with when Reach stopped) for the
      // next Reach to continue.
      record(now());
      closed = true;
      for (const s of sessions.values()) end(s);
    },
  };
}
