// Compatibility is a capability check, not a promise about a version number.
// Extra fields are tolerated; required fields and approval scope are not guessed.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { computerWord } from "../computer-word.mjs";
import { spawnable } from "../agent-cli.mjs";
// A command's output read from a file, not a pipe. Claude Code (2.1.291)
// exits before a pipe has taken all of its --help: 8 or 16 KB of 22 KB came
// through, cut mid-line, and the flags past the cut read as missing
// ("Claude's CLI interface is incompatible with Reach", Oct 7). Writes to
// a file complete before the process can exit.
export async function runToFile(file, args, { timeout = 5000, maxBuffer = 256 * 1024, env, spawn: launch = spawn } = {}) {
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 16 * 1024 * 1024)
    throw Error("Invalid probe output limit.");
  const tmp = path.join(os.tmpdir(), `reach-probe-${process.pid}-${crypto.randomUUID()}`);
  const fd = fs.openSync(tmp, "wx+", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const child = launch(file, args, { env, stdio: ["ignore", fd, "ignore"], windowsHide: true });
      let failure = null, force = null, finished = false;
      const stop = error => {
        if (failure || finished) return;
        failure = error;
        // Keep the output file until observed exit. A slow or TERM-resistant
        // child must not continue writing an unlinked file after we return.
        try { child.kill("SIGTERM"); } catch { /* force termination below */ }
        if (finished) return;
        force = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} }, 1000);
        force.unref?.();
      };
      const timer = setTimeout(() => stop(Error("Probe timed out.")), timeout);
      // This limits ordinary runaway output promptly, with bounded reads
      // below. It is not a filesystem quota or a sandbox for a hostile CLI.
      const output = setInterval(() => {
        try { if (fs.fstatSync(fd).size > maxBuffer) stop(Error("Probe output exceeded its limit.")); }
        catch { stop(Error("Probe output could not be read.")); }
      }, 25);
      output.unref?.();
      const done = (error = null) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer); clearTimeout(force); clearInterval(output);
        if (failure || error) reject(failure || error); else resolve();
      };
      child.once("error", error => {
        if (!child.pid) done(error); // failed to spawn: there is no writer
        else stop(Error("Probe process failed."));
      });
      child.once("exit", code => done(code === 0 ? null : Error("Probe process failed.")));
    });
    // Never allocate/read the entire output and truncate it afterwards.
    if (fs.fstatSync(fd).size > maxBuffer) throw Error("Probe output exceeded its limit.");
    const data = Buffer.alloc(maxBuffer + 1);
    let length = 0;
    while (length < data.length) {
      const read = fs.readSync(fd, data, length, data.length - length, length);
      if (!read) break;
      length += read;
    }
    if (length > maxBuffer) throw Error("Probe output exceeded its limit.");
    return { stdout: data.subarray(0, length).toString("utf8") };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
  }
}
// A help text that stopped mid-way (no final newline, after at least a
// pipe's worth): what it lacks can't be held against the agent.
export const cutShort = (text) => text.length >= 4096 && !text.endsWith("\n");
export const object = (v) => !!v && typeof v === "object" && !Array.isArray(v);
export const compatibilityError = (agent, feature, uncertain = false) =>
  Object.assign(
    new Error(
      `${agent === "codex" ? "Codex" : "Claude"}'s ${feature} interface is incompatible with Reach. Update Reach or use the screen or terminal.${uncertain ? " The action may already have happened; check the conversation before sending again." : ""}`,
    ),
    {
      status: 409,
      code: "AGENT_INCOMPATIBLE",
      feature,
      uncertain,
      retryable: false,
    },
  );
export const uncertainDelivery = (agent, platform = process.platform) =>
  Object.assign(
    new Error(
      `${agent === "codex" ? "Codex" : "Claude"} did not confirm the action. It may already have happened. Automatic retry is paused; check the conversation on your ${computerWord(platform)} before sending again.`,
    ),
    {
      status: 409,
      code: "AGENT_DELIVERY_UNKNOWN",
      uncertain: true,
      retryable: false,
    },
  );

