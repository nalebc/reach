import fs from "node:fs";
import { actionWords } from "./agent-actions.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";
import { atomicJson, browserIdleEnded, fail, isPlainRecord } from "./core.mjs";
import { desktopBinary } from "./desktop-native.mjs";
import {
  createToolBrowserDriver,
  nativeToolProcess,
} from "./tool-browser-driver.mjs";
import { PREBUILT_TOOLS } from "./prebuilt-tools.mjs";
import {
  protectedPage,
  protectedTitle,
  PROTECTED_TITLE_WORDS,
  PROTECTED_APP_NAMES,
} from "./agent-guard.mjs";
import { moneySite } from "./money-sites.mjs";
import {
  TOOL_PROTOCOL,
  TOOL_BROWSERS,
  TOOL_LIMITS,
  TOOL_UUID,
  toolOrigin,
  validateToolDefinition,
  toolInputs,
  resolveToolValue,
  protocolDescription,
} from "./tool-protocol.mjs";

const problem = (code, message, status = 409) =>
  Object.assign(fail(status, message), { code });
const copy = (value) => structuredClone(value);
const fp = (client) =>
  JSON.stringify([client.id, client.policy, client.scopes, client.expiresAt]);
const digest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
// A run's inputs, as kept in the run ledger (saved for a day) to tell a retry
// from a reused requestId. A full-control tool may type a password into a
// page, so they are never kept as a plain fast hash someone could guess
// from: salted scrypt, per run, compared in constant time.
// One at a time, all agents together: each is ~30 ms of one of libuv's four
// threads, worked out before any run budget, and an agent replaying a
// requestId (or naming a browser it can't use) as fast as it could kept all
// four busy, stalling Reach's file, zlib and crypto work (CodeQL #67).
const derive = promisify(crypto.scrypt);
let deriving = Promise.resolve();
const scrypt = (...args) => {
  const turn = deriving.then(() => derive(...args));
  deriving = turn.catch(() => {});
  return turn;
};
const INPUTS = /^s1:([A-Za-z0-9_-]{22}):([A-Za-z0-9_-]{43})$/;
export const inputsFingerprint = async (inputs, salt = crypto.randomBytes(16)) =>
  `s1:${salt.toString("base64url")}:${(await scrypt(inputs, salt, 32)).toString("base64url")}`;
export const sameInputs = async (fingerprint, inputs) => {
  const parts = INPUTS.exec(fingerprint);
  // Saved before Reach salted them (at most a day old): those inputs can't
  // be compared, and the run they name is still never repeated.
  if (!parts) return true;
  const derived = await scrypt(inputs, Buffer.from(parts[1], "base64url"), 32);
  return crypto.timingSafeEqual(derived, Buffer.from(parts[2], "base64url"));
};
const safeName = (value) =>
  String(value || "attachment")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .slice(0, 150) || "attachment";
