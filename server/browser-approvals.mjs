import crypto from "node:crypto";
import path from "node:path";
import { terminalLocation } from "./restricted-terminal.mjs";
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
};
const active = (request) => ["pending", "executing"].includes(request.status);
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
  action: { ...request.action },
  reason: request.reason,
  status: request.status,
  createdAt: request.createdAt,
  expiresAt: request.expiresAt,
  ...(request.error ? { error: request.error } : {}),
  ...(request.output !== undefined ? { output: request.output } : {}),
  ...(request.folder !== undefined ? { folder: request.folder } : {}),
  ...(request.directory !== undefined ? { directory: request.directory, completedAt: request.completedAt } : {}),
});

function parse(input) {
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
const permits = (client, action) => action.type === "terminal"
  ? client.policy.restrictedTerminal === true && client.policy.screen !== "ask" &&
    !!(client.agentRoots || client.policy.roots)?.[action.root]
  : action.type === "command"
    ? client.policy.commandRequests === true && !client.policy.restrictedTerminal
    : client.policy.screen === "ask" && !client.policy.restrictedTerminal;
function owner(client) {
  if (client?.kind !== "device" || !client.scopes?.includes("admin"))
    throw fail(403, "Only the computer's owner can answer this request.");
}

// Routes use this before taking a review screenshot. Queue insertion repeats
// the check against the latest grant after any asynchronous capture work.
export function validateBrowserRequest(client, input, at = Date.now()) {
  const parsed = parse(input);
  if (!isBrowser(client, at) || !permits(client, parsed.action))
    throw fail(403, "This invitation does not allow this request.");
  return parsed;
}

// This queue holds exact, short-lived requests, never an execution credential.
// Screen and restricted terminal actions run only in the owner's decision call.
// Legacy manual command requests remain messages and never reach execute().
// This is a consent gate, not an OS sandbox for the effects of a screen action.
export function createBrowserApprovals({
  verifyClient,
  execute,
  notify = () => {},
  record = () => {},
  now = Date.now,
}) {
  const requests = new Map();
  const requestTimes = new Map();
  let allRequestTimes = [];
  let closed = false;
  const audit = (message) => record("agent", message);
  const current = (request) => {
    const client = verifyClient(request.clientId);
    return client?.id === request.clientId && isBrowser(client, now()) &&
      permits(client, request.action) && grant(client) === request.grant ? client : null;
  };
  const sweep = () => {
    for (const request of requests.values()) {
      if (!active(request)) continue;
      if (request.expiresAt <= now()) request.status = "expired";
      else if (!current(request)) request.status = "revoked";
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
    if (request.expiresAt <= now()) {
      request.status = "expired";
      throw fail(410, "This request expired. Ask for a new one.");
    }
    const client = current(request);
    if (!client) {
      request.status = "revoked";
      throw fail(403, "This browser's access expired or was revoked.");
    }
    return client;
  };
  return {
    request(client, input) {
      if (closed) throw fail(503, "Browser requests are unavailable.");
      const { action, reason } = validateBrowserRequest(client, input, now());
      // Both the initiating credential and its current server-side grant
      // must authorize this action. A caller cannot substitute another ID.
      const latest = verifyClient(client.id);
      if (latest?.id !== client.id || !isBrowser(latest, now()) || !permits(latest, action))
        throw fail(403, "This browser's access expired or was revoked.");
      sweep();
      const pending = [...requests.values()].filter(active);
      if (pending.length >= 20 || pending.filter((r) => r.clientId === client.id).length >= 3)
        throw fail(429, "Wait for an existing browser request to be answered.");
      // Cancellation does not release notification capacity: a browser must
      // not spam its owner by rapidly asking and withdrawing the same action.
      const cutoff = now() - 60000;
      allRequestTimes = allRequestTimes.filter((time) => time > cutoff);
      for (const [id, times] of requestTimes) {
        const recent = times.filter((time) => time > cutoff);
        if (recent.length) requestTimes.set(id, recent);
        else requestTimes.delete(id);
      }
      const recent = requestTimes.get(client.id) || [];
      if (recent.length >= 10 || allRequestTimes.length >= 60)
        throw fail(429, "Too many browser requests. Wait a minute before asking again.");
      recent.push(now());
      requestTimes.set(client.id, recent);
      allRequestTimes.push(now());
      const request = {
        id: crypto.randomUUID(),
        clientId: client.id,
        grant: grant(latest),
        name: String(latest.name || "AI browser").slice(0, 80),
        action,
        reason,
        ...(action.type === "terminal" ? { folder: path.join((latest.agentRoots || latest.policy.roots)[action.root], action.cwd || "") } : {}),
        status: "pending",
        createdAt: now(),
        expiresAt: Math.min(now() + (["command", "terminal"].includes(action.type) ? 300000 : 60000), latest.expiresAt),
      };
      requests.set(request.id, request);
      audit("An AI browser requested owner approval");
      // Push payloads and audit entries deliberately omit the action, reason,
      // credentials, and any resulting screen or command contents.
      try {
        Promise.resolve(notify({
          title: "An AI browser needs your approval",
          tag: `browser-${crypto.createHash("sha256").update(client.id).digest("hex").slice(0, 12)}`,
        })).catch(() => {});
      } catch {
        // Notification availability never changes the stored consent state.
      }
      return visible(request);
    },
    listOwner() {
      sweep();
      return [...requests.values()].filter((request) => request.status === "pending").map(visible).reverse();
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
      if (request.status !== "pending")
        throw fail(409, "This browser request is no longer pending.");
      request.status = "cancelled";
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
      if (request.clientId === client.id)
        throw fail(403, "A browser cannot answer its own request.");
      if (closed || request.status !== "pending")
        throw fail(409, "This browser request is no longer pending.");
      const command = request.action.type === "command";
      if (!(command ? ["deny", "handled"] : ["approve", "deny"]).includes(decision))
        throw fail(400, command
          ? "Handle this command yourself, then mark it handled, or deny it. Reach cannot execute it."
          : request.action.type === "terminal" ? "Approve this one restricted command or deny it." : "Approve this one screen action or deny it.");
      if (decision !== "approve") {
        request.status = decision === "handled" ? "handled" : "denied";
        audit(decision === "handled"
          ? "The owner marked a browser command request handled"
          : "The owner denied a browser request");
        return visible(request);
      }
      // Claim before the first await: concurrent decisions and retries cannot
      // execute a payload twice or turn approval into a lasting capability.
      request.status = "executing";
      const authorize = () => {
        checkOwner();
        return authorizeRequest(request);
      };
      try {
        authorize();
        const output = await execute(request.action, authorize, visible(request));
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
        audit(request.action.type === "terminal" ? "The owner approved one restricted terminal command" : "The owner approved one browser screen action");
      } catch (error) {
        if (request.status === "executing") request.status = "failed";
        request.error = [400, 401, 403, 409, 410, 423, 501, 503, 504].includes(error?.status) && typeof error.message === "string"
          ? error.message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)
          : request.action.type === "terminal" ? "The command could not be completed. Review the folder and request again." : "The screen action was not confirmed. Review the screen before requesting another action.";
        audit(request.action.type === "terminal" ? "A restricted terminal command was not completed" : "A browser screen action was not confirmed");
      }
      return visible(request);
    },
    cancelClient(clientId) {
      for (const request of requests.values())
        if (request.clientId === clientId && active(request)) request.status = "revoked";
    },
    cancelPending() {
      for (const request of requests.values())
        if (active(request)) request.status = "cancelled";
    },
    close() {
      closed = true;
      for (const request of requests.values())
        if (active(request)) request.status = "revoked";
    },
  };
}
