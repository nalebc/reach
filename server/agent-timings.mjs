import fs from "node:fs";
import { fail } from "./core.mjs";
import { fromBrowserPage } from "./agent-runtimes.mjs";

// How long Reach takes for each of an agent's calls, looks included, and how
// long the agent takes between them (Oct 12: "agents using MCP to control
// the Mac are very slow today"): a step is Reach's answer plus the agent's
// own turn, and only the first is ours to make faster.
//
// One entry per call: when it came in, which agent, what kind of call (a
// fixed name from its path, never its query or body), Reach's time from
// request in to response out, and the gap since Reach's previous answer to
// that agent (its own time, the network round trip included). Never what was
// on screen, typed or read: no text, no value, no address. A small ring in
// memory, and the same entries on disk next to agent-actions.jsonl, bounded
// as that file is.
const MAX = 20000;
const RING = 2000;
// A pause longer than this starts a new stretch of work.
export const STRETCH_GAP_MS = 5 * 60_000;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// Calls that aren't the agent's steps: its copy reading its access, its
// tools or the plan of a call, and its hourly credential trade. Through
// /api/browser/mcp/call (a tool call), reading its access is a step.
const UPKEEP = new Set(["GET /api/browser", "GET /api/device", "GET /api/device/runtime", "POST /api/device/rotate",
  "GET /api/browser/mcp/tools", "POST /api/browser/mcp/plan", "DELETE /api/device/access"]);
// Its page's live picture asks for these several times a second.
const PAGE_POLLS = new Set(["GET /api/browser/desktop/screen", "GET /api/browser/desktop/front"]);
const KINDS = {
  "GET /api/browser": "access",
  "POST /api/browser/desktop/input": "act",
  "POST /api/browser/desktop/wait": "wait",
  "POST /api/browser/desktop/open": "open-app",
  "POST /api/browser/desktop/open-url": "open-url",
  "POST /api/browser/desktop/open-file": "open-file",
  "POST /api/browser/desktop/focus": "focus",
  "POST /api/browser/desktop/find": "find",
  "GET /api/browser/desktop/describe": "describe",
  "GET /api/browser/desktop/elements": "elements",
  "GET /api/browser/desktop/screen": "screenshot",
  "GET /api/browser/desktop/front": "front",
  "GET /api/browser/desktop/windows": "windows",
  "GET /api/browser/desktop/menus": "menus",
  "GET /api/browser/desktop/read": "read-page",
  "GET /api/browser/desktop/displays": "displays",
  "GET /api/browser/desktop/apps": "apps",
  "GET /api/browser/desktop/mac-shortcuts": "mac-shortcuts",
  "POST /api/browser/desktop/mac-shortcuts/run": "mac-shortcut",
  "POST /api/browser/shell": "shell",
  "GET /api/browser/shell/history": "shell-history",
  "POST /api/browser/files/change": "file-change",
  "GET /api/browser/files/search": "file-search",
  "GET /api/files": "files",
  "GET /api/files/text": "file-read",
  "GET /api/browser/tools": "tools",
  "GET /api/browser/tools/protocol": "tool-protocol",
  "POST /api/browser/tools/define": "tool-define",
  "POST /api/browser/tools/run": "tool",
  "POST /api/browser/tools/batch": "tool-batch",
  "GET /api/browser/shortcuts": "shortcuts",
  "POST /api/browser/shortcuts/run": "shortcut",
  "GET /api/browser/mcp/discover": "discover",
  "GET /api/browser/services": "services",
  "POST /api/browser/services/run": "service",
  "POST /api/browser/permissions/request": "permission",
};
/** The kind of a call from its method and path alone: a fixed name, "other" for the rest. */
export function callKind(method, path) {
  const route = String(path || "").split("?")[0];
  const key = `${String(method || "").toUpperCase()} ${route}`;
  if (KINDS[key]) return KINDS[key];
  if (/^GET \/api\/browser\/tools\/operations\/[^/]+$/.test(key)) return "tool-check";
  if (/^GET \/api\/browser\/terminals\/[^/]+$/.test(key)) return "terminal-read";
  return "other";
}
const whole = (value) => Math.max(0, Math.round(Number(value) || 0));
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
};