const privateTitles = [...PROTECTED_TITLE_WORDS, ...PROTECTED_APP_NAMES];
export const BATCH_ITEMS = 10;
// Batch tabs open on this Mac at once, all agents together, and how long one
// kept for its handles (or left to inspect) stays before Reach closes it.
export const BATCH_TABS = 10;
export const BATCH_TAB_MS = 5 * 60 * 1000;
const tabKey = (tab) => `${tab.window}:${tab.tab}`;
// Each batch item is an ordinary run with a request ID of its own, derived
// from the batch's: calling the batch again never repeats a finished item.
export const batchItemId = (requestId, index) => {
  const h = crypto
    .createHash("sha256")
    .update(`reach.batch:${requestId}:${index}`)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${(8 | (parseInt(h[16], 16) & 3)).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
// A stop that every later item would meet too.
const BATCH_STOPS = [
  "setup_required",
  "browser_closed",
  "browser_window_required",
  "browser_access",
  "access_changed",
  "login_required",
  // Another tool took the Mac between items: the rest would wait for it too.
  "busy",
];
const body = (req, allowed) => {
  if (
    !isPlainRecord(req.body) ||
    Object.keys(req.body).some((key) => !allowed.includes(key))
  )
    throw fail(400, "Use only the documented tool fields.");
  return req.body;
};

/** A bounded, declarative interpreter shared by built-in and agent-defined tools. */
export function createAgentTools(
  config,
  {
    desktop,
    driver = null,
    record = () => {},
    // The owner's log of what each agent did (agent-actions.mjs add).
    actions = () => {},
    hosts = () => [],
    // A tool that couldn't run until the owner sets its browser up: told,
    // so Reach can show the owner just that (tool-setup.mjs).
    onSetupRequired = () => {},
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitMs = 8000,
    runMs = TOOL_LIMITS.runMs,
    // A batch starts no new item after this; the agent calls it again.
    batchMs = 30000,
    savings = null,
    pdf = async (value, options) =>
      nativeToolProcess(
        await desktopBinary(config, "tool-receipt", { signal: options.signal }),
        [],
        JSON.stringify({ text: value.text, source: value.url }),
        options,
      ),
  } = {},
) {
  const ownsDriver = driver === null;
  driver ??= createToolBrowserDriver();
  const definitionsFile = path.join(config.dataDir, "agent-tools.json");
  const ledgerFile = path.join(config.dataDir, "agent-tool-runs.json");
  const artifactDir = path.join(config.dataDir, "agent-tool-files");
  fs.mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(artifactDir).isSymbolicLink())
    throw fail(500, "The tool file directory must be private.");
  fs.chmodSync(artifactDir, 0o700);
  // No artifact survives a server restart: its in-memory ownership and TTL do not either.
  for (const entry of fs.readdirSync(artifactDir))
    if (TOOL_UUID.test(entry)) fs.unlinkSync(path.join(artifactDir, entry));
  const load = (file, max) => {
    if (!fs.existsSync(file)) return [];
    if (fs.lstatSync(file).isSymbolicLink() || fs.statSync(file).size > max)
      throw fail(500, "The tool store could not be verified.");
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(data))
      throw fail(500, "The tool store could not be read.");
    return data;
  };
  let saved = load(definitionsFile, 3 * 1024 * 1024).map((entry) => {
    if (!isPlainRecord(entry) || typeof entry.enabled !== "boolean")
      throw fail(500, "The tool definition store is invalid.");
    return { ...entry, definition: validateToolDefinition(entry.definition) };
  });
  if (
    saved.length > TOOL_LIMITS.tools ||
    new Set(saved.map((entry) => entry.definition.id)).size !== saved.length
  )
    throw fail(500, "The tool definition store is invalid.");
  const ledger = new Map(),
    results = new Map(),
    handles = new Map(),
    files = new Map();
  let running = null,
    // The batch running on this Mac, if any: one at a time.
    batching = null,
    closed = false;
  for (const entry of load(ledgerFile, 1024 * 1024)) {
    if (
      !TOOL_UUID.test(entry.requestId) ||
      typeof entry.clientId !== "string" ||
      typeof entry.hash !== "string" ||
      !Number.isFinite(entry.at)
    )
      throw fail(500, "The tool run store is invalid.");
    if (entry.at > now() - 24 * 60 * 60 * 1000) {
      if (entry.status === "running") {
        entry.status = "uncertain";
        entry.code = "interrupted";
      }
      ledger.set(`${entry.clientId}:${entry.requestId}`, entry);
    }
  }
  const persistLedger = () => atomicJson(ledgerFile, [...ledger.values()]);
  if (ledger.size) persistLedger();
  // Tabs Reach opened behind for batches, every agent's: the only tabs Reach
  // ever closes. Never more than BATCH_TABS open; each closes when its batch
  // ends or, kept, within BATCH_TAB_MS. Saved, so a restart closes them too.
  const tabsFile = path.join(config.dataDir, "agent-tool-tabs.json"),
    batchTabs = new Map();
  try {
    for (const entry of load(tabsFile, 256 * 1024))
      if (
        isPlainRecord(entry) &&
        Number.isInteger(entry.window) &&
        Number.isInteger(entry.tab) &&
        typeof entry.clientId === "string" &&
        typeof entry.appPath === "string" &&
        entry.appPath.endsWith(".app") &&
        typeof entry.url === "string" &&
        Array.isArray(entry.origins) &&
        entry.origins.every((origin) => typeof origin === "string") &&
        batchTabs.size < BATCH_TABS
      )
        // From before the restart: closed now, and only on the page it was left on.
        batchTabs.set(tabKey(entry), { ...entry, until: 0, restored: true, attempts: 0 });
  } catch {
    /* unreadable: nothing to close */
  }
  const saveTabs = () => {
    try {
      atomicJson(
        tabsFile,
        [...batchTabs.values()].map(({ attempts, ...entry }) => entry),
      );
    } catch {
      /* the tabs still close while Reach runs */
    }
  };
  // Close Reach's batch tabs: only while still on their tool's sites (before a
  // restart, on the exact page they were left on), and never the tab the owner
  // is looking at. A tab that left, or that the owner brought forward, is theirs.
  const closeTabs = async (entries, appPath, { guard = async () => {}, signal } = {}) => {
    if (!entries.length) return 0;
    const native = (request) =>
      driver.transport("Chrome", request, { appPath, signal, timeoutMs: 12000 });
    let count = 0;
    try {
      await guard();
      let list;
      try {
        list = await native({ op: "tabs" });
      } catch (error) {
        if (error.code !== "browser_closed") throw error;
        list = [];
      }
      const open = new Map((Array.isArray(list) ? list : []).map((tab) => [tabKey(tab), tab]));
      // The pages the tabs that stay are on now, for after a restart.
      for (const [key, entry] of batchTabs)
        if (!entry.restored && open.has(key)) entry.url = open.get(key).url;
      for (const entry of entries) {
        const tab = open.get(tabKey(entry));
        let origin = null;
        try {
          origin = new URL(tab.url).origin;
        } catch {}
        if (
          !tab ||
          !entry.origins.includes(origin) ||
          (entry.restored && tab.url !== entry.url)
        ) {
          batchTabs.delete(tabKey(entry));
          continue;
        }
        await guard();
        try {
          await native({ op: "close", target: tab, expectedURL: tab.url, behind: true });
          batchTabs.delete(tabKey(entry));
          count++;
        } catch (error) {
          if (error.code === "owner_tab" || ++entry.attempts >= 3)
            batchTabs.delete(tabKey(entry));
        }
      }
    } finally {
      saveTabs();
    }
    return count;
  };
  // Tabs past their time close on their own, even with no agent around:
  // Reach tidying its own background tabs touches no input and no page.
  let sweepTimer = null;
  const scheduleSweep = () => {
    clearTimeout(sweepTimer);
    sweepTimer = null;
    if (closed || !batchTabs.size) return;
    const next = Math.min(...[...batchTabs.values()].map((entry) => entry.until));
    sweepTimer = setTimeout(sweep, Math.min(BATCH_TAB_MS, Math.max(1000, next - now())));
    sweepTimer.unref?.();
  };
  const sweep = async () => {
    sweepTimer = null;
    if (closed) return;
    const due = [...batchTabs.values()].filter((entry) => entry.until <= now());
    // A tool or batch on the Mac goes first; the sweep comes back after.
    if (due.length && !running && !batching)
      for (const appPath of new Set(due.map((entry) => entry.appPath))) {
        const group = due.filter((entry) => entry.appPath === appPath);
        try {
          await closeTabs(group, appPath);
        } catch {
          for (const entry of group)
            if (++entry.attempts >= 3) batchTabs.delete(tabKey(entry));
          saveTabs();
        }
      }
    scheduleSweep();
  };
  scheduleSweep();
  const definitions = () => [
    ...PREBUILT_TOOLS.map((definition) => ({
      definition,
      enabled: true,
      builtIn: true,
    })),
    ...saved,
  ];
  const check = (authorize) => {
    if (closed) throw fail(503, "Reach is shutting down.");
    const client = authorize();
    if (
      client?.kind !== "agent" ||
      (client.status && client.status !== "accepted") ||
      client.expiresAt <= now() ||
      browserIdleEnded(client, now()) ||
      !client.policy?.browser ||
      !["full", "apps"].includes(client.policy.preset) ||
      !["browser:screen", "browser:control", "browser:open"].every((scope) =>
        client.scopes?.includes(scope),
      )
    )
      throw fail(
        403,
        "Browser tools need this agent's current screen, control and app access.",
      );
    return client;
  };
  const allowed = (client, app) =>
    !!TOOL_BROWSERS[app.name] &&
    (client.policy.preset === "full" || !(client.policy.hidden || []).some(
      (hidden) => hidden.id === app.id || hidden.bundleId === app.bundleId,
    )) &&
    (client.policy.preset === "full" ||
      (client.policy.apps || []).some(
        (chosen) => chosen.id === app.id && chosen.bundleId === app.bundleId,
      ));
  const browserApps = async (authorize) => {
    const client = check(authorize);
    if (!desktop?.withBrowser) return [];
    const apps = await desktop.catalog(() => check(authorize));
    return apps
      .filter((app) => Object.values(TOOL_BROWSERS).includes(app.bundleId))
      .map((app) => ({
        ...app,
        name: Object.keys(TOOL_BROWSERS).find(
          (name) => TOOL_BROWSERS[name] === app.bundleId,
        ),
      }))
      .filter((app) => allowed(client, app));
  };
  const prune = () => {
    for (const [id, handle] of handles)
      if (handle.until <= now()) handles.delete(id);
    for (const [id, file] of files)
      if (file.until <= now()) {
        files.delete(id);
        fs.rmSync(path.join(artifactDir, id), { force: true });
      }
    for (const [key, entry] of ledger)
      if (entry.at < now() - 24 * 60 * 60 * 1000) {
        ledger.delete(key);
        results.delete(key);
      }
  };
  const getHandle = (id, client, browser) => {
    const handle = handles.get(id);
    if (
      !handle ||
      handle.until <= now() ||
      handle.clientId !== client.id ||
      handle.browser !== browser
    )
      throw problem(
        "stale_handle",
        "This item handle expired, belongs to another session or uses another browser. Search again.",
      );
    return handle;
  };
  const getFile = (id, client) => {
    const file = files.get(id);
    if (!file || file.until <= now() || file.clientId !== client.id)
      throw problem(
        "stale_file",
        "This file handle expired or belongs to another session. Download it again.",
      );
    return file;
  };
  const fileBytes = (id, client) => {
    const file = getFile(id, client);
    let fd;
    try {
      fd = fs.openSync(
        path.join(artifactDir, id),
        fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0),
      );
      const info = fs.fstatSync(fd);
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size !== file.size ||
        info.size > TOOL_LIMITS.fileBytes ||
        info.ino !== file.ino ||
        info.dev !== file.dev
      )
        throw Error("changed");
      const bytes = fs.readFileSync(fd);
      if (crypto.createHash("sha256").update(bytes).digest("hex") !== file.hash)
        throw Error("changed");
      return bytes;
    } catch {
      throw problem(
        "stale_file",
        "The private attachment changed or disappeared. Download it again.",
      );
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  };
  const storeFile = (client, data, name, mime) => {
    if (!data.length || data.length > TOOL_LIMITS.fileBytes)
      throw problem(
        "file_limit",
        "The returned file is empty or exceeds 8 MiB.",
        413,
      );
    if ([...files.values()].filter((f) => f.clientId === client.id).length >= 30)
      throw problem(
        "file_limit",
        "The private file handle limit was reached. Wait for unused files to expire.",
        413,
      );
    const id = crypto.randomUUID(),
      file = {
        clientId: client.id,
        until: Math.min(client.expiresAt, now() + 15 * 60 * 1000),
        name: safeName(name),
        mime: String(mime || "application/octet-stream").slice(0, 100),
        size: data.length,
      };
    fs.writeFileSync(path.join(artifactDir, id), data, {
      mode: 0o600,
      flag: "wx",
    });
    const info = fs.statSync(path.join(artifactDir, id));
    Object.assign(file, {
      ino: info.ino,
      dev: info.dev,
      hash: crypto.createHash("sha256").update(data).digest("hex"),
    });
    files.set(id, file);
    return {
      handle: id,
      filename: file.name,
      mime: file.mime,
      bytes: file.size,
      expiresAt: file.until,
    };
  };
  const checkURL = (value, definition, client) => {
    const origin = toolOrigin(value);
    if (!definition.origins.includes(origin))
      throw problem(
        "wrong_site",
        "The page left this tool's declared websites. Sign in yourself if the browser needs it.",
      );
    const url = new URL(value),
      key = `${url.hostname.toLowerCase()}:${url.port}`;
    if (client?.policy?.preset === "full") return url.href;
    if (
      protectedPage(value, hosts()) ||
      /(^|\.)(passwords\.google\.com|vault\.bitwarden\.(com|eu)|start\.1password\.com)$/.test(
        url.hostname,
      )
    )
      throw problem(
        "protected",
        "Password stores and protected browser pages cannot be used by tools.",
        403,
      );
    if (
      hosts().some(
        (host) =>
          host.toLowerCase() === url.hostname.toLowerCase() ||
          host.toLowerCase() === key,
      )
    )
      throw problem(
        "protected",
        "Tools cannot open Reach's own addresses.",
        403,
      );
    // Bank sites: an agent reads them itself, on screen, where every click is
    // checked (money-sites.mjs); a saved tool's steps aren't.
    if (moneySite(url.href))
      throw problem(
        "protected",
        "Saved tools don't run on bank sites. Read the bank's pages on screen instead.",
        403,
      );
    return url.href;
  };
  const resolveTarget = (target, values, context) =>
    Object.fromEntries(
      Object.entries(target).map(([key, value]) => [
        key,
        ["name", "text", "equals"].includes(key)
          ? resolveToolValue(value, values, context)
          : key === "identity"
            ? resolveTarget(value, values, context)
            : value,
      ]),
    );
  const summary = (entry) => ({
    protocol: TOOL_PROTOCOL,
    id: entry.id,
    requestId: entry.requestId,
    status: entry.status,
    completedSteps: entry.completedSteps || 0,
    totalSteps: entry.totalSteps,
    ...(entry.code ? { code: entry.code } : {}),
    ...(entry.status === "uncertain"
      ? {
          error:
            "The previous run was interrupted. Its effects will not be repeated. Inspect the browser before continuing.",
        }
      : {}),
    resultExpired: true,
  });
  const api = {
    async catalog(authorize, query = "") {
      if (typeof query !== "string" || query.length > 160)
        throw fail(400, "Search tools by task name.");
      const browsers = await browserApps(authorize);
      check(authorize);
      return {
        protocol: TOOL_PROTOCOL,
        browsers: [...new Set(browsers.map((app) => app.name))],
        tools: browsers.length
          ? definitions()
              .filter(
                (entry) =>
                  entry.enabled &&
                  `${entry.definition.title} ${entry.definition.description}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
              )
              .map((entry) => copy(entry.definition))
          : [],
        hint: `Check reach_tools before using the screen. Pick a named tool and execute it once with a requestId.${browsers.some((app) => app.name === "Chrome") ? " For the same tool over a list of items, use reach_tool_batch: up to 10 items per call, each in its own Chrome tab." : ""} To create one, read reach_tool_protocol and register the same reach.tool.v1 definition with reach_define_tool.`,
      };
    },
    protocol(authorize) {
      check(authorize);
      return protocolDescription();
    },
    async define(authorize, value) {
      const client = check(authorize),
        definition = validateToolDefinition(value);
      definition.origins.forEach((origin) => checkURL(origin, definition, client));
      if (!(await browserApps(authorize)).length)
        throw fail(
          403,
          "Choose an allowed Chrome or Safari app before defining tools.",
        );
      check(authorize);
      // reach_tool_<id> must not shadow Reach's own reach_tool_* tools.
      if (["batch", "operation", "protocol"].includes(definition.id))
        throw fail(400, "This tool ID is reserved. Choose another.");
      if (saved.some((entry) => entry.definition.id === definition.id))
        throw fail(
          409,
          "This tool ID already exists. Choose a new ID; saved tools are immutable.",
        );
      if (saved.length >= TOOL_LIMITS.tools)
        throw fail(
          400,
          "Delete a saved tool before creating another (limit 100).",
        );
      const next = [...saved, { definition, enabled: true, createdAt: now() }];
      atomicJson(definitionsFile, next);
      saved = next;
      record("agent", `${client.name} created tool ${definition.title}`);
      return { protocol: TOOL_PROTOCOL, tool: copy(definition), enabled: true };
    },
    inspect() {
      return copy(definitions());
    },
    update(id, enabled) {
      if (
        typeof enabled !== "boolean" ||
        !saved.some((entry) => entry.definition.id === id)
      )
        throw fail(
          400,
          "Choose an agent-created tool and whether it is enabled.",
        );
      const next = saved.map((entry) =>
        entry.definition.id === id ? { ...entry, enabled } : entry,
      );
      atomicJson(definitionsFile, next);
      saved = next;
      if (!enabled && running?.id === id) {
        running.cancelled = true;
        running.controller.abort();
      }
      return { ok: true };
    },
    remove(id) {
      if (!saved.some((entry) => entry.definition.id === id))
        throw fail(404, "Agent-created tool not found.");
      const next = saved.filter((entry) => entry.definition.id !== id);
      atomicJson(definitionsFile, next);
      saved = next;
      if (running?.id === id) {
        running.cancelled = true;
        running.controller.abort();
      }
      return { ok: true };
    },
    operation(authorize, requestId) {
      const client = check(authorize),
        key = `${client.id}:${requestId}`,
        entry = ledger.get(key);
      if (!entry) throw fail(404, "This session has no such tool run.");
      if (entry.grant !== digest(fp(client)))
        throw fail(403, "Access changed since this tool run.");
      return copy(results.get(key) || summary(entry));
    },
    // tab and background are Reach's own (batch below), never an agent's:
    // the run uses that tab and never brings the browser forward.
    async run(authorize, input, { signal, tab = null, background = false } = {}) {
      signal?.throwIfAborted();
      const client = check(authorize);
      if (
        !isPlainRecord(input) ||
        Object.keys(input).some(
          (key) => !["id", "browser", "requestId", "values"].includes(key),
        ) ||
        !TOOL_BROWSERS[input.browser] ||
        !TOOL_UUID.test(input.requestId || "")
      )
        throw fail(
          400,
          "Supply a tool ID, Chrome or Safari, a UUID requestId and declared values.",
        );
      prune();
      const key = `${client.id}:${input.requestId}`;
      if (input.values !== undefined && !isPlainRecord(input.values))
        throw fail(400, "Tool values must be a plain object.");
      // Hash the normalized values so a retry that spells out a default matches.
      let hashValues = input.values || {};
      try {
        const known = definitions().find(
          (entry) => entry.definition.id === input.id,
        )?.definition;
        if (known) hashValues = toolInputs(known, hashValues);
      } catch {}
      const inputs = JSON.stringify([
        input.id,
        input.browser,
        Object.fromEntries(
          Object.entries(hashValues).sort(([a], [b]) => a.localeCompare(b)),
        ),
      ]);
      if (ledger.has(key)) {
        const prior = ledger.get(key);
        const same = await sameInputs(prior.hash, inputs);
        // Checked again after comparing: access may have ended meanwhile.
        const current = check(authorize);
        if (!same)
          throw problem(
            "request_conflict",
            "This requestId was used with different inputs.",
          );
        if (prior.grant !== digest(fp(current)))
          throw fail(403, "Access changed since this tool run.");
        return copy(results.get(key) || summary(prior));
      }
      if (running)
        throw Object.assign(fail(409, "Another tool is running on this Mac."), {
          kind: "busy",
        });
      if (ledger.size >= 1000)
        throw fail(
          429,
          "The tool run limit was reached. Old request IDs expire after 24 hours.",
        );
      const definition = definitions().find(
        (entry) => entry.definition.id === input.id && entry.enabled,
      )?.definition;
      if (!definition) throw fail(404, "This tool is missing or disabled.");
      const values = toolInputs(definition, input.values || {}),
        context = {};
      // Preflight references before navigation, composition or any other side effect.
      for (const [name, field] of Object.entries(definition.inputs)) {
        if (field.type === "handle" && values[name]) {
          const handle = getHandle(values[name], client, input.browser);
          checkURL(handle.target.url, definition, client);
        }
        if (field.type === "file" && values[name]) {
          context.filename = getFile(values[name], client).name;
          fileBytes(values[name], client);
        }
      }
      if (
        definition.id === "builtin_gmail_draft" &&
        !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(values.to)
      )
        throw fail(400, "Supply one recipient email address.");
      const hash = await inputsFingerprint(inputs);
      const apps = await browserApps(authorize),
        candidates = apps.filter((app) => app.name === input.browser);
      if (ledger.has(key)) return api.run(authorize, input, { signal, tab, background });
      if (running)
        throw Object.assign(fail(409, "Another tool is running on this Mac."), {
          kind: "busy",
        });
      if (candidates.length !== 1)
        throw problem(
          "browser_access",
          "Choose exactly one installed, allowed copy of this browser.",
          403,
        );
      const grant = fp(client),
        startedAt = now();
      const entry = {
        clientId: client.id,
        requestId: input.requestId,
        hash,
        grant: digest(grant),
        id: definition.id,
        at: now(),
        status: "running",
        completedSteps: 0,
        totalSteps: definition.steps.length,
      };
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) controller.abort();
      const deadline = setTimeout(() => controller.abort(), runMs);
      deadline.unref();
      running = {
        id: definition.id,
        clientId: client.id,
        cancelled: false,
        controller,
      };
      ledger.set(key, entry);
      try {
        persistLedger();
      } catch (error) {
        running = null;
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
        ledger.delete(key);
        throw error;
      }
      const current = () => {
        const latest = check(authorize);
        if (
          fp(latest) !== grant ||
          running?.cancelled ||
          !definitions().some(
            (item) => item.definition.id === definition.id && item.enabled,
          )
        )
          throw problem(
            "access_changed",
            "Tool access changed or the owner cancelled this run.",
            403,
          );
        if (controller.signal.aborted || now() - startedAt >= runMs)
          throw problem(
            "time_limit",
            "This run reached its time limit. Inspect any completed steps before continuing.",
            408,
          );
        return latest;
      };
      let effectPending = false,
        target = null,
        document = null,
        root = null;
      const data = {};
      try {
        if (definition.steps[0].op === "navigate")
          checkURL(
            resolveToolValue(definition.steps[0].url, values, context),
            definition, client,
          );
        await desktop.withBrowser(
          client,
          candidates[0].id,
          current,
          async (nativeGuard, launch) => {
            const guard = async () => {
              current();
              await nativeGuard();
              current();
            };
            const transport = async (request, effect = false) => {
              await guard();
              effectPending = effect;
              const result = await driver.transport(input.browser, request, {
                appPath: candidates[0].id,
                signal: controller.signal,
                timeoutMs: Math.min(12000, runMs - (now() - startedAt)),
              });
              effectPending = false;
              await guard();
              return result;
            };
            const page = async (request) => {
              await guard();
              const effect = ["click", "fill", "attach", "download"].includes(
                request.op,
              );
              effectPending = effect;
              const result = await driver.page(
                input.browser,
                target,
                {
                  origins: definition.origins,
                  protectedTitles: client.policy.preset === "full" ? [] : privateTitles,
                  fullControl: client.policy.preset === "full",
                  document,
                  root,
                  ...request,
                },
                {
                  appPath: candidates[0].id,
                  signal: controller.signal,
                  timeoutMs: Math.min(12000, runMs - (now() - startedAt)),
                },
              );
              if (result?.error) {
                effectPending = result.uncertain === true;
                throw Object.assign(
                  problem(result.code || "unsupported", result.error),
                  { uncertain: result.uncertain === true },
                );
              }
              effectPending = false;
              await guard();
              if (
                !isPlainRecord(result) ||
                typeof result.url !== "string" ||
                result.document !== document
              )
                throw problem(
                  "stale",
                  "The browser returned a different document.",
                );
              checkURL(result.url, definition, client);
              return result;
            };
            const retryRead = async (work) => {
              const until = Math.min(startedAt + runMs, now() + waitMs);
              for (;;) {
                try {
                  return await work();
                } catch (error) {
                  if (
                    !["missing", "loading"].includes(error.code) ||
                    now() + 100 >= until
                  )
                    throw error;
                  await wait(100);
                  current();
                }
              }
            };
            const bind = async (url) => {
              await retryRead(async () => {
                const info = await transport({ op: "info", target });
                checkURL(info.url, definition, client);
                if (client.policy.preset !== "full" &&
                  /\/(login|signin|sign-in|challenge|captcha)(\/|$)/i.test(
                    new URL(info.url).pathname,
                  )
                )
                  throw problem(
                    "login_required",
                    "The browser needs you to sign in or complete a verification challenge.",
                  );
                if (client.policy.preset !== "full" && (
                  protectedTitle(info.title) ||
                  privateTitles.some((word) =>
                    String(info.title || "")
                      .toLowerCase()
                      .includes(word),
                  ))
                )
                  throw problem(
                    "protected",
                    "This browser page is protected.",
                    403,
                  );
                if (info.url !== url)
                  throw problem(
                    "loading",
                    "The browser has not reached the exact requested page.",
                  );
                target = { ...info };
                await guard();
                const bound = await driver.page(
                  input.browser,
                  target,
                  {
                    op: "bind",
                    origins: definition.origins,
                    protectedTitles: client.policy.preset === "full" ? [] : privateTitles,
                    fullControl: client.policy.preset === "full",
                    expectedURL: url,
                    document: crypto.randomUUID(),
                  },
                  {
                    appPath: candidates[0].id,
                    signal: controller.signal,
                    timeoutMs: Math.min(12000, runMs - (now() - startedAt)),
                  },
                );
                if (bound?.error) throw problem(bound.code, bound.error);
                if (!TOOL_UUID.test(bound?.document || "") || bound.url !== url)
                  throw problem(
                    "stale",
                    "Could not bind the requested browser document.",
                  );
                document = bound.document;
                root = null;
              });
            };
            // Chrome's scripting setting belongs to a profile. Check the exact
            // window we will use, without scripting a private account page.
            const preflight = async (window) => {
              const readiness = await transport({
                op: "preflight",
                probeId: crypto.randomUUID(),
                ...(window === undefined ? {} : { window }),
              });
              if (readiness?.ok !== true)
                throw problem(
                  "setup_required",
                  "The browser’s scripting setup could not be verified.",
                );
            };
            for (const [index, step] of definition.steps.entries()) {
              current();
              const command = `${input.requestId}:${index}`;
              if (step.op === "navigate" && background) {
                // A batch item: the tab the batch opened behind for it, or the
                // one this run is already on. Never another of the owner's tabs.
                const url = checkURL(
                  resolveToolValue(step.url, values, context),
                  definition, client,
                );
                const own = target || tab;
                if (!own)
                  throw problem(
                    "unsupported",
                    "This batch item has no tab of its own.",
                  );
                // The batch checked this window's scripting once for all items.
                target = copy(own);
                if (target.url !== url) {
                  await bind(target.url);
                  target = await transport(
                    {
                      op: "navigate",
                      target,
                      expectedURL: target.url,
                      expectedDocument: document,
                      url,
                    },
                    true,
                  );
                }
                await bind(url);
              } else if (step.op === "navigate") {
                const url = checkURL(
                    resolveToolValue(step.url, values, context),
                    definition, client,
                  ),
                  dest = new URL(url);
                let tabs;
                try {
                  tabs = await transport({ op: "tabs" });
                } catch (error) {
                  if (error.code !== "browser_closed" || !launch) throw error;
                  await guard();
                  effectPending = true;
                  await launch();
                  effectPending = false;
                  tabs = await transport({ op: "tabs" });
                }
                if (!Array.isArray(tabs) || tabs.length > 1000)
                  throw problem(
                    "unsupported",
                    "The browser tab list is invalid.",
                  );
                const matches = tabs.filter((tab) => {
                  // A batch's tabs are Reach's, never the owner's choice of tab.
                  if (input.browser === "Chrome" && batchTabs.has(tabKey(tab)))
                    return false;
                  try {
                    const here = new URL(tab.url);
                    return (
                      here.origin === dest.origin &&
                      here.pathname === dest.pathname
                    );
                  } catch {
                    return false;
                  }
                });
                if (matches.length > 1)
                  throw problem(
                    "ambiguous",
                    "Multiple tabs match this exact site and account. Choose one before running the tool.",
                  );
                await preflight(matches[0]?.window);
                target =
                  matches[0] || (await transport({ op: "create", url }, true));
                if (matches.length && target.url !== url) {
                  await bind(target.url);
                  target = await transport(
                    {
                      op: "navigate",
                      target,
                      expectedURL: target.url,
                      expectedDocument: document,
                      url,
                    },
                    true,
                  );
                }
                await bind(url);
                if (!background) await transport(
                  {
                    op: "focus",
                    target,
                    expectedURL: target.url,
                    expectedDocument: document,
                  },
                  true,
                );
              } else if (step.op === "use") {
                const handle = getHandle(
                  resolveToolValue(step.handle, values, context),
                  client,
                  input.browser,
                );
                if (!background) await preflight(handle.target.window);
                target = copy(handle.target);
                document = handle.document;
                root = handle.pageRef;
                Object.assign(context, handle.context);
                await page({
                  op: "use",
                  fields: handle.fields,
                  expectedFields: handle.context,
                });
                if (!background) await transport(
                  {
                    op: "focus",
                    target,
                    expectedURL: target.url,
                    expectedDocument: document,
                  },
                  true,
                );
              } else {
                const request = {
                  op: step.op,
                  command,
                  target: resolveTarget(step.target, values, context),
                };
                if (step.value !== undefined)
                  request.value = resolveToolValue(step.value, values, context);
                if (step.filter !== undefined)
                  request.filter = resolveToolValue(
                    step.filter,
                    values,
                    context,
                  );
                if (step.empty)
                  request.empty = resolveTarget(step.empty, values, context);
                if (step.fields)
                  request.fields = Object.fromEntries(
                    Object.entries(step.fields).map(([key, value]) => [
                      key,
                      resolveTarget(value, values, context),
                    ]),
                  );
                if (step.op === "attach") {
                  const id = resolveToolValue(step.file, values, context),
                    file = getFile(id, client);
                  const bytes = fileBytes(id, client);
                  request.file = {
                    name: file.name,
                    mime: file.mime,
                    data: bytes.toString("base64"),
                  };
                  context.filename = file.name;
                }
                if (step.op === "download")
                  request.maxBytes = TOOL_LIMITS.fileBytes;
                const result =
                  step.op === "wait"
                    ? await retryRead(() => page(request))
                    : await page(request);
                if (step.op === "click") {
                  root = null;
                  if (result.nextUrl) {
                    try {
                      checkURL(result.nextUrl, definition, client);
                      await bind(result.nextUrl);
                    } catch (error) {
                      // The click already happened; count it and report uncertainty
                      // so the agent does not click again.
                      entry.completedSteps = index + 1;
                      throw Object.assign(error, { uncertain: true });
                    }
                  }
                }
                if (step.op === "collect") {
                  if (
                    !Array.isArray(result.items) ||
                    result.items.length > 30 ||
                    [...handles.values()].filter((h) => h.clientId === client.id).length + result.items.length > 1000
                  )
                    throw problem(
                      "limit",
                      "The page returned too many item handles.",
                    );
                  data[step.as] = {
                    coverage: "visible_page",
                    more: result.more === true,
                    items: result.items.map((item) => {
                      if (
                        !isPlainRecord(item) ||
                        !TOOL_UUID.test(item.pageRef || "") ||
                        Object.keys(request.fields).some(
                          (key) =>
                            typeof item[key] !== "string" ||
                            item[key].length > 1000,
                        )
                      )
                        throw problem(
                          "unsupported",
                          "An item handle could not be verified.",
                        );
                      const id = crypto.randomUUID(),
                        metadata = Object.fromEntries(
                          Object.keys(request.fields).map((key) => [
                            key,
                            item[key],
                          ]),
                        );
                      const until = Math.min(
                        client.expiresAt,
                        now() + 5 * 60 * 1000,
                      );
                      handles.set(id, {
                        clientId: client.id,
                        browser: input.browser,
                        target: copy(target),
                        document,
                        pageRef: item.pageRef,
                        context: metadata,
                        fields: request.fields,
                        until,
                      });
                      return { ...metadata, handle: id, expiresAt: until };
                    }),
                  };
                } else if (step.op === "download") {
                  let status;
                  do {
                    status = await page({
                      op: "download_status",
                      download: command,
                    });
                    if (status.state === "running") await wait(100);
                    current();
                  } while (status.state === "running");
                  if (
                    status.state !== "completed" ||
                    !Number.isInteger(status.length) ||
                    status.length > Math.ceil(TOOL_LIMITS.fileBytes / 3) * 4
                  )
                    throw problem(
                      "download_failed",
                      status.failure || "The download could not be verified.",
                    );
                  let encoded = "";
                  for (
                    let offset = 0;
                    offset < status.length;
                    offset += 262144
                  ) {
                    const chunk = await page({
                      op: "download_chunk",
                      download: command,
                      offset,
                    });
                    if (
                      typeof chunk.data !== "string" ||
                      chunk.data.length > 262144
                    )
                      throw problem(
                        "download_failed",
                        "The download chunk is invalid.",
                      );
                    encoded += chunk.data;
                  }
                  if (
                    encoded.length !== status.length ||
                    !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)
                  )
                    throw problem(
                      "download_failed",
                      "The download bytes could not be verified.",
                    );
                  data[step.as] = storeFile(
                    client,
                    Buffer.from(encoded, "base64"),
                    status.name,
                    status.mime,
                  );
                } else if (step.op === "pdf") {
                  if (
                    typeof result.text !== "string" ||
                    result.text.length > 50000
                  )
                    throw problem(
                      "unsupported",
                      "The receipt text is invalid.",
                    );
                  await guard();
                  const encoded = await pdf(result, {
                    signal: controller.signal,
                    timeoutMs: Math.min(12000, runMs - (now() - startedAt)),
                  });
                  await guard();
                  const bytes = Buffer.from(encoded, "base64");
                  if (bytes.subarray(0, 5).toString() !== "%PDF-")
                    throw problem(
                      "pdf_failed",
                      "The receipt PDF could not be verified.",
                    );
                  data[step.as] = storeFile(
                    client,
                    bytes,
                    `receipt-${safeName(context.order || "snapshot")}.pdf`,
                    "application/pdf",
                  );
                } else if (step.op === "read") {
                  if (
                    typeof result.text !== "string" ||
                    result.text.length > 50000
                  )
                    throw problem("unsupported", "The page text is invalid.");
                  data[step.as] = result.text;
                }
              }
              current();
              entry.completedSteps = index + 1;
              persistLedger();
            }
          },
        );
        entry.status = "completed";
        const result = {
          protocol: TOOL_PROTOCOL,
          id: definition.id,
          requestId: input.requestId,
          browser: input.browser,
          status: entry.status,
          completedSteps: entry.completedSteps,
          totalSteps: entry.totalSteps,
          data,
        };
        results.set(key, result);
        record("agent", `${client.name} completed tool ${definition.title}`);
        actions(client, { kind: "tool", text: actionWords("tool", { title: definition.title }), app: input.browser });
      } catch (error) {
        entry.status =
          effectPending || error.uncertain
            ? "uncertain"
            : [
                  "setup_required",
                  "wrong_site",
                  "browser_closed",
                  "login_required",
                  "browser_window_required",
                ].includes(error.code || error.kind)
              ? "needs_owner"
              : "stopped";
        entry.code = error.code || error.kind || "stopped";
        if (entry.code === "setup_required") onSetupRequired(input.browser, client.name);
        results.set(key, {
          protocol: TOOL_PROTOCOL,
          id: definition.id,
          requestId: input.requestId,
          browser: input.browser,
          status: entry.status,
          completedSteps: entry.completedSteps,
          totalSteps: entry.totalSteps,
          code: entry.code,
          error: String(error.message).slice(0, 500),
          data,
        });
        record("agent", `${client.name}'s tool ${definition.title} stopped`);
        actions(client, { kind: "tool", text: actionWords("tool", { title: definition.title }), app: input.browser, ok: false, reason: String(error.message).slice(0, 300) });
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", cancel);
        running = null;
        try {
          persistLedger();
        } catch {}
      }
      return copy(results.get(key));
    },
    // One tool over up to ten items, each in a tab of its own. The tabs open
    // behind, all at once, so their pages load side by side; then each item
    // runs as an ordinary run, one after another, so clicks on one site's
    // cart never race each other.
    async batch(authorize, input, { signal } = {}) {
      signal?.throwIfAborted();
      const client = check(authorize);
      if (
        !isPlainRecord(input) ||
        Object.keys(input).some(
          (key) => !["id", "browser", "requestId", "items", "keepTabs"].includes(key),
        ) ||
        typeof input.id !== "string" ||
        !TOOL_UUID.test(input.requestId || "") ||
        !Array.isArray(input.items) ||
        input.items.length < 1 ||
        input.items.length > BATCH_ITEMS ||
        input.items.some((values) => !isPlainRecord(values)) ||
        (input.keepTabs !== undefined && typeof input.keepTabs !== "boolean")
      )
        throw fail(
          400,
          `Supply a tool ID, a UUID requestId and 1 to ${BATCH_ITEMS} items of its declared values.`,
        );
      // Safari names a tab by its position, which opening tabs shifts.
      if (input.browser !== "Chrome")
        throw fail(400, "Batches run in Chrome.");
      const definition = definitions().find(
        (entry) => entry.definition.id === input.id && entry.enabled,
      )?.definition;
      if (!definition) throw fail(404, "This tool is missing or disabled.");
      // One batch at a time on this Mac: a second one, or a retry while the
      // first still runs, never opens tabs of its own.
      if (batching)
        throw Object.assign(fail(409, "Another batch is running on this Mac."), {
          kind: "busy",
        });
      batching = client.id;
      try {
        return await runBatch(authorize, client, input, definition, signal);
      } finally {
        batching = null;
        scheduleSweep();
      }
    },
    cancelClient(id) {
      // Its batch tabs close now, with nobody left to use their handles.
      for (const entry of batchTabs.values())
        if (entry.clientId === id) entry.until = 0;
      saveTabs();
      scheduleSweep();
      if (running?.clientId === id) {
        running.cancelled = true;
        running.controller.abort();
      }
      for (const [key, value] of handles)
        if (value.clientId === id) handles.delete(key);
      for (const [key, value] of files)
        if (value.clientId === id) {
          files.delete(key);
          fs.rmSync(path.join(artifactDir, key), { force: true });
        }
    },
    close() {
      closed = true;
      if (ownsDriver) driver.close?.();
      // Tabs still open stay saved: the next start closes them.
      clearTimeout(sweepTimer);
      if (running) {
        running.cancelled = true;
        running.controller.abort();
      }
      handles.clear();
      for (const id of files.keys())
        fs.rmSync(path.join(artifactDir, id), { force: true });
      files.clear();
    },
  };
  async function runBatch(authorize, client, input, definition, signal) {
    const startedAt = now(),
      ids = input.items.map((_, index) => batchItemId(input.requestId, index)),
      known = (index) => ledger.has(`${client.id}:${ids[index]}`),
      outcomes = [],
      tabs = [];
    const failed = (error) => ({
      status: "stopped",
      code: error.code || error.kind || "stopped",
      error: String(error.message).slice(0, 500),
    });
    let appPath = null;
    const browser = async () => {
      if (appPath) return appPath;
      const candidates = (await browserApps(authorize)).filter(
        (app) => app.name === input.browser,
      );
      if (candidates.length !== 1)
        throw problem(
          "browser_access",
          "Choose exactly one installed, allowed copy of this browser.",
          403,
        );
      return (appPath = candidates[0].id);
    };
    // The browser for this batch alone: no tool runs meanwhile, and the
    // owner removing the agent's access cancels it.
    const exclusive = async (work) => {
      const app = await browser();
      if (running)
        throw Object.assign(fail(409, "Another tool is running on this Mac."), {
          kind: "busy",
        });
      const controller = new AbortController(),
        cancel = () => controller.abort();
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) controller.abort();
      running = { id: definition.id, clientId: client.id, cancelled: false, controller };
      try {
        return await desktop.withBrowser(
          client,
          app,
          () => check(authorize),
          (nativeGuard, launch) =>
            work({
              guard: async () => {
                if (controller.signal.aborted)
                  throw problem(
                    "access_changed",
                    "Tool access changed or the owner cancelled this run.",
                    403,
                  );
                await nativeGuard();
              },
              launch,
              native: (request) =>
                driver.transport(input.browser, request, {
                  appPath: app,
                  signal: controller.signal,
                  timeoutMs: 12000,
                }),
              signal: controller.signal,
            }),
        );
      } finally {
        running = null;
        signal?.removeEventListener("abort", cancel);
      }
    };
    // Items not yet run whose tool starts on a page: their tabs first.
    const opening = [];
    if (definition.steps[0].op === "navigate")
      input.items.forEach((values, index) => {
        if (known(index)) return;
        try {
          const url = checkURL(
            resolveToolValue(
              definition.steps[0].url,
              toolInputs(definition, values),
              {},
            ),
            definition, client,
          );
          opening.push({ index, url });
        } catch (error) {
          outcomes[index] = failed(error);
        }
      });
    // The windows the items' handles live in, or the front one.
    const windows = new Set();
    input.items.forEach((values, index) => {
      if (known(index)) return;
      for (const [name, field] of Object.entries(definition.inputs))
        if (field.type === "handle" && typeof values[name] === "string") {
          const handle = handles.get(values[name]);
          if (handle?.clientId === client.id) windows.add(handle.target.window);
        }
    });
    let stop = null;
    if (opening.length || windows.size)
      try {
        await exclusive(async ({ guard, launch, native, signal: abort }) => {
          const preflight = async (window) => {
            await guard();
            const ready = await native({
              op: "preflight",
              probeId: crypto.randomUUID(),
              background: true,
              ...(window === undefined ? {} : { window }),
            });
            if (ready?.ok !== true)
              throw problem(
                "setup_required",
                "The browser’s scripting setup could not be verified.",
              );
          };
          if (opening.length)
            try {
              await preflight();
            } catch (error) {
              if (error.code !== "browser_closed" || !launch) throw error;
              await guard();
              await launch();
              await preflight();
            }
          for (const window of windows) await preflight(window);
          // Tabs past their time close first, any agent's: room before more open.
          await closeTabs(
            [...batchTabs.values()].filter(
              (entry) => entry.until <= now() && entry.appPath === appPath,
            ),
            appPath,
            { guard, signal: abort },
          );
          // A retry's items go back to the tabs an earlier call opened for them.
          const earlier = (index) =>
            [...batchTabs.values()].find(
              (entry) => entry.clientId === client.id && entry.item === ids[index],
            );
          let open = new Map();
          if (opening.some(({ index }) => earlier(index))) {
            await guard();
            open = new Map(
              (await native({ op: "tabs" })).map((tab) => [tabKey(tab), tab]),
            );
          }
          for (const { index, url } of opening) {
            const entry = earlier(index);
            if (entry) {
              const tab = open.get(tabKey(entry));
              let origin = null;
              try {
                origin = new URL(tab.url).origin;
              } catch {}
              if (tab && definition.origins.includes(origin)) {
                tabs[index] = { ...tab };
                entry.until = now() + BATCH_TAB_MS;
                continue;
              }
              // Gone, or it left the tool's sites: the owner's now.
              batchTabs.delete(tabKey(entry));
              saveTabs();
            }
            if (batchTabs.size >= BATCH_TABS) {
              outcomes[index] = {
                status: "not_started",
                code: "tab_limit",
                error: `Reach already has ${BATCH_TABS} agent tabs open. They close when the batch that uses them ends, or within ${BATCH_TAB_MS / 60000} minutes.`,
              };
              continue;
            }
            await guard();
            const tab = await native({ op: "create", url, background: true });
            // The address it was opened with: the item's run waits there
            // for the page instead of reading a half-started tab.
            tabs[index] = { ...tab, url };
            batchTabs.set(tabKey(tab), {
              clientId: client.id,
              appPath,
              origins: definition.origins,
              window: tab.window,
              tab: tab.tab,
              url,
              item: ids[index],
              until: now() + BATCH_TAB_MS,
              attempts: 0,
            });
            saveTabs();
          }
        });
      } catch (error) {
        stop = failed(error);
        if (error.code === "setup_required")
          onSetupRequired(input.browser, client.name);
      }
    let ran = 0,
      started = false,
      loading = 0;
    for (const [index, values] of input.items.entries()) {
      if (outcomes[index]) continue;
      // Every call moves at least one item forward.
      if (!known(index) && (stop || signal?.aborted || (started && now() - startedAt >= batchMs))) {
        outcomes[index] = stop
          ? { ...stop, status: "not_started" }
          : { status: "not_started" };
        continue;
      }
      const fresh = !known(index);
      started ||= fresh;
      try {
        const result = await api.run(
          authorize,
          { id: input.id, browser: input.browser, requestId: ids[index], values },
          { signal, tab: tabs[index] || null, background: true },
        );
        if (fresh) ran++;
        outcomes[index] = {
          status: result.status,
          completedSteps: result.completedSteps,
          totalSteps: result.totalSteps,
          ...(result.code ? { code: result.code, error: result.error } : {}),
          ...(result.data ? { data: result.data } : {}),
        };
      } catch (error) {
        // Refused before it started (busy, access): nothing happened yet.
        outcomes[index] = known(index)
          ? failed(error)
          : { ...failed(error), status: "not_started" };
      }
      if (fresh && outcomes[index].code === "loading") loading++;
      // Two pages that never settled on their address: the site rewrites
      // it, and each item left would wait out its load the same way.
      if (fresh && (BATCH_STOPS.includes(outcomes[index].code) || loading >= 2))
        stop = { status: "not_started", code: outcomes[index].code, error: outcomes[index].error };
    }
    // Close the tabs Reach opened for these items, unless the agent keeps
    // them for the handles they hold. Only Reach's own tabs, only while
    // they're still on the tool's sites, and only for items that finished
    // or never started: a stopped or uncertain item's tab is the owner's
    // and the agent's to inspect.
    const itemTabs = input.items.map((values, index) => {
      const used = tabs[index] ? [tabs[index]] : [];
      for (const [name, field] of Object.entries(definition.inputs))
        if (field.type === "handle" && typeof values[name] === "string") {
          const handle = handles.get(values[name]);
          if (handle?.clientId === client.id) used.push(handle.target);
        }
      return used.filter(
        (tab) => batchTabs.get(tabKey(tab))?.clientId === client.id,
      );
    });
    const settled = (index) => ["completed", "not_started"].includes(outcomes[index].status);
    const left = outcomes.filter((item) => item.status === "not_started").length;
    const kept = new Set(),
      closing = new Map();
    itemTabs.forEach((used, index) => {
      if (used.length && (input.keepTabs || !settled(index))) kept.add(index);
    });
    // A tab a kept item still uses stays open too.
    const keep = new Set([...kept].flatMap((index) => itemTabs[index].map(tabKey)));
    itemTabs.forEach((used, index) => {
      if (!kept.has(index))
        for (const tab of used) if (!keep.has(tabKey(tab))) closing.set(tabKey(tab), tab);
    });
    // Kept tabs close on their own once their handles have expired.
    for (const index of kept)
      for (const tab of itemTabs[index]) {
        const entry = batchTabs.get(tabKey(tab));
        if (entry) entry.until = now() + BATCH_TAB_MS;
      }
    // The rest are due now: what can't close here, the sweep closes.
    for (const key of closing.keys()) {
      const entry = batchTabs.get(key);
      if (entry) entry.until = now();
    }
    saveTabs();
    let closedTabs = 0;
    // Closing waits for nothing: past the budget, the sweep closes them.
    if (closing.size && now() - startedAt < batchMs + 25000)
      try {
        closedTabs = await exclusive(({ guard, signal: abort }) =>
          closeTabs(
            [...closing.keys()].map((key) => batchTabs.get(key)).filter(Boolean),
            appPath,
            { guard, signal: abort },
          ),
        );
      } catch {
        /* paused or busy: the sweep closes them */
      }
    // Round trips the agent didn't make: about one tool call per item.
    if (ran > 1)
      savings?.record({ agent: "browser", kind: "tab-batch", tokens: (ran - 1) * 300, count: ran });
    record(
      "agent",
      `${client.name} ran ${definition.title} on ${input.items.length} tabs`,
    );
    return {
      protocol: TOOL_PROTOCOL,
      id: definition.id,
      requestId: input.requestId,
      browser: input.browser,
      status: outcomes.every((item) => item.status === "completed")
        ? "completed"
        : left || outcomes.some((item) => item.status === "completed")
          ? "partial"
          : "stopped",
      items: outcomes.map((item, index) => ({ index, requestId: ids[index], ...item })),
      tabsClosed: closedTabs,
      // The items whose tabs are still open, for their handles or to inspect.
      ...(kept.size ? { tabsKept: [...kept] } : {}),
      ...(left
        ? {
            next: "Call again with the same requestId and items to run the rest; finished items are never repeated.",
          }
        : {}),
    };
  }
  return api;
}

