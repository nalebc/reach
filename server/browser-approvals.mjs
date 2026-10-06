import { parseBrowserScript } from "./browser-scripts.mjs";
import crypto from "node:crypto";
import { browserNotification, notificationPush } from "./notification-items.mjs";
import path from "node:path";
import { terminalLocation } from "./restricted-terminal.mjs";
import { parseBrowserMutation } from "./browser-mutations.mjs";
import { fail, isPlainRecord, hasReviewControls } from "./core.mjs";

const SCREEN_KEYS = new Set([
  "enter", "backspace", "tab", "escape", "left", "right", "up", "down",
]);
const FIELDS = {
  click: ["x", "y", "button", "count"],
  text: ["text"],
  key: ["key"],
  scroll: ["direction", "amount"],
  command: ["command"],
  terminal: ["command", "root", "cwd"],
  "terminal-change": ["command", "root", "cwd"],
  "terminal-script": ["command", "root", "cwd"],
};
const active = (request) => ["pending", "executing"].includes(request.status);
export const browserRequestActions = (action) => action.type === "batch" ? action.actions : [action];
const terminalRequest = (action) => browserRequestActions(action).every((step) => step.type === "terminal");
const grant = (client) => JSON.stringify({
  scopes: [...client.scopes].sort(),
  policy: client.policy,
  roots: client.agentRoots,
  expiresAt: client.expiresAt,
  tailscale: client.tailscale,
});
const visible = (request) => ({
  id: request.id,
  clientId: request.clientId,
  name: request.name,
  action: structuredClone(request.action),
  reason: request.reason,
  status: request.status,
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
  ...(request.steps ? {
    steps: structuredClone(request.steps),
    completedCount: request.steps.filter((step) => step.status === "executed").length,
    attemptedCount: request.steps.filter((step) => ["executing", "executed", "failed"].includes(step.status)).length,
    ...(request.executionExpiresAt ? { executionExpiresAt: request.executionExpiresAt } : {}),
  } : {}),
  ...(request.error ? { error: request.error } : {}),
  ...(request.output !== undefined ? { output: request.output } : {}),
  ...(request.approval ? { approval: request.approval } : {}),
  ...(request.exitCode !== undefined ? { exitCode: request.exitCode } : {}),
  ...(request.folder !== undefined ? { folder: request.folder } : {}),
  ...(request.directory !== undefined ? { directory: request.directory, completedAt: request.completedAt } : {}),
});

