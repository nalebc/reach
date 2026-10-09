import { spawn } from "node:child_process";
import os from "node:os";
import { desktopBinary } from "./desktop-native.mjs";
import { fail } from "./core.mjs";
import { hiddenControls, nativeRules, typedTextRefusal } from "./agent-guard.mjs";
import { presetScopes } from "./agent-presets.mjs";

// This Mac's screen and input for preset agents, through the native checker
// (scripts/native/agent-desktop.swift): one helper process per agent session,
// started with that session's rules. Agents act one at a time: the Mac has one
// pointer and one keyboard, so an agent holds it for a short lease that each
// of its actions extends, and the others are told who has it. Screenshots are
// reads and run side by side. The owner's own hands (checked natively) and the
// owner's phone (checked here) always come first.
const KINDS = { blocked: 403, paused: 409, retry: 409, busy: 409, invalid: 400, unavailable: 503, setup_required: 503 };
const refusal = (value) => Object.assign(fail(KINDS[value.kind] || 403, String(value.error || "The Mac couldn't do that.").slice(0, 300)), { kind: value.kind || "blocked" });
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

export function normalizeAction(value) {
  if (!plain(value) || typeof value.type !== "string") throw fail(400, "Choose one action: click, move, drag, scroll, type or key.");
  const keys = Object.keys(value);
  const only = (...allowed) => { if (keys.some((key) => !allowed.includes(key))) throw fail(400, `A ${value.type} action takes only ${allowed.join(", ")}.`); };
  const modifiers = () => {
    if (value.modifiers === undefined) return [];
    if (!Array.isArray(value.modifiers) || value.modifiers.length > 4 || value.modifiers.some((m) => !MODIFIERS.has(m))) throw fail(400, "Modifiers are cmd, shift, option or control.");
    return [...new Set(value.modifiers)];
  };
  const point = (x, y) => { if (!number(value[x], 0, 1) || !number(value[y], 0, 1)) throw fail(400, "Give the point as fractions of the screen, 0 to 1."); return { [x]: value[x], [y]: value[y] }; };
  switch (value.type) {
    case "move": only("type", "x", "y"); return { type: "move", ...point("x", "y") };
    case "click": {
      only("type", "x", "y", "button", "count", "modifiers");
      if (value.button !== undefined && !["left", "right"].includes(value.button)) throw fail(400, "Click with the left or right button.");
      if (value.count !== undefined && ![1, 2, 3].includes(value.count)) throw fail(400, "Click once, twice or three times.");
      return { type: "click", ...point("x", "y"), button: value.button || "left", count: value.count || 1, modifiers: modifiers() };
    }
    case "drag": only("type", "x", "y", "toX", "toY"); return { type: "drag", ...point("x", "y"), ...point("toX", "toY") };
    case "scroll": {
      only("type", "x", "y", "dx", "dy");
      if (!number(value.dx ?? 0, -2000, 2000) || !number(value.dy ?? 0, -2000, 2000)) throw fail(400, "Scroll by up to 2000 pixels each way.");
      return { type: "scroll", ...point("x", "y"), dx: value.dx ?? 0, dy: value.dy ?? 0 };
    }
    case "type": {
      only("type", "text", "secret");
      if (value.secret !== undefined && value.secret !== true) throw fail(400, "Mark only a password as secret.");
      if (typeof value.text !== "string" || !value.text || value.text.length > 2000 || hiddenControls.test(value.text))
        throw fail(400, "Type up to 2000 characters, without hidden controls.");
      // A secret (a username, email or password from the agent's vault) is
      // never echoed, logged or recorded; it never goes into a terminal.
      return value.secret ? { type: "type", text: value.text, secret: true } : { type: "type", text: value.text };
    }
    case "key": {
      only("type", "key", "modifiers");
      const key = typeof value.key === "string" ? value.key.toLowerCase() : "";
      if (!KEYS.has(key)) throw fail(400, "Unknown key.");
      return { type: "key", key, modifiers: modifiers() };
    }
    // A numbered label from elements(): clicked at its live center natively.
    case "element": {
      only("type", "snapshot", "n", "button", "count");
      if (typeof value.snapshot !== "string" || !/^[a-z0-9-]{1,40}$/i.test(value.snapshot)) throw fail(400, "Look at the labels again.");
      if (!Number.isInteger(value.n) || value.n < 1 || value.n > 500) throw fail(400, "Choose a label number.");
      if (value.button !== undefined && !["left", "right"].includes(value.button)) throw fail(400, "Click with the left or right button.");
      if (value.count !== undefined && ![1, 2, 3].includes(value.count)) throw fail(400, "Click once, twice or three times.");
      return { type: "element", snapshot: value.snapshot, n: value.n, ...(value.button ? { button: value.button } : {}), ...(value.count ? { count: value.count } : {}) };
    }
    default: throw fail(400, "Choose one action: click, move, drag, scroll, type, key or element.");
  }
}