export function validateQuestions(questions, agent) {
  if (!Array.isArray(questions) || !questions.length || questions.length > 100)
    throw compatibilityError(agent, "questions");
  const ids = new Set();
  for (const q of questions) {
    const id = agent === "claude" ? q?.question : q?.id;
    if (
      !object(q) ||
      typeof id !== "string" ||
      !id.trim() ||
      ids.has(id) ||
      typeof q.question !== "string" ||
      !q.question.trim() ||
      (q.header !== undefined && typeof q.header !== "string") ||
      ["multiSelect", "isOther", "isSecret"].some(
        (k) => q[k] !== undefined && typeof q[k] !== "boolean",
      ) ||
      (q.options != null &&
        (!Array.isArray(q.options) ||
          q.options.some(
            (o) =>
              !object(o) ||
              typeof o.label !== "string" ||
              !o.label.trim() ||
              (o.description !== undefined &&
                typeof o.description !== "string"),
          )))
    )
      throw compatibilityError(agent, "questions");
    const labels = (q.options || []).map((o) => o.label);
    if (new Set(labels).size !== labels.length)
      throw compatibilityError(agent, "questions");
    ids.add(id);
  }
}

export const readOnlyRpc = (method) =>
  /\/(read|list)$/.test(method) || method === "initialize";
const strings = (v, keys) =>
  object(v) && keys.every((k) => v[k] == null || typeof v[k] === "string");
const list = (v, check) => v == null || (Array.isArray(v) && v.every(check));
const threadShape = (t) =>
  strings(t, ["id", "name", "preview", "cwd", "model", "reasoningEffort"]) &&
  typeof t.id === "string" && !!t.id &&
  (t.gitInfo == null || strings(t.gitInfo, ["branch"])) &&
  (t.status == null ||
    (strings(t.status, ["type"]) &&
      list(t.status.activeFlags, (f) => typeof f === "string")));
const itemShape = (entry) => {
  if (
    !object(entry) ||
    !object(entry.item) ||
    typeof entry.item.type !== "string"
  )
    return false;
  const item = entry.item;
  // Unknown/internal items are ignored by codexItem; do not reject their private schema.
  switch (item.type) {
    case "userMessage":
      return (
        strings(item, ["id"]) &&
        list(item.content, (c) => strings(c, ["type", "text"]))
      );
    case "agentMessage":
      return strings(item, ["id", "text"]);
    case "commandExecution":
      return strings(item, ["id", "status", "aggregatedOutput"]);
    case "fileChange":
      return (
        strings(item, ["id", "status"]) &&
        list(item.changes, (c) => strings(c, ["path", "diff"]))
      );
    case "mcpToolCall":
      return strings(item, ["id", "status"]);
    default:
      return true;
  }
};
export function validateCodexResult(method, result) {
  let valid = object(result);
  // thread/loaded/list pages thread ids, not objects (codex-cli 0.162 schema).
  if (valid && method === "thread/loaded/list")
    valid =
      Array.isArray(result.data) &&
      result.data.every((id) => typeof id === "string" && !!id) &&
      (result.nextCursor == null || typeof result.nextCursor === "string");
  else if (valid && /\/(list)$/.test(method))
    valid = Array.isArray(result.data) && result.data.every(object);
  if (
    valid &&
    ["thread/start", "thread/read", "thread/resume"].includes(method)
  )
    valid = threadShape(result.thread);
  if (valid && method === "thread/list") valid = result.data.every(threadShape);
  if (valid && method === "thread/items/list")
    valid = result.data.every(itemShape);
  if (valid && method === "thread/queue/list")
    valid = result.data.every(
      (q) =>
        strings(q, ["id"]) &&
        typeof q.id === "string" &&
        list(q.input, (i) => strings(i, ["type", "text"])),
    );
  if (valid && method === "model/list")
    valid = result.data.every(
      (m) =>
        strings(m, [
          "id",
          "displayName",
          "description",
          "defaultReasoningEffort",
        ]) &&
        typeof m.id === "string" &&
        list(m.supportedReasoningEfforts, (e) =>
          strings(e, ["reasoningEffort", "description"]),
        ) &&
        list(m.inputModalities, (v) => typeof v === "string") &&
        list(m.serviceTiers, (tier) =>
          strings(tier, ["id", "name", "description"]),
        ),
    );
  if (valid && method === "turn/start")
    valid = object(result.turn) && typeof result.turn.id === "string";
  if (valid && method === "thread/queue/add")
    valid = object(result.queuedSubmission) && typeof result.queuedSubmission.id === "string" && !!result.queuedSubmission.id;
  if (valid && method === "thread/queue/delete") valid = typeof result.deleted === "boolean";
  if (valid && method === "turn/steer") valid = typeof result.turnId === "string" && !!result.turnId;
  if (valid && method === "thread/turns/list")
    // A status Codex adds later is a turn all the same (finished once it has
    // an end time): never a reason to stop reading turns.
    valid = result.data.every(t => object(t) && typeof t.id === "string" && !!t.id && typeof t.status === "string" && !!t.status);
  if (valid && method === "account/read")
    valid = result.account === null || object(result.account);
  if (!valid) throw compatibilityError("codex", method, !readOnlyRpc(method));
  return result;
}

