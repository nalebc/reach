import fs from "node:fs";
import { actionWords } from "./agent-actions.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { atomicJson, browserIdleEnded, fail, isPlainRecord } from "./core.mjs";
import { normalizeAction } from "./agent-desktop.mjs";
import { hiddenControls, protectedAppReason } from "./agent-guard.mjs";

const MAX_STEPS = 60,
  MAX_SHORTCUTS = 100;
const copy = (value) => structuredClone(value);
const busy = () =>
  Object.assign(
    fail(
      409,
      "A shortcut or recorded action is already running. Wait for it to finish.",
    ),
    { kind: "busy", retryInMs: 500 },
  );
const text = (value, max) =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= max &&
  !hiddenControls.test(value);
const identifier = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const browserBundle = (value) =>
  /^(com\.apple\.Safari|com\.google\.Chrome|org\.chromium|org\.mozilla\.firefox|com\.microsoft\.edgemac|com\.brave\.Browser|company\.thebrowser|com\.operasoftware|com\.vivaldi|com\.duckduckgo|com\.kagi)(\.|$)/i.test(
    value,
  );
// Only an origin landing page is inferred as reusable navigation. Paths may
// contain authentication tokens too; keep them as per-run inputs.
const website = (value, originOnly = true) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      (!originOnly || url.pathname === "/")
      ? url.href
      : null;
  } catch {
    return null;
  }
};
const addressKey = (action) =>
  action.type === "key" &&
  action.key === "l" &&
  action.modifiers?.length === 1 &&
  ["cmd", "command", "meta"].includes(action.modifiers[0]);
const printableKey = (action) =>
  action.type === "key" &&
  typeof action.key === "string" &&
  (action.key.length === 1 || action.key === "space") &&
  !action.modifiers?.some((mod) =>
    ["cmd", "command", "meta", "control", "ctrl"].includes(mod),
  );
const rawContext = (front) => ({
  bundle: front.bundle,
  title: front.title || "",
  layout: front.layout || "",
});
const context = (front) => ({
  bundle: front.bundle,
  fingerprint: crypto
    .createHash("sha256")
    .update(JSON.stringify([front.title || "", front.layout || ""]))
    .digest("hex"),
});
const matches = (front, expected) => {
  const current = context(front);
  return (
    current.bundle === expected.bundle &&
    current.fingerprint === expected.fingerprint
  );
};