const HELPER_FAILURES = {
  timeout: "did not answer in time", process_exit: "exited", process_error: "could not stay connected",
  stdin_error: "lost its input connection", write_error: "could not send the request",
  invalid_reply: "returned an invalid reply", oversized_reply: "returned too much data",
  unexpected_reply: "returned an unexpected reply", stopped: "stopped",
};
const HELPER_OPERATIONS = new Set(["rules", "catalog", "shot", "front", "act", "open"]);
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
  spawnHelper,
  now = Date.now,
  leaseMs = 2500,
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
  const pausedAgents = new Set(); // by the owner, from the agent list
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
    const pending = { client, helper: state.helper };
    pendingInputs.add(pending);
    try {
      return await state.helper.send(request, () => {
        checkState(client, authorize, scope, state);
        checkInputAllowed(client);
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
  const observe = (client) => { looks.set(client.id, now()); };
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
    async screenshot(client, authorize, { maxWidth = 2560 } = {}) {
      const latest = live(client, authorize, "browser:screen");
      const width = Math.max(320, Math.min(3840, Number(maxWidth) || 2560));
      // One capture per agent at a time: a request that arrives while one
      // runs (a page that gave up and asked again) shares it. Abandoned
      // requests used to queue behind each other and swamp macOS's capture
      // service until no picture came back at all.
      const running = capturing.get(latest.id);
      let result;
      if (running && running.width >= width) result = await running.promise;
      else {
        const recent = (shots.get(latest.id) || []).filter((time) => time > now() - 1000);
        if (recent.length >= SHOTS_PER_SECOND) throw fail(429, "Wait a moment between screenshots.");
        recent.push(now()); shots.set(latest.id, recent);
        // Recorded before any await, so a request arriving now shares it.
        const promise = (async () => {
          if (running) await running.promise.catch(() => {});
          const state = await session(latest);
          checkState(client, authorize, "browser:screen", state);
          const value = answer(await state.helper.send({ op: "shot", maxWidth: width }));
          checkState(client, authorize, "browser:screen", state);
          return value;
        })();
        const entry = { width, promise };
        capturing.set(latest.id, entry);
        try { result = await promise; } finally { if (capturing.get(latest.id) === entry) capturing.delete(latest.id); }
      }
      live(client, authorize, "browser:screen");
      if (typeof result.jpeg !== "string" || result.jpeg.length > 12 * 1024 * 1024) throw fail(503, "The screen image could not be verified.");
      const jpeg = Buffer.from(result.jpeg, "base64");
      if (jpeg.length < 2 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) throw fail(503, "The screen image is unavailable.");
      observe(latest);
      return { jpeg, width: result.width, height: result.height, hidden: result.hidden || 0 };
    },
    /** What is in front: the app, its window title, whether it takes commands or a password, and why it is closed to the agent if it is. */
    async front(client, authorize) {
      const latest = live(client, authorize, "browser:screen");
      const state = await session(latest);
      checkState(client, authorize, "browser:screen", state);
      const result = answer(await state.helper.send({ op: "front" }));
      checkState(client, authorize, "browser:screen", state);
      const holder = currentHolder();
      observe(latest);
      return { app: String(result.app || ""), bundle: String(result.bundle || ""), title: String(result.title || "").slice(0, 200),
        terminalLike: result.terminalLike === true, secure: result.secure === true, blocked: String(result.blocked || "").slice(0, 300),
        path: String(result.path || "").slice(0, 4096), layout: String(result.layout || "").slice(0, 2000),
        holder: holder && holder.clientId !== latest.id ? holder.name : "" };
    },
    /** What can be clicked in the front window, numbered, from the accessibility tree. */
    async elements(client, authorize) {
      const latest = live(client, authorize, "browser:control");
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      const result = answer(await state.helper.send({ op: "elements" }));
      checkState(client, authorize, "browser:control", state);
      const fraction = (value) => Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
      const items = (Array.isArray(result.items) ? result.items : []).slice(0, 250)
        .filter((item) => Number.isInteger(item?.n))
        .map((item) => ({ n: item.n, role: String(item.role || "").slice(0, 40), name: String(item.name || "").slice(0, 60), secure: item.secure === true,
          x: fraction(item.x), y: fraction(item.y), w: fraction(item.w), h: fraction(item.h) }));
      return { snapshot: String(result.snapshot || "").slice(0, 40), app: String(result.app || "").slice(0, 100), items, truncated: result.truncated === true };
    },
    /** One input action, checked here (shape, typed text) and natively (its exact target). */
    async act(client, input, authorize, { expected } = {}) {
      const latest = live(client, authorize, "browser:control");
      const action = normalizeAction(input);
      const state = await session(latest);
      checkState(client, authorize, "browser:control", state);
      checkFresh(latest);
      take(latest);
      try {
        if (action.type === "type") {
          const front = answer(await state.helper.send({ op: "front" }));
          if (front.blocked) throw Object.assign(fail(403, String(front.blocked).slice(0, 300)), { kind: "blocked" });
          if (action.secret) {
            // Vault values (usernames, emails, passwords) never go to a terminal,
            // where they would run or show as a command.
            if (front.terminalLike === true) throw Object.assign(fail(403, "Vault values don't go into a terminal. Click the sign-in field first."), { kind: "blocked" });
          } else if (front.secure) throw Object.assign(fail(403, "That's a password field. Use the Password box so the password stays hidden."), { kind: "blocked" });
          const reason = action.secret ? null : typedTextRefusal(action.text, { terminalLike: front.terminalLike === true, hosts: hosts(), protectedPaths: protectedPaths(), home });
          if (reason) throw Object.assign(fail(403, reason), { kind: "blocked" });
          action.terminalLikeChecked = front.terminalLike === true;
        }
        checkState(client, authorize, "browser:control", state);
        take(latest);
        const result = answer(await dispatchInput(latest, state, { op: "act", action, ...(expected ? { expected } : {}) }, authorize, "browser:control"));
        checkState(client, authorize, "browser:control", state);
        extend(latest);
        observe(latest);
        note(latest, action.type, result);
        return { ok: true, app: String(result.app || ""), bundle: String(result.bundle || "") };
      } catch (error) {
        if (error?.kind === "blocked") note(latest, "blocked", { app: "" });
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
      return { ok: true, app: String(result.app || ""), bundle: String(result.bundle || "") };
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
        agents: Object.fromEntries([...activity].map(([id, entry]) => [id, { ...entry }])), paused: [...pausedAgents] };
    },
    /** The owner's pause: the agent keeps looking, but every action waits until resumed. */
    setPaused(id, paused) {
      if (paused) { pausedAgents.add(id); release(id); } else pausedAgents.delete(id);
      return pausedAgents.has(id);
    },
    isPaused: (id) => pausedAgents.has(id),
    cancelClient(id) {
      sessions.get(id)?.helper.stop();
      sessions.delete(id);
      activity.delete(id);
      shots.delete(id);
      capturing.delete(id);
      looks.delete(id);
      pausedAgents.delete(id);
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
