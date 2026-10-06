// Driving Claude Code sessions from Reach: one `claude -p` process per
// session in stream-json mode, resumed by its own id (never a fork) or started
// with a new one, with permission prompts answered on the phone
// (--permission-prompts host). Verified with claude 2.1.289, signed out: the
// flags, the initialize handshake (models, commands), system/init with our
// session id, replayed user messages, API errors, results, set_model and
// set_permission_mode. Permission requests (can_use_tool) and their answers
// follow the shapes in the CLI's own code; they need a signed-in turn to see.
import { uncertainDelivery, object, validateQuestions, compatibilityError, probeAgent } from "./compatibility.mjs";
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
  const choices = help.match(/--permission-mode[\s\S]*?\(choices:([^)]*)\)/)?.[1] || "";
  const ids = [...choices.matchAll(/"([\w-]+)"/g)].map((m) => m[1]).filter((id) => id !== "dontAsk");
  const order = Object.keys(MODE_NAMES);
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
  const name = request.display_name || request.tool_name || "a tool";
  const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
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

// The phone's answer as Claude Code expects it; only what was offered.
export function claudeAnswer(prompt, answer) {
  if (prompt.kind === "dialog") {
    if (answer?.decision !== "cancel") throw bad("Answer this one on your Mac.", 409);
    return { behavior: "cancelled" };
  }
  if (prompt.kind === "question") {
    const answers = {};
    for (const q of prompt.questions) {
      const given = answer?.answers?.[q.id];
      if (!Array.isArray(given) || !given.length || given.some((g) => typeof g !== "string" || g.length > 2000))
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
}) {
  const sessions = new Map();
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
      });
    return sessions.get(id);
  };
  // Told of each change to a session (the chat list hears of its status and
  // questions this way).
  const changeListeners = new Set();
  const changed = (s) => {
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
  const rest = (s) => {
    clearTimeout(s.idle);
    if (!s.proc || s.turns) return;
    s.idle = setTimeout(() => !s.turns && end(s), s.waiters.size ? idleMs : graceMs);
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
    s.status = "idle";
    s.streaming = "";
    s.activity = null;
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
        } else if (request.subtype === "request_user_dialog") {
          s.prompts.set(m.request_id, {
            id: m.request_id,
            kind: "dialog",
            title: "Claude Code needs your answer on your Mac",
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
        else if (m.subtype !== "init") return;
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
        if ((m.message?.content || []).some?.((b) => b?.type === "tool_result")) s.activity = null;
        break;
      case "result":
        s.turns = Math.max(0, s.turns - 1);
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

  async function launch(s, { resume }) {
    const claude = await locate();
    if (closed) throw bad("Claude session service is closed.", 503);
    if (!claude) throw bad("Claude Code isn't installed on this Mac.", 404);
    const compatible = await check(claude);
    if (compatible.status !== "available") throw compatibilityError("claude", "CLI");
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
      ...(s.settings.model ? ["--model", s.settings.model] : []),
      ...(s.settings.effort ? ["--effort", s.settings.effort] : []),
      ...(mode ? ["--permission-mode", mode] : []),
    ];
    const proc = spawn(claude, args, { cwd: s.cwd || os.homedir(), env: clean, stdio: ["pipe", "pipe", "pipe"] });
    s.proc = proc;
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
        } catch {
          s.error = compatibilityError("claude", "stream").message;
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
      for (const waiting of s.pending.values()) { clearTimeout(waiting.timer); waiting.reject(uncertainDelivery("claude")); }
      s.pending.clear();
      if (s.turns) s.error ||= "Claude Code stopped before finishing.";
      s.turns = 0;
      s.status = "idle";
      s.prompts.clear();
      s.streaming = "";
      s.activity = null;
      changed(s);
    });
    // The handshake the SDK host makes; it also loads the session.
    // Never send the user's message before the host accepts the handshake.
    try { await control(s, { subtype: "initialize" }); }
    catch (e) { end(s); throw Object.assign(e, { retryable: false }); }
  }

  async function turn(s, input) {
    s.turns++;
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
      const operation = previous.catch(() => {}).then(async () => {
      if (cwd) s.cwd = cwd;
      if (model) s.settings.model = model;
      if (effort) s.settings.effort = effort;
      if (mode) s.settings.mode = mode;
      // A thinking level is a launch setting: change it between turns.
      if (s.proc && !s.turns && effort && effort !== s.launchedEffort) end(s);
      if (!s.proc) await launch(s, { resume: true });
      else {
        if (model) await control(s, { subtype: "set_model", model });
        if (mode && claudeMode(mode)) await control(s, { subtype: "set_permission_mode", mode: claudeMode(mode) });
      }
      await turn(s, input);
      return { turnId: null };
      });
      s.sending = operation;
      return operation;
    },
    async start({ cwd, text, images, model, effort, mode }) {
      if (typeof cwd !== "string" || !cwd.startsWith("/")) throw bad("Choose a folder.");
      const input = claudeContent({ text, images }, readFile);
      const id = randomUUID();
      const s = state(id);
      s.cwd = cwd;
      s.settings = { model: model || null, effort: effort || null, mode: mode || null };
      await launch(s, { resume: false });
      await turn(s, input);
      return { threadId: id, turnId: null };
    },
    async stop(id) {
      const s = sessions.get(id);
      if (!s?.proc || !s.turns) throw bad("Reach isn't running anything here. Stop it on your Mac.", 409);
      s.stopping = true;
      // Not stopped after all: a later error in this turn is a real one.
      await control(s, { subtype: "interrupt" }).catch((error) => {
        s.stopping = false;
        throw error;
      });
      return { stopped: true };
    },
    async respond(id, promptId, answer) {
      const s = sessions.get(id);
      const prompt = s?.prompts.get(String(promptId));
      if (!prompt) throw bad("This prompt was already answered.", 409);
      if (prompt.attempted) throw bad("This answer was already attempted. Check Claude on your Mac.", 409);
      const response = claudeAnswer(prompt, answer);
      prompt.attempted = true;
      try { await write(s, { type: "control_response", response: { subtype: "success", request_id: prompt.id, response } }); }
      catch (error) { s.error = error.message; changed(s); throw error; }
      s.prompts.delete(String(promptId));
      if (!s.prompts.size && s.status === "waiting") s.status = "running";
      changed(s);
      return { answered: true };
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
        prompts: [...s.prompts.values()].map(({ input, suggestions, attempted, ...p }) => p),
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
      closed = true;
      for (const s of sessions.values()) end(s);
    },
  };
}