/** Local recipes, captured only while explicitly recording. No images, passwords or literal form text. */
export function createAgentShortcuts({
  dataDir,
  desktop,
  record = () => {},
  // The owner's log of what each agent did (agent-actions.mjs add).
  actions = () => {},
  now = Date.now,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const file = path.join(dataDir, "agent-shortcuts.json");
  let saved = [];
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(raw) > 2 * 1024 * 1024)
      throw fail(500, "Saved shortcuts exceed their storage limit.");
    saved = JSON.parse(raw);
    if (!Array.isArray(saved) || saved.length > MAX_SHORTCUTS)
      throw fail(500, "Saved shortcuts could not be read.");
    // Migrate prior recordings without losing IDs, steps or owner disable state.
    // Sensitive literal material becomes a fingerprint or a required run input.
    for (const item of saved) validateSaved(item, { legacy: true });
    const migrated = saved.map(migrateSaved);
    for (const item of migrated) validateSaved(item);
    if (JSON.stringify(migrated) !== JSON.stringify(saved))
      atomicJson(file, migrated);
    saved = migrated;
  }
  const recordings = new Map(),
    inputs = new Set();
  let running = null,
    closed = false;
  const persist = (next) => {
    if (Buffer.byteLength(JSON.stringify(next)) > 2 * 1024 * 1024)
      throw fail(
        400,
        "Shortcut storage is full. Delete an unused shortcut first.",
      );
    atomicJson(file, next);
    saved = next;
  };
  const check = (authorize) => {
    if (closed) throw fail(503, "Reach is shutting down.");
    const client = authorize();
    if (
      client.kind !== "agent" ||
      (client.status && client.status !== "accepted") ||
      client.expiresAt <= now() ||
      browserIdleEnded(client, now()) ||
      !["full", "apps"].includes(client.policy?.preset) ||
      !client.scopes?.includes("browser:control") ||
      !client.scopes.includes("browser:open") ||
      !client.scopes.includes("browser:screen")
    )
      throw fail(403, "Shortcuts need an active agent with app control.");
    if (!desktop)
      throw fail(503, "App control is unavailable on this computer.");
    return client;
  };
  const permitted = (item, client) =>
    item.steps.every((step) => {
      const app =
        step.type === "open" || step.type === "website"
          ? { id: step.app, bundleId: step.bundle }
          : { bundleId: step.context.bundle };
      return (
        !protectedAppReason(app) &&
        !(client.policy.hidden || []).some(
          (entry) => entry.id === app.id || entry.bundleId === app.bundleId,
        ) &&
        (client.policy.preset === "full" ||
          client.policy.apps?.some(
            (entry) =>
              entry.bundleId === app.bundleId &&
              (!app.id || entry.id === app.id),
          ))
      );
    });
  const prune = () => {
    for (const [id, entry] of recordings)
      if (entry.expiresAt <= now() || now() - entry.startedAt > 30 * 60000)
        recordings.delete(id);
  };
  const status = (entry) => ({
    clientId: entry.clientId,
    name: entry.name,
    startedAt: entry.startedAt,
    stepCount: entry.steps.length,
    error: entry.error || "",
    steps: copy(entry.steps),
  });
  const lock = async (clientId, work) => {
    if (running || inputs.has(clientId)) throw busy();
    inputs.add(clientId);
    try {
      return await work();
    } finally {
      inputs.delete(clientId);
    }
  };
  const capture = async (client, action, authorize, operation) =>
    lock(client.id, async () => {
      prune();
      const entry = recordings.get(client.id);
      // A password is never part of a saved tool.
      if (!entry || entry.error || action.secret || action.fields?.some((field) => field.secret)) return operation();
      // A label number belongs to one look at the screen; a saved tool
      // replayed later can't aim with it.
      if (action.type === "element" || action.type === "fill") {
        entry.error = action.type === "fill"
          ? "Recording stopped: form fills can't be replayed yet. Discard it and record with clicks and Type."
          : "Recording stopped: label clicks can't be replayed. Discard it and record with clicks on the picture.";
        return operation();
      }
      // Read before the action, append only after its confirmed success.
      let front;
      if (action.type !== "open")
        front = await desktop.front(client, authorize).catch(() => undefined);
      const result = await operation();
      if (recordings.get(client.id) !== entry) return result;
      try {
        check(authorize);
        if (entry.steps.length >= MAX_STEPS)
          throw fail(
            400,
            "Recording reached 60 steps. Discard it and record a shorter task.",
          );
        const delayMs = Math.max(0, Math.min(1500, now() - entry.lastAt));
        if (action.type === "open") {
          if (!text(result.bundle, 200))
            throw fail(409, "The app identity could not be recorded.");
          entry.steps.push({
            type: "open",
            app: action.app,
            bundle: result.bundle,
            delayMs,
          });
        } else {
          if (
            !front?.bundle ||
            front.blocked ||
            front.secure ||
            (result.bundle && result.bundle !== front.bundle)
          )
            throw fail(
              409,
              "Recording stopped at a protected field or a different app. Discard and record each app separately.",
            );
          if (printableKey(action))
            throw fail(
              409,
              "Recording stopped before saving a text-producing key. Use Type for form text so it becomes an input, then record again.",
            );
          const before = entry.steps.at(-2),
            last = entry.steps.at(-1);
          // Turn Cmd+L, a plain HTTPS address, Enter into a stable navigation step.
          if (
            action.type === "key" &&
            ["enter", "return"].includes(action.key) &&
            !action.modifiers?.length &&
            before?.type === "action" &&
            addressKey(before.action) &&
            last?.type === "input" &&
            entry.pendingUrl &&
            before.context.bundle === front.bundle &&
            last.context.bundle === front.bundle &&
            browserBundle(front.bundle)
          ) {
            const app =
              front.path ||
              [...entry.steps]
                .reverse()
                .find(
                  (step) =>
                    step.type === "open" && step.bundle === front.bundle,
                )?.app;
            if (app) {
              entry.steps.splice(-2, 2, {
                type: "website",
                app,
                bundle: front.bundle,
                url: entry.pendingUrl,
                delayMs: before.delayMs,
              });
              entry.pendingUrl = null;
              entry.lastAt = now();
              return result;
            }
          }
          entry.pendingUrl =
            action.type === "type" &&
            last?.type === "action" &&
            addressKey(last.action)
              ? website(action.text)
              : null;
          if (action.type === "type")
            entry.steps.push({
              type: "input",
              input: `text${++entry.inputCount}`,
              context: context(front),
              delayMs,
            });
          else
            entry.steps.push({
              type: "action",
              action: copy(action),
              context: context(front),
              delayMs,
            });
        }
        entry.lastAt = now();
      } catch (error) {
        entry.error = error.message;
      }
      return result;
    });
  const api = {
    act: (client, action, authorize) => {
      const normalized = normalizeAction(action);
      return capture(client, normalized, authorize, () =>
        desktop.act(client, normalized, authorize),
      );
    },
    open: (client, app, authorize) =>
      capture(client, { type: "open", app }, authorize, () =>
        desktop.open(client, app, authorize),
      ),
    ownerList() {
      prune();
      return {
        shortcuts: copy(saved),
        recordings: [...recordings.values()].map(status),
        running: running ? copy(running) : null,
      };
    },
    list(authorize, query = "") {
      const client = check(authorize);
      prune();
      if (
        typeof query !== "string" ||
        query.length > 160 ||
        hiddenControls.test(query)
      )
        throw fail(400, "Search by a shortcut's task name.");
      const needle = query.trim().toLowerCase();
      const found = saved.filter(
        (item) =>
          item.enabled &&
          permitted(item, client) &&
          (!needle || item.name.toLowerCase().includes(needle)),
      );
      return {
        shortcuts: copy(
          found.slice(0, needle ? 10 : MAX_SHORTCUTS).map((item) =>
            needle
              ? item
              : {
                  id: item.id,
                  name: item.name,
                  stepCount: item.steps.length,
                  inputs: item.steps
                    .filter((step) => step.input)
                    .map((step) => step.input),
                  apps: [
                    ...new Set(
                      item.steps.map(
                        (step) => step.bundle || step.context?.bundle,
                      ),
                    ),
                  ],
                },
          ),
        ),
        more: needle && found.length > 10,
        recording: recordings.has(client.id)
          ? status(recordings.get(client.id))
          : null,
      };
    },
    start(authorize, name) {
      const client = check(authorize);
      prune();
      if (running || inputs.has(client.id)) throw busy();
      if (!text(name, 80))
        throw fail(400, "Name this shortcut in up to 80 characters.");
      if (recordings.has(client.id))
        throw fail(
          409,
          "Save or discard this agent's current recording first.",
        );
      if (recordings.size >= 8)
        throw fail(429, "Finish another recording first.");
      const entry = {
        clientId: client.id,
        name: name.trim(),
        startedAt: now(),
        lastAt: now(),
        expiresAt: client.expiresAt,
        steps: [],
        inputCount: 0,
      };
      recordings.set(client.id, entry);
      record("agent", `${client.name} started recording a shortcut`);
      return status(entry);
    },
    save(authorize) {
      const client = check(authorize);
      if (inputs.has(client.id) || running) throw busy();
      prune();
      const entry = recordings.get(client.id);
      if (!entry) throw fail(404, "There is no recording for this agent.");
      if (entry.error) throw fail(409, entry.error);
      if (!entry.steps.length)
        throw fail(400, "Record at least one successful action first.");
      const item = {
        id: crypto.randomUUID(),
        name: entry.name,
        createdAt: now(),
        enabled: true,
        steps: copy(entry.steps),
      };
      validateSaved(item);
      if (!permitted(item, client))
        throw fail(
          403,
          "This recording includes apps outside your current access.",
        );
      // Re-learning a task keeps its ID stable, including the owner's disable.
      const bundles = (value) =>
        [
          ...new Set(
            value.steps.map((step) => step.bundle || step.context?.bundle),
          ),
        ]
          .sort()
          .join("|");
      const previous = saved.find(
        (entry) =>
          entry.name.toLowerCase() === item.name.toLowerCase() &&
          bundles(entry) === bundles(item),
      );
      if (previous) {
        item.id = previous.id;
        item.createdAt = previous.createdAt;
        item.enabled = previous.enabled;
      }
      if (!previous && saved.length >= MAX_SHORTCUTS)
        throw fail(400, "Delete a shortcut before saving another (limit 100).");
      persist(
        previous
          ? saved.map((entry) => (entry.id === item.id ? item : entry))
          : [...saved, item],
      );
      recordings.delete(client.id);
      record("agent", `${client.name} saved a shortcut`);
      return copy(item);
    },
    discard(clientId) {
      if (inputs.has(clientId)) throw busy();
      recordings.delete(clientId);
      return { ok: true };
    },
    update(id, enabled) {
      if (typeof enabled !== "boolean")
        throw fail(400, "Choose whether this shortcut is enabled.");
      if (!saved.some((item) => item.id === id))
        throw fail(404, "Shortcut not found.");
      persist(
        saved.map((item) => (item.id === id ? { ...item, enabled } : item)),
      );
      if (!enabled && running?.id === id) running.cancelled = true;
      return { ok: true };
    },
    remove(id) {
      if (!saved.some((item) => item.id === id))
        throw fail(404, "Shortcut not found.");
      persist(saved.filter((item) => item.id !== id));
      if (running?.id === id) running.cancelled = true;
      return { ok: true };
    },
    async run(authorize, id, values = {}) {
      const client = check(authorize);
      if (running || inputs.size) throw busy();
      if (recordings.has(client.id))
        throw fail(
          409,
          "Save or discard this agent's recording before replaying a shortcut.",
        );
      const item = saved.find((entry) => entry.id === id && entry.enabled);
      if (!item || !permitted(item, client))
        throw fail(
          403,
          "This shortcut is disabled or outside this agent's app access.",
        );
      const required = item.steps
        .filter((step) => step.input)
        .map((step) => step.input);
      if (
        !isPlainRecord(values) ||
        Object.keys(values).some((key) => !required.includes(key)) ||
        required.some((key) => !text(values[key], 2000))
      )
        throw fail(
          400,
          `Supply the shortcut's text inputs: ${required.join(", ") || "none"}.`,
        );
      const fingerprint = JSON.stringify([
        client.id,
        client.policy,
        client.scopes,
        client.expiresAt,
      ]);
      const current = () => {
        const latest = check(authorize);
        if (now() - startedAt > 25000)
          throw fail(
            408,
            "Shortcut reached its time limit. Record a shorter sequence.",
          );
        if (
          running?.cancelled ||
          !saved.find((entry) => entry.id === id && entry.enabled) ||
          fingerprint !==
            JSON.stringify([
              latest.id,
              latest.policy,
              latest.scopes,
              latest.expiresAt,
            ])
        )
          throw fail(
            403,
            "Shortcut stopped because its access changed, it was disabled, or it was cancelled.",
          );
        return latest;
      };
      running = {
        runId: crypto.randomUUID(),
        id,
        clientId: client.id,
        name: item.name,
        completedSteps: 0,
        totalSteps: item.steps.length,
      };
      const startedAt = now();
      const act = async (action, expected) => {
        current();
        return desktop.act(client, action, current, { expected });
      };
      try {
        for (const [index, step] of item.steps.entries()) {
          current();
          if (now() - startedAt > 25000)
            throw fail(
              408,
              "Shortcut reached its time limit. Record a shorter sequence.",
            );
          if (step.delayMs) await wait(step.delayMs);
          current();
          if (step.type === "open")
            await desktop.open(client, step.app, current);
          else if (step.type === "website") {
            await desktop.open(client, step.app, current);
            await act(
              { type: "key", key: "l", modifiers: ["cmd"] },
              { bundle: step.bundle },
            );
            await act(
              { type: "type", text: step.url ?? values[step.input] },
              { bundle: step.bundle },
            );
            await act({ type: "key", key: "enter" }, { bundle: step.bundle });
          } else {
            // Wait briefly for the recorded page/window to settle. No blind retries of inputs.
            let front;
            for (let attempt = 0; attempt < 8; attempt++) {
              current();
              front = await desktop.front(client, current);
              if (matches(front, step.context) || front.secure || front.blocked)
                break;
              await wait(200);
            }
            if (front.secure || front.blocked || !matches(front, step.context))
              throw fail(
                409,
                "The app, window or focused field changed. Look at the screen and continue with the agent.",
              );
            await act(
              step.type === "input"
                ? { type: "type", text: values[step.input] }
                : step.action,
              rawContext(front),
            );
          }
          current();
          running.completedSteps = index + 1;
        }
        record("agent", `${client.name} completed a shortcut`);
        actions(client, { kind: "shortcut", text: actionWords("shortcut", { name: item.name }) });
        return {
          status: "completed",
          id,
          completedSteps: item.steps.length,
          totalSteps: item.steps.length,
        };
      } catch (error) {
        record("agent", `${client.name}'s shortcut stopped`);
        actions(client, { kind: "shortcut", text: actionWords("shortcut", { name: item.name }), ok: false, reason: String(error?.message || "Stopped").slice(0, 300) });
        return {
          status: "stopped",
          id,
          completedSteps: running.completedSteps,
          totalSteps: item.steps.length,
          error: error.message,
          ...(error.kind ? { kind: error.kind } : {}),
        };
      } finally {
        running = null;
      }
    },
    cancel(runId) {
      if (runId !== undefined && running?.runId !== runId)
        throw fail(
          409,
          "That shortcut run ended or changed. Refresh before stopping the current run.",
        );
      if (running) running.cancelled = true;
      return { ok: true };
    },
    cancelClient(id) {
      recordings.delete(id);
      if (running?.clientId === id) running.cancelled = true;
    },
    close() {
      closed = true;
      recordings.clear();
      if (running) running.cancelled = true;
    },
  };
  return api;
}

