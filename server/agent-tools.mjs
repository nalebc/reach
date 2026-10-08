import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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
const safeName = (value) =>
  String(value || "attachment")
    .replace(/[\u0000-\u001f\u007f/\\]/g, "_")
    .slice(0, 150) || "attachment";
const privateTitles = [...PROTECTED_TITLE_WORDS, ...PROTECTED_APP_NAMES];
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
    driver = createToolBrowserDriver(),
    record = () => {},
    hosts = () => [],
    now = Date.now,
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    waitMs = 8000,
    runMs = TOOL_LIMITS.runMs,
    pdf = async (value, options) =>
      nativeToolProcess(
        await desktopBinary(config, "tool-receipt", { signal: options.signal }),
        [],
        JSON.stringify({ text: value.text, source: value.url }),
        options,
      ),
  } = {},
) {
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
    !(client.policy.hidden || []).some(
      (hidden) => hidden.id === app.id || hidden.bundleId === app.bundleId,
    ) &&
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
    if (files.size >= 30)
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
  const checkURL = (value, definition) => {
    const origin = toolOrigin(value);
    if (!definition.origins.includes(origin))
      throw problem(
        "wrong_site",
        "The page left this tool's declared websites. Sign in yourself if the browser needs it.",
      );
    const url = new URL(value),
      key = `${url.hostname.toLowerCase()}:${url.port}`;
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
        hint: "Check reach_tools before using the screen. Pick a named tool and execute it once with a requestId. To create one, read reach_tool_protocol and register the same reach.tool.v1 definition with reach_define_tool.",
      };
    },
    protocol(authorize) {
      check(authorize);
      return protocolDescription();
    },
    async define(authorize, value) {
      const client = check(authorize),
        definition = validateToolDefinition(value);
      definition.origins.forEach((origin) => checkURL(origin, definition));
      if (!(await browserApps(authorize)).length)
        throw fail(
          403,
          "Choose an allowed Chrome or Safari app before defining tools.",
        );
      check(authorize);
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
    async run(authorize, input) {
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
      const hash = digest([
        input.id,
        input.browser,
        Object.fromEntries(
          Object.entries(input.values || {}).sort(([a], [b]) =>
            a.localeCompare(b),
          ),
        ),
      ]);
      if (ledger.has(key)) {
        const prior = ledger.get(key);
        if (prior.hash !== hash)
          throw problem(
            "request_conflict",
            "This requestId was used with different inputs.",
          );
        if (prior.grant !== digest(fp(client)))
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
          checkURL(handle.target.url, definition);
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
      const apps = await browserApps(authorize),
        candidates = apps.filter((app) => app.name === input.browser);
      if (ledger.has(key)) return api.run(authorize, input);
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
      const deadline = setTimeout(() => controller.abort(), runMs);
      deadline.unref();
      running = {
        id: definition.id,
        clientId: client.id,
        cancelled: false,
        controller,
      };
      ledger.set(key, entry);
      persistLedger();
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
            definition,
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
                  protectedTitles: privateTitles,
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
              checkURL(result.url, definition);
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
                checkURL(info.url, definition);
                if (
                  /\/(login|signin|sign-in|challenge|captcha)(\/|$)/i.test(
                    new URL(info.url).pathname,
                  )
                )
                  throw problem(
                    "login_required",
                    "The browser needs you to sign in or complete a verification challenge.",
                  );
                if (
                  protectedTitle(info.title) ||
                  privateTitles.some((word) =>
                    String(info.title || "")
                      .toLowerCase()
                      .includes(word),
                  )
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
                    protectedTitles: privateTitles,
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
              if (step.op === "navigate") {
                const url = checkURL(
                    resolveToolValue(step.url, values, context),
                    definition,
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
                await transport(
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
                await preflight(handle.target.window);
                target = copy(handle.target);
                document = handle.document;
                root = handle.pageRef;
                Object.assign(context, handle.context);
                await page({
                  op: "use",
                  fields: handle.fields,
                  expectedFields: handle.context,
                });
                await transport(
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
                    checkURL(result.nextUrl, definition);
                    await bind(result.nextUrl);
                  }
                }
                if (step.op === "collect") {
                  if (
                    !Array.isArray(result.items) ||
                    result.items.length > 30 ||
                    handles.size + result.items.length > 1000
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
      } finally {
        clearTimeout(deadline);
        persistLedger();
        running = null;
      }
      return copy(results.get(key));
    },
    cancelClient(id) {
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
    if (Object.keys(req.query).some((key) => key !== "query"))
      throw fail(400, "Search only by task name.");
    res.json(await tools.catalog(agent(req), req.query.query || ""));
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
    req.reauthorize();
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
