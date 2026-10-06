import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import JSON5 from "json5";

const fail = (status, message) => Object.assign(new Error(message), { status });
// Admin too (the owner chose it, Oct 5): a chat moved here from another agent
// gets a session of its own with its history added as notes (sessions.reset,
// sessions.patch, chat.inject), shown in OpenClaw's own app.
const scopes = ["operator.read", "operator.write", "operator.approvals", "operator.admin"];
const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (Array.isArray(message?.content) ? message.content : [])
        .filter((p) => p.type === "text")
        .map((p) => p.text || "")
        .join("\n");

// The host reads its own OpenClaw config. Credentials never travel to the phone.
// Always use loopback: a remote Gateway in this config is not a local install.
export async function localOpenClawConfig({
  env = process.env,
  home = os.homedir(),
} = {}) {
  const state = env.OPENCLAW_STATE_DIR || path.join(home, ".openclaw");
  const file =
    env.REACH_OPENCLAW_CONFIG ||
    env.OPENCLAW_CONFIG_PATH ||
    path.join(state, "openclaw.json");
  let config;
  try {
    config = JSON5.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT")
      throw fail(
        503,
        "OpenClaw was not found on this computer. Install it and start its local Gateway.",
      );
    throw fail(
      503,
      "Reach could not read the OpenClaw configuration. Check OPENCLAW_CONFIG_PATH on this computer.",
    );
  }
  if (config.gateway?.mode === "remote")
    throw fail(
      503,
      "This OpenClaw profile uses a remote Gateway. Connect Reach to the computer running that Gateway.",
    );
  const port = Number(
    env.OPENCLAW_GATEWAY_PORT || config.gateway?.port || 18789,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw fail(503, "OpenClaw has an invalid local Gateway port.");
  const secret = (value) => {
    if (typeof value !== "string") return undefined;
    return value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
      (_, key) => env[key] || "",
    );
  };
  return {
    url: `ws://127.0.0.1:${port}`,
    token: secret(env.OPENCLAW_GATEWAY_TOKEN || config.gateway?.auth?.token),
    password: secret(
      env.OPENCLAW_GATEWAY_PASSWORD || config.gateway?.auth?.password,
    ),
  };
}

async function deviceIdentity(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT")
      throw fail(503, "Reach’s OpenClaw device identity could not be read.");
  }
  const keys = crypto.generateKeyPairSync("ed25519");
  const raw = keys.publicKey
    .export({ type: "spki", format: "der" })
    .subarray(-32);
  const identity = {
    id: crypto.createHash("sha256").update(raw).digest("hex"),
    publicKey: raw.toString("base64url"),
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(file, JSON.stringify(identity), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    return JSON.parse(await fs.readFile(file, "utf8"));
  }
  return identity;
}