function migrateSaved(item) {
  const result = copy(item);
  let nextInput = Math.max(
    0,
    ...result.steps.map((step) =>
      /^text[1-9][0-9]*$/.test(step.input || "")
        ? Number(step.input.slice(4))
        : 0,
    ),
  );
  const input = () => `text${++nextInput}`;
  for (const step of result.steps) {
    if (step.context && !step.context.fingerprint)
      step.context = context(step.context);
    if (step.type === "website" && step.url && !website(step.url)) {
      delete step.url;
      step.input = input();
    } else if (step.type === "action" && printableKey(step.action)) {
      delete step.action;
      step.type = "input";
      step.input = input();
    }
  }
  return result;
}

function validateSaved(item, { legacy = false } = {}) {
  if (
    !isPlainRecord(item) ||
    !identifier(item.id) ||
    !text(item.name, 80) ||
    !Number.isFinite(item.createdAt) ||
    typeof item.enabled !== "boolean" ||
    !Array.isArray(item.steps) ||
    !item.steps.length ||
    item.steps.length > MAX_STEPS ||
    Object.keys(item).some(
      (key) => !["id", "name", "createdAt", "enabled", "steps"].includes(key),
    )
  )
    throw fail(400, "Invalid saved shortcut.");
  const inputs = new Set();
  for (const step of item.steps) {
    if (
      !isPlainRecord(step) ||
      !Number.isInteger(step.delayMs) ||
      step.delayMs < 0 ||
      step.delayMs > 1500
    )
      throw fail(400, "Invalid shortcut step.");
    if (["open", "website"].includes(step.type)) {
      if (
        !text(step.app, 4096) ||
        !path.isAbsolute(step.app) ||
        !step.app.endsWith(".app") ||
        !text(step.bundle, 200)
      )
        throw fail(400, "Invalid shortcut app.");
      if (
        step.type === "website" &&
        (!browserBundle(step.bundle) ||
          (step.input !== undefined
            ? step.url !== undefined ||
              !/^text[1-9][0-9]*$/.test(step.input) ||
              inputs.has(step.input)
            : typeof step.url !== "string" ||
              website(step.url, !legacy) !== step.url))
      )
        throw fail(400, "Invalid shortcut website.");
      if (step.input) inputs.add(step.input);
    } else {
      if (
        !isPlainRecord(step.context) ||
        !text(step.context.bundle, 200) ||
        !(
          (typeof step.context.fingerprint === "string" &&
            /^[a-f0-9]{64}$/.test(step.context.fingerprint) &&
            Object.keys(step.context).every((key) =>
              ["bundle", "fingerprint"].includes(key),
            )) ||
          (legacy &&
            typeof step.context.title === "string" &&
            step.context.title.length <= 200 &&
            typeof step.context.layout === "string" &&
            step.context.layout.length <= 2000 &&
            Object.keys(step.context).every((key) =>
              ["bundle", "title", "layout"].includes(key),
            ))
        )
      )
        throw fail(400, "Invalid shortcut context.");
      if (step.type === "input") {
        if (!/^text[1-9][0-9]*$/.test(step.input) || inputs.has(step.input))
          throw fail(400, "Invalid shortcut text input.");
        inputs.add(step.input);
      } else if (step.type === "action") {
        if (
          step.action?.type === "type" ||
          (!legacy && printableKey(step.action || {}))
        )
          throw fail(
            400,
            "Saved text must be supplied when the shortcut runs.",
          );
        normalizeAction(step.action);
      } else throw fail(400, "Invalid shortcut step type.");
    }
    const allowed =
      step.type === "open"
        ? ["type", "app", "bundle", "delayMs"]
        : step.type === "website"
          ? ["type", "app", "bundle", "url", "input", "delayMs"]
          : step.type === "input"
            ? ["type", "input", "context", "delayMs"]
            : ["type", "action", "context", "delayMs"];
    if (Object.keys(step).some((key) => !allowed.includes(key)))
      throw fail(400, "Unexpected shortcut step field.");
  }
}

