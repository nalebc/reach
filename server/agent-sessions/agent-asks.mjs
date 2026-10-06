// An agent asking you something (a permission, a question) in any session,
// the Claude and Codex apps' included, answered from the phone. Claude Code
// and Codex both run a PermissionRequest hook before they ask (Claude Code:
// ~/.claude/settings.json; Codex: ~/.codex/config.toml); Reach's hook
// (scripts/agent-hook.mjs) asks Reach over this private socket. Reach holds the
// ask for the phone when the phone has that session open, or nobody has used
// the Mac for a while; it lets go (the agent then shows its own dialog) as
// soon as the Mac is used after the ask arrived. Each ask ends exactly once:
// the phone's answer, the Mac in use, or the hook ending (timeout, Esc, the
// session closing). Verified Oct 4: Claude Code takes the hook's answer as the
// person's, also for AskUserQuestion (updatedInput.answers), in Claude app
// sessions. Codex documents the same hook (allow, or deny with a message).
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { claudeAnswer, describeClaudePrompt } from "./claude-host.mjs";
import { idleSeconds } from "./claude-import.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENTS = new Set(["claude", "codex"]);
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

// A Codex approval as the phone shows Reach's own Codex approvals.
export function describeCodexHookPrompt(id, { tool_name: tool = "", tool_input: input = {} } = {}) {
  const command = input.command ?? input.cmd;
  const shown = Array.isArray(command) ? command.join(" ") : command;
  return {
    id,
    kind: "command",
    tool,
    title: shown !== undefined ? "Run this command?" : `Allow ${tool || "this"}?`,
    command: shown !== undefined ? String(shown) : JSON.stringify(input).slice(0, 600),
    cwd: typeof input.workdir === "string" ? input.workdir : "",
    reason: typeof input.justification === "string" ? input.justification : "",
    decisions: ["accept", "decline"],
  };
}
export function codexHookAnswer(prompt, answer) {
  if (!prompt.decisions.includes(answer?.decision)) throw bad("That choice is not available for this prompt.");
  return answer.decision === "accept"
    ? { behavior: "allow" }
    : { behavior: "deny", message: "The user declined this from Reach." };
}
const describe = (agent, id, input) =>
  agent === "codex"
    ? describeCodexHookPrompt(id, input)
    : describeClaudePrompt(id, { tool_name: input.tool_name, input: input.tool_input });
const decide = (agent, prompt, answer) =>
  agent === "codex" ? codexHookAnswer(prompt, answer) : claudeAnswer(prompt, answer);