export function agentToolRoutes(app, { tools }) {
  const agent = (req) => () => req.reauthorize();
  const owner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only the owner can manage saved tools.");
  };
  app.get("/api/browser/tools", async (req, res) => {
    if (Object.keys(req.query).some((key) => !["query", "detail", "id"].includes(key)) || (req.query.detail !== undefined && !["true", "false"].includes(req.query.detail)) || (req.query.id !== undefined && (typeof req.query.id !== "string" || req.query.id.length > 48)))
      throw fail(400, "Search only by task name.");
    const result = await tools.catalog(agent(req), req.query.query || "");
    if (req.query.id) result.tools = result.tools.filter(tool => tool.id === req.query.id);
    if (req.query.detail !== "true" && !req.query.id) result.tools = result.tools.map(({ protocol, id, title, description, inputs }) => ({ protocol, id, title, description, inputs, tool: `reach_tool_${id}` }));
    res.json(result);
  });
  app.get("/api/browser/tools/protocol", (req, res) =>
    res.json(tools.protocol(agent(req))),
  );
  app.post("/api/browser/tools/define", async (req, res) =>
    res
      .status(201)
      .json(
        await tools.define(agent(req), body(req, ["definition"]).definition),
      ),
  );
  app.post("/api/browser/tools/run", async (req, res) => {
    const result = await tools.run(
      agent(req),
      body(req, ["id", "browser", "requestId", "values"]),
    );
    try {
      req.reauthorize();
    } catch (error) {
      // A finished run's result must not be lost because access lapsed mid-run.
      if (result?.status !== "completed") throw error;
    }
    res.json(result);
  });
  app.post("/api/browser/tools/batch", async (req, res) => {
    const result = await tools.batch(
      agent(req),
      body(req, ["id", "browser", "requestId", "items", "keepTabs"]),
    );
    try {
      req.reauthorize();
    } catch (error) {
      // Finished items' results must not be lost because access lapsed mid-batch.
      if (!result?.items?.some((item) => item.status === "completed")) throw error;
    }
    res.json(result);
  });
  app.get("/api/browser/tools/operations/:requestId", (req, res) =>
    res.json(tools.operation(agent(req), req.params.requestId)),
  );
  app.get("/api/agents/tools", (req, res) => {
    owner(req);
    res.json({ tools: tools.inspect() });
  });
  app.patch("/api/agents/tools/:id", (req, res) => {
    owner(req);
    res.json(tools.update(req.params.id, body(req, ["enabled"]).enabled));
  });
  app.delete("/api/agents/tools/:id", (req, res) => {
    owner(req);
    res.json(tools.remove(req.params.id));
  });
}