export function agentShortcutRoutes(app, { shortcuts }) {
  const owner = (req) => {
    const client = req.reauthorize();
    if (client.kind !== "device" || !client.scopes.includes("admin"))
      throw fail(403, "Only the owner manages saved shortcuts.");
    return client;
  };
  const body = (req, keys) => {
    const input =
      req.method === "DELETE" && req.body === undefined ? {} : req.body;
    if (
      !isPlainRecord(input) ||
      Object.keys(input).some((key) => !keys.includes(key))
    )
      throw fail(400, "Unexpected shortcut arguments.");
    return input;
  };
  app.get("/api/agents/shortcuts", (req, res) => {
    owner(req);
    res.json(shortcuts.ownerList());
  });
  app.patch("/api/agents/shortcuts/:id", (req, res) => {
    owner(req);
    res.json(shortcuts.update(req.params.id, body(req, ["enabled"]).enabled));
  });
  app.delete("/api/agents/shortcuts/:id", (req, res) => {
    owner(req);
    res.json(shortcuts.remove(req.params.id));
  });
  app.post("/api/agents/shortcuts/cancel", (req, res) => {
    owner(req);
    const input = body(req, ["runId"]);
    if (typeof input.runId !== "string" || !/^[a-f0-9-]{36}$/.test(input.runId))
      throw fail(400, "Choose the current shortcut run to stop.");
    res.json(shortcuts.cancel(input.runId));
  });
  app.get("/api/browser/shortcuts", (req, res) => {
    if (Object.keys(req.query).some((key) => key !== "query"))
      throw fail(400, "Search only by task name.");
    res.json(shortcuts.list(() => req.reauthorize(), req.query.query));
  });
  app.post("/api/browser/shortcuts/record", (req, res) =>
    res
      .status(201)
      .json(shortcuts.start(() => req.reauthorize(), body(req, ["name"]).name)),
  );
  app.delete("/api/browser/shortcuts/record", (req, res) => {
    body(req, []);
    res.json(shortcuts.discard(req.reauthorize().id));
  });
  app.post("/api/browser/shortcuts/save", (req, res) => {
    body(req, []);
    res.status(201).json(shortcuts.save(() => req.reauthorize()));
  });
  app.post("/api/browser/shortcuts/run", async (req, res) => {
    const input = body(req, ["id", "values"]);
    res.json(
      await shortcuts.run(() => req.reauthorize(), input.id, input.values),
    );
  });
}
