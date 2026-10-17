import crypto from "node:crypto";
import {
  browserIdleEnded,
  fail,
  isPlainRecord,
  hasReviewControls,
} from "./core.mjs";
import { ServiceConnectorError } from "./service-connectors.mjs";
import { validPresetPolicy } from "./agent-presets.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fingerprint = (client) =>
  JSON.stringify([
    client.id,
    client.policy,
    client.scopes,
    client.expiresAt,
    client.browserBinding,
  ]);
const exact = (value, fields) => {
  if (
    !isPlainRecord(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw fail(400, "Use only the documented service fields.");
  return value;
};
const copy = (value) => structuredClone(value);

/** Full control includes services; narrower presets need service consent.
 * All access dies with the admitted session; no provider secrets reach the agent. */
export function createAgentServices({
  verifyClient,
  connectors = [],
  now = Date.now,
  notify = () => {},
  record = () => {},
  available = () => true,
  paused = () => false,
  runMs = 35000,
} = {}) {
  const providers = new Map(
    connectors.map((connector) => [connector.id, connector]),
  );
  const entries = new Map(),
    runs = new Map();
  let closed = false;
  if (
    providers.size !== connectors.length ||
    connectors.some(
      (connector) =>
        !/^[a-z][a-z0-9_]{0,47}$/.test(connector.id) ||
        !connector.actions.length ||
        connector.actions.some((action) => action.readOnly !== true),
    )
  )
    throw Error(
      "Service connectors must declare unique IDs and read-only actions.",
    );
  const agent = (client) => {
    if (closed) throw fail(503, "Reach is shutting down.");
    if (
      !client ||
      client.kind !== "agent" ||
      (client.status
        ? client.status !== "accepted"
        : client.admission?.status !== "collected") ||
      !Number.isFinite(client.expiresAt) ||
      client.expiresAt <= now() ||
      browserIdleEnded(client, now()) ||
      !client.policy?.browser ||
      !client.policy.preset ||
      !client.scopes?.includes("browser:read")
    )
      throw fail(403, "Services need an active, approved agent connection.");
    return client;
  };
  const owner = (authorize) => {
    const client = authorize();
    if (client?.kind !== "device" || !client.scopes?.includes("admin"))
      throw fail(403, "Only the owner can approve or revoke service access.");
    return client;
  };
  const provider = (id) => {
    const connector = providers.get(id);
    if (!connector) throw fail(404, "This service is not available.");
    return connector;
  };
  const current = (entry) => {
    try {
      return (
        fingerprint(agent(verifyClient(entry.clientId))) === entry.fingerprint
      );
    } catch {
      return false;
    }
  };
  const retire = (entry, status) => {
    entry.status = status;
    for (const [key, run] of runs)
      if (run.grantId === entry.id) {
        run.controller.abort();
        runs.delete(key);
      }
  };
  const prune = () => {
    for (const [id, entry] of entries) {
      if (["pending", "approved"].includes(entry.status)) {
        if (!current(entry)) retire(entry, "revoked");
        else if (entry.expiresAt <= now()) retire(entry, "expired");
      }
      if (
        !["pending", "approved"].includes(entry.status) &&
        entry.createdAt < now() - 86400000
      )
        entries.delete(id);
    }
    for (const [key, run] of runs)
      if (run.until <= now()) {
        run.controller.abort();
        runs.delete(key);
      }
  };
  const view = (entry) => {
    const connector = provider(entry.connectorId);
    return {
      id: entry.id,
      clientId: entry.clientId,
      agentName: entry.agentName,
      connectorId: connector.id,
      serviceName: connector.name,
      transport: connector.transport,
      account: connector.account,
      scopes: [...entry.scopes],
      permissions: [...new Set(connector.actions.map((a) => a.permission))],
      reason: entry.reason,
      status: entry.status,
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      accessExpiresAt: entry.accessExpiresAt,
      approval: entry.approval || "owner",
    };
  };
  const latest = (client, connectorId) =>
    [...entries.values()]
      .reverse()
      .find(
        (entry) =>
          entry.clientId === client.id &&
          entry.connectorId === connectorId &&
          entry.fingerprint === fingerprint(client),
      );
  const fullControl = (client) =>
    client.policy.preset === "full" &&
    validPresetPolicy(client.policy) &&
    client.scopes.includes("browser:shell");
  const accessFor = (client, connector) => {
    let entry = latest(client, connector.id);
    if (
      !fullControl(client) ||
      connector.unavailable?.(client) ||
      ["approved", "denied", "revoked"].includes(entry?.status)
    )
      return entry;
    // The invitation already authorizes this access. Recheck its live grant
    // before publishing it, just as execution does. Explicit revocation stands.
    if (fingerprint(agent(verifyClient(client.id))) !== fingerprint(client))
      throw fail(403, "This agent's access changed. Refresh its services.");
    if (!entry || entry.status === "expired") {
      if (entries.size >= 500)
        throw fail(429, "Too many service requests. Try again later.");
      entry = {
        id: crypto.randomUUID(),
        clientId: client.id,
        agentName: client.name,
        connectorId: connector.id,
        scopes: [...new Set(connector.actions.map((a) => a.scope))],
        fingerprint: fingerprint(client),
        createdAt: now(),
      };
      entries.set(entry.id, entry);
    }
    Object.assign(entry, {
      status: "approved",
      approval: "invitation",
      reason: "Included in the owner's Full control invitation.",
      expiresAt: client.expiresAt,
      accessExpiresAt: client.expiresAt,
    });
    record(
      "agent",
      `${client.name}: ${connector.name} access included in Full control`,
    );
    return entry;
  };
  const api = {
    catalog(authorize) {
      const client = agent(authorize());
      prune();
      return {
        connectors: [...providers.values()].map((connector) => {
          const entry = accessFor(client, connector);
          return {
            id: connector.id,
            name: connector.name,
            description: connector.description,
            transport: connector.transport,
            unavailable: connector.unavailable?.(client) || null,
            account: connector.account,
            access: entry ? view(entry) : null,
            actions: connector.actions.map(
              ({
                id,
                title,
                scope,
                permission,
                readOnly,
                inputSchema,
                example,
                fromResult,
              }) =>
                copy({
                  id,
                  title,
                  scope,
                  permission,
                  readOnly,
                  inputSchema,
                  example,
                  fromResult,
                }),
            ),
          };
        }),
      };
    },
    request(authorize, input) {
      const client = agent(authorize());
      exact(input, ["connectorId", "reason"]);
      const connector = provider(input.connectorId);
      const unavailable = connector.unavailable?.(client);
      if (unavailable) throw fail(403, unavailable);
      if (
        typeof input.reason !== "string" ||
        !input.reason.trim() ||
        input.reason.length > 300 ||
        hasReviewControls(input.reason)
      )
        throw fail(
          400,
          "Explain why this agent needs the service (up to 300 characters).",
        );
      prune();
      const existing = accessFor(client, connector);
      if (existing && ["pending", "approved"].includes(existing.status))
        return view(existing);
      if (
        fullControl(client) &&
        existing &&
        ["denied", "revoked"].includes(existing.status)
      )
        throw fail(
          403,
          "The owner ended this service access. Ask them to restore it.",
        );
      if (existing && existing.createdAt > now() - 30000)
        throw fail(429, "Wait a moment before requesting this service again.");
      if (
        entries.size >= 500 ||
        [...entries.values()].filter(
          (e) => e.clientId === client.id && e.createdAt > now() - 60000,
        ).length >= 5
      )
        throw fail(429, "Too many service requests. Try again later.");
      const entry = {
        id: crypto.randomUUID(),
        clientId: client.id,
        agentName: client.name,
        connectorId: connector.id,
        scopes: [...new Set(connector.actions.map((a) => a.scope))],
        fingerprint: fingerprint(client),
        reason: input.reason.trim(),
        status: "pending",
        createdAt: now(),
        expiresAt: Math.min(client.expiresAt, now() + 300000),
        accessExpiresAt: Math.min(client.expiresAt, now() + 86400000),
      };
      entries.set(entry.id, entry);
      record(
        "agent",
        `${client.name} requested service access to ${connector.name}`,
      );
      try {
        Promise.resolve(
          notify({
            category: "access",
            title: "Service access request",
            body: "An agent needs your permission to use a service. Review on Home.",
            icon: "agent",
            tag: `service-${entry.id}`,
            url: `/?page=overview&needs=service:${entry.id}`,
            actions: [{ action: "open", title: "Review access" }],
          }),
        ).catch(() => {});
      } catch {
        /* Consent survives notification failure. */
      }
      return view(entry);
    },
    inspect() {
      prune();
      return [...entries.values()].map(view).reverse();
    },
    list(authorize) {
      owner(authorize);
      return { access: api.inspect() };
    },
    decide(authorize, id, input) {
      owner(authorize);
      exact(input, ["decision"]);
      if (!["approve", "deny", "revoke"].includes(input.decision))
        throw fail(400, "Choose approve, deny or revoke.");
      prune();
      const entry = entries.get(id);
      if (!entry) throw fail(404, "Service request not found.");
      if (input.decision === "revoke") retire(entry, "revoked");
      else {
        if (entry.status !== "pending")
          throw fail(
            409,
            "This request has already ended. Refresh service access.",
          );
        if (input.decision === "approve") {
          entry.status = "approved";
          entry.expiresAt = entry.accessExpiresAt;
        } else retire(entry, "denied");
      }
      record(
        "agent",
        `${entry.agentName}: ${provider(entry.connectorId).name} access ${entry.status}`,
      );
      return view(entry);
    },
    async run(authorize, input) {
      const client = agent(authorize());
      exact(input, ["connectorId", "action", "values", "requestId"]);
      const connector = provider(input.connectorId),
        action = connector.actions.find((a) => a.id === input.action);
      if (!action || !UUID.test(input.requestId || ""))
        throw fail(400, "Choose a service action and a UUID requestId.");
      const values = action.validate(copy(input.values));
      prune();
      const grant = accessFor(client, connector);
      const check = () => {
        const live = agent(authorize());
        if (
          !grant ||
          grant.status !== "approved" ||
          grant.expiresAt <= now() ||
          grant.fingerprint !== fingerprint(live) ||
          !grant.scopes.includes(action.scope) ||
          !current(grant)
        )
          throw fail(
            403,
            "Service access is not approved or has ended. Request access from the owner.",
          );
        if (!available() || paused(client.id))
          throw fail(
            409,
            "Reach or this agent is paused. Resume before using services.",
          );
        const unavailable = connector.unavailable?.(live);
        if (unavailable) throw fail(403, unavailable);
        return live;
      };
      check();
      const key = `${client.id}:${input.requestId}`,
        hash = JSON.stringify([connector.id, action.id, values]);
      const previous = runs.get(key);
      if (previous) {
        if (previous.hash !== hash || previous.grantId !== grant.id)
          throw fail(409, "This requestId belongs to another service run.");
        const result = await previous.promise;
        check();
        return copy(result);
      }
      if (
        runs.size >= 500 ||
        [...runs.values()].filter((run) => run.pending).length >= 8
      )
        throw fail(429, "Service tools are busy. Try again shortly.");
      const controller = new AbortController();
      const run = {
        grantId: grant.id,
        hash,
        controller,
        pending: true,
        until: Math.min(grant.expiresAt, now() + 300000),
      };
      runs.set(key, run);
      // Poll authorization while a connector works, including disconnect, pause,
      // expiry and revocation. Never release a result after access was removed.
      const monitor = setInterval(() => {
        try {
          check();
        } catch {
          controller.abort();
        }
      }, 100);
      const timeout = setTimeout(() => controller.abort(), runMs);
      monitor.unref();
      timeout.unref();
      let abort;
      const aborted = new Promise((_, reject) => {
        abort = () =>
          reject(fail(409, "Service run stopped. Check access and try again."));
        controller.signal.addEventListener("abort", abort, { once: true });
      });
      run.promise = (async () => {
        try {
          check();
          const raw = await Promise.race([
            Promise.resolve().then(() => {
              check();
              controller.signal.throwIfAborted();
              return connector.run(action.id, values, {
                signal: controller.signal,
                authorize: check,
                requestId: input.requestId,
              });
            }),
            aborted,
          ]);
          check();
          controller.signal.throwIfAborted();
          const data = action.project(raw, values);
          record(
            "agent",
            `${client.name} used ${action.title} · ${connector.name}`,
          );
          return {
            status: "completed",
            requestId: input.requestId,
            connectorId: connector.id,
            action: action.id,
            transport: connector.transport,
            data,
          };
        } catch (error) {
          check();
          if (error instanceof ServiceConnectorError)
            throw fail(error.status, error.message);
          // Provider errors may contain URLs, headers or account secrets.
          throw fail(
            502,
            "The service could not complete this read. Try again with a new requestId.",
          );
        } finally {
          clearInterval(monitor);
          clearTimeout(timeout);
          controller.signal.removeEventListener("abort", abort);
          run.pending = false;
        }
      })();
      return copy(await run.promise);
    },
    cancelClient(id) {
      for (const entry of entries.values())
        if (entry.clientId === id) retire(entry, "revoked");
    },
    close() {
      closed = true;
      for (const entry of entries.values()) retire(entry, "revoked");
      entries.clear();
    },
  };
  return api;
}

export function agentServiceRoutes(app, services) {
  app.get("/api/browser/services", (req, res) =>
    res.json(services.catalog(req.reauthorize)),
  );
  app.post("/api/browser/services/request", (req, res) =>
    res.json(services.request(req.reauthorize, req.body)),
  );
  app.post("/api/browser/services/run", async (req, res) => {
    const result = await services.run(req.reauthorize, req.body);
    req.reauthorize();
    res.json(result);
  });
  app.get("/api/agents/services", (req, res) =>
    res.json(services.list(req.reauthorize)),
  );
  app.post("/api/agents/services/:id", (req, res) =>
    res.json(services.decide(req.reauthorize, req.params.id, req.body)),
  );
}
