// Driving Claude Code sessions from Reach: one `claude -p` process per
// session in stream-json mode, resumed by its own id (never a fork) or started
// with a new one, with permission prompts answered on the phone
// (--permission-prompts host). Verified with claude 2.1.289, signed out: the
// flags, the initialize handshake (models, commands), system/init with our
// session id, replayed user messages, API errors, results, set_model and
// set_permission_mode. Permission requests (can_use_tool) and their answers
// follow the shapes in the CLI's own code; they need a signed-in turn to see.
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
  const input = request.input || {};
  if (request.tool_name === "AskUserQuestion" && Array.isArray(input.questions))
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
  const name = request.display_name || request.tool_name || "a tool";
  const suggestions = Array.isArray(request.permission_suggestions) ? request.permission_suggestions : [];
  const shown = input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.pattern ?? input.host;
  return {
    id,
    kind: "tool",
    tool: request.tool_name || "",
    title: request.description || `Allow ${name}?`,
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
  env = process.env,
  now = Date.now,
  // After a turn, Reach keeps its process this long while the phone shows the
  // session, and only `graceMs` otherwise: an idle process left behind would
  // let the Claude app open the session as a second writer.
  idleMs = 60 * 1000,
  graceMs = 5000,
  readFile = fs.readFileSync,
}) {
  const sessions = new Map();
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
  const changed = (s) => {
    s.version++;
    for (const wake of [...s.waiters]) wake();
  };
  const write = (s, message) => s.proc?.stdin.write(`${JSON.stringify(message)}\n`);
  const control = (s, request) =>
    new Promise((resolve, reject) => {
      const id = `reach-${randomUUID()}`;
      s.pending.set(id, { resolve, reject });
      write(s, { type: "control_request", request_id: id, request });
      setTimeout(() => s.pending.delete(id) && reject(bad("Claude Code didn't answer.", 504)), 15000).unref?.();
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
    s.prompts.clear();
    for (const waiting of s.pending.values()) waiting.reject(bad("Claude Code disconnected.", 503));
    s.pending.clear();
    s.status = "idle";
    changed(s);
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
    switch (m.type) {
      case "control_request": {
        if (typeof m.request_id !== "string" || !m.request_id) return;
        const request = m.request || {};
        if (request.subtype === "can_use_tool") {
          s.prompts.set(m.request_id, describeClaudePrompt(m.request_id, request));
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
          write(s, {
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
        if (r.subtype === "error") waiting.reject(bad(r.error || "Claude Code refused that.", 409));
        else waiting.resolve(r.response || {});
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
        else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") s.streaming += e.delta.text || "";
        else return;
        break;
      }
      case "assistant": {
        if (m.parent_tool_use_id) return;
        s.streaming = "";
        s.items++;
        const tools = (m.message?.content || []).filter((b) => b?.type === "tool_use");
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
        if (m.is_error) s.error = String(m.result || "Claude Code stopped with an error.");
        if (!s.turns) {
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
    if (!claude) throw bad("Claude Code isn't installed on this Mac.", 404);
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
      for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        if (!line.trim()) continue;
        try {
          handle(s, JSON.parse(line));
        } catch {
          /* a line that isn't a message */
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
      for (const waiting of s.pending.values()) waiting.reject(bad("Claude Code stopped.", 503));
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
    write(s, { type: "control_request", request_id: `reach-init-${randomUUID()}`, request: { subtype: "initialize" } });
  }

  function turn(s, input) {
    write(s, { type: "user", message: { role: "user", content: input }, parent_tool_use_id: null, session_id: s.id });
    s.turns++;
    s.wrote = true;
    s.status = s.status === "waiting" ? "waiting" : "running";
    s.error = null;
    clearTimeout(s.idle);
    changed(s);
  }

  return {
    drives: (id) => !!sessions.get(id)?.proc,
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
      turn(s, input);
      return { turnId: null };
    },
    async start({ cwd, text, images, model, effort, mode }) {
      if (typeof cwd !== "string" || !cwd.startsWith("/")) throw bad("Choose a folder.");
      const input = claudeContent({ text, images }, readFile);
      const id = randomUUID();
      const s = state(id);
      s.cwd = cwd;
      s.settings = { model: model || null, effort: effort || null, mode: mode || null };
      await launch(s, { resume: false });
      turn(s, input);
      return { threadId: id, turnId: null };
    },
    async stop(id) {
      const s = sessions.get(id);
      if (!s?.proc || !s.turns) throw bad("Reach isn't running anything here. Stop it on your Mac.", 409);
      await control(s, { subtype: "interrupt" });
      return { stopped: true };
    },
    async respond(id, promptId, answer) {
      const s = sessions.get(id);
      const prompt = s?.prompts.get(String(promptId));
      if (!prompt) throw bad("This prompt was already answered.", 409);
      if (prompt.replying) throw bad("This answer is already being sent.", 409);
      const response = claudeAnswer(prompt, answer);
      const proc = s.proc;
      if (!proc || proc.stdin.destroyed || proc.stdin.writableEnded || proc.stdin.writable === false)
        throw bad("Claude Code disconnected. Open the live screen to check the request.", 503);
      prompt.replying = true;
      try {
        await new Promise((resolve, reject) => {
          const stopped = () => finish(bad("Claude Code disconnected before the answer was delivered.", 503));
          const finish = (error) => {
            clearTimeout(timer);
            proc.removeListener("exit", stopped);
            proc.removeListener("error", stopped);
            if (error) reject(error);
            else if (s.proc !== proc) stopped();
            else resolve();
          };
          const timer = setTimeout(() => finish(bad("Claude Code did not confirm delivery. Check the request before retrying.", 504)), 10000);
          proc.once("exit", stopped);
          proc.once("error", stopped);
          try {
            proc.stdin.write(`${JSON.stringify({ type: "control_response", response: { subtype: "success", request_id: prompt.id, response } })}\n`, finish);
          } catch (error) { finish(error); }
        });
        if (s.prompts.get(String(promptId)) === prompt) s.prompts.delete(String(promptId));
        if (!s.prompts.size && s.status === "waiting") s.status = "running";
        changed(s);
        return { answered: true };
      } finally {
        prompt.replying = false;
      }
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
        prompts: [...s.prompts.values()].map(({ input, suggestions, replying, ...p }) => p),
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
        const finish = (found) => {
          clearTimeout(timer);
          try {
            proc.kill();
          } catch {}
          resolve(found);
        };
        const empty = { models: [], commands: [] };
        const timer = setTimeout(() => finish(empty), 15000);
        proc.on("error", () => finish(empty));
        proc.stdout.on("data", (chunk) => {
          buffer += chunk;
          for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
            const line = buffer.slice(0, i);
            buffer = buffer.slice(i + 1);
            try {
              const m = JSON.parse(line);
              if (m.type === "control_response")
                finish({ models: m.response?.response?.models || [], commands: m.response?.response?.commands || [] });
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
      for (const s of sessions.values()) end(s);
    },
  };
}