function parse(input) {
  if (isPlainRecord(input) && input.type === "batch") {
    if (Object.keys(input).some((key) => !["type", "reason", "actions"].includes(key)) ||
        !Array.isArray(input.actions) || input.actions.length < 1 || input.actions.length > 5)
      throw fail(400, "Request between 1 and 5 exact actions in one batch.");
    if (Buffer.byteLength(JSON.stringify(input)) > 12000)
      throw fail(400, "Keep the complete batch under 12,000 bytes.");
    const actions = input.actions.map((step) => {
      if (!isPlainRecord(step) || ["batch", "command", "terminal-change", "terminal-script"].includes(step.type) || Object.hasOwn(step, "reason"))
        throw fail(400, "Use screen actions or restricted commands, without nested batches or manual command requests.");
      return parse({ ...step, reason: input.reason }).action;
    });
    if (actions.some((step) => (step.type === "terminal") !== (actions[0].type === "terminal")))
      throw fail(400, "Keep screen actions and restricted commands in separate batches.");
    return { action: Object.freeze({ type: "batch", actions: Object.freeze(actions) }), reason: input.reason.trim() };
  }
  if (!isPlainRecord(input) ||
      typeof input.type !== "string" ||
      !Object.hasOwn(FIELDS, input.type))
    throw fail(400, "Choose a supported screen action or command request.");
  const fields = FIELDS[input.type];
  if (Object.keys(input).some((key) => !["type", "reason", ...fields].includes(key)))
    throw fail(400, "This request contains unsupported fields.");
  if (typeof input.reason !== "string" || !input.reason.trim() || input.reason.length > 1000 || hasReviewControls(input.reason))
    throw fail(400, "Explain why this action is needed, in up to 1,000 characters without hidden control characters.");
  const action = { type: input.type };
  for (const key of fields) if (input[key] !== undefined) action[key] = input[key];
  if (action.type === "click") {
    if (![action.x, action.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1) ||
        (action.button !== undefined && !["left", "right"].includes(action.button)) ||
        (action.count !== undefined && ![1, 2].includes(action.count)))
      throw fail(400, "Choose a screen point and a single or double left or right click.");
    action.button ??= "left";
    action.count ??= 1;
  }
  if (action.type === "text" &&
      (typeof action.text !== "string" || !action.text || action.text.length > 2000 || /[\u0000-\u0008\u000b-\u001f\u007f]/.test(action.text)))
    throw fail(400, "Text must contain 1 to 2,000 characters; only newline and tab control characters are supported.");
  if (action.type === "key" && !SCREEN_KEYS.has(action.key))
    throw fail(400, "Choose Enter, Backspace, Tab, Escape, or an arrow key.");
  if (action.type === "scroll") {
    if (action.amount === undefined) action.amount = 3;
    if (!["up", "down"].includes(action.direction) ||
        !Number.isInteger(action.amount) || action.amount < 1 || action.amount > 5)
      throw fail(400, "Choose up or down and 1 to 5 scroll steps.");
  }
  if (action.type === "command" &&
      (typeof action.command !== "string" || !action.command.trim() || action.command.length > 4000 || action.command.includes("\0")))
    throw fail(400, "Describe the command to handle, in up to 4,000 characters without null characters.");
  if (["terminal-change", "terminal-script"].includes(action.type)) {
    if (typeof action.command !== "string" || !action.command.trim() || action.command.length > 4000 || hasReviewControls(action.command))
      throw fail(400, "Enter a command of up to 4,000 characters without hidden controls.");
    if (action.type === "terminal-script") parseBrowserScript(action.command); else parseBrowserMutation(action.command);
    terminalLocation({ ...action, command: "pwd" });
    if (!Number.isSafeInteger(action.root) || action.root < 0) throw fail(400, "Choose a shared working folder.");
  }
  if (action.type === "terminal") {
    terminalLocation(action);
    if (!Number.isSafeInteger(action.root) || action.root < 0)
      throw fail(400, "Choose a shared folder for this command.");
  }
  return { action: Object.freeze(action), reason: input.reason.trim() };
}

function isBrowser(client, now) {
  return client?.kind === "agent" && client.policy?.browser === true &&
    client.scopes?.includes("browser:read") &&
    client.scopes?.includes("browser:request") &&
    Number.isFinite(client.expiresAt) && client.expiresAt > now;
}
const permits = (client, action) => action.type === "batch"
  ? action.actions.every((step) => permits(client, step))
  : action.type === "terminal-script"
  ? client.policy.restrictedTerminal === true && client.policy.scriptApproval === true && !!(client.agentRoots || client.policy.roots)?.[action.root]
  : action.type === "terminal-change"
  ? client.policy.restrictedTerminal === true && client.policy.terminalApproval === true &&
    !!(client.agentRoots || client.policy.roots)?.[action.root]
  : action.type === "terminal"
  ? client.policy.restrictedTerminal === true &&
    !!(client.agentRoots || client.policy.roots)?.[action.root]
  : action.type === "command"
    ? client.policy.commandRequests === true && !client.policy.restrictedTerminal
    : false; // Desktop input is retired; selected-app input has its own guard.
function owner(client) {
  if (client?.kind !== "device" || !client.scopes?.includes("admin"))
    throw fail(403, "Only the computer's owner can answer this request.");
}

// Routes and queue insertion both enforce grants. Legacy screen actions are
// parsed for compatibility but never permitted, even for older invitations.
export function validateBrowserRequest(client, input, at = Date.now()) {
  const parsed = parse(input);
  if (!isBrowser(client, at) || !permits(client, parsed.action))
    throw fail(403, "This invitation does not allow this request.");
  return parsed;
}