export function createAgentAsks({
  socketPath,
  // Seconds since the last keyboard or mouse input on the Mac (null: unknown).
  idle = idleSeconds,
  // Nobody at the Mac for this long: the phone answers.
  awayMs = 60 * 1000,
  // How often a held ask checks whether the Mac has been used.
  everyMs = 1000,
  watchGraceMs = 5000,
  // (agent, session): prompts already reaching the phone another way (Reach's own sessions).
  skip = () => false,
  // (agent, session): a phone has this session open right now.
  watching = () => false,
  // (agent, session): the phone can show this session (an app's or a
  // terminal's, not a headless run). Anything else is never held.
  shows = async () => true,
}) {
  const asks = new Map(); // id -> ask
  const ended = new Map(); // id -> why, for a late answer from the phone
  const versions = new Map(); // agent:session -> changes
  const listeners = new Set();
  const changed = (agent, sessionId) => {
    versions.set(key(agent, sessionId), (versions.get(key(agent, sessionId)) || 0) + 1);
    for (const listener of listeners) listener(agent, sessionId);
  };
  // Seconds since the Mac was last used; null when unknown, which counts as
  // someone there (the agent shows its dialog on the Mac).
  const idleNow = () =>
    Promise.resolve()
      .then(idle)
      .catch(() => null);
  const remember = (id, why) => {
    ended.set(id, why);
    if (ended.size > 200) ended.delete(ended.keys().next().value);
  };
  const of = (agent, sessionId) => [...asks.values()].filter((a) => a.agent === agent && a.sessionId === sessionId);

  function serve(socket) {
    let buffer = "";
    let ask = null;
    let done = false;
    // Ends the ask once: a decision for the agent, or none (its dialog shows).
    const finish = (decision, why) => {
      if (done) return;
      done = true;
      if (ask) {
        asks.delete(ask.id);
        clearInterval(ask.watch);
        remember(ask.id, why);
        changed(ask.agent, ask.sessionId);
      }
      try {
        socket.end(`${JSON.stringify(decision ? { decision } : {})}\n`);
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
      if (buffer.length > 1024 * 1024) return socket.destroy();
      const at = buffer.indexOf("\n");
      if (at < 0) return;
      let input;
      try {
        input = JSON.parse(buffer.slice(0, at));
      } catch {
        return finish(null);
      }
      const agent = input.agent;
      if (
        !AGENTS.has(agent) ||
        !UUID.test(String(input.session_id)) ||
        typeof input.tool_name !== "string" ||
        skip(agent, input.session_id)
      )
        return finish(null);
      if (!watching(agent, input.session_id)) {
        const shown = await Promise.resolve()
          .then(() => shows(agent, input.session_id))
          .catch(() => false);
        if (!shown) return finish(null);
        const seconds = await idleNow();
        if (seconds == null || seconds * 1000 < awayMs) return finish(null);
      }
      if (done) return;
      const id = crypto.randomBytes(6).toString("hex");
      const tool_input = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
      ask = {
        id,
        agent,
        sessionId: input.session_id,
        prompt: describe(agent, id, { tool_name: input.tool_name, tool_input }),
        finish,
        at: Date.now(),
        lastWatched: watching(agent, input.session_id) ? Date.now() : null,
      };
      asks.set(id, ask);
      changed(agent, ask.sessionId);
      // Keep the phone answerable while it is reading this session. Mac input
      // (including Reach screen control) must not silently steal its question.
      ask.watch = setInterval(async () => {
        if (watching(agent, ask.sessionId)) {
          ask.lastWatched = Date.now();
          return;
        }
        if (ask.lastWatched != null && Date.now() - ask.lastWatched < watchGraceMs) return;
        const seconds = await idleNow();
        if (!done && (seconds == null || seconds * 1000 < Date.now() - ask.at)) finish(null, "mac");
      }, everyMs);
      ask.watch.unref?.();
    });
  }

  const server = net.createServer(serve);
  let listening = false;
  return {
    socketPath,
    async listen() {
      if (process.platform === "win32") throw bad("Agent permission hooks require Unix socket permissions.", 501);
      fs.rmSync(socketPath, { force: true });
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, () => {
          server.off("error", reject);
          resolve();
        });
      });
      fs.chmodSync(socketPath, 0o600);
      listening = true;
    },
    // What the phone shows: the same prompt cards as Reach's own sessions.
    prompts: (agent, sessionId) => of(agent, sessionId).map(({ prompt: { input, suggestions, ...shown } }) => shown),
    has: (agent, sessionId) => of(agent, sessionId).length > 0,
    owns: (promptId) => asks.has(String(promptId)) || ended.has(String(promptId)),
    answer(agent, sessionId, promptId, answer) {
      const ask = asks.get(String(promptId));
      if (!ask || ask.agent !== agent || ask.sessionId !== sessionId)
        throw bad(
          ended.get(String(promptId)) === "mac" ? "Answered on your Mac." : "This prompt was already answered.",
          409,
        );
      ask.finish(decide(agent, ask.prompt, answer), "phone"); // 400 for anything not offered
      return { answered: true };
    },
    version: (agent, sessionId) => versions.get(key(agent, sessionId)) || 0,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // Reach is quitting: every held ask goes back to the Mac's dialog.
    close() {
      for (const ask of [...asks.values()]) ask.finish(null, "mac");
      if (listening) {
        server.close();
        fs.rmSync(socketPath, { force: true });
        listening = false;
      }
    },
  };
}
