import { spawn } from "node:child_process";
import os from "node:os";
import { desktopBinary } from "./desktop-native.mjs";
import { fail } from "./core.mjs";
import { hiddenControls, nativeRules, protectedPathReason, typedTextRefusal } from "./agent-guard.mjs";
import { actionWords } from "./agent-actions.mjs";
import { presetScopes } from "./agent-presets.mjs";
import { createAgentPauses } from "./agent-pauses.mjs";

// This Mac's screen and input for preset agents, through the native checker
// (scripts/native/agent-desktop.swift): one helper process per agent session,
// started with that session's rules. Agents act one at a time: the Mac has one
// pointer and one keyboard, so an agent holds it for a short lease that each
// of its actions extends, and the others are told who has it. Screenshots are
// reads, serialised per agent (a second request shares or waits for the first). The owner's own hands (checked natively) and the
// owner's phone (checked here) always come first.
const KINDS = { blocked: 403, paused: 409, retry: 409, busy: 409, invalid: 400, unavailable: 503, setup_required: 503 };
const refusal = (value) => Object.assign(fail(KINDS[value.kind] || 403, String(value.error || "The Mac couldn't do that.").slice(0, 300)), { kind: value.kind || "blocked", ...(Array.isArray(value.candidates) ? { candidates: value.candidates.slice(0, 8) } : {}) });
const number = (value, min, max) => typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
const KEYS = new Set(["return", "enter", "tab", "space", "delete", "backspace", "escape", "esc", "left", "right", "down", "up", "forwarddelete", "home", "end", "pageup", "pagedown",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", ..."abcdefghijklmnopqrstuvwxyz0123456789", "=", "-", "]", "[", "'", ";", "\\", ",", "/", ".", "`"]);
// A live screen asks back to back; ten a second keeps it real time without
// letting one agent monopolise the helper.
export const SHOTS_PER_SECOND = 10;
const MODIFIERS = new Set(["cmd", "command", "meta", "shift", "option", "alt", "control", "ctrl"]);
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** The exact action shapes an agent may send; anything else is refused before the Mac sees it. */
/** Reach's own addresses on this Mac: the agent may never open them. */
export function reachAddresses(config = {}, { hostname = os.hostname() } = {}) {
  const port = Number(config.port) || 0;
  const names = ["localhost", "127.0.0.1", "[::1]", "0.0.0.0", String(hostname || "").toLowerCase().replace(/\.local$/, "")].filter(Boolean);
  const addresses = new Set();
  for (const name of names) if (port) addresses.add(`${name}:${port}`);
  for (const origin of [config.publicOrigin, config.origin]) {
    try { const url = new URL(origin); addresses.add(url.hostname.toLowerCase()); } catch { /* not set */ }
  }
  return [...addresses];
}

// The front window as one readable text (reach_describe_screen): its app and
// title, then what is there in reading order, each control inline as
// [n] Role "name" (= what a field holds), clickable by its number.
const FIELD_ROLES = new Set(["TextField", "TextArea", "SearchField", "ComboBox", "SecureTextField"]);
export function describeScreen({ app = "", title = "", snapshot = "", windowRef = "", displayId, items = [], texts = [], truncated = false } = {}) {
  const control = (item) => `[${item.n}]${item.ref ? ` {${item.ref}}` : ""} ${item.role}${item.name ? ` "${item.name}"` : ""}` +
    (item.context ? ` in ${JSON.stringify(item.context)}` : "") +
    (item.secure ? " (password field: sign in from your vault)" : item.value ? ` = "${item.value}"` : "");
  const entries = [
    ...items.map((item) => ({ x: item.x, mid: item.y + item.h / 2, line: control(item) })),
    ...texts.map((line) => ({ x: line.x, mid: line.y + line.h / 2, line: line.heading ? `# ${line.text}` : line.text })),
  ].sort((a, b) => a.mid - b.mid);
  // Group by height first (a consistent order), then read each row left to right.
  const rows = [];
  for (const entry of entries) {
    const last = rows.at(-1);
    if (last && Math.abs(entry.mid - last.mid) < 0.006) last.parts.push(entry);
    else rows.push({ mid: entry.mid, parts: [entry] });
  }
  for (const row of rows) row.parts = row.parts.sort((a, b) => a.x - b.x).map((entry) => entry.line);
  const head = [`${app}${title ? ` — ${title}` : ""}`,
    (windowRef ? `Window ${windowRef}${displayId ? ` · display ${displayId}` : ""}. Controls have stable refs: reach_act {"action":{"type":"element","ref":"e-…"}}. ` : "") +
    (snapshot ? `Click a [number] with reach_act {"action":{"type":"element","snapshot":"${snapshot}","n":NUMBER}}.` : ""), ""];
  const body = rows.map((row) => row.parts.join("   ")).join("\n");
  const fields = items.filter((item) => FIELD_ROLES.has(item.role) || item.secure);
  const form = fields.length
    ? `\nFields: ${fields.map((item) => `"${item.name || `#${item.n}`}"${item.secure ? " (password)" : ""}`).join(", ")}. Fill them in one call: reach_fill {"fields":[{"label":"…","text":"…"}], "submit":true}; a value from your vault with "secret":true.`
    : "";
  return (head.join("\n") + body + form + (truncated ? "\n… more is on screen than listed: scroll, then describe again." : "")).slice(0, 30000);
}

// The numbered controls and visible text as the agent receives them, bounded,
// from what the helper read (elements, find).
const fractionOf = (value) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
const nativeRef = value => typeof value === "string" && /^[ewt]-[a-f0-9-]{1,38}$/.test(value);
const tabList = (tabs) => tabs.slice(0, 40).filter((tab) => plain(tab) && typeof tab.title === "string" && tab.title).map((tab) => ({ title: tab.title.slice(0, 120), selected: tab.selected === true, ...(nativeRef(tab.ref) ? { ref: tab.ref } : {}) }));
export function shapeElements(result) {
  const fraction = fractionOf;
  const items = (Array.isArray(result.items) ? result.items : []).slice(0, 250)
    .filter((item) => Number.isInteger(item?.n))
    .map((item) => ({ n: item.n, role: String(item.role || "").slice(0, 40), name: String(item.name || "").slice(0, 120), ...(nativeRef(item.ref) ? { ref: item.ref } : {}), ...(typeof item.context === "string" ? { context: item.context.slice(0, 400) } : {}), secure: item.secure === true,
      // What a field holds is on screen already; never a password field's.
      ...(typeof item.value === "string" && item.value && item.secure !== true ? { value: item.value.slice(0, 120) } : {}),
      x: fraction(item.x), y: fraction(item.y), w: fraction(item.w), h: fraction(item.h) }));
  // The window's visible text, in reading order: what a person reads there.
  let budget = 20000;
  const texts = (Array.isArray(result.texts) ? result.texts : []).slice(0, 500)
    .filter((line) => typeof line?.text === "string" && line.text)
    .map((line) => ({ text: line.text.slice(0, 300), ...(typeof line.context === "string" ? { context: line.context.slice(0, 400) } : {}), ...(line.heading === true ? { heading: true } : {}),
      x: fraction(line.x), y: fraction(line.y), w: fraction(line.w), h: fraction(line.h) }))
    .filter((line) => (budget -= line.text.length) >= 0);
  // The form at a glance: its fields, for reach_fill in one call.
  const fields = items.filter((item) => FIELD_ROLES.has(item.role))
    .map(({ n, name, role, value, secure }) => ({ n, label: name, role, ...(value !== undefined ? { value } : {}), ...(secure ? { secure: true } : {}) }));
  return { ...(nativeRef(result.windowRef) ? { windowRef: result.windowRef } : {}), ...(Number.isSafeInteger(result.revision) ? { revision: result.revision } : {}), ...(Number.isInteger(result.displayId) ? { displayId: result.displayId } : {}), snapshot: String(result.snapshot || "").slice(0, 40), app: String(result.app || "").slice(0, 100),
    title: String(result.title || "").slice(0, 200), items, texts, fields, truncated: result.truncated === true || budget < 0 };
}

export function normalizeAction(value) {
  if (plain(value) && value.displayId !== undefined) {
    const { displayId, ...rest } = value;
    if (!Number.isInteger(displayId) || displayId < 1 || displayId > 4294967295) throw fail(400, "Choose a display from reach_displays.");
    return { ...normalizeAction(rest), displayId };
  }
  if (!plain(value) || typeof value.type !== "string") throw fail(400, "Choose one action: click, move, drag, scroll, type or key.");
  const keys = Object.keys(value);
  const only = (...allowed) => { if (keys.some((key) => !allowed.includes(key))) throw fail(400, `A ${value.type} action takes only ${allowed.join(", ")}.`); };
  const modifiers = () => {
    if (value.modifiers === undefined) return [];
    if (!Array.isArray(value.modifiers) || value.modifiers.length > 4 || value.modifiers.some((m) => !MODIFIERS.has(m))) throw fail(400, "Modifiers are cmd, shift, option or control.");
    return [...new Set(value.modifiers)];
  };
  // A long press: the button stays down holdMs (100 to 10000), one press only.
  const hold = () => {
    if (value.holdMs === undefined) return {};
    if (!Number.isInteger(value.holdMs) || value.holdMs < 100 || value.holdMs > 10000) throw fail(400, "Hold for 100 to 10000 milliseconds.");
    if (value.count !== undefined && value.count !== 1) throw fail(400, "Hold one press, not several.");
    return { holdMs: value.holdMs };
  };
  const point = (x, y) => { if (!number(value[x], 0, 1) || !number(value[y], 0, 1)) throw fail(400, "Give the point as fractions of the screen, 0 to 1."); return { [x]: value[x], [y]: value[y] }; };
  switch (value.type) {
    case "move": only("type", "x", "y"); return { type: "move", ...point("x", "y") };
    case "click": {
      only("type", "x", "y", "button", "count", "modifiers", "holdMs");
      if (value.button !== undefined && !["left", "right"].includes(value.button)) throw fail(400, "Click with the left or right button.");
      if (value.count !== undefined && ![1, 2, 3].includes(value.count)) throw fail(400, "Click once, twice or three times.");
      return { type: "click", ...point("x", "y"), button: value.button || "left", count: value.count || 1, modifiers: modifiers(), ...hold() };
    }
    // holdMs: down that long before moving (a long press picks it up);
    // durationMs: how long the move takes (a slider, a file onto a folder).
    case "drag": {
      only("type", "x", "y", "toX", "toY", "holdMs", "durationMs");
      if (value.holdMs !== undefined && (!Number.isInteger(value.holdMs) || value.holdMs < 0 || value.holdMs > 5000)) throw fail(400, "Hold before a drag for up to 5000 milliseconds.");
      if (value.durationMs !== undefined && (!Number.isInteger(value.durationMs) || value.durationMs < 50 || value.durationMs > 5000)) throw fail(400, "Drag over 50 to 5000 milliseconds.");
      return { type: "drag", ...point("x", "y"), ...point("toX", "toY"),
        ...(value.holdMs ? { holdMs: value.holdMs } : {}), ...(value.durationMs !== undefined ? { durationMs: value.durationMs } : {}) };
    }
    case "scroll": {
      only("type", "x", "y", "dx", "dy");
      if (!number(value.dx ?? 0, -2000, 2000) || !number(value.dy ?? 0, -2000, 2000)) throw fail(400, "Scroll by up to 2000 pixels each way.");
      return { type: "scroll", ...point("x", "y"), dx: value.dx ?? 0, dy: value.dy ?? 0 };
    }
    case "type": {
      only("type", "text", "secret", "paste");
      if (value.secret !== undefined && value.secret !== true) throw fail(400, "Mark only a password as secret.");
      if (value.paste !== undefined && value.paste !== true) throw fail(400, "Set paste to true, or leave it out.");
      if (value.paste && value.secret) throw fail(400, "Vault values are typed, never pasted.");
      if (typeof value.text !== "string" || !value.text || value.text.length > 2000 || hiddenControls.test(value.text))
        throw fail(400, "Type up to 2000 characters, without hidden controls.");
      // A secret (a username, email or password from the agent's vault) is
      // never echoed, logged or recorded; it never goes into a terminal.
      // Pasted text goes through the clipboard in one go (long text).
      return value.secret ? { type: "type", text: value.text, secret: true } : { type: "type", text: value.text, ...(value.paste ? { paste: true } : {}) };
    }
    case "key": {
      only("type", "key", "modifiers");
      const key = typeof value.key === "string" ? value.key.toLowerCase() : "";
      if (!KEYS.has(key)) throw fail(400, "Unknown key.");
      return { type: "key", key, modifiers: modifiers() };
    }
    // A menu item by its path, pressed through accessibility (no pointer).
    case "menu": {
      only("type", "path");
      if (!Array.isArray(value.path) || !value.path.length || value.path.length > 6 ||
          value.path.some((title) => typeof title !== "string" || !title.trim() || title.length > 80 || hiddenControls.test(title)))
        throw fail(400, "Give the menu path: the menu's title, then each item down to the one to press, up to 6 names.");
      return { type: "menu", path: value.path.map((title) => title.trim()) };
    }
    // A numbered label from elements(): clicked at its live center natively.
    case "element": {
      only("type", "snapshot", "n", "ref", "button", "count", "holdMs");
      if (value.ref !== undefined) {
        if (!nativeRef(value.ref) || !value.ref.startsWith("e-") || value.snapshot !== undefined || value.n !== undefined) throw fail(400, "Choose a control by ref, or snapshot and number.");
        const normalized = normalizeAction({ ...value, ref: undefined, snapshot: "validation", n: 1 });
        const { snapshot, n, ref, ...rest } = normalized;
        return { ...rest, ref: value.ref };
      }
      if (typeof value.snapshot !== "string" || !/^[a-z0-9-]{1,40}$/i.test(value.snapshot)) throw fail(400, "Look at the labels again.");
      if (!Number.isInteger(value.n) || value.n < 1 || value.n > 500) throw fail(400, "Choose a label number.");
      if (value.button !== undefined && !["left", "right"].includes(value.button)) throw fail(400, "Click with the left or right button.");
      if (value.count !== undefined && ![1, 2, 3].includes(value.count)) throw fail(400, "Click once, twice or three times.");
      return { type: "element", snapshot: value.snapshot, n: value.n, ...(value.button ? { button: value.button } : {}), ...(value.count ? { count: value.count } : {}), ...hold() };
    }
    // A control by its name, as the screen describes it (press), and a form's
    // fields by their labels, typed in one go (fill): found on the Mac.
    case "press": {
      only("type", "name", "role", "within", "button", "count", "holdMs");
      if (value.within !== undefined && (typeof value.within !== "string" || !value.within.trim() || value.within.length > 200 || hiddenControls.test(value.within))) throw fail(400, "Name the containing region, up to 200 characters.");
      const name = typeof value.name === "string" ? value.name.trim() : "";
      if (!name || name.length > 120 || hiddenControls.test(name)) throw fail(400, "Name the control, up to 120 characters.");
      if (value.role !== undefined && (typeof value.role !== "string" || !/^[A-Za-z]{1,40}$/.test(value.role))) throw fail(400, "Give the control's role as one word, such as Button.");
      if (value.button !== undefined && !["left", "right"].includes(value.button)) throw fail(400, "Click with the left or right button.");
      if (value.count !== undefined && ![1, 2, 3].includes(value.count)) throw fail(400, "Click once, twice or three times.");
      return { type: "press", name, ...(value.within ? { within: value.within } : {}), ...(value.role ? { role: value.role } : {}), ...(value.button ? { button: value.button } : {}), ...(value.count ? { count: value.count } : {}), ...hold() };
    }
    case "fill": {
      only("type", "fields", "submit", "replace", "paste");
      if (!Array.isArray(value.fields) || !value.fields.length || value.fields.length > 12) throw fail(400, "Fill 1 to 12 fields.");
      const fields = value.fields.map((field) => {
        if (!plain(field) || Object.keys(field).some((key) => !["label", "text", "secret"].includes(key))) throw fail(400, "Each field takes label, text and secret.");
        const label = typeof field.label === "string" ? field.label.trim() : "";
        if (!label || label.length > 120 || hiddenControls.test(label)) throw fail(400, "Name each field by its label, up to 120 characters.");
        if (typeof field.text !== "string" || !field.text || field.text.length > 2000 || hiddenControls.test(field.text)) throw fail(400, "Type up to 2000 characters into a field, without hidden controls.");
        if (field.secret !== undefined && field.secret !== true) throw fail(400, "Mark only a vault value as secret.");
        return field.secret ? { label, text: field.text, secret: true } : { label, text: field.text };
      });
      if (fields.reduce((sum, field) => sum + field.text.length, 0) > 2000) throw fail(400, "Type at most 2000 characters in one fill.");
      for (const flag of ["submit", "replace", "paste"]) if (value[flag] !== undefined && value[flag] !== true) throw fail(400, `Set ${flag} to true, or leave it out.`);
      return { type: "fill", fields, ...(value.submit ? { submit: true } : {}), ...(value.replace ? { replace: true } : {}), ...(value.paste ? { paste: true } : {}) };
    }
    default: throw fail(400, "Choose one action: click, move, drag, scroll, type, key, element, press, fill or menu.");
  }
}

const HELPER_FAILURES = {
  timeout: "did not answer in time", process_exit: "exited", process_error: "could not stay connected",
  stdin_error: "lost its input connection", write_error: "could not send the request",
  invalid_reply: "returned an invalid reply", oversized_reply: "returned too much data",
  unexpected_reply: "returned an unexpected reply", stopped: "stopped",
};
const HELPER_OPERATIONS = new Set(["rules", "catalog", "shot", "front", "act", "open", "elements", "open-url", "browser-check", "windows", "focus", "menus", "find", "read", "open-file", "displays", "wait-change"]);
const helperFailure = (reason, request, dispatched = false) => {
  const helperReason = Object.hasOwn(HELPER_FAILURES, reason) ? reason : "stopped";
  const helperOperation = HELPER_OPERATIONS.has(request?.op) ? request.op : "unknown";
  const helperDispatch = dispatched ? "completion_unknown" : "not_dispatched";
  const guidance = dispatched
    ? "Completion is unknown. Check the screen before trying again."
    : "This request was not sent. Check the screen before trying again.";
  return Object.assign(fail(503, `The Mac's agent helper ${HELPER_FAILURES[helperReason]} during ${helperOperation}. ${guidance}`),
    { kind: "unavailable", helperReason, helperOperation, helperDispatch });
};

// One helper process: JSON lines in, JSON lines out, one request at a time.
export class AgentDesktopHelper {
  constructor(child, { timeoutMs = 15000 } = {}) {
    this.child = child;
    this.queue = [];
    this.current = null;
    this.stopped = false;
    // send() rejects as soon as stopping starts, before the native process
    // exits. Input ownership must last until it cannot post any more events.
    this.terminated = new Promise(resolve => {
      child.once("exit", resolve);
      child.once("error", () => { if (!child.pid) resolve(); });
    });
    this.timeoutMs = timeoutMs;
    let buffer = "";
    child.stderr?.on("data", () => {});
    child.stdin.on("error", () => this.stop("stdin_error"));
    child.on("error", () => this.stop("process_error"));
    child.on("exit", () => this.stop("process_exit"));
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 12 * 1024 * 1024) return this.stop("oversized_reply");
      let at;
      while ((at = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        const pending = this.current;
        if (!pending) return this.stop("unexpected_reply");
        let value;
        try { value = JSON.parse(line); } catch { return this.stop("invalid_reply"); }
        if (!plain(value) || (value.ok !== true && !(typeof value.error === "string" && Object.hasOwn(KINDS, value.kind))))
          return this.stop("invalid_reply");
        this.current = null;
        clearTimeout(pending.timer);
        pending.resolve(value);
        this.next();
      }
    });
  }
  send(request, beforeSend) {
    if (this.stopped) return Promise.reject(helperFailure(this.stopReason, request));
    return new Promise((resolve, reject) => { this.queue.push({ request, beforeSend, resolve, reject }); this.next(); });
  }
  next() {
    if (this.current || this.stopped) return;
    while (this.queue.length && !this.stopped) {
      const item = this.queue.shift();
      // Reads can occupy this helper while an input waits. Recheck the input
      // synchronously at its actual dispatch, not only when it was enqueued.
      try { item.beforeSend?.(); }
      catch (error) { item.reject(error); continue; }
      item.timer = setTimeout(() => { this.stop("timeout"); }, this.timeoutMs);
      this.current = item;
      let line;
      try { line = JSON.stringify(item.request) + "\n"; }
      catch { this.stop("write_error"); return; }
      // Mark before write: even a synchronous write failure cannot prove that
      // no bytes reached the native process. Never retry the action here.
      item.dispatched = true;
      try { this.child.stdin.write(line); }
      catch { this.stop("write_error"); }
      return;
    }
  }
  stop(reason = "stopped") {
    if (this.stopped) return;
    this.stopped = true;
    this.stopReason = reason;
    const waiting = [this.current, ...this.queue].filter(Boolean);
    this.current = null; this.queue = [];
    for (const item of waiting) { clearTimeout(item.timer); item.reject(helperFailure(reason, item.request, item.dispatched)); }
    try { this.child.stdin.end(); } catch { /* already closed */ }
    const child = this.child;
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      const force = setTimeout(() => child.kill("SIGKILL"), 1000);
      force.unref();
      child.once("exit", () => clearTimeout(force));
    }, 300);
    timer.unref();
    child.once("exit", () => clearTimeout(timer));
  }
}