// Bounded, account-free probes. Cache by executable metadata, so an in-place
// upgrade is noticed even before the TTL expires. Failed probes expire sooner.
// The oldest releases with everything Reach uses, found by testing each
// release (Oct 13): Claude Code 2.1.259 brought --permission-prompts (how
// the phone answers its permission prompts), Codex 0.148.0 the queue of
// messages sent while it works. Older ones are named, with what to do,
// rather than "Update Reach" (what an old Claude Code was told before).
export const OLDEST_WORKING = { claude: "2.1.259", codex: "0.148.0" };
const olderThan = (version, floor) => {
  const a = String(version).split(/[.+-]/).slice(0, 3).map(Number), b = floor.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== b[i]) return (a[i] || 0) < b[i];
  return false;
};
export function tooOld(agent, version) {
  const floor = OLDEST_WORKING[agent];
  if (!floor || !version || !/^\d+\.\d+\.\d+/.test(version) || !olderThan(version, floor)) return null;
  const name = agent === "codex" ? "Codex" : "Claude Code";
  return { version, status: "incompatible", reason: `${name} ${version} is older than Reach works with: update it to ${floor} or newer, or use the screen or terminal.` };
}
export function createAgentProbe({
  run = runToFile,
  stat = fs.statSync,
  now = Date.now,
  ttlMs = 60000,
} = {}) {
  const cache = new Map();
  return async (agent, file) => {
    if (!file)
      return {
        version: null,
        status: "unavailable",
        reason: "Agent executable was not found.",
      };
    let fingerprint;
    try {
      const s = stat(file);
      fingerprint = `${s.ino}:${s.size}:${s.mtimeMs}`;
    } catch {
      fingerprint = "unknown";
    }
    const key = `${agent}:${file}`;
    const old = cache.get(key);
    if (old && old.fingerprint === fingerprint && now() < old.expires)
      return old.value;
    const entry = { fingerprint, expires: now() + ttlMs };
    entry.value = (async () => {
      let version = null;
      try {
        const options = {
          timeout: 5000,
          maxBuffer: 256 * 1024,
          env: { ...process.env, CI: "1", NO_COLOR: "1" },
        };
        const cli = spawnable(file);
        const v = await run(cli.file, [...cli.args, "--version"], options);
        version =
          String(v.stdout).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ||
          null;
        const old = tooOld(agent, version);
        if (old) return old;
        const required =
          agent === "claude"
            ? [
                // Every option Reach launches Claude Code with (claude-host.mjs),
                // but --resume-session-at, which its --help doesn't list. One
                // gone is found here, not as "may already have happened" on send.
                "--input-format",
                "--output-format",
                "--resume",
                "--session-id",
                "--permission-mode",
                "--verbose",
                "--permission-prompts",
                "--permission-prompt-tool",
                "--include-partial-messages",
                "--replay-user-messages",
                "--model",
                "--effort",
              ]
            : ["start"];
        // Read again while the text looks cut short (see runToFile): only a
        // whole reading may find the agent incompatible.
        let help = "",
          missing = required;
        for (let attempt = 0; attempt < 3 && missing.length; attempt++) {
          const h = await run(
            cli.file,
            [...cli.args, ...(agent === "claude" ? ["--help"] : ["app-server", "daemon", "--help"])],
            options,
          );
          help = String(h.stdout);
          missing = required.filter((flag) => !help.includes(flag));
          if (missing.length && !cutShort(help)) break;
        }
        if (missing.length && cutShort(help)) {
          entry.expires = now() + Math.min(ttlMs, 10000);
          return {
            version,
            status: "unavailable",
            reason:
              "Could not read the agent's command list fully. Try again in a moment, or use the screen or terminal.",
          };
        }
        // Missing from a release new enough: it changed, and Reach needs to.
        if (missing.length)
          return {
            version,
            status: "incompatible",
            reason:
              "Required agent commands are unavailable. Update Reach or use the screen or terminal.",
          };
        return { version, status: "available", checkedAt: now() };
      } catch {
        entry.expires = now() + Math.min(ttlMs, 10000);
        return {
          version,
          status: "unavailable",
          reason:
            "Could not verify the agent interface. Use the screen or terminal, then check again.",
        };
      }
    })();
    cache.set(key, entry);
    return entry.value;
  };
}
export const probeAgent = createAgentProbe();