export function createOpenClaw({
  dataDir,
  configuration = localOpenClawConfig,
  Socket = WebSocket,
  timeoutMs = 10000,
} = {}) {
  let socket,
    connecting,
    ready = false,
    revision = 0,
    lastList = null,
    listAt = 0,
    listing;
  const pending = new Map(),
    runs = new Map(),
    approvals = new Map();
  const connectionError = () =>
    fail(
      503,
      "OpenClaw Gateway is unavailable. Start OpenClaw on this computer, then retry.",
    );
  const reset = (error) => {
    ready = false;
    connecting = null;
    lastList = null;
    listAt = 0;
    revision++;
    runs.clear();
    approvals.clear();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  const request = (method, params = {}) =>
    new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN)
        return reject(connectionError());
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          fail(
            504,
            "OpenClaw did not respond in time. Check the session before retrying.",
          ),
        );
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const connect = () => {
    if (ready) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      const config = await configuration();
      const identity = await deviceIdentity(
        path.join(dataDir, "openclaw-device.json"),
      );
      await new Promise((resolve, reject) => {
        const ws = new Socket(config.url, { maxPayload: 16 * 1024 * 1024 });
        socket = ws;
        const timer = setTimeout(() => {
          ws.terminate();
          reject(connectionError());
        }, timeoutMs);
        const finish = (error) => {
          clearTimeout(timer);
          if (error) {
            reject(error);
            ws.close();
          } else resolve();
        };
        ws.on("error", () => finish(connectionError()));
        ws.on("close", () => {
          if (socket === ws) {
            socket = null;
            reset(connectionError());
          }
          finish(connectionError());
        });
        ws.on("message", (buffer) => {
          if (socket !== ws) return;
          let frame;
          try {
            frame = JSON.parse(String(buffer));
          } catch {
            return;
          }
          if (frame.type === "res") {
            const waiter = pending.get(frame.id);
            if (!waiter) return;
            pending.delete(frame.id);
            clearTimeout(waiter.timer);
            if (frame.ok) waiter.resolve(frame.payload);
            else
              waiter.reject(
                fail(
                  409,
                  /pairing/i.test(frame.error?.message || "")
                    ? "OpenClaw requires device pairing. Approve the Reach device in OpenClaw, then retry."
                    : `OpenClaw: ${[config.token, config.password]
                        .filter(Boolean)
                        .reduce(
                          (message, secret) =>
                            message.split(secret).join("[redacted]"),
                          String(
                            frame.error?.message || "Request was rejected.",
                          ),
                        )
                        .slice(0, 300)}`,
                ),
              );
          }
          if (frame.type !== "event") return;
          if (frame.event === "connect.challenge") {
            const nonce = frame.payload?.nonce;
            if (typeof nonce !== "string" || !nonce)
              return finish(connectionError());
            const signedAt = Date.now();
            const payload = [
              "v3",
              identity.id,
              "gateway-client",
              "backend",
              "operator",
              scopes.join(","),
              String(signedAt),
              config.token || "",
              nonce,
              process.platform,
              "",
            ].join("|");
            request("connect", {
              minProtocol: 3,
              maxProtocol: 3,
              client: {
                id: "gateway-client",
                displayName: "Reach",
                version: "1.0.0",
                platform: process.platform,
                mode: "backend",
              },
              role: "operator",
              scopes,
              caps: ["tool-events"],
              auth: {
                ...(config.token ? { token: config.token } : {}),
                ...(config.password ? { password: config.password } : {}),
              },
              device: {
                id: identity.id,
                publicKey: identity.publicKey,
                signedAt,
                nonce,
                signature: crypto
                  .sign(null, Buffer.from(payload), identity.privateKey)
                  .toString("base64url"),
              },
            }).then(() => {
              ready = true;
              finish();
            }, finish);
          } else {
            const p = frame.payload || {};
            if (frame.event === "chat" && p.sessionKey) {
              if (p.state === "delta")
                runs.set(p.sessionKey, {
                  runId: p.runId,
                  text: textOf(p.message),
                  status: "running",
                });
              else
                runs.set(p.sessionKey, {
                  runId: p.runId,
                  text: "",
                  status: p.state === "error" ? "error" : "idle",
                  error: p.errorMessage,
                });
              listAt = 0;
            }
            if (frame.event === "exec.approval.requested")
              approvals.set(p.id, p);
            if (frame.event === "exec.approval.resolved")
              approvals.delete(p.id);
            revision++;
          }
        });
      });
    })().catch((error) => {
      connecting = null;
      throw error;
    });
    return connecting;
  };
  const rpc = async (method, params) => {
    await connect();
    return request(method, params);
  };
  const list = async () => {
    if (lastList && Date.now() - listAt < 3000) return lastList;
    if (listing) return listing;
    listing = rpc("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    })
      .then((result) => {
        if (!Array.isArray(result?.sessions))
          throw fail(502, "OpenClaw returned an unsupported session list.");
        lastList = result.sessions;
        listAt = Date.now();
        return lastList;
      })
      .finally(() => {
        listing = null;
      });
    return listing;
  };
  const validKey = (key) => {
    if (
      typeof key !== "string" ||
      !key ||
      key.length > 1000 ||
      /[\x00-\x1f]/.test(key)
    )
      throw fail(400, "Choose an OpenClaw session.");
    return key;
  };
  const known = async (key) => {
    validKey(key);
    const row = (await list()).find((s) => s.key === key);
    if (!row)
      throw fail(
        404,
        "This OpenClaw session is no longer available. Refresh the list.",
      );
    return row;
  };
  const activeApprovals = (key) =>
    [...approvals.values()]
      .filter(
        (a) =>
          a.expiresAtMs > Date.now() && (!key || a.request?.sessionKey === key),
      )
      .map((a) => ({
        id: a.id,
        sessionKey: a.request?.sessionKey,
        command: a.request?.command || "OpenClaw needs permission",
        cwd: a.request?.cwd || "",
        expiresAt: a.expiresAtMs,
      }));
  const canDeliver = (s) =>
    !!(s.deliveryContext?.to || s.lastTo) &&
    !["webchat", "internal", ""].includes(
      s.deliveryContext?.channel || s.channel || s.lastChannel || "",
    );
  const session = (s) => ({
    key: s.key,
    canDeliver: canDeliver(s),
    title: s.label || s.displayName || s.key,
    agentId:
      s.agentId ||
      (s.key.startsWith("agent:") ? s.key.split(":")[1] : "main") ||
      "main",
    channel:
      s.deliveryContext?.channel || s.channel || s.lastChannel || "webchat",
    updatedAt: s.updatedAt || 0,
    model: s.model || "",
    status: activeApprovals(s.key).length
      ? "waiting"
      : runs.get(s.key)?.status || "idle",
  });
  return {
    async overview() {
      try {
        const rows = await list();
        return {
          connected: true,
          sessions: rows.map(session).sort((a, b) => b.updatedAt - a.updatedAt),
          approvals: activeApprovals(),
          revision,
        };
      } catch (error) {
        return {
          connected: false,
          sessions: [],
          approvals: [],
          error: error.message,
          revision,
        };
      }
    },
    async history(key, limit = 200) {
      const row = await known(key);
      limit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
      const result = await rpc("chat.history", { sessionKey: key, limit });
      const messages = Array.isArray(result?.messages) ? result.messages : [];
      return {
        session: session(row),
        items: messages
          .map((m, i) => ({
            id: m.id || `${m.timestamp || 0}:${i}`,
            role: m.role || "system",
            text:
              textOf(m) ||
              (Array.isArray(m.content) &&
              m.content.some((p) =>
                ["image", "audio", "video", "file"].includes(p.type),
              )
                ? "[Attachment — view in OpenClaw]"
                : ""),
            at: m.timestamp,
            tool: m.role === "toolResult" || m.role === "tool",
          }))
          .filter((m) => m.text),
        streaming: runs.get(key)?.text || "",
        error: runs.get(key)?.error || "",
        approvals: activeApprovals(key),
        revision,
        historyLimit: limit,
        mayHaveOlder: messages.length >= limit,
      };
    },
    async send({ key, text, deliver = false, requestId }) {
      const row = await known(key);
      if (deliver === true && !canDeliver(row))
        throw fail(
          400,
          "This session has no external reply destination. Choose Reply in Reach.",
        );
      if (typeof text !== "string" || !text.trim() || text.length > 100000)
        throw fail(400, "Enter a message of at most 100,000 characters.");
      if (typeof requestId !== "string" || !/^[\w-]{8,100}$/.test(requestId))
        throw fail(400, "A message request ID is required.");
      const result = await rpc("chat.send", {
        sessionKey: key,
        message: text,
        deliver: deliver === true,
        idempotencyKey: requestId,
      });
      if (!result?.runId || runs.get(key)?.runId !== result.runId)
        runs.set(key, { runId: result?.runId, text: "", status: "running" });
      listAt = 0;
      return { runId: result?.runId, status: result?.status || "started" };
    },
    // A chat moved here from another agent (agent-sessions/move.mjs): a new
    // session named after it, its history added as notes (OpenClaw's app
    // shows them and its agent reads them; nothing runs until a message).
    // One that fails half-way is removed again.
    async fork({ title = "", notes = [], label = "Moved" } = {}) {
      const key = `agent:main:reach-${crypto.randomUUID().slice(0, 8)}`;
      await rpc("sessions.reset", { key, reason: "new" });
      try {
        if (title) await rpc("sessions.patch", { key, label: String(title).slice(0, 120) });
        for (const message of notes) await rpc("chat.inject", { sessionKey: key, message, label });
      } catch (error) {
        await rpc("sessions.delete", { key, deleteTranscript: true }).catch(() => {});
        throw error;
      }
      listAt = 0;
      return { key };
    },
    async stop(key) {
      await known(key);
      const result = await rpc("chat.abort", { sessionKey: key });
      runs.delete(key);
      return result;
    },
    async approve(id, decision) {
      const prompt = activeApprovals().find((a) => a.id === id);
      if (!prompt)
        throw fail(
          404,
          "This OpenClaw approval expired or was already answered.",
        );
      if (!["allow-once", "deny"].includes(decision))
        throw fail(400, "Choose Allow once or Deny.");
      const result = await rpc("exec.approval.resolve", { id, decision });
      approvals.delete(id);
      revision++;
      return result;
    },
    close() {
      const old = socket;
      socket = null;
      old?.terminate();
      reset(connectionError());
    },
  };
}

export function openClawRoutes(app, client) {
  const base = "/api/sessions/openclaw";
  app.get(`${base}/overview`, async (_req, res) =>
    res.json(await client.overview()),
  );
  app.get(`${base}/history`, async (req, res) =>
    res.json(await client.history(req.query.key, req.query.limit)),
  );
  app.post(`${base}/send`, async (req, res) =>
    res.json(await client.send(req.body || {})),
  );
  app.post(`${base}/stop`, async (req, res) =>
    res.json(await client.stop(req.body?.key)),
  );
  app.post(`${base}/approval`, async (req, res) =>
    res.json(await client.approve(req.body?.id, req.body?.decision)),
  );
}