export function createAgentTimings({ file = null, now = Date.now, max = MAX, ring = RING } = {}) {
  let entries = []; // oldest first, at most `ring`
  let lines = 0, warned = false;
  // When Reach last answered each agent: the start of its own time.
  const answered = new Map();
  if (file) {
    try {
      const all = [];
      for (const line of fs.readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        lines += 1;
        try {
          const entry = JSON.parse(line);
          if (plain(entry) && typeof entry.clientId === "string" && typeof entry.kind === "string" && Number.isFinite(entry.at)) all.push(entry);
        } catch { /* a torn line */ }
      }
      entries = all.slice(-ring);
      for (const entry of entries) answered.set(entry.clientId, entry.at + whole(entry.reachMs));
    } catch (error) { if (error?.code !== "ENOENT") console.warn(`Reach: couldn't read the agent timings (${error.code || error.message}).`); }
  }
  // Written after each answer, in order, never on its way out: a slow disk
  // never slows an agent.
  let writing = Promise.resolve();
  const warn = (error) => {
    if (!warned) { warned = true; console.warn(`Reach: couldn't save the agent timings (${error.code || error.message}); they hold until Reach restarts.`); }
  };
  const persist = (entry) => {
    if (!file) return;
    writing = writing.then(async () => {
      try {
        await fs.promises.appendFile(file, JSON.stringify(entry) + "\n", { mode: 0o600 });
        lines += 1;
        if (lines > max) {
          // Kept as long as agent-actions.jsonl: the newest half stays.
          const kept = (await fs.promises.readFile(file, "utf8")).split("\n").filter(Boolean).slice(-Math.ceil(max / 2));
          const temporary = `${file}.${process.pid}.tmp`;
          await fs.promises.writeFile(temporary, kept.join("\n") + "\n", { mode: 0o600 });
          await fs.promises.rename(temporary, file);
          lines = kept.length;
        }
      } catch (error) { warn(error); }
    });
  };
  const add = (client, { kind, startedAt, finishedAt, ok }) => {
    if (!plain(client) || typeof client.id !== "string") return null;
    const previous = answered.get(client.id);
    const gap = previous === undefined ? null : startedAt - previous;
    const entry = { at: startedAt, clientId: client.id, kind: String(kind).slice(0, 40), reachMs: whole(finishedAt - startedAt),
      // The agent's own time: from Reach's last answer to this call. A
      // call sent before the last one was answered took none.
      ...(gap !== null && gap <= STRETCH_GAP_MS ? { agentMs: whole(gap) } : {}), ok: ok !== false };
    answered.set(client.id, Math.max(previous ?? 0, finishedAt));
    entries.push(entry);
    if (entries.length > ring) entries.splice(0, entries.length - ring);
    persist(entry);
    return entry;
  };
  const timed = new WeakMap(); // res -> the call it answers
  return {
    add,
    /**
     * Express middleware, after authentication: times every call an agent
     * makes. A tool call through /api/browser/mcp/call runs its route on the
     * same request again: timed once, from its arrival, as the route it ran.
     */
    middleware(req, res, next) {
      const client = req.client;
      if (client?.kind !== "agent" || !client.policy?.browser) return next();
      const method = String(req.method || "").toUpperCase();
      const route = String(req.originalUrl || req.url || "").split("?")[0];
      const key = `${method} ${route}`;
      let call = timed.get(res);
      if (call) {
        // The route the tool call ran, named by its own path.
        call.key = key;
        return next();
      }
      const viaCall = key === "POST /api/browser/mcp/call";
      if (!viaCall && (UPKEEP.has(key) || (PAGE_POLLS.has(key) && fromBrowserPage(req)))) return next();
      call = { key, startedAt: now() };
      timed.set(res, call);
      res.once("finish", () => {
        const [verb, path] = call.key.split(" ");
        add(client, { kind: callKind(verb, path), startedAt: call.startedAt, finishedAt: now(), ok: res.statusCode < 400 });
      });
      next();
    },
    /** One agent's calls, newest first, up to limit (for tests and the owner). */
    list({ clientId, limit = 200 } = {}) {
      if (typeof clientId !== "string" || !clientId) throw fail(400, "Choose an agent.");
      return entries.filter((entry) => entry.clientId === clientId).slice(-limit).reverse();
    },
    /**
     * One agent's stretches of work, newest first: calls with no pause
     * longer than STRETCH_GAP_MS between them, each with Reach's typical
     * time per call and the agent's typical time between calls (medians).
     */
    stretches(clientId, { limit = 20 } = {}) {
      if (typeof clientId !== "string" || !clientId) return [];
      const stretches = [];
      let current = null;
      for (const entry of entries) {
        if (entry.clientId !== clientId) continue;
        if (!current || entry.agentMs === undefined) {
          current = { from: entry.at, to: entry.at, reach: [], agent: [] };
          stretches.push(current);
        }
        current.to = entry.at + whole(entry.reachMs);
        current.reach.push(whole(entry.reachMs));
        if (entry.agentMs !== undefined) current.agent.push(whole(entry.agentMs));
      }
      return stretches.filter((stretch) => stretch.agent.length).slice(-limit).reverse()
        .map((stretch) => ({ from: stretch.from, to: stretch.to, calls: stretch.reach.length, reachMs: median(stretch.reach), agentMs: median(stretch.agent) }));
    },
    /** Settles once every entry so far is on disk (tests). */
    flushed: () => writing,
  };
}