export function createAgentDesktop(config, {
  available = () => process.platform === "darwin" && !!config.screen,
  hosts = () => [],
  titles = () => ["reach"],
  protectedPaths = () => [],
  home = os.homedir(),
  verifyClient = () => undefined,
  phoneControls = () => false,
  automationControls = () => false,
  // When a chat last drove the Mac (desktop-automation.mjs changedAt): an
  // agent's picture from before then may show the wrong window.
  screenChangedAt = () => 0,
  paused = () => false,
  onActivity = () => {},
  record = () => {},
  // The owner's log of what each agent did (agent-actions.mjs add).
  actions = () => {},
  spawnHelper,
  now = Date.now,
  leaseMs = 2500,
  // Where the owner's pauses are kept across restarts (agent-pauses.mjs).
  pausesFile = null,
} = {}) {
  const sessions = new Map(); // clientId -> { helper, fingerprint, rules }
  const activity = new Map(); // clientId -> { at, kind, app, bundle, name }
  // When each agent last looked at the screen. Looking never holds the Mac:
  // a live screen asks several times a second, and each look used to hold
  // chats' Claude app messages 30 s, so with one open they never went in.
  const looks = new Map(); // clientId -> ms
  const shots = new Map();    // clientId -> recent screenshot times
  const capturing = new Map(); // clientId -> { width, promise } of the capture running now
  const lease = { holder: null, name: "", until: 0 };
  const pendingInputs = new Set(); // native operations, including stopped helpers awaiting exit
  const pausedAgents = createAgentPauses({ file: pausesFile }); // by the owner, from the agent list
  let utility = null, utilityIdle = null, catalogCache = null, closed = false;
  const fingerprint = (client) => JSON.stringify([client.id, client.expiresAt, client.policy]);
  const start = async (rules) => {
    if (spawnHelper) return spawnHelper(rules);
    const binary = await desktopBinary(config, "agent-desktop");
    const helper = new AgentDesktopHelper(spawn(binary, [], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", HOME: home } }));
    if (rules) {
      const ready = await helper.send({ op: "rules", ...rules });
      if (ready.error) { helper.stop(); throw refusal(ready); }
      if (ready.accessibility === false && rules.mode !== "view") { helper.stop(); throw fail(503, "Reach needs Accessibility (System Settings → Privacy & Security) before an agent can use this Mac."); }
      if (ready.screen === false) { helper.stop(); throw fail(503, "Reach needs Screen Recording before an agent can see this Mac."); }
    }
    return helper;
  };
  // The live client, its preset still granting what this call needs.
  const live = (client, authorize, scope) => {
    if (closed) throw fail(503, "Reach is shutting down.");
    const current = authorize();
    const latest = verifyClient(client?.id) || current;
    if (!latest || latest.id !== client?.id || latest.kind !== "agent" || latest.policy?.browser !== true || latest.policy.preset === undefined ||
        !Number.isFinite(latest.expiresAt) || latest.expiresAt <= now() || !presetScopes(latest.policy).includes(scope) || !latest.scopes?.includes(scope))
      throw fail(403, "This agent's access to the Mac has changed or ended.");
    if (paused()) throw fail(409, "Reach is paused. The Mac waits until it resumes.");
    return latest;
  };
  const session = async (client) => {
    if (!available()) throw fail(503, "Screen access for agents needs this Mac's Screen Recording and Accessibility permissions.");
    const fp = fingerprint(client);
    let state = sessions.get(client.id);
    if (state && (state.fingerprint !== fp || state.helper.stopped)) { state.helper.stop(); sessions.delete(client.id); state = null; }
    if (!state) {
      const rules = nativeRules(client.policy, { hosts: hosts(), titles: titles(), protectedPaths: protectedPaths(), home });
      const helper = await start(rules);
      state = { helper, fingerprint: fp, rules };
      // The policy may have changed while the helper started.
      const again = sessions.get(client.id);
      if (again) { helper.stop(); return again; }
      sessions.set(client.id, state);
    }
    return state;
  };
  // Starting a helper, inspecting focus and capturing a frame all await native
  // work. Its rules must still match the live grant when we dispatch or return.
  const checkState = (client, authorize, scope, state) => {
    try {
      const current = live(client, authorize, scope);
      if (fingerprint(current) !== state.fingerprint)
        throw fail(403, "This agent's access changed. Refresh before using the Mac again.");
      return current;
    } catch (error) {
      state.helper.stop();
      if (sessions.get(client.id) === state) sessions.delete(client.id);
      throw error;
    }
  };
  const answer = (value) => { if (!value || value.error) throw refusal(value || {}); return value; };
  const checkInputAllowed = (client) => {
    if (pausedAgents.has(client.id)) throw Object.assign(fail(409, "The owner paused this agent. It can look, not touch, until they resume it."), { kind: "paused" });
    if (phoneControls()) throw Object.assign(fail(409, "You're controlling the Mac from your phone. The agent waits."), { kind: "paused" });
    if (automationControls()) throw Object.assign(fail(409, "A chat is updating its desktop app. Wait for that operation to finish, then check the screen."), { kind: "busy", holder: "Desktop automation", retryInMs: 1000 });
  };
  // One agent at a time on the Mac. Holding it is short: each action extends it.
  const take = (client) => {
    checkInputAllowed(client);
    // Even the same agent must await its previous input. Queuing a second
    // write in the native helper would let it run after the owner pauses us.
    const running = pendingInputs.values().next().value;
    if (running || (lease.holder && lease.holder !== client.id && lease.until > now())) {
      const name = running ? String(running.client.name || "Another agent").slice(0, 80) : lease.name;
      throw Object.assign(fail(409, `${name} is using the Mac right now. Try again in a moment.`), { kind: "busy", holder: name, retryInMs: Math.max(100, lease.until - now()) });
    }
    lease.holder = client.id; lease.name = String(client.name || "Another agent").slice(0, 80); lease.until = now() + leaseMs;
  };
  const extend = (client) => { if (lease.holder === client.id) lease.until = now() + leaseMs; };
  const release = (clientId) => { if (lease.holder === clientId) { lease.holder = null; lease.name = ""; lease.until = 0; } };
  const dispatchInput = async (client, state, request, authorize, scope) => {
    const pending = { client, helper: state.helper, sent: false };
    pendingInputs.add(pending);
    try {
      return await state.helper.send(request, () => {
        checkState(client, authorize, scope, state);
        checkInputAllowed(client);
        pending.sent = true;
      });
    } finally {
      // Revoking a client releases its idle lease immediately, but a dying
      // native helper must not overlap a replacement agent's input.
      if (state.helper.stopped && state.helper.terminated) await state.helper.terminated;
      pendingInputs.delete(pending);
    }
  };
  const currentHolder = () => {
    const pending = pendingInputs.values().next().value;
    return pending ? { clientId: pending.client.id, name: String(pending.client.name || "Another agent").slice(0, 80) }
      : lease.until > now() ? { clientId: lease.holder, name: lease.name } : null;
  };
  const observe = (client, at = now()) => { looks.set(client.id, at); };
  // Who holds the Mac for chats' desktop work, by name, or false. Pending
  // native input remains authoritative even after revocation or an expired
  // idle lease, until the old helper has actually exited.
  const automationBusy = () => {
    const holder = currentHolder();
    return holder ? `${holder.name} is using the Mac` : false;
  };
  // A click aimed from a picture taken before a chat drove the Mac could land
  // on the wrong window: the agent looks again first.
  const checkFresh = (client) => {
    if ((looks.get(client.id) ?? 0) < screenChangedAt())
      throw Object.assign(fail(409, "A chat just updated the Claude app on this Mac, so the screen may have changed. Look at the screen again, then act."), { kind: "busy", holder: "Desktop automation", retryInMs: 0, stale: true });
  };
  const note = (client, kind, result) => {
    const previous = activity.get(client.id);
    const entry = { at: now(), kind, app: String(result?.app || "").slice(0, 100), bundle: String(result?.bundle || "").slice(0, 200), name: client.name };
    activity.set(client.id, entry);
    if (entry.app && entry.app !== previous?.app) record("agent", `${client.name} is using ${entry.app}`);
    onActivity(client.id, entry);
  };
  return {
    available,
    automationBusy,
    // Owner control interrupts queued/current agent input, but receives an
    // actual process-exit barrier rather than the promptly rejected request.
    yieldForOwner() {
      const pending = [...pendingInputs];
      const helpers = [...new Set(pending.map(entry => entry.helper))];
      if (!helpers.length) return null;
      return Promise.all([...pending.flatMap(entry => entry.finished ? [entry.finished] : []), ...helpers.map(helper => {
        try { helper.stop(); } catch { return Promise.reject(fail(503, "The previous agent input helper could not be stopped.")); }
        return helper.terminated && typeof helper.terminated.then === "function"
          ? helper.terminated
          : Promise.reject(fail(503, "The previous agent input helper termination could not be verified."));
      })]);
    },
    normalizeAction,
    /** Every app on this Mac, for the owner's picker: {id, name, bundleId, running}. */
    async catalog(authorize = () => {}) {
      authorize();
      if (!available()) throw fail(503, "The app list needs this Mac's screen helpers.");
      if (catalogCache && catalogCache.until > now()) return structuredClone(catalogCache.apps);
      if (!utility || utility.stopped) utility = await start(null);
      clearTimeout(utilityIdle);
      utilityIdle = setTimeout(() => { utility?.stop(); utility = null; }, 60000);
      utilityIdle.unref?.();
      const result = answer(await utility.send({ op: "catalog" }));
      authorize();
      const apps = (Array.isArray(result.apps) ? result.apps : []).filter((app) => typeof app?.id === "string" && typeof app.name === "string" && typeof app.bundleId === "string").slice(0, 1024)
        .map((app) => ({ id: app.id, name: app.name.slice(0, 100), bundleId: app.bundleId.slice(0, 200), running: app.running === true }));
      catalogCache = { apps, until: now() + 10000 };
      return structuredClone(apps);
    },
    /** A JPEG of the screen with Reach, protected and hidden windows left out; in Apps, only the chosen apps. */
    async screenshot(client, authorize, { maxWidth = 2560, displayId } = {}) {
      const latest = live(client, authorize, "browser:screen");
      const width = Math.max(320, Math.min(3840, Number(maxWidth) || 2560));
      // One capture per agent at a time: a request that arrives while one
      // runs (a page that gave up and asked again) shares it. Abandoned
      // requests used to queue behind each other and swamp macOS's capture
      // service until no picture came back at all.
      const running = capturing.get(latest.id);
      // The look counts from when the picture was asked for, not when it came back.
      let askedAt = running && running.width >= width && running.displayId === displayId ? running.askedAt : now();
      let result;
      if (running && running.width >= width && running.displayId === displayId) result = await running.promise;
      else {
        const recent = (shots.get(latest.id) || []).filter((time) => time > now() - 1000);
        if (recent.length >= SHOTS_PER_SECOND) throw fail(429, "Wait a moment between screenshots.");
        recent.push(now()); shots.set(latest.id, recent);
        // Recorded before any await, so a request arriving now shares it.
        const promise = (async () => {
          if (running) await running.promise.catch(() => {});
          const state = await session(latest);
          checkState(client, authorize, "browser:screen", state);
          const value = answer(await state.helper.send({ op: "shot", maxWidth: width, ...(displayId ? { displayId } : {}) }));
          checkState(client, authorize, "browser:screen", state);
          return value;
        })();
        const entry = { width, displayId, promise, askedAt };
        capturing.set(latest.id, entry);
        try { result = await promise; } finally { if (capturing.get(latest.id) === entry) capturing.delete(latest.id); }
      }
      live(client, authorize, "browser:screen");
      if (typeof result.jpeg !== "string" || result.jpeg.length > 12 * 1024 * 1024) throw fail(503, "The screen image could not be verified.");
      const jpeg = Buffer.from(result.jpeg, "base64");
      if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw fail(503, "The screen image is unavailable.");
      observe(latest, askedAt);
      return { jpeg, displayId: result.displayId, width: result.width, height: result.height, hidden: result.hidden || 0 };
    },
    /** What is in front: the app, its window title, whether it takes commands or a password, and why it is closed to the agent if it is. */
    async front(client, authorize) {
      const latest = live(client, authorize, "browser:screen");
      const state = await session(latest);
      checkState(client, authorize, "browser:screen", state);
      const result = answer(await state.helper.send({ op: "front", detail: true }));
      checkState(client, authorize, "browser:screen", state);
      const holder = currentHolder();
      // An app the owner hid from this agent: not even its name (security
      // audit L6), whatever an older helper answers.
      const lower = (value) => String(value || "").toLowerCase();
      if (latest.policy.preset !== "full" && (result.blocked === "The owner hid this app from the agent." ||
          (latest.policy?.hidden || []).some((app) => (app.id && app.id === result.path) || (app.name && lower(app.name) === lower(result.app)))))
        return { app: "", bundle: "", title: "", terminalLike: false, secure: false, blocked: "The owner hid this app from the agent.",
          path: "", layout: "", holder: holder && holder.clientId !== latest.id ? holder.name : "" };
      return { app: String(result.app || ""), bundle: String(result.bundle || ""), title: String(result.title || "").slice(0, 200),
        terminalLike: result.terminalLike === true, secure: result.secure === true, blocked: String(result.blocked || "").slice(0, 300),
        path: String(result.path || "").slice(0, 4096), layout: String(result.layout || "").slice(0, 2000),
        holder: holder && holder.clientId !== latest.id ? holder.name : "",
        // A browser: its page and tabs, so the agent knows where it is without describing the screen.
        ...(typeof result.url === "string" && result.url ? { url: result.url.slice(0, 2048) } : {}),
        ...(Array.isArray(result.tabs) ? { tabs: tabList(result.tabs) } : {}) };
    },
    /** Every window the agent may know of: the allowed apps' windows, a browser's with its page and tabs (reach_windows). */
    async windows(client, authorize) {
      const latest = live(client, authorize, "browser:screen");
      const state = await session(latest);
      checkState(client, authorize, "browser:screen", state);
      const result = answer(await state.helper.send({ op: "windows" }));
      checkState(client, authorize, "browser:screen", state);
      observe(latest);
      const hidden = latest.policy.preset === "full" ? [] : latest.policy?.hidden || [];
      const lower = (value) => String(value || "").toLowerCase();
      const windows = (Array.isArray(result.windows) ? result.windows : []).slice(0, 120)
        .filter((item) => plain(item) && typeof item.id === "string" && /^(w-[a-f0-9-]{1,38}|\d{1,8}:\d{1,2})$/.test(item.id))
        // An app the owner hid from this agent: not even its name, whatever an older helper answers.
        .filter((item) => !hidden.some((app) => (app.bundleId && app.bundleId === item.bundle) || (app.name && lower(app.name) === lower(item.app))))
        .map((item) => ({ id: item.id, app: String(item.app || "").slice(0, 100), bundle: String(item.bundle || "").slice(0, 200), title: String(item.title || "").slice(0, 200),
          minimized: item.minimized === true, front: item.front === true, ...(item.dialog === true ? { dialog: true } : {}),
          ...(typeof item.url === "string" && item.url ? { url: item.url.slice(0, 2048) } : {}),
          ...(Array.isArray(item.tabs) ? { tabs: tabList(item.tabs) } : {}) }));
      const holder = currentHolder();
      return { windows, holder: holder && holder.clientId !== latest.id ? holder.name : "" };
    },
    /** One window brought forward by its id from windows(), its title checked; a browser tab by title (reach_focus_window). */
    async focusWindow(client, { id, title, tab, tabRef } = {}, authorize) {
      const latest = live(client, authorize, "browser:open");
      if (typeof id !== "string" || !/^(w-[a-f0-9-]{1,38}|\d{1,8}:\d{1,2})$/.test(id)) throw fail(400, "Choose a window by the id reach_windows gave.");
      if (title !== undefined && (typeof title !== "string" || title.length > 200 || hiddenControls.test(title))) throw fail(400, "Give the window's title as listed, up to 200 characters.");
      if (tabRef !== undefined && (!nativeRef(tabRef) || !tabRef.startsWith("t-") || tab !== undefined)) throw fail(400, "Choose one tab by title or ref.");
      if (tab !== undefined && (typeof tab !== "string" || !tab.trim() || tab.length > 120 || hiddenControls.test(tab))) throw fail(400, "Name the tab by its title, up to 120 characters.");
      const state = await session(latest);
      checkState(client, authorize, "browser:open", state);
      take(latest);
      const result = answer(await dispatchInput(latest, state, { op: "focus", id, ...(title ? { title } : {}), ...(tab ? { tab: tab.trim() } : {}), ...(tabRef ? { tabRef } : {}) }, authorize, "browser:open"));
      checkState(client, authorize, "browser:open", state);
      extend(latest);
      observe(latest);
      note(latest, "open", result);
      actions(latest, { kind: "focus", text: actionWords("focus", { title }, result), app: result.app });
      return { ok: true, app: String(result.app || ""), bundle: String(result.bundle || ""), title: String(result.title || "").slice(0, 200),
        ...(result.front === false ? { front: false } : {}), ...(typeof result.tab === "string" && result.tab ? { tab: result.tab.slice(0, 120) } : {}) };
    },
    /** The front app's menu bar: each menu's items with their shortcuts; one menu named, with its submenus (reach_menus). */
    async menus(client, menu, authorize) {
      const latest = live(client, authorize, "browser:control");
      if (menu !== undefined && (typeof menu !== "string" || !menu.trim() || menu.length > 80 || hiddenControls.test(menu))) throw fail(400, "Name one menu, up to 80 characters, or none for all of them.");
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      const result = answer(await state.helper.send({ op: "menus", ...(menu ? { menu: menu.trim() } : {}) }));
      checkState(client, authorize, "browser:control", state);
      observe(latest);
      let budget = 400;
      const items = (list, depth) => (Array.isArray(list) && depth <= 3 ? list : []).filter((item) => plain(item) && typeof item.title === "string" && item.title).filter(() => budget-- > 0)
        .map((item) => ({ title: String(item.title || "").slice(0, 80), ...(item.enabled === false ? { enabled: false } : {}), ...(typeof item.key === "string" && item.key ? { key: item.key.slice(0, 12) } : {}),
          ...(item.checked === true ? { checked: true } : {}), ...(item.submenu === true ? { submenu: true } : {}), ...(Array.isArray(item.items) ? { items: items(item.items, depth + 1) } : {}) }));
      return { app: String(result.app || "").slice(0, 100), title: String(result.title || "").slice(0, 200),
        menus: (Array.isArray(result.menus) ? result.menus : []).slice(0, 30).filter(plain).map((entry) => ({ title: String(entry.title || "").slice(0, 80), items: items(entry.items, 1) })),
        truncated: result.truncated === true || budget < 0 };
    },
    /** Something in the front window by its words, scrolled into view, with the screen read again (reach_find). Scrolling is an input: the Mac is held for it. */
    async find(client, { text, name, role } = {}, authorize) {
      const latest = live(client, authorize, "browser:control");
      if ((text === undefined) === (name === undefined)) throw fail(400, "Find text, or a control by its name.");
      if (text !== undefined && (typeof text !== "string" || !text.trim() || text.length > 200 || hiddenControls.test(text))) throw fail(400, "Give the text to find, up to 200 characters.");
      if (name !== undefined && (typeof name !== "string" || !name.trim() || name.length > 120 || hiddenControls.test(name))) throw fail(400, "Name the control to find, up to 120 characters.");
      if (role !== undefined && (name === undefined || typeof role !== "string" || !/^[A-Za-z]{1,40}$/.test(role))) throw fail(400, "Give the control's role as one word, such as Button, with its name.");
      const askedAt = now();
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      take(latest);
      const result = answer(await dispatchInput(latest, state, { op: "find", ...(text !== undefined ? { text: text.trim() } : { name: name.trim(), ...(role ? { role } : {}) }) }, authorize, "browser:control"));
      checkState(client, authorize, "browser:control", state);
      extend(latest);
      observe(latest, askedAt);
      actions(latest, { kind: "find", text: actionWords("find", { text, name }, result), app: result.app });
      if (result.found !== true) return { found: false, app: String(result.app || "").slice(0, 100), title: String(result.title || "").slice(0, 200), truncated: result.truncated === true };
      const shaped = shapeElements(result);
      return { found: true, ...(Number.isInteger(result.n) && result.n >= 1 && result.n <= shaped.items.length ? { n: result.n } : {}),
        role: String(result.role || "").slice(0, 40), ...(text !== undefined ? { text: String(result.text || "").slice(0, 160) } : { name: String(result.name || "").slice(0, 120) }),
        matches: Number.isInteger(result.matches) ? Math.max(1, Math.min(500, result.matches)) : 1, inView: result.inView !== false, scrolled: result.scrolled === true,
        ...(result.inView === false && typeof result.direction === "string" ? { direction: ["above", "below", "left", "right"].includes(result.direction) ? result.direction : "below", distance: Number.isFinite(result.distance) ? Math.max(0, Math.min(100000, Math.round(result.distance))) : 0 } : {}),
        ...shaped };
    },
    /** The front window's whole text, what is scrolled away included (reach_read_page). */
    async readPage(client, authorize) {
      const latest = live(client, authorize, "browser:control");
      const askedAt = now();
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      const result = answer(await state.helper.send({ op: "read" }));
      checkState(client, authorize, "browser:control", state);
      observe(latest, askedAt);
      return { app: String(result.app || "").slice(0, 100), bundle: String(result.bundle || "").slice(0, 200), title: String(result.title || "").slice(0, 200),
        url: String(result.url || "").slice(0, 2048), text: String(result.text || "").slice(0, 60000), truncated: result.truncated === true };
    },
    /** A file opened in the app that owns it, or shown in the Finder (reach_open_file): never a program, never a protected path. */
    async openFile(client, filePath, { reveal = false } = {}, authorize) {
      const latest = live(client, authorize, "browser:open");
      if (typeof filePath !== "string" || !filePath.startsWith("/") || filePath.length > 4096 || /[\u0000-\u001f\u007f]/.test(filePath)) throw fail(400, "Give the file's full path on this Mac.");
      if (reveal !== true && reveal !== false) throw fail(400, "Set reveal to true, or leave it out.");
      const reason = latest.policy.preset === "full" ? null : protectedPathReason(filePath, { protectedPaths: protectedPaths(), home });
      if (reason) {
        actions(latest, { kind: "open-file", text: actionWords("open-file", { path: filePath, reveal }), ok: false, reason });
        throw Object.assign(fail(403, reason), { kind: "blocked" });
      }
      const state = await session(latest);
      checkState(client, authorize, "browser:open", state);
      take(latest);
      const result = answer(await dispatchInput(latest, state, { op: "open-file", path: filePath, ...(reveal ? { reveal: true } : {}) }, authorize, "browser:open"));
      checkState(client, authorize, "browser:open", state);
      extend(latest);
      observe(latest);
      note(latest, "open", result);
      actions(latest, { kind: "open-file", text: actionWords("open-file", { path: filePath, reveal }, result), app: result.app });
      return { ok: true, app: String(result.app || ""), bundle: String(result.bundle || ""), ...(result.front === false ? { front: false } : {}) };
    },
    /** What can be clicked in the front window, numbered, from the accessibility tree. */
    async elements(client, authorize, { displayId } = {}) {
      const latest = live(client, authorize, "browser:control");
      const askedAt = now();
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      const result = answer(await state.helper.send({ op: "elements", ...(displayId ? { displayId } : {}) }));
      checkState(client, authorize, "browser:control", state);
      // The numbered labels read the live screen: that is a look.
      observe(latest, askedAt);
      return shapeElements(result);
    },
    async displays(client, authorize) {
      const latest = live(client, authorize, "browser:screen"), state = await session(latest);
      checkState(client, authorize, "browser:screen", state);
      const result = answer(await state.helper.send({ op: "displays" }));
      checkState(client, authorize, "browser:screen", state);
      return { displays: (result.displays || []).slice(0, 32).filter(item => Number.isInteger(item.id)).map(({ id, main, x, y, width, height }) => ({ id, main: main === true, x, y, width, height })) };
    },
    async waitForChange(client, revision, ms, authorize) {
      const latest = live(client, authorize, "browser:control"), state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      const result = answer(await state.helper.send({ op: "wait-change", revision, ms: Math.min(400, Math.max(1, ms)) }));
      checkState(client, authorize, "browser:control", state);
      return result;
    },
    /** One input action, checked here (shape, typed text) and natively (its exact target). */
    async act(client, input, authorize, { expected } = {}) {
      const latest = live(client, authorize, "browser:control");
      const action = normalizeAction(input);
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      checkFresh(latest);
      try {
        // Typed text (type), or a form's fields (fill): checked against what
        // is in front before anything is sent.
        const typing = action.type === "type" ? [action] : action.type === "fill" ? action.fields : [];
        if (typing.length) {
          take(latest);
          const front = answer(await state.helper.send({ op: "front" }));
          if (front.blocked) throw Object.assign(fail(403, String(front.blocked).slice(0, 300)), { kind: "blocked" });
          for (const entry of typing) {
            if (entry.secret) {
              // Apps keeps vault values out of terminals. Full control may use
              // any target; explicit secrets still stay out of the action log.
              if (latest.policy.preset !== "full" && front.terminalLike === true) throw Object.assign(fail(403, "Vault values don't go into a terminal. Click the sign-in field first."), { kind: "blocked" });
            } else if (front.secure && action.type === "type") {
              if (latest.policy.preset !== "full") throw Object.assign(fail(403, "That's a password field. Use the Password box so the password stays hidden."), { kind: "blocked" });
              entry.secret = true;
              delete action.paste;
            }
            // Content checks apply only to narrower presets.
            const reason = latest.policy.preset === "full" ? null : typedTextRefusal(entry.text, { terminalLike: front.terminalLike === true, hosts: hosts(), protectedPaths: protectedPaths(), home });
            if (reason) throw Object.assign(fail(403, reason), { kind: "blocked" });
          }
          action.terminalLikeChecked = front.terminalLike === true;
        }
        checkState(client, authorize, "browser:control", state);
        take(latest);
        const result = answer(await dispatchInput(latest, state, { op: "act", action, ...(expected ? { expected } : {}) }, authorize, "browser:control"));
        checkState(client, authorize, "browser:control", state);
        extend(latest);
        observe(latest);
        note(latest, action.type, result);
        actions(latest, { kind: action.type, text: actionWords(action.type, action, result), app: result.app });
        return { ok: true, app: String(result.app || ""), bundle: String(result.bundle || "") };
      } catch (error) {
        if (error?.kind === "blocked") {
          note(latest, "blocked", { app: "" });
          actions(latest, { kind: action.type, text: actionWords(action.type, action), ok: false, reason: error.message });
        }
        throw error;
      }
    },
    /** Open or bring forward one app, within the preset. */
    async open(client, appPath, authorize) {
      const latest = live(client, authorize, "browser:open");
      if (typeof appPath !== "string" || !appPath.startsWith("/") || !appPath.endsWith(".app") || appPath.length > 4096 || /[\u0000-\u001f\u007f]/.test(appPath))
        throw fail(400, "Choose an app by its path on this Mac.");
      const state = await session(latest);
      checkState(client, authorize, "browser:open", state);
      take(latest);
      const result = answer(await dispatchInput(latest, state, { op: "open", app: appPath }, authorize, "browser:open"));
      checkState(client, authorize, "browser:open", state);
      extend(latest);
      observe(latest);
      note(latest, "open", result);
      actions(latest, { kind: "open", text: actionWords("open", { app: appPath }, result), app: result.app });
      return { ok: true, app: String(result.app || ""), bundle: String(result.bundle || ""), ...(result.front === false ? { front: false } : {}) };
    },
    /** A website in the owner's own browser (default for web links, or one chosen), within the preset. */
    async openUrl(client, url, browserPath, authorize) {
      const latest = live(client, authorize, "browser:open");
      let parsed;
      try { parsed = new URL(url); } catch { parsed = null; }
      if (typeof url !== "string" || url.length > 2048 || !parsed || !["http:", "https:"].includes(parsed.protocol) || /[\u0000-\u001f\u007f\s]/.test(url))
        throw fail(400, "Give a web address that starts with https://.");
      if (browserPath !== undefined && (typeof browserPath !== "string" || !browserPath.startsWith("/") || !browserPath.endsWith(".app") || browserPath.length > 4096))
        throw fail(400, "Choose the browser by its path on this Mac.");
      const reason = latest.policy.preset === "full" ? null : typedTextRefusal(url, { hosts: hosts(), protectedPaths: protectedPaths(), home });
      if (reason) throw Object.assign(fail(403, reason), { kind: "blocked" });
      const state = await session(latest);
      checkState(client, authorize, "browser:open", state);
      take(latest);
      const result = answer(await dispatchInput(latest, state, { op: "open-url", url, ...(browserPath ? { app: browserPath } : {}) }, authorize, "browser:open"));
      checkState(client, authorize, "browser:open", state);
      extend(latest);
      observe(latest);
      note(latest, "open", result);
      actions(latest, { kind: "open-url", text: actionWords("open-url", { url }, result), app: result.app });
      return { ok: true, app: String(result.app || ""), bundle: String(result.bundle || ""), ...(result.front === false ? { front: false } : {}) };
    },
    /** Keep the Mac's input lease for a whole declarative browser operation. */
    async withBrowser(client, appPath, authorize, work) {
      const latest = live(client, authorize, "browser:control");
      live(client, authorize, "browser:open");
      live(client, authorize, "browser:screen");
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      take(latest);
      // Browser effects run in a separate process from this policy-check
      // helper. Owner takeover must wait for both, including a rejected run.
      let finish;
      const finished = new Promise(resolve => { finish = resolve; });
      const pending = { client: latest, helper: state.helper, finished };
      pendingInputs.add(pending);
      const guard = async () => {
        checkState(client, authorize, "browser:control", state);
        checkState(client, authorize, "browser:open", state);
        checkState(client, authorize, "browser:screen", state);
        checkInputAllowed(latest);
        answer(await state.helper.send({ op: "browser-check", app: appPath }, () => {
          checkState(client, authorize, "browser:control", state);
          checkInputAllowed(latest);
        }));
        checkState(client, authorize, "browser:control", state);
        checkInputAllowed(latest);
        extend(latest);
      };
      try {
        await guard();
        const result = await work(guard, async () => {
          await guard();
          answer(await state.helper.send({ op: "open", app: appPath }, () => {
            checkState(client, authorize, "browser:open", state);
            checkInputAllowed(latest);
          }));
          await guard();
        });
        await guard();
        note(latest, "tool", { app: appPath.split("/").pop().replace(/\.app$/, "") });
        return result;
      } finally {
        if (state.helper.stopped && state.helper.terminated) await state.helper.terminated;
        pendingInputs.delete(pending);
        finish();
      }
    },
    /** Who holds the Mac and what each agent last did, for the owner. */
    activity() {
      return { holder: currentHolder(),
        agents: Object.fromEntries([...activity].map(([id, entry]) => [id, { ...entry }])), paused: pausedAgents.list() };
    },
    /** The owner's pause: the agent keeps looking, but every action waits until resumed. Kept across restarts. */
    setPaused(id, paused) {
      if (paused) release(id);
      // A hold or slow drag already sent lets go now (the helper releases what
      // it holds on stop), rather than seconds after the owner paused it.
      // Queued input is refused by its own dispatch check.
      if (paused) for (const entry of pendingInputs) if (entry.sent && entry.client.id === id) try { entry.helper.stop(); } catch {}
      return pausedAgents.set(id, paused);
    },
    isPaused: (id) => pausedAgents.has(id),
    // Every one of these agents, at once: after Reach ended unexpectedly, or
    // when the saved pauses couldn't be read (who was paused is unknown).
    pauseAll(ids) {
      for (const id of ids) release(id);
      return pausedAgents.add(ids);
    },
    pausesUnreadable: () => pausedAgents.unreadable,
    // Pauses of agents whose access has ended.
    forgetPauses: (alive) => pausedAgents.prune(alive),
    // The session's work ends; the owner's pause stays until they resume it
    // or the agent's access ends (a Reopen or an access change never resumes it).
    cancelClient(id) {
      sessions.get(id)?.helper.stop();
      sessions.delete(id);
      activity.delete(id);
      shots.delete(id);
      capturing.delete(id);
      looks.delete(id);
      release(id);
    },
    close() {
      closed = true;
      for (const state of sessions.values()) state.helper.stop();
      sessions.clear();
      looks.clear();
      utility?.stop(); utility = null; clearTimeout(utilityIdle);
    },
  };
}