// This queue holds exact, short-lived requests, never an execution credential.
// Restricted terminal actions run only in the owner's decision call.
// Legacy manual command requests remain messages and never reach execute().
// Selected-app actions cannot enter this queue or fall back to desktop input.
export function createBrowserApprovals({
  verifyClient,
  verifyOwner = () => null,
  execute,
  notify = () => {},
  record = () => {},
  onChange,
  now = Date.now,
}) {
  const requests = new Map();
  // Memory-only, keyed by invitation identity and its complete current grant.
  // Neither names nor agent-supplied approval fields participate in matching.
  const sessionApprovals = new Map();
  const rememberable = (action) => ["terminal-change", "terminal-script"].includes(action.type);
  const commandKey = (action) => JSON.stringify([action.type, action.command, action.root, action.cwd || ""]);
  const approvalKey = (client, action) => JSON.stringify([client.id, grant(client), commandKey(action)]);
  const remembered = (client, action) => {
    if (closed || !rememberable(action) || !isBrowser(client, now()) || !permits(client, action)) return null;
    for (const [oldKey, old] of sessionApprovals) if (old.clientId === client.id && old.grant !== grant(client)) sessionApprovals.delete(oldKey);
    const key = approvalKey(client, action), entry = sessionApprovals.get(key);
    if (!entry) return null;
    try {
      const latest = verifyClient(client.id);
      if (!latest || !isBrowser(latest, now()) || grant(latest) !== entry.grant || entry.expiresAt <= now()) throw Error("Expired session approval");
      entry.checkOwner();
      return entry;
    } catch { sessionApprovals.delete(key); return null; }
  };
  const requestTimes = new Map();
  let allRequestTimes = [];
  const automaticTimes = new Map();
  let allAutomaticTimes = [];
  let changes = Promise.resolve();
  let persistenceError;
  const changed = (request) => {
    if (!onChange) return;
    const snapshot = visible(request);
    changes = changes.then(() => onChange(snapshot)).catch((error) => { persistenceError ||= error; });
  };
  const flushChanges = async () => {
    await changes;
    if (persistenceError) throw fail(503, "Command history could not be saved. Execution is blocked; no automatic retry will occur.");
  };
  let closed = false;
  const audit = (message) => record("agent", message);
  const skipRemaining = (request) => {
    for (const step of request.steps || []) if (step.status === "pending") step.status = "skipped";
  };
  const current = (request) => {
    const client = verifyClient(request.clientId);
    return client?.id === request.clientId && isBrowser(client, now()) &&
      permits(client, request.action) && grant(client) === request.grant ? client : null;
  };
  const sweep = () => {
    for (const [key, entry] of sessionApprovals) {
      const client = verifyClient(entry.clientId);
      if (!client || remembered(client, entry.action) !== entry) sessionApprovals.delete(key);
    }
    for (const request of requests.values()) {
      if (!active(request)) continue;
      if (Math.min(request.expiresAt, request.executionExpiresAt ?? Infinity) <= now()) request.status = "expired";
      else if (!current(request)) request.status = "revoked";
      if (!active(request)) { skipRemaining(request); changed(request); }
    }
    // Pending work stays bounded separately. Retain only a small history, in
    // memory; restarting the companion never replays unfinished actions.
    const history = [...requests.values()].filter((request) => !active(request));
    for (const request of history.slice(0, Math.max(0, history.length - 100)))
      requests.delete(request.id);
  };
  const get = (id) => {
    sweep();
    const request = requests.get(id);
    if (!request) throw fail(404, "This browser request was not found.");
    return request;
  };
  const authorizeRequest = (request) => {
    if (closed || request.status !== "executing")
      throw fail(409, "This request is no longer approved for execution.");
    if (Math.min(request.expiresAt, request.executionExpiresAt ?? Infinity) <= now()) {
      request.status = "expired";
      skipRemaining(request); changed(request);
      throw fail(410, "This request expired. Ask for a new one.");
    }
    const client = current(request);
    if (!client) {
      request.status = "revoked";
      skipRemaining(request); changed(request);
      throw fail(403, "This browser's access expired or was revoked.");
    }
    return client;
  };
  return {
    flushChanges,
    request(client, input, { automatic = false, session = false } = {}) {
      if (automatic && input?.type !== "terminal") throw fail(403, "Only supported read commands may run automatically.");
      if (closed) throw fail(503, "Browser requests are unavailable.");
      const { action, reason } = validateBrowserRequest(client, input, now());
      // Both the initiating credential and its current server-side grant
      // must authorize this action. A caller cannot substitute another ID.
      const latest = verifyClient(client.id);
      if (latest?.id !== client.id || !isBrowser(latest, now()) || !permits(latest, action))
        throw fail(403, "This browser's access expired or was revoked.");
      sweep();
      if (session && !remembered(latest, action)) throw fail(403, "This command needs a new owner approval.");
      const automaticBudget = automatic || session;
      const pending = [...requests.values()].filter(active);
      if (pending.length >= 20 || pending.filter((r) => r.clientId === client.id).length >= 3)
        throw fail(429, "Wait for an existing browser request to be answered.");
      // Cancellation does not release notification capacity: a browser must
      // not spam its owner by rapidly asking and withdrawing the same action.
      const cutoff = now() - 60000;
      const times = automaticBudget ? automaticTimes : requestTimes;
      let allTimes = (automaticBudget ? allAutomaticTimes : allRequestTimes).filter((time) => time > cutoff);
      for (const [id, values] of times) {
        const recent = values.filter((time) => time > cutoff);
        if (recent.length) times.set(id, recent); else times.delete(id);
      }
      const recent = times.get(client.id) || [];
      if (recent.length >= (automaticBudget ? 120 : 10) || allTimes.length >= (automaticBudget ? 600 : 60))
        throw fail(429, "Too many browser requests. Wait a minute before asking again.");
      recent.push(now()); times.set(client.id, recent); allTimes.push(now());
      if (automaticBudget) allAutomaticTimes = allTimes; else allRequestTimes = allTimes;
      const request = {
        id: crypto.randomUUID(),
        clientId: client.id,
        grant: grant(latest),
        name: String(latest.name || "AI browser").slice(0, 80),
        action,
        reason,
        approval: session ? "session" : automatic ? "automatic" : "owner",
        ...(["terminal", "terminal-change", "terminal-script"].includes(action.type) ? { folder: path.join((latest.agentRoots || latest.policy.roots)[action.root], action.cwd || "") } : {}),
        ...(action.type === "batch" ? { steps: action.actions.map((step) => ({
          action: step,
          status: "pending",
          ...(step.type === "terminal" ? { folder: path.join((latest.agentRoots || latest.policy.roots)[step.root], step.cwd || "") } : {}),
        })) } : {}),
        status: "pending",
        createdAt: now(),
        expiresAt: Math.min(now() + (["command", "terminal-change", "terminal-script"].includes(action.type) || terminalRequest(action) ? 300000 : 60000), latest.expiresAt),
      };
      requests.set(request.id, request);
      changed(request);
      audit(automatic ? "An AI browser submitted a read-only command" : "An AI browser requested owner approval");
      // Push payloads and audit entries deliberately omit the action, reason,
      // credentials, and any resulting screen or command contents.
      try {
        if (!automaticBudget) Promise.resolve(notify({
          ...notificationPush(browserNotification(request)),
          category: "access",
          tag: `browser-${crypto.createHash("sha256").update(client.id).digest("hex").slice(0, 12)}`,
        })).catch(() => {});
      } catch {
        // Notification availability never changes the stored consent state.
      }
      return visible(request);
    },
    async runRemembered(client, input, reauthorize) {
      const { action } = validateBrowserRequest(client, input, now());
      const entry = remembered(client, action);
      if (!entry) return null;
      const item = this.request(client, input, { session: true });
      return this.decide(entry.owner, item.id, "approve", () => {
        const latest = reauthorize();
        if (latest.id !== client.id || remembered(latest, action) !== entry) throw fail(403, "This session approval ended. Ask the owner again.");
        entry.checkOwner();
        return entry.owner;
      });
    },
    async runReadOnly(client, input, reauthorize) {
      if (input?.type !== "terminal") throw fail(403, "Only supported read commands may run automatically.");
      const item = this.request(client, input, { automatic: true });
      const request = requests.get(item.id);
      request.status = "executing";
      changed(request);
      const authorize = () => {
        const caller = reauthorize();
        if (caller?.id !== request.clientId) throw fail(403, "The terminal session changed.");
        return authorizeRequest(request);
      };
      try {
        if (onChange) await flushChanges();
        authorize();
        const output = await execute(request.action, authorize, visible(request));
        authorize();
        request.output = typeof output === "string" ? output.slice(0, 64100) : "";
        const location = terminalLocation(request.action);
        if (location.spec.name === "cd") request.directory = location.relative === "." ? "" : location.relative;
        request.completedAt = now();
        request.status = "executed";
      } catch (error) {
        if (request.status === "executing") request.status = "failed";
        request.error = [400, 401, 403, 409, 410, 423, 503, 504].includes(error?.status) ? error.message : "The command could not be completed.";
      }
      changed(request);
      if (onChange) await flushChanges();
      return visible(request);
    },
    listOwner() {
      sweep();
      return [...requests.values()].filter((request) => request.status === "pending" ||
        (["batch", "terminal", "terminal-change", "terminal-script"].includes(request.action.type) && request.status === "executing")).map(visible).reverse();
    },
    getOwner(id) {
      return visible(get(id));
    },
    listClient(client) {
      if (!isBrowser(client, now()))
        throw fail(403, "This invitation does not allow browser requests.");
      sweep();
      return [...requests.values()]
        .filter((request) => request.clientId === client.id).map(visible).reverse();
    },
    cancel(client, id) {
      if (!isBrowser(client, now()))
        throw fail(403, "This invitation does not allow browser requests.");
      const request = get(id);
      if (request.clientId !== client.id)
        throw fail(404, "This browser request was not found.");
      if (request.status !== "pending" && !(["batch", "terminal", "terminal-change", "terminal-script"].includes(request.action.type) && request.status === "executing"))
        throw fail(409, "This browser request is no longer pending.");
      for (const [key, entry] of sessionApprovals) if (entry.clientId === request.clientId && commandKey(entry.action) === commandKey(request.action)) sessionApprovals.delete(key);
      request.status = "cancelled";
      skipRemaining(request);
      changed(request);
      return visible(request);
    },
    async decide(client, id, decision, authorizeOwner) {
      owner(client);
      if (typeof authorizeOwner !== "function")
        throw fail(403, "Owner authorization must be checked before answering.");
      const checkOwner = () => {
        const refreshed = authorizeOwner();
        // Route authorizers may throw on failure without returning a value.
        if (refreshed !== undefined) {
          owner(refreshed);
          if (refreshed.id !== client.id)
            throw fail(403, "The approving owner changed. Review the request again.");
        }
      };
      checkOwner();
      const request = get(id);
      if (decision === "deny") { for (const [key, entry] of sessionApprovals) if (entry.clientId === request.clientId && commandKey(entry.action) === commandKey(request.action)) sessionApprovals.delete(key); }
      if (request.clientId === client.id)
        throw fail(403, "A browser cannot answer its own request.");
      if (!closed && ["batch", "terminal", "terminal-change", "terminal-script"].includes(request.action.type) && request.status === "executing" && decision === "deny") {
        request.status = "cancelled";
        skipRemaining(request);
        changed(request);
        if (onChange) await flushChanges();
        audit("The owner stopped a browser action batch");
        return visible(request);
      }
      if (closed || request.status !== "pending")
        throw fail(409, "This browser request is no longer pending.");
      const remember = decision === "approve-session";
      if (remember) {
        owner(verifyOwner(client.id));
        if (!rememberable(request.action)) throw fail(400, "Session approval is only available for one exact terminal command.");
        if (sessionApprovals.size >= 500) throw fail(429, "Too many remembered approvals. End this session to clear them.");
        decision = "approve";
      }
      const command = request.action.type === "command";
      if (!(command ? ["deny", "handled"] : ["approve", "deny"]).includes(decision))
        throw fail(400, command
          ? "Handle this command yourself, then mark it handled, or deny it. Reach cannot execute it."
          : request.action.type === "terminal" ? "Approve this one restricted command or deny it." : "Approve this one screen action or deny it.");
      if (decision !== "approve") {
        request.status = decision === "handled" ? "handled" : "denied";
        skipRemaining(request);
        changed(request);
        if (onChange) await flushChanges();
        audit(decision === "handled"
          ? "The owner marked a browser command request handled"
          : "The owner denied a browser request");
        return visible(request);
      }
      // Claim before the first await: concurrent decisions and retries cannot
      // execute a payload twice or turn approval into a lasting capability.
      request.status = "executing";
      changed(request);
      if (request.steps)
        request.executionExpiresAt = Math.min(request.expiresAt, now() + (terminalRequest(request.action) ? 30000 : 20000));
      const authorize = () => {
        checkOwner();
        return authorizeRequest(request);
      };
      try {
        if (onChange) await flushChanges();
        authorize();
        // Only the host executor reports progress. Every child is immutable,
        // ordered, and attempted at most once; the agent receives no new grant.
        const progress = async (index, status, output) => {
          const step = request.steps?.[index];
          if (!step || !["executing", "executed"].includes(status))
            throw fail(409, "Invalid batch execution progress.");
          if (status === "executing") {
            authorize();
            if (step.status !== "pending" || request.steps.slice(0, index).some((prior) => prior.status !== "executed"))
              throw fail(409, "Batch actions must run once, in the reviewed order.");
          } else if (step.status !== "executing") {
            throw fail(409, "This batch action was not started.");
          }
          step.status = status;
          if (status === "executed" && step.action.type === "terminal") {
            step.output = typeof output === "string" ? output.slice(0, 12000) : "";
            const location = terminalLocation(step.action);
            if (location.spec.name === "cd") {
              step.directory = location.relative === "." ? "" : location.relative;
              step.completedAt = now();
            }
          }
          changed(request);
          if (onChange) await flushChanges();
        };
        const output = await execute(request.action, authorize, visible(request), progress);
        if (request.steps && request.steps.some((step) => step.status !== "executed"))
          throw fail(409, "The batch stopped before every action completed. Review the results before requesting more actions.");
        if (["terminal-change", "terminal-script"].includes(request.action.type)) {
          authorize();
          request.output = typeof output === "string" ? output.slice(0, 64100) : (output?.output || "").slice(0, 64100);
          if (request.action.type === "terminal-script") { request.exitCode = output?.exitCode ?? null; if (output?.exitCode !== 0) { request.status = "failed"; request.error = output?.exitCode === null ? "Command stopped." : `Command exited with status ${output?.exitCode}.`; } }
        }
        if (request.action.type === "terminal") {
          authorize();
          request.output = typeof output === "string" ? output.slice(0, 64100) : "";
        const location = terminalLocation(request.action);
        if (location.spec.name === "cd") {
          request.directory = location.relative === "." ? "" : location.relative;
          request.completedAt = now();
        }
        }
        // Revocation during native dispatch cannot undo an action already
        // delivered to the OS. Preserve the interrupted status and never retry.
        if (request.status === "executing") request.status = "executed";
        audit(request.steps ? "The owner approved an exact browser action batch" : request.action.type === "terminal" ? "The owner approved one restricted terminal command" : "The owner approved one browser screen action");
      } catch (error) {
        if (request.status === "executing") request.status = "failed";
        request.error = [400, 401, 403, 409, 410, 423, 501, 503, 504].includes(error?.status) && typeof error.message === "string"
          ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)
          : ["terminal", "terminal-change", "terminal-script"].includes(request.action.type) ? "The command could not be completed. Review the folder and request again." : "The screen action was not confirmed. Review the screen before requesting another action.";
        for (const step of request.steps || []) if (step.status === "executing") {
          step.status = "failed";
          step.error = request.error;
        }
        skipRemaining(request);
        audit(request.steps ? "A browser action batch stopped before completion" : request.action.type === "terminal" ? "A restricted terminal command was not completed" : "A browser screen action was not confirmed");
      }
      changed(request);
      if (onChange) await flushChanges();
      if (remember && request.status === "executed") {
        checkOwner();
        const latest = current(request);
        if (latest && !closed) {
          const approvingOwner = verifyOwner(client.id);
          owner(approvingOwner);
          const ownerId = client.id, ownerGrant = grant(approvingOwner);
          sessionApprovals.set(approvalKey(latest, request.action), {
            clientId: latest.id, grant: grant(latest), expiresAt: latest.expiresAt,
            action: request.action, owner: { id: client.id, kind: client.kind, scopes: [...client.scopes] },
            checkOwner: () => {
              const currentOwner = verifyOwner(ownerId);
              owner(currentOwner);
              if (currentOwner.id !== ownerId || grant(currentOwner) !== ownerGrant) throw fail(403, "The approving owner's access changed.");
            },
          });
        }
      }
      return visible(request);
    },
    cancelClient(clientId) {
      for (const [key, entry] of sessionApprovals) if (entry.clientId === clientId) sessionApprovals.delete(key);
      for (const request of requests.values())
        if (request.clientId === clientId && active(request)) { request.status = "revoked"; skipRemaining(request); changed(request); }
    },
    cancelPending() {
      sessionApprovals.clear();
      for (const request of requests.values())
        if (active(request)) { request.status = "cancelled"; skipRemaining(request); changed(request); }
    },
    close() {
      closed = true;
      sessionApprovals.clear();
      for (const request of requests.values())
        if (active(request)) { request.status = "revoked"; skipRemaining(request); changed(request); }
    },
  };
}
