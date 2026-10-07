// Compatibility is a capability check, not a promise about a version number.
// Extra fields are tolerated; required fields and approval scope are not guessed.
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const exec = promisify(execFile);
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
export const uncertainDelivery = (agent) =>
  Object.assign(
    new Error(
      `${agent === "codex" ? "Codex" : "Claude"} did not confirm the action. It may already have happened. Automatic retry is paused; check the conversation on your computer before sending again.`,
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
      (q.options !== undefined &&
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
  if (valid && /\/(list)$/.test(method))
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
    valid = result.data.every(t => object(t) && typeof t.id === "string" && !!t.id && ["inProgress", "completed", "interrupted", "failed"].includes(t.status));
  if (valid && method === "account/read")
    valid = result.account === null || object(result.account);
  if (!valid) throw compatibilityError("codex", method, !readOnlyRpc(method));
  return result;
}

// Bounded, account-free probes. Cache by executable metadata, so an in-place
// upgrade is noticed even before the TTL expires. Failed probes expire sooner.
export function createAgentProbe({
  run = exec,
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
        const v = await run(file, ["--version"], options);
        version =
          String(v.stdout).match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0] ||
          null;
        const h = await run(
          file,
          agent === "claude" ? ["--help"] : ["app-server", "daemon", "--help"],
          options,
        );
        const help = String(h.stdout);
        const required =
          agent === "claude"
            ? [
                "--input-format",
                "--output-format",
                "--resume",
                "--session-id",
                "--permission-mode",
              ]
            : ["start"];
        const missing = required.filter((flag) => !help.includes(flag));
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
