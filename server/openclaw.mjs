import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import WebSocket from "ws";
import JSON5 from "json5";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { partLabels } from "./agent-sessions/message-parts.mjs";
import * as usageFeature from "./openclaw-usage.mjs";
import * as healthFeature from "./openclaw-health.mjs";
import * as schedulesFeature from "./openclaw-schedules.mjs";
import * as watchFeature from "./openclaw-watch.mjs";
import * as agentsFeature from "./openclaw-agents.mjs";
import * as skillsFeature from "./openclaw-skills.mjs";
import * as wizardFeature from "./openclaw-wizard.mjs";
import * as onboardFeature from "./openclaw-onboard.mjs";

// Features in files of their own, each adding its routes.
export const FEATURES = [usageFeature, healthFeature, schedulesFeature, watchFeature, agentsFeature, skillsFeature, onboardFeature, wizardFeature];

const fail = (status, message) => Object.assign(new Error(message), { status });
// Gateway errors can embed downstream provider credentials, not just the
// Gateway's own token. Publish fixed descriptions, never arbitrary error text.
const unconfirmedRun =
  "OpenClaw has not confirmed completion. Check OpenClaw before sending again.";
// WhatsApp's login steps, said in Reach's words (never OpenClaw's text).
const whatsappNote = (value) => {
  const text = String(value || "");
  if (/already linked/i.test(text)) return "WhatsApp is already linked.";
  if (/expired|No active WhatsApp login/i.test(text)) return "The QR expired. Get a new one.";
  if (/logged out/i.test(text)) return "WhatsApp logged this link out. Get a new QR.";
  if (/login failed|Failed to/i.test(text)) return "The WhatsApp login failed. Get a new QR.";
  if (/Still waiting/i.test(text)) return "Still waiting for the scan.";
  if (/linked|connected/i.test(text)) return "WhatsApp is linked.";
  return "";
};
const publicGatewayError = (value) => {
  const text = String(value || "");
  if (!text) return "";
  // This exact local status is safe even if echoed by a Gateway.
  if (text === unconfirmedRun) return unconfirmedRun;
  if (/protocol mismatch/i.test(text))
    return "Reach and OpenClaw use incompatible connection versions. Update Reach to reconnect.";
  if (/credit balance|quota|billing|rate.?limit|429/i.test(text))
    return "OpenClaw reports a credit balance or usage limit. Check OpenClaw on this computer.";
  if (/auth|credential|api.?key|token|password|401|403/i.test(text))
    return "OpenClaw reports an authentication problem. Check OpenClaw on this computer.";
  if (/timeout|timed out/i.test(text))
    return "OpenClaw reports a timeout. Check the session before retrying.";
  return "OpenClaw reported an error. Check OpenClaw on this computer.";
};
// Admin too (the owner chose it, Oct 5): a chat moved here from another agent
// gets a session of its own with its history added as notes (sessions.reset,
// sessions.patch, chat.inject), shown in OpenClaw's own app.
const scopes = [
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.admin",
];
const textOf = (message) =>
  typeof message?.content === "string"
    ? message.content
    : (Array.isArray(message?.content) ? message.content : [])
        .filter((p) => p?.type === "text" && typeof p.text === "string")
        .map((p) => p.text || "")
        .join("\n");
// What OpenClaw writes as the user's turn when it retries on a fallback model.
const fallbackRetry =
  "Continue where you left off. The previous model attempt failed or timed out.";

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

// Reach talks to OpenClaw only in chats Reach made itself (agent:<id>:reach-…,
// plain webchat). A chat that belongs to a WhatsApp group, a Discord channel or
// DM, or a cron job is shown and never written to: a message there runs the
// agent inside that group's context, and on Oct 5 replies reached a friends'
// WhatsApp group. Enforced on send, whoever asks.
const channelOf = (s) => String(s?.deliveryContext?.channel || s?.channel || s?.lastChannel || "webchat").toLowerCase();
export const reachMade = (key) => /^agent:[\w-]+:reach-[\w-]+$/.test(String(key || ""));
// OpenClaw names a chat in at most 64 characters (sessions.patch refuses
// more), cut between characters, never inside an emoji.
export const LABEL_MAX = 64;
export function chatLabel(text, room = LABEL_MAX) {
  let out = "";
  for (const ch of String(text || "").trim().replace(/\s+/g, " ")) {
    if (out.length + ch.length > room) break;
    out += ch;
  }
  return out.trim();
}
export function writable(s) {
  const to = s?.deliveryContext?.to || s?.lastTo;
  return (
    reachMade(s?.key) &&
    ["webchat", "internal"].includes(channelOf(s)) &&
    !(typeof to === "string" && to.trim())
  );
}
// What a chat is, for people: "WhatsApp group", "Discord · #general",
// "Alex on Discord", never OpenClaw's raw ids ("whatsapp:g-1203…@g.us").
const APPS = {
  whatsapp: "WhatsApp",
  discord: "Discord",
  telegram: "Telegram",
  slack: "Slack",
  signal: "Signal",
  imessage: "iMessage",
};
export function readableName(s) {
  const raw = String(s?.label || s?.displayName || "").trim();
  const channel = channelOf(s);
  const app =
    APPS[channel] ||
    (channel && !["webchat", "internal"].includes(channel)
      ? channel[0].toUpperCase() + channel.slice(1)
      : "");
  const key = String(s?.key || "");
  const person = /^(.{1,60}?) user id:\d+$/.exec(raw)?.[1];
  if (person) return app ? `${person} on ${app}` : person;
  const looksRaw = !raw || raw === key || /^[a-z]+:\S+$/i.test(raw);
  if (!looksRaw) return raw.slice(0, 120);
  const hash = /#([\w-]{1,60})$/.exec(raw)?.[1];
  if (/:group:|@g\.us/.test(`${key} ${raw}`)) {
    // Two groups apart: the end of its id.
    const tail = /(\d{4})(?:@g\.us)?$/.exec(key)?.[1];
    return `${app || "Chat"} group${tail ? ` ·${tail}` : ""}`;
  }
  if (hash) return `${app || "Chat"} · #${hash}`;
  if (/:channel:/.test(key)) return `${app || "Chat"} channel`;
  if (/:direct:/.test(key)) return `${app || "Chat"} direct messages`;
  return app ? `${app} chat` : "OpenClaw chat";
}

export function readableSchedule(schedule) {
  if (schedule?.kind === "every") {
    const seconds = Math.max(1, Math.round(Number(schedule.everyMs) / 1000));
    if (!Number.isFinite(seconds)) return "Recurring";
    const [amount, unit] =
      seconds % 86400 === 0
        ? [seconds / 86400, "day"]
        : seconds % 3600 === 0
          ? [seconds / 3600, "hour"]
          : seconds % 60 === 0
            ? [seconds / 60, "minute"]
            : [seconds, "second"];
    return `Every ${amount} ${unit}${amount === 1 ? "" : "s"}`;
  }
  if (schedule?.kind === "at")
    return typeof schedule.at === "string" ? schedule.at : "One-time run";
  if (schedule?.kind !== "cron" || typeof schedule.expr !== "string")
    return "Scheduled";
  const [minute, hour, day, month, week] = schedule.expr.trim().split(/\s+/);
  let label = schedule.expr;
  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    Number(minute) < 60 &&
    Number(hour) < 24 &&
    day === "*" &&
    month === "*"
  ) {
    const time = `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
    const days = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
      "Sunday",
    ];
    if (week === "*") label = `Daily at ${time}`;
    else if (week === "1-5") label = `Weekdays at ${time}`;
    else if (/^[0-7]$/.test(week))
      label = `Every ${days[Number(week)]} at ${time}`;
  }
  return [label, typeof schedule.tz === "string" ? schedule.tz : ""]
    .filter(Boolean)
    .join(" · ");
}

export function createOpenClaw({
  dataDir,
  configuration = localOpenClawConfig,
  Socket = WebSocket,
  timeoutMs = 10000,
  now = Date.now,
  reconcileMs = 5000,
  // The first wait before opening a dropped connection again.
  redialMs = 1000,
  staleMs = 120000,
  // A burst of changes (a reply streaming in) is told to waiting phones at
  // most this often.
  coalesceMs = 300,
  // How long a failed model may be followed by OpenClaw's next one (its
  // fallbacks run under the same runId) before the run counts as failed:
  // OpenClaw's own AGENT_RUN_ERROR_RETRY_GRACE_MS.
  retryGraceMs = 15000,
} = {}) {
  let socket,
    connecting,
    ready = false,
    revision = 0,
    lastList = null,
    listAt = 0,
    listing,
    methods,
    serverVersion = "",
    redact = publicGatewayError;
  const pending = new Map(),
    runs = new Map(),
    approvals = new Map(),
    completions = new Map(),
    attempts = new Map(),
    // New chats by the phone's requestId (start() below).
    starts = new Map(),
    terminalRuns = new Set(),
    // Told when approvals come or go (notifications look then).
    approvalListeners = new Set(),
    // Told every Gateway event (features in openclaw-*.mjs watch these).
    eventListeners = new Set();
  const approvalsChanged = () => {
    for (const listener of approvalListeners) listener();
    tell();
  };
  // Phones waiting for what they show to change (changes() below): looked
  // at once a burst settles.
  const waiters = new Set();
  let telling = null;
  const tell = () => {
    if (telling || !waiters.size) return;
    telling = setTimeout(() => {
      telling = null;
      for (const waiter of [...waiters]) waiter.check();
    }, coalesceMs);
    telling.unref?.();
  };
  const changed = () => {
    revision++;
    tell();
  };
  // Each chat's messages as OpenClaw last gave them, kept while only the
  // reply being written changes (its words come with the events): a phone
  // reading the chat as it streams doesn't ask the Gateway each time.
  const histories = new Map(); // key -> { turn, limit, at, result }
  const settingVersions = new Map();
  const turnOf = (key) => {
    const run = runs.get(key);
    return `${run?.runId || ""}|${run?.status || ""}|${!!run?.generated}`;
  };
  // Approvals come only as the Gateway's events: while anyone listens, a
  // dropped connection is opened again (sooner, then up to every 30 s),
  // instead of waiting for someone to ask.
  let closed = false,
    redial = null;
  const keepOpen = (wait = redialMs) => {
    if (closed || redial || !approvalListeners.size) return;
    redial = setTimeout(() => {
      redial = null;
      if (!closed) connect().catch(() => keepOpen(Math.min(wait * 2, 30000)));
    }, wait);
    redial.unref?.();
  };
  const putRun = (key, run) => {
    if (!runs.has(key) && runs.size >= 512) {
      const disposable = [...runs].find(
        ([, r]) => !["running", "unknown"].includes(r.status),
      );
      if (disposable) runs.delete(disposable[0]);
      else return false;
    }
    runs.set(key, run);
    changed();
    listAt = 0;
    return true;
  };
  // A model failed and OpenClaw may be trying the next: still running.
  const settleRetry = (run) => {
    clearTimeout(run.retryTimer);
    run.retryTimer = null;
    run.retrying = "";
  };
  const finishRun = (key, run, status, error = "") => {
    if (runs.get(key) !== run) return;
    settleRetry(run);
    Object.assign(run, {
      status,
      text: "",
      error: redact(error),
      updatedAt: now(),
    });
    if (["idle", "error"].includes(status)) {
      terminalRuns.add(run.runId);
      if (terminalRuns.size > 2048)
        terminalRuns.delete(terminalRuns.values().next().value);
    }
    changed();
    listAt = 0;
  };
  // gatewayDown: nothing answers on its port; a phone may start it.
  const connectionError = () =>
    Object.assign(
      fail(
        503,
        "OpenClaw Gateway is unavailable. Start OpenClaw on this computer, then retry.",
      ),
      { gatewayDown: true },
    );
  const reset = (error) => {
    const dropped = ready;
    ready = false;
    connecting = null;
    lastList = null;
    listAt = 0;
    changed();
    completions.clear();
    for (const run of runs.values()) {
      settleRetry(run);
      if (run.status === "running")
        Object.assign(run, {
          status: "unknown",
          text: "",
          error:
            "Connection interrupted. Checking the existing run; your message will not be sent again.",
          checkedAt: 0,
        });
    }
    const hadApprovals = approvals.size > 0;
    approvals.clear();
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    if (hadApprovals) approvalsChanged();
    if (dropped) keepOpen();
  };
  const request = (method, params = {}, completion, waitMs = timeoutMs) =>
    new Promise((resolve, reject) => {
      if (closed || !socket || socket.readyState !== WebSocket.OPEN)
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
      }, waitMs);
      pending.set(id, { resolve, reject, timer, method });
      if (completion) completions.set(id, completion);
      try {
        socket.send(JSON.stringify({ type: "req", id, method, params }));
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        completions.delete(id);
        reject(connectionError());
      }
    });
  const connect = () => {
    if (closed) return Promise.reject(connectionError());
    if (ready) return Promise.resolve();
    if (connecting) return connecting;
    connecting = (async () => {
      const config = await configuration();
      if (closed) throw connectionError();
      const identity = await deviceIdentity(
        path.join(dataDir, "openclaw-device.json"),
      );
      if (closed) throw connectionError();
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
            return finish(connectionError());
          }
          if (
            !frame ||
            typeof frame !== "object" ||
            Array.isArray(frame) ||
            typeof frame.type !== "string"
          )
            return finish(connectionError());
          if (frame.type === "res") {
            // `agent` has two responses with the SAME RPC id: accepted, then
            // finished (including delivery errors). Keep listening after ack.
            const completion = completions.get(frame.id);
            if (
              completion &&
              (!frame.ok || ["ok", "error"].includes(frame.payload?.status))
            ) {
              completions.delete(frame.id);
              completion(frame);
            }
            const waiter = pending.get(frame.id);
            if (!waiter) return;
            pending.delete(frame.id);
            clearTimeout(waiter.timer);
            if (frame.ok) waiter.resolve(frame.payload);
            else
              waiter.reject(
                Object.assign(
                  fail(
                    409,
                    /pairing/i.test(frame.error?.message || "")
                      ? "OpenClaw requires device pairing. Approve the Reach device in OpenClaw, then retry."
                      : redact(frame.error?.message || "Request was rejected."),
                  ),
                  {
                    // OpenClaw keeps chat names apart (nameChat, settings).
                    labelInUse:
                      waiter.method === "sessions.patch" &&
                      /label already in use/i.test(
                        String(frame.error?.message || ""),
                      ),
                    invalidInjectParams:
                      waiter.method === "chat.inject" &&
                      /invalid chat\.inject params/i.test(
                        String(frame.error?.message || ""),
                      ),
                    // Any method: it exists here, only the params were wrong.
                    invalidParams: /invalid \S+ params/i.test(
                      String(frame.error?.message || ""),
                    ),
                  },
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
              // 2026.9 moved to protocol 4; older installed Gateways use 3.
              // Both retain this signed handshake and the RPCs used by Reach.
              minProtocol: 3,
              maxProtocol: 4,
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
            }).then((hello) => {
              if (socket !== ws) return finish(connectionError());
              serverVersion =
                typeof hello?.server?.version === "string"
                  ? hello.server.version.slice(0, 40)
                  : "";
              methods = Array.isArray(hello?.features?.methods)
                ? new Set(hello.features.methods)
                : null;
              ready = true;
              changed();
              finish();
              probeInject();
            }, finish);
          } else {
            const p = frame.payload || {};
            for (const listener of eventListeners) {
              try {
                listener(frame.event, p);
              } catch {}
            }
            if (["chat", "agent"].includes(frame.event))
              updateRun(frame.event, p);
            if (
              frame.event === "exec.approval.requested" &&
              typeof p.id === "string" &&
              p.id &&
              typeof p.request?.command === "string" &&
              p.request.command.trim() &&
              Number.isFinite(p.expiresAtMs) &&
              p.expiresAtMs > Date.now() &&
              !approvals.has(p.id)
            ) {
              approvals.set(p.id, { ...p, socket: ws });
              approvalsChanged();
              // Gone when it expires, though nothing says so.
              setTimeout(
                approvalsChanged,
                Math.min(2 ** 31 - 1, p.expiresAtMs - Date.now() + 50),
              ).unref?.();
            }
            if (
              frame.event === "exec.approval.resolved" &&
              approvals.delete(p.id)
            )
              approvalsChanged();
            changed();
          }
        });
      });
    })().catch((error) => {
      connecting = null;
      throw error;
    });
    return connecting;
  };
  // chat.inject on Gateways that handle it without listing it in hello
  // (OpenClaw 2026.3.13: in its handlers, not its list, so moving a chat
  // there was offered nowhere). Asked once per connection with nothing to
  // add: "invalid chat.inject params" means it's there, anything else not.
  let injectable = null;
  let injectProbe = Promise.resolve();
  // sessions.usage likewise (2026.3.13 handles it, lists it nowhere): a
  // chat's spend (openclaw-usage.mjs).
  let usageable = null;
  let usageProbe = Promise.resolve();
  const probeInject = () => {
    usageable = null;
    if (methods && !methods.has("sessions.usage"))
      usageProbe = request("sessions.usage", { limit: 0 }).then(
        () => (usageable = true),
        (e) => (usageable = e?.invalidParams === true),
      );
    injectable = null;
    if (!methods || methods.has("chat.inject")) return;
    injectProbe = request("chat.inject", {}).then(
      () => (injectable = true),
      (e) => (injectable = e?.invalidInjectParams === true),
    );
  };
  const beforeDispatchFailures = new WeakSet(),
    authorizationFailures = new WeakSet();
  const rpc = async (method, params, completion, authorize = () => {}, waitMs) => {
    const check = () => {
      try {
        authorize();
      } catch (error) {
        if (error && typeof error === "object")
          authorizationFailures.add(error);
        throw error;
      }
    };
    try {
      check();
      await connect();
      check();
      if (method === "chat.inject") await injectProbe;
      if (method === "sessions.usage") await usageProbe;
      check();
      if (
        methods &&
        !methods.has(method) &&
        !(method === "chat.inject" && injectable === true) &&
        !(method === "sessions.usage" && usageable === true)
      )
        throw fail(
          409,
          `This OpenClaw Gateway does not support ${method}. Update OpenClaw on this computer.`,
        );
    } catch (error) {
      if (error && typeof error === "object") beforeDispatchFailures.add(error);
      throw error;
    }
    // No await between the final live authorization and socket dispatch.
    return request(method, params, completion, waitMs);
  };
  const can = (method) =>
    !methods ||
    methods.has(method) ||
    (method === "chat.inject" && injectable === true) ||
    (method === "sessions.usage" && usageable !== false);
  const updateRun = (event, p) => {
    if (typeof p.runId !== "string" || !p.runId) return;
    if (terminalRuns.has(p.runId)) return;
    const key =
      typeof p.sessionKey === "string"
        ? p.sessionKey
        : [...runs].find(([, run]) => run.runId === p.runId)?.[0];
    if (!key) return;
    let run = runs.get(key);
    // Old/foreign events must not finish or overwrite a newer Reach run.
    if (
      run &&
      run.runId !== p.runId &&
      ["running", "unknown"].includes(run.status)
    )
      return;
    if (run?.runId === p.runId && ["idle", "error"].includes(run.status))
      return;
    if (event === "agent" && p.stream === "tool" && run?.runId === p.runId) {
      Object.assign(run, { updatedAt: now(), status: "running", error: "" });
      return;
    }
    const state =
      event === "chat"
        ? p.state
        : p.stream === "lifecycle"
          ? { start: "start", end: "final", error: "error" }[p.data?.phase]
          : p.stream === "assistant"
            ? "delta"
            : null;
    if (!["start", "delta", "final", "error", "aborted"].includes(state))
      return;
    if (!run || run.runId !== p.runId) {
      run = { runId: p.runId, status: "running", text: "", updatedAt: now() };
      if (!putRun(key, run)) return;
    }
    run.updatedAt = now();
    if (["start", "delta"].includes(state)) {
      // The next model took over: the failed one's words are gone.
      if (run.retrying) {
        settleRetry(run);
        run.text = "";
      }
      run.status = "running";
      run.error = "";
      if (state === "delta")
        run.text =
          event === "chat"
            ? textOf(p.message)
            : typeof p.data?.text === "string"
              ? p.data.text
              : run.text;
    } else if (state === "error") {
      // Not the end yet: when a model fails (no credit, unknown model…)
      // OpenClaw tries its fallbacks under the same runId, and their events
      // may come without the sessionKey. Failed only if none starts in time.
      const error =
        p.errorMessage ||
        p.data?.error ||
        "OpenClaw could not complete the run.";
      clearTimeout(run.retryTimer);
      run.retrying = redact(error);
      run.retryTimer = setTimeout(() => {
        if (runs.get(key) !== run || !run.retrying) return;
        finishRun(key, run, "error", error);
        if (run.delivery) run.delivery.status = "failed";
      }, retryGraceMs);
      run.retryTimer.unref?.();
    } else if (run.delivery && state !== "aborted") {
      // Generation ends before outbound delivery. Only the terminal RPC result
      // can report delivery success/failure; lifecycle alone is not a receipt.
      run.text = "";
      run.generated = true;
    } else finishRun(key, run, "idle");
    changed();
  };
  const reconcile = async (key) => {
    const run = runs.get(key);
    if (!run || !["running", "unknown"].includes(run.status) || !run.runId)
      return;
    if (run.checking) return run.checking;
    if (run.checkedAt != null && now() - run.checkedAt < reconcileMs) return;
    run.checkedAt = now();
    run.checking = (async () => {
      try {
        const result = await rpc("agent.wait", {
          runId: run.runId,
          timeoutMs: 1,
        });
        if (
          runs.get(key) !== run ||
          !["running", "unknown"].includes(run.status)
        )
          return;
        if (result?.runId !== run.runId)
          throw Error("Unsupported OpenClaw run status.");
        if (["ok", "error"].includes(result.status)) {
          if (run.delivery && result.status === "ok") {
            // On older Gateways agent.wait may refer only to generation. Give
            // the delivery response time to arrive; never invent a receipt.
            if (now() - run.updatedAt < 30000 && run.status !== "unknown")
              return;
            run.delivery.status = "unconfirmed";
          }
          if (run.delivery && result.status === "error")
            run.delivery.status = "failed";
          finishRun(
            key,
            run,
            result.status === "error" ? "error" : "idle",
            result.error,
          );
        } else if (result.status !== "timeout")
          throw Error("Unsupported OpenClaw run status.");
      } catch {
        // Polling is read-only. A status failure must never retry the message.
      }
      if (
        ["running", "unknown"].includes(run.status) &&
        now() - run.updatedAt >= staleMs
      ) {
        finishRun(key, run, "unknown", unconfirmedRun);
        if (run.delivery) run.delivery.status = "unconfirmed";
      }
    })().finally(() => {
      run.checking = null;
    });
    return run.checking;
  };
  const list = async () => {
    if (lastList && Date.now() - listAt < 3000) return lastList;
    if (listing) return listing;
    listing = rpc("sessions.list", {
      includeGlobal: true,
      includeUnknown: true,
    })
      .then((result) => {
        if (
          !Array.isArray(result?.sessions) ||
          result.sessions.some(
            (row) =>
              !row ||
              typeof row !== "object" ||
              typeof row.key !== "string" ||
              !row.key ||
              [
                "label",
                "displayName",
                "agentId",
                "channel",
                "lastChannel",
                "model",
              ].some((k) => row[k] != null && typeof row[k] !== "string") ||
              (row.deliveryContext?.channel != null &&
                typeof row.deliveryContext.channel !== "string"),
          )
        )
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
  // What a phone shows, as a short stamp: the list (who's connected, each
  // chat's run, the approvals), or one chat (its run and reply so far).
  const stamp = (value) =>
    crypto
      .createHash("sha1")
      .update(JSON.stringify(value))
      .digest("base64url")
      .slice(0, 12);
  const listStamp = () =>
    stamp([
      ready,
      [...settingVersions],
      [...runs].map(([key, run]) => [key, run.status, !!run.generated]),
      activeApprovals().map((a) => a.id),
    ]);
  const chatStamp = (key) => {
    const run = runs.get(key);
    return stamp([
      ready,
      settingVersions.get(key),
      run?.runId,
      run?.status,
      run?.text,
      run?.error,
      run?.retrying,
      !!run?.generated,
      run?.delivery?.status,
      activeApprovals(key).map((a) => [a.id, a.canRespond]),
    ]);
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
        canRespond:
          !a.attempted &&
          ready &&
          socket === a.socket &&
          (!methods || methods.has("exec.approval.resolve")),
      }));
  const destination = (s) => {
    const context = s.deliveryContext || {};
    const channel = context.channel || s.lastChannel || s.channel;
    const to = context.to || s.lastTo;
    if (
      typeof channel !== "string" ||
      ["webchat", "internal", ""].includes(channel) ||
      typeof to !== "string" ||
      !to.trim()
    )
      return null;
    return {
      channel,
      to,
      accountId: context.accountId || s.lastAccountId,
      threadId: context.threadId ?? s.lastThreadId,
    };
  };
  const checkChannel = async (target) => {
    const result = await rpc("channels.status", { probe: false });
    const accounts = result?.channelAccounts?.[target.channel];
    if (!Array.isArray(accounts))
      throw fail(
        409,
        "OpenClaw could not verify the reply channel. Check its Channels page, or choose Reply in Reach.",
      );
    const account = target.accountId
      ? accounts.find((a) => a.accountId === target.accountId)
      : accounts.find(
          (a) =>
            a.accountId === result.channelDefaultAccountId?.[target.channel],
        ) || (accounts.length === 1 ? accounts[0] : null);
    if (
      !account ||
      account.enabled === false ||
      account.configured === false ||
      account.running === false ||
      account.connected === false ||
      account.linked === false ||
      (target.channel === "whatsapp" && account.connected !== true) ||
      ![account.configured, account.running, account.connected].includes(true)
    )
      throw fail(
        409,
        `${target.channel === "whatsapp" ? "WhatsApp" : target.channel} is not connected in OpenClaw. Reconnect it in OpenClaw’s Channels page, or choose Reply in Reach. Nothing was sent.`,
      );
  };
  const session = (s) => ({
    key: s.key,
    title: readableName(s),
    // Reach writes only in chats it made itself (see writable()).
    writable: writable(s),
    agentId:
      s.agentId ||
      (s.key.startsWith("agent:") ? s.key.split(":")[1] : "main") ||
      "main",
    channel:
      s.deliveryContext?.channel || s.channel || s.lastChannel || "webchat",
    updatedAt: s.updatedAt || 0,
    model: s.model || "",
    modelProvider: s.modelProvider || "",
    thinkingLevel: s.thinkingLevel || "",
    status: activeApprovals(s.key).length
      ? "waiting"
      : runs.get(s.key)?.status || "idle",
    canStop: runs.get(s.key)?.method !== "agent",
  });
  // Names a new chat; OpenClaw keeps names apart, so a second "Login page"
  // becomes "Login page (2)".
  const nameChat = async (key, title, authorize) => {
    const base = chatLabel(title);
    if (!base) return;
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? "" : ` (${n})`;
      const label = chatLabel(base, LABEL_MAX - suffix.length) + suffix;
      try {
        return await rpc("sessions.patch", { key, label }, undefined, authorize);
      } catch (error) {
        if (n >= 20 || error?.labelInUse !== true) throw error;
      }
    }
  };
  const api = {
    // Fixed, read-only inventories. Return only display fields: Gateway
    // account objects and agent configuration may contain credentials.
    async catalog() {
      await connect();
      const read = async (method) => {
        if (methods && !methods.has(method)) return null;
        const result = await rpc(method, {});
        const rows = result?.[method === "agents.list" ? "agents" : "models"];
        if (
          !Array.isArray(rows) ||
          rows.some((row) => !row || typeof row.id !== "string")
        )
          throw fail(
            502,
            `OpenClaw returned an unsupported ${method === "agents.list" ? "agent" : "model"} list.`,
          );
        return result;
      };
      const results = await Promise.allSettled([
        read("agents.list"),
        read("models.list"),
      ]);
      const agents =
        results[0].status === "fulfilled" ? results[0].value : null;
      const models =
        results[1].status === "fulfilled" ? results[1].value : null;
      return {
        defaultAgentId:
          typeof agents?.defaultId === "string" ? agents.defaultId : "main",
        agents: (agents?.agents || []).map((a) => ({
          id: a.id,
          name:
            typeof a.identity?.name === "string"
              ? a.identity.name
              : typeof a.name === "string"
                ? a.name
                : a.id,
        })),
        models: (models?.models || []).map((m) => ({
          id:
            typeof m.provider === "string" &&
            m.provider &&
            !m.id.startsWith(`${m.provider}/`)
              ? `${m.provider}/${m.id}`
              : m.id,
          name: typeof m.name === "string" ? m.name : m.id,
          reasoning: m.reasoning !== false,
        })),
        canEdit: !methods || methods.has("sessions.patch"),
        errors: results.flatMap((r, i) =>
          r.status === "rejected"
            ? [
                `${i ? "Models" : "Agents"}: ${redact(r.reason?.message || "Unavailable")}`,
              ]
            : [],
        ),
      };
    },
    // `refresh` asks each channel again (OpenClaw's probe), not its last word.
    async channels({ refresh = false } = {}) {
      const result = await rpc("channels.status", { probe: refresh === true }, undefined, undefined, refresh === true ? 30000 : undefined);
      if (
        !result?.channelAccounts ||
        typeof result.channelAccounts !== "object"
      )
        throw fail(502, "OpenClaw returned unsupported channel status.");
      return {
        channels: Object.entries(result.channelAccounts).flatMap(
          ([channel, accounts]) =>
            (Array.isArray(accounts) ? accounts : [])
              .filter((a) => a && typeof a === "object")
              .map((a) => ({
                channel,
                accountId: String(a.accountId || "default"),
                name: String(a.name || a.accountId || "Default account"),
                status:
                  a.enabled === false
                    ? "disabled"
                    : a.configured === false
                      ? "unconfigured"
                      : a.connected === false ||
                          a.running === false ||
                          a.linked === false
                        ? "disconnected"
                        : a.connected === true
                          ? "connected"
                          : a.running === true
                            ? "running"
                            : "unknown",
                error: redact(a.lastError || ""),
              })),
        ),
        // What Reach can set up here; the rest is OpenClaw's own setup.
        canLinkWhatsApp: can("web.login.start") && can("web.login.wait"),
      };
    },
    // Links WhatsApp: OpenClaw's QR, scanned in WhatsApp → Linked devices
    // on the phone that has WhatsApp. Never over a linked account (OpenClaw
    // stops the channel to start a login); `relink` logs it out first.
    async linkWhatsApp({ accountId, relink = false } = {}, authorize = () => {}) {
      authorize();
      if (accountId !== undefined && (typeof accountId !== "string" || !/^[\w-]{1,80}$/.test(accountId)))
        throw fail(400, "Choose a WhatsApp account.");
      const status = await rpc("channels.status", { probe: false }, undefined, authorize);
      const accounts = Array.isArray(status?.channelAccounts?.whatsapp) ? status.channelAccounts.whatsapp : [];
      const id = accountId || status?.channelDefaultAccountId?.whatsapp;
      const account = accounts.find((a) => a?.accountId === id) || (!accountId && accounts.length === 1 ? accounts[0] : null);
      if (account?.connected === true && !relink)
        throw fail(409, "WhatsApp is already connected in OpenClaw.");
      if (account && (account.linked === true || account.connected === true)) {
        if (!relink)
          throw fail(409, "WhatsApp is linked but not connected. Refresh, or link it again with a new QR.");
        await rpc("channels.logout", { channel: "whatsapp", ...(accountId ? { accountId } : {}) }, undefined, authorize);
      }
      const result = await rpc(
        "web.login.start",
        { timeoutMs: 30000, ...(accountId ? { accountId } : {}) },
        undefined,
        authorize,
        40000,
      );
      const qr = typeof result?.qrDataUrl === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.qrDataUrl) && result.qrDataUrl.length < 300000
        ? result.qrDataUrl
        : "";
      changed();
      return { qr, message: whatsappNote(result?.message) };
    },
    // Waits a while for the QR to be scanned (the phone asks again).
    async waitWhatsApp({ accountId } = {}, authorize = () => {}) {
      authorize();
      if (accountId !== undefined && (typeof accountId !== "string" || !/^[\w-]{1,80}$/.test(accountId)))
        throw fail(400, "Choose a WhatsApp account.");
      const result = await rpc(
        "web.login.wait",
        { timeoutMs: 20000, ...(accountId ? { accountId } : {}) },
        undefined,
        authorize,
        30000,
      );
      if (result?.connected === true) changed();
      return { connected: result?.connected === true, message: whatsappNote(result?.message) };
    },
    async automations({ offset = 0, query = "" } = {}) {
      offset = Number(offset);
      if (
        !Number.isInteger(offset) ||
        offset < 0 ||
        offset > 100000 ||
        typeof query !== "string" ||
        query.length > 200
      )
        throw fail(400, "Choose a valid schedule page or search.");
      const result = await rpc("cron.list", {
        includeDisabled: true,
        limit: 50,
        offset,
        ...(query ? { query } : {}),
      });
      if (
        !Array.isArray(result?.jobs) ||
        result.jobs.some(
          (j) =>
            !j ||
            typeof j.id !== "string" ||
            typeof j.name !== "string" ||
            typeof j.enabled !== "boolean",
        )
      )
        throw fail(502, "OpenClaw returned unsupported scheduled jobs.");
      return {
        canEdit: !methods || methods.has("cron.update"),
        canAdd: can("cron.add"),
        canRun: can("cron.run"),
        canRemove: can("cron.remove"),
        hasMore: result.hasMore === true,
        nextOffset: result.nextOffset ?? offset + result.jobs.length,
        jobs: result.jobs.map((j) => ({
          id: j.id,
          name: j.name,
          agentId: j.agentId || "main",
          enabled: j.enabled === true,
          schedule: readableSchedule(j.schedule),
          nextRunAt: j.state?.nextRunAtMs || 0,
          lastRunAt: j.state?.lastRunAtMs || 0,
          status: j.state?.runningAtMs
            ? "running"
            : typeof j.state?.lastRunStatus === "string"
              ? j.state.lastRunStatus
              : typeof j.state?.lastStatus === "string"
                ? j.state.lastStatus
                : "idle",
          error: redact(j.state?.lastError || ""),
          delivery:
            j.delivery?.mode === "announce"
              ? j.delivery.channel && j.delivery.channel !== "last"
                ? j.delivery.channel
                : "Last channel"
              : j.delivery?.mode === "webhook"
                ? "Webhook"
                : "No external delivery",
        })),
      };
    },
    async setAutomation({ id, enabled } = {}, authorize = () => {}) {
      authorize();
      if (
        typeof id !== "string" ||
        !id ||
        id.length > 200 ||
        typeof enabled !== "boolean"
      )
        throw fail(400, "Choose a scheduled job and whether it is enabled.");
      const result = await rpc(
        "cron.update",
        { id, patch: { enabled } },
        undefined,
        authorize,
      );
      if (result?.enabled !== enabled)
        throw fail(
          502,
          "OpenClaw did not confirm the schedule change. Refresh before trying again.",
        );
      return { enabled };
    },
    // A new schedule: OpenClaw runs `message` in a chat of its own at each
    // time; replies stay in OpenClaw (and Reach) unless `announce` sends
    // them to the channel last used.
    async addAutomation({ name, expr, tz, message, agentId, announce = false } = {}, authorize = () => {}) {
      authorize();
      if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
        throw fail(400, "Name the schedule (up to 120 characters).");
      if (typeof message !== "string" || !message.trim() || message.length > 20000)
        throw fail(400, "Write what OpenClaw should do each time.");
      const fields = typeof expr === "string" ? expr.trim().split(/\s+/) : [];
      if (fields.length !== 5 || !fields.every((f) => /^[\d*/,\-A-Za-z?]{1,40}$/.test(f)))
        throw fail(400, "Choose when it runs (five cron fields, like 0 9 * * 1-5).");
      if (tz !== undefined && tz !== "" && (typeof tz !== "string" || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)*$/.test(tz) || tz.length > 64))
        throw fail(400, "Choose a valid time zone.");
      if (agentId !== undefined && (typeof agentId !== "string" || !/^[\w-]{1,80}$/.test(agentId)))
        throw fail(400, "Choose an OpenClaw agent.");
      if (typeof announce !== "boolean") throw fail(400, "Choose where results go.");
      const result = await rpc("cron.add", {
        name: name.trim(),
        ...(agentId ? { agentId } : {}),
        enabled: true,
        schedule: { kind: "cron", expr: fields.join(" "), ...(tz ? { tz } : {}) },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: { kind: "agentTurn", message: message.trim() },
        delivery: announce ? { mode: "announce", channel: "last" } : { mode: "none" },
      }, undefined, authorize);
      const id = result?.id || result?.job?.id;
      if (typeof id !== "string" || !id)
        throw fail(502, "OpenClaw did not confirm the new schedule. Refresh before trying again.");
      return { id };
    },
    async runAutomation({ id } = {}, authorize = () => {}) {
      authorize();
      if (typeof id !== "string" || !id || id.length > 200) throw fail(400, "Choose a scheduled job.");
      const result = await rpc("cron.run", { id, mode: "force" }, undefined, authorize);
      if (result?.ok === false || result?.runnable === false)
        throw fail(
          409,
          result.reason === "already-running"
            ? "This schedule is already running."
            : "OpenClaw did not run this schedule. Check it in OpenClaw.",
        );
      return { ran: true };
    },
    async removeAutomation({ id } = {}, authorize = () => {}) {
      authorize();
      if (typeof id !== "string" || !id || id.length > 200) throw fail(400, "Choose a scheduled job.");
      const result = await rpc("cron.remove", { id }, undefined, authorize);
      if (result?.ok === false || result?.removed === false)
        throw fail(409, "OpenClaw did not remove this schedule. Refresh before trying again.");
      return { removed: true };
    },
    async settings(
      { key, label, model, thinkingLevel } = {},
      authorize = () => {},
    ) {
      authorize();
      const row = await known(key);
      authorize();
      if (!writable(row))
        throw fail(
          403,
          "Reach changes only chats it made. Channel and scheduled chats are managed in OpenClaw.",
        );
      if (
        ["running", "unknown"].includes(runs.get(key)?.status) ||
        activeApprovals(key).length
      )
        throw fail(
          409,
          "Wait for OpenClaw to finish before changing this chat.",
        );
      const patch = { key };
      if (label !== undefined) {
        if (typeof label !== "string" || !label.trim() || label.trim().length > LABEL_MAX)
          throw fail(400, `Choose a chat name of up to ${LABEL_MAX} characters.`);
        patch.label = label.trim();
      }
      if (model !== undefined) {
        if (
          model !== null &&
          (typeof model !== "string" || !model.trim() || model.length > 200)
        )
          throw fail(400, "Choose a model or the agent default.");
        patch.model = model;
      }
      if (thinkingLevel !== undefined) {
        if (
          thinkingLevel !== null &&
          ![
            "off",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
            "adaptive",
          ].includes(thinkingLevel)
        )
          throw fail(400, "Choose a thinking level or the agent default.");
        patch.thinkingLevel = thinkingLevel;
      }
      if (Object.keys(patch).length === 1)
        throw fail(400, "Choose a chat setting to change.");
      const result = await rpc("sessions.patch", patch, undefined, authorize).catch((error) => {
        if (error?.labelInUse === true)
          throw fail(409, "Another OpenClaw chat already has this name. Choose another.");
        throw error;
      });
      if (result?.ok !== true)
        throw fail(
          502,
          "OpenClaw did not confirm the chat settings. Refresh before trying again.",
        );
      listAt = 0;
      settingVersions.set(key, (settingVersions.get(key) || 0) + 1);
      if (settingVersions.size > 1024)
        settingVersions.delete(settingVersions.keys().next().value);
      changed();
      return { saved: true };
    },
    // For features in their own files (server/openclaw-*.mjs): one Gateway
    // method through the same live authorization and support checks.
    call(method, params = {}, authorize = () => {}, waitMs) {
      return rpc(method, params, undefined, authorize, waitMs);
    },
    // Whether the connected Gateway lists `method` (true before connecting).
    can(method) {
      return can(method);
    },
    // Every Gateway event, as (event, payload); payloads are OpenClaw's own
    // text, so redact before anything reaches a phone.
    onEvent(listener) {
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    redact: (value) => redact(value),
    // Whether Reach's Gateway connection is open now (relays, workflows).
    connected: () => ready,
    // The connected Gateway's own version ("" before connecting).
    server: () => ({ version: serverVersion }),
    // Approvals came or went (notifications look then, not on a beat).
    onApprovalsChange(listener) {
      approvalListeners.add(listener);
      return () => approvalListeners.delete(listener);
    },
    async overview() {
      const version = listStamp();
      try {
        const rows = await list();
        return {
          connected: true,
          sessions: rows.map(session).sort((a, b) => b.updatedAt - a.updatedAt),
          approvals: activeApprovals(),
          revision,
          version,
        };
      } catch (error) {
        return {
          connected: false,
          sessions: [],
          approvals: [],
          error: error.message,
          // Installed here, its Gateway just isn't running (gatewayStart).
          ...(error.gatewayDown ? { canStart: true } : {}),
          revision,
          version,
        };
      }
    },
    async history(key, limit = 200) {
      const version = chatStamp(key);
      const row = await known(key);
      limit = Math.max(1, Math.min(1000, Math.floor(Number(limit) || 200)));
      const kept = histories.get(key);
      const turn = turnOf(key);
      const result =
        kept &&
        kept.turn === turn &&
        kept.limit === limit &&
        Date.now() - kept.at < 10000
          ? kept.result
          : await rpc("chat.history", { sessionKey: key, limit });
      if (result !== kept?.result) {
        histories.delete(key);
        histories.set(key, { turn, limit, at: Date.now(), result });
        if (histories.size > 16)
          histories.delete(histories.keys().next().value);
      }
      if (!Array.isArray(result?.messages))
        throw fail(502, "OpenClaw returned unsupported conversation history.");
      await reconcile(key);
      const messages = result.messages.filter(
        (m) => m && typeof m === "object",
      );
      const run = runs.get(key);
      const lastAssistant = [...messages]
        .reverse()
        .find((m) => m.role === "assistant");
      // History can be committed before the final event. Do not show that same
      // answer again as the live bubble (but preserve genuinely repeated turns).
      const assistantIsCurrent =
        messages.lastIndexOf(lastAssistant) >
        messages.findLastIndex((m) => m.role === "user");
      const streaming =
        run?.text &&
        !(
          assistantIsCurrent && textOf(lastAssistant).trim() === run.text.trim()
        )
          ? run.text
          : "";
      // OpenClaw's bookkeeping is not conversation: after a failed model it
      // writes the prompt again (or `fallbackRetry`) for the next one, and a
      // reply it posted to WhatsApp etc. is written again as a
      // "delivery-mirror". Each shows once; the reply says where it went.
      const hidden = new Set(),
        sentTo = new Map();
      let asked = null,
        reply = -1;
      messages.forEach((m, i) => {
        const text = textOf(m).trim();
        if (m.role === "user") {
          const before = messages[i - 1];
          if (
            before?.role === "assistant" &&
            before.stopReason === "error" &&
            (text === asked || text === fallbackRetry)
          )
            return hidden.add(i);
          asked = text;
          reply = -1;
        } else if (m.role === "assistant" && text) {
          if (
            m.model === "delivery-mirror" &&
            reply >= 0 &&
            text === textOf(messages[reply]).trim()
          ) {
            hidden.add(i);
            sentTo.set(
              reply,
              row.deliveryContext?.channel ||
                row.lastChannel ||
                row.channel ||
                "",
            );
          } else reply = i;
        }
      });
      return {
        session: session(row),
        items: messages
          .map((m, i) => ({
            id: String(m.id || `${m.timestamp || 0}:${i}`),
            role: typeof m.role === "string" ? m.role : "system",
            // A voice note from a channel, named for what it is.
            text:
              textOf(m) ||
              (partLabels(m.content)[0]
                ? `[${partLabels(m.content)[0]} — open it in OpenClaw]`
                : Array.isArray(m.content) &&
                    m.content.some((p) => p?.type === "image")
                  ? "[Attachment — view in OpenClaw]"
                  : ""),
            at: m.timestamp,
            tool: m.role === "toolResult" || m.role === "tool",
            ...(sentTo.has(i) ? { sentTo: sentTo.get(i) } : {}),
          }))
          .filter((m, i) => m.text && !hidden.has(i)),
        streaming,
        error: run?.error || "",
        delivery: run?.delivery || null,
        phase:
          run?.status === "running" && run.retrying
            ? "retrying"
            : run?.generated && run?.status === "running"
              ? "delivery"
              : "generation",
        // Why it's trying another model (that one's error).
        ...(run?.status === "running" && run.retrying
          ? { retrying: run.retrying }
          : {}),
        approvals: activeApprovals(key),
        revision,
        version,
        historyLimit: limit,
        mayHaveOlder: messages.length >= limit,
      };
    },
    async send(
      { key, text, deliver = false, requestId },
      authorize = () => {},
    ) {
      authorize();
      validKey(key);
      // Reach never asks OpenClaw to post outside Reach: a "reply via
      // WhatsApp" in a group session went to the whole group (Oct 5). Refused
      // here, before any Gateway call, whoever asks.
      if (deliver !== false)
        throw fail(
          403,
          "Reach doesn’t post to WhatsApp, Discord or other apps. Replies stay in Reach and OpenClaw. Nothing was sent.",
        );
      if (typeof text !== "string" || !text.trim() || text.length > 100000)
        throw fail(400, "Enter a message of at most 100,000 characters.");
      if (typeof requestId !== "string" || !/^[\w-]{8,100}$/.test(requestId))
        throw fail(400, "A message request ID is required.");
      const signature = crypto
        .createHash("sha256")
        .update(JSON.stringify({ key, text, deliver }))
        .digest("hex");
      const previous = attempts.get(requestId);
      if (previous) {
        if (previous.signature !== signature)
          throw fail(
            409,
            "This message request ID was already used for a different message or destination.",
          );
        return previous.promise;
      }
      if (attempts.size >= 2048)
        throw fail(
          503,
          "Reach’s OpenClaw send limit was reached. Restart Reach after current runs finish.",
        );
      const attempt = { signature };
      attempt.promise = (async () => {
        const row = await known(key);
        authorize();
        if (!writable(row)) {
          attempt.safeToRetry = true;
          throw fail(
            403,
            `This chat belongs to ${readableName(row)}. Reach shows it but doesn’t write in it, so nothing reaches ${channelOf(row) === "webchat" ? "it" : "that app"} from here. Nothing was sent.`,
          );
        }
        const target = deliver ? destination(row) : null;
        if (deliver && !target)
          throw fail(
            400,
            "This session has no external reply destination. Choose Reply in Reach.",
          );
        await reconcile(key);
        authorize();
        if (
          ["running", "unknown"].includes(runs.get(key)?.status) ||
          activeApprovals(key).length
        )
          throw fail(
            409,
            "This OpenClaw session already has an active or unconfirmed run. Check it before sending another message.",
          );
        if (target) await checkChannel(target);
        authorize();
        // Recheck after asynchronous channel validation: another phone may send.
        if (["running", "unknown"].includes(runs.get(key)?.status))
          throw fail(409, "OpenClaw is already working in this session.");
        const method = target ? "agent" : "chat.send";
        const run = {
          runId: requestId,
          method,
          text: "",
          status: "running",
          updatedAt: now(),
          ...(target
            ? { delivery: { channel: target.channel, status: "pending" } }
            : {}),
        };
        if (!putRun(key, run))
          throw fail(
            503,
            "Too many OpenClaw runs are awaiting confirmation. Check OpenClaw before sending again.",
          );
        const complete = (frame) => {
          if (frame.payload?.runId && frame.payload.runId !== run.runId) return;
          const failed = !frame.ok || frame.payload?.status === "error";
          const deliveryStatus = frame.payload?.result?.deliveryStatus;
          const status =
            typeof deliveryStatus === "string"
              ? deliveryStatus
              : deliveryStatus?.status;
          const deliveryFailed =
            failed || ["failed", "partial_failed"].includes(status);
          run.delivery.status = deliveryFailed
            ? "failed"
            : status === "sent"
              ? "sent"
              : status === "suppressed"
                ? "suppressed"
                : "unconfirmed";
          finishRun(
            key,
            run,
            deliveryFailed ? "error" : "idle",
            deliveryFailed
              ? frame.error?.message ||
                  frame.payload?.summary ||
                  "OpenClaw could not deliver this reply. Check the channel before retrying."
              : "",
          );
        };
        try {
          const result = await rpc(
            method,
            {
              sessionKey: key,
              message: text,
              deliver,
              idempotencyKey: requestId,
              ...(target
                ? {
                    replyChannel: target.channel,
                    replyTo: target.to,
                    bestEffortDeliver: false,
                    ...(target.accountId
                      ? { replyAccountId: target.accountId }
                      : {}),
                    ...(target.threadId != null
                      ? { threadId: String(target.threadId) }
                      : {}),
                  }
                : {}),
            },
            target ? complete : undefined,
            authorize,
          );
          if (
            typeof result?.runId !== "string" ||
            result.runId !== requestId ||
            !["started", "accepted", "in_flight", "ok", "error"].includes(
              result.status,
            )
          )
            throw fail(
              502,
              "OpenClaw returned an unrecognized send result. Check this session before retrying.",
            );
          if (!target && ["ok", "error"].includes(result.status))
            finishRun(
              key,
              run,
              result.status === "ok" ? "idle" : "error",
              result.summary,
            );
          return { runId: result.runId, status: run.status };
        } catch (error) {
          if (run.status === "running")
            finishRun(
              key,
              run,
              error.status === 409 || beforeDispatchFailures.has(error)
                ? "error"
                : "unknown",
              error.message,
            );
          if (beforeDispatchFailures.has(error)) {
            // No Gateway run exists yet: a later explicit retry of this ID
            // must be able to receive its own streaming/terminal events.
            terminalRuns.delete(requestId);
          }
          if (error.status === 409 || beforeDispatchFailures.has(error))
            attempt.safeToRetry = true;
          throw error;
        }
      })().catch((error) => {
        // Preflight refusals and explicit RPC rejections are safe to retry after
        // the user fixes the channel. Transport-uncertain sends stay deduped.
        if (
          attempt.safeToRetry ||
          ![...runs.values()].some((r) => r.runId === requestId)
        )
          attempts.delete(requestId);
        throw error;
      });
      attempts.set(requestId, attempt);
      return attempt.promise;
    },
    // A new chat started from Reach: a webchat session of Reach's own (no
    // WhatsApp or Discord behind it), the only kind Reach writes in. Works
    // on Gateways too old to move chats (no chat.inject).
    async create(
      { title = "", agentId, model, thinkingLevel } = {},
      authorize = () => {},
    ) {
      authorize();
      if (agentId !== undefined) {
        if (typeof agentId !== "string" || !/^[\w-]{1,80}$/.test(agentId))
          throw fail(400, "Choose an OpenClaw agent.");
        const roster = await rpc("agents.list", {}, undefined, authorize);
        if (!roster?.agents?.some((a) => a.id === agentId))
          throw fail(400, "This OpenClaw agent is no longer available.");
      }
      const key = `agent:${agentId || "main"}:reach-${crypto.randomUUID().slice(0, 8)}`;
      await rpc("sessions.reset", { key, reason: "new" }, undefined, authorize);
      listAt = 0;
      try {
        authorize();
        if (model !== undefined || thinkingLevel !== undefined)
          await api.settings({ key, model, thinkingLevel }, authorize);
        if (title)
          await nameChat(key, title, authorize).catch((error) => {
            if (authorizationFailures.has(error)) throw error;
          });
        listAt = 0;
        return { key };
      } catch (error) {
        // Cleanup only this newly created session, even after access ends.
        await rpc("sessions.delete", { key, deleteTranscript: true }).catch(
          () => {},
        );
        listAt = 0;
        throw error;
      }
    },
    // A new chat and its first message, once per requestId (a phone that
    // asks again after a dropped answer gets the same chat, not a second).
    // A message OpenClaw refused leaves no empty chat behind; one whose
    // fate is unknown keeps its chat, which shows what happened.
    start(
      { text, requestId, agentId, model, thinkingLevel },
      authorize = () => {},
    ) {
      authorize();
      if (typeof text !== "string" || !text.trim() || text.length > 100000)
        throw fail(400, "Write what you'd like OpenClaw to do.");
      if (typeof requestId !== "string" || !/^[\w-]{8,100}$/.test(requestId))
        throw fail(400, "A message request ID is required.");
      const known = starts.get(requestId);
      const choices = JSON.stringify([agentId, model, thinkingLevel]);
      if (known) {
        if (known.text !== text || known.choices !== choices)
          throw fail(
            409,
            "This message request ID was already used for a different message.",
          );
        return known.promise;
      }
      const started = { text, choices };
      started.promise = (async () => {
        const { key } = await api.create(
          {
            title: text.trim().split("\n")[0],
            agentId,
            model,
            thinkingLevel,
          },
          authorize,
        );
        try {
          await api.send(
            { key, text, requestId: `new-${requestId}` },
            authorize,
          );
        } catch (error) {
          if (!(error.status >= 400 && error.status < 500)) return { key };
          await api.remove(key).catch(() => {});
          throw error;
        }
        return { key };
      })().catch((error) => {
        starts.delete(requestId);
        throw error;
      });
      starts.set(requestId, started);
      if (starts.size > 256) starts.delete(starts.keys().next().value);
      return started.promise;
    },
    // Removes a chat Reach made (never one of WhatsApp's or Discord's).
    // A relay's or workflow's result, posted where this chat's own messages
    // go: the WhatsApp or Telegram chat that asked, one to one. The owner
    // chose it for that relay (Oct 8). Never a group or channel (Oct 5: a
    // reply reached a friends' WhatsApp group), never another recipient,
    // and no agent runs: OpenClaw's `send` delivers the text as it is.
    async post({ key, text, requestId }, authorize = () => {}) {
      authorize();
      validKey(key);
      if (typeof text !== "string" || !text.trim() || text.length > 20000)
        throw fail(400, "Nothing to post, or too long to post (20,000 characters at most).");
      if (typeof requestId !== "string" || !/^[\w-]{8,100}$/.test(requestId))
        throw fail(400, "A post request ID is required.");
      const row = await known(key);
      authorize();
      const target = destination(row);
      if (!target)
        throw fail(409, "This chat has no app to post to. Nothing was sent.");
      if (
        /:group:|:channel:|@g\.us/i.test(`${key} ${target.to}`) ||
        /group|channel/i.test(String(row.chatType || ""))
      )
        throw fail(403, "Reach posts only to one-to-one chats, never groups or channels. Nothing was sent.");
      await checkChannel(target);
      authorize();
      const result = await rpc(
        "send",
        {
          to: target.to,
          message: text.trim(),
          channel: target.channel,
          ...(typeof target.accountId === "string" && target.accountId
            ? { accountId: target.accountId }
            : {}),
          ...(target.threadId != null && target.threadId !== ""
            ? { threadId: String(target.threadId) }
            : {}),
          sessionKey: key,
          idempotencyKey: requestId,
        },
        undefined,
        authorize,
      );
      if (result?.ok === false)
        throw fail(502, "OpenClaw didn't confirm the post. Check the chat before posting again.");
      return { posted: true, channel: target.channel };
    },
    async remove(key, authorize = () => {}) {
      authorize();
      if (!reachMade(key)) throw fail(403, "Reach removes only chats it made.");
      await rpc(
        "sessions.delete",
        { key, deleteTranscript: true },
        undefined,
        authorize,
      );
      listAt = 0;
      return { removed: true };
    },
    // Whether this Gateway can take a chat moved from another agent.
    canMove: () =>
      !methods || methods.has("chat.inject") || injectable === true,
    // A chat moved here from another agent (agent-sessions/move.mjs): a new
    // session named after it, its history added as notes (OpenClaw's app
    // shows them and its agent reads them; nothing runs until a message).
    // One that fails half-way is removed again.
    async fork(
      { title = "", notes = [], label = "Moved" } = {},
      authorize = () => {},
    ) {
      authorize();
      const key = `agent:main:reach-${crypto.randomUUID().slice(0, 8)}`;
      await rpc("sessions.reset", { key, reason: "new" }, undefined, authorize);
      try {
        authorize();
        if (title) await nameChat(key, title, authorize);
        for (const message of notes)
          await rpc(
            "chat.inject",
            { sessionKey: key, message, label: chatLabel(label, 100) },
            undefined,
            authorize,
          );
        authorize();
      } catch (error) {
        await rpc("sessions.delete", { key, deleteTranscript: true }).catch(
          () => {},
        );
        throw error;
      }
      listAt = 0;
      return { key };
    },
    async stop(key, authorize = () => {}) {
      authorize();
      await known(key);
      const result = await rpc(
        "chat.abort",
        { sessionKey: key },
        undefined,
        authorize,
      );
      if (result?.aborted !== true) {
        await reconcile(key);
        if (["running", "unknown"].includes(runs.get(key)?.status))
          throw fail(
            409,
            "OpenClaw did not confirm stopping this run. Stop it in OpenClaw on your computer.",
          );
        return result;
      }
      const run = runs.get(key);
      if (run) finishRun(key, run, "idle");
      return result;
    },
    async approve(id, decision, authorize = () => {}) {
      authorize();
      const prompt = approvals.get(id);
      if (!prompt || prompt.expiresAtMs <= Date.now())
        throw fail(
          404,
          "This OpenClaw approval expired or was already answered.",
        );
      if (!["allow-once", "allow-always", "deny"].includes(decision))
        throw fail(400, "Choose Allow once, Always allow or Deny.");
      if (prompt.replying)
        throw fail(409, "This answer is already being sent.");
      if (prompt.attempted)
        throw fail(
          409,
          "This answer was already attempted. Check OpenClaw before answering again.",
        );
      if (
        !ready ||
        socket !== prompt.socket ||
        socket?.readyState !== WebSocket.OPEN
      )
        throw connectionError();
      if (methods && !methods.has("exec.approval.resolve"))
        throw fail(
          409,
          "This OpenClaw Gateway cannot accept approvals. Answer in OpenClaw on your computer.",
        );
      authorize();
      prompt.replying = true;
      prompt.attempted = true;
      try {
        // Use the connection that requested this decision; never reconnect
        // and send an old answer into a different Gateway session.
        const result = await request("exec.approval.resolve", { id, decision });
        if (result?.ok !== true)
          throw fail(
            409,
            "OpenClaw did not confirm the answer. Check the request before retrying.",
          );
        if (approvals.get(id) === prompt) {
          approvals.delete(id);
          approvalsChanged();
        }
        changed();
        return result;
      } finally {
        prompt.replying = false;
      }
    },
    // Resolves once what a phone shows changed since `after` (one chat,
    // given its key; else the list and its approvals), or after ms: phones
    // wait on this instead of asking every few seconds. Never connects.
    changes({ key, after = "", ms = 25000, signal } = {}) {
      const version = () => (key ? chatStamp(key) : listStamp());
      return new Promise((resolve) => {
        const waiter = {
          check: () => version() !== after && waiter.done(),
          done: () => {
            clearTimeout(timer);
            waiters.delete(waiter);
            signal?.removeEventListener?.("abort", waiter.done);
            resolve({ version: version() });
          },
        };
        const timer = setTimeout(
          waiter.done,
          Math.max(0, Math.min(Number(ms) || 0, 60000)),
        );
        waiters.add(waiter);
        signal?.addEventListener?.("abort", waiter.done);
        waiter.check();
      });
    },
    close() {
      closed = true;
      clearTimeout(redial);
      clearTimeout(telling);
      for (const waiter of [...waiters]) waiter.done();
      const old = socket;
      socket = null;
      old?.terminate();
      reset(connectionError());
    },
  };
  return api;
}

// Starts this computer's own OpenClaw Gateway, the service OpenClaw set up
// (`openclaw gateway start`: launchd, systemd or schtasks), for a phone that
// found it stopped. Fixed arguments; never a remote profile.
export async function startOpenClawGateway({
  configuration = localOpenClawConfig,
  run = promisify(execFile),
  env = process.env,
  platform = process.platform,
  authorize = () => {},
} = {}) {
  authorize();
  await configuration();
  authorize();
  try {
    if (platform === "win32")
      await run("cmd.exe", ["/d", "/c", "openclaw gateway start"], {
        timeout: 30000,
        windowsHide: true,
      });
    else
      await run(env.SHELL || "/bin/sh", ["-lc", "openclaw gateway start"], {
        timeout: 30000,
      });
  } catch {
    throw fail(
      503,
      "OpenClaw’s Gateway didn’t start. On this computer, run: openclaw gateway start",
    );
  }
}

// Channels a phone can add with a bot token, through OpenClaw's own
// `openclaw channels add` (its checks, its config; the Gateway then starts
// the channel). Tokens go to OpenClaw only: never stored or echoed by Reach.
export const TOKEN_CHANNELS = {
  telegram: ["token"],
  discord: ["token"],
  slack: ["botToken", "appToken"],
};
const tokenShape = /^[\x21-\x7e]{8,4096}$/;
export async function addOpenClawChannel(
  { channel, token, botToken, appToken, name } = {},
  {
    run = promisify(execFile),
    env = process.env,
    platform = process.platform,
    authorize = () => {},
  } = {},
) {
  authorize();
  const fields = TOKEN_CHANNELS[channel];
  if (!fields || !Object.hasOwn(TOKEN_CHANNELS, channel))
    throw fail(400, "Choose Telegram, Discord or Slack.");
  const values = { token, botToken, appToken };
  for (const field of fields)
    if (typeof values[field] !== "string" || !tokenShape.test(values[field].trim()))
      throw fail(400, field === "appToken" ? "Paste the Slack app token (xapp-…)." : field === "botToken" ? "Paste the Slack bot token (xoxb-…)." : "Paste the bot token.");
  if (name !== undefined && name !== "" && (typeof name !== "string" || name.length > 80 || /[\u0000-\u001f]/.test(name)))
    throw fail(400, "Choose a shorter account name.");
  if (platform === "win32") throw fail(409, "On Windows, add channels in OpenClaw on this computer.");
  // OpenClaw copies the token into its own config (a --token-file would be
  // kept as a path to that file instead).
  const args = ["channels", "add", "--channel", channel];
  if (channel === "slack")
    args.push("--bot-token", values.botToken.trim(), "--app-token", values.appToken.trim());
  else args.push("--token", values.token.trim());
  if (name) args.push("--name", name.trim());
  authorize();
  try {
    // "$@": the tokens are arguments, never shell text.
    await run(env.SHELL || "/bin/sh", ["-lc", 'exec openclaw "$@"', "openclaw", ...args], { timeout: 60000 });
  } catch {
    throw fail(409, "OpenClaw didn't accept this channel. Check the token and try again.");
  }
  return { added: true };
}

export const SETUP_SECTIONS = ["model", "channels"];
export function openClawRoutes(
  app,
  client,
  { startGateway = startOpenClawGateway, settleMs = 500, openSetup, addChannel = addOpenClawChannel, features = FEATURES, ...context } = {},
) {
  const base = "/api/sessions/openclaw";
  const authorize = (req) => () => req.reauthorize();
  for (const feature of features)
    feature.routes(app, client, { ...context, base, authorize, openSetup });
  app.post(`${base}/channels/add`, async (req, res) => {
    const added = await addChannel(req.body || {}, { authorize: authorize(req) });
    res.json(added);
  });
  // Older phones must not silently launch a terminal for advanced setup.
  app.post(`${base}/setup`, async (req, _res) => {
    authorize(req)();
    throw fail(409, "Use guided setup in Reach. Refresh the page to get the new setup controls.");
  });
  app.get(`${base}/overview`, async (_req, res) =>
    res.json(await client.overview()),
  );
  // Waits until what a phone shows changes (?key: one chat; else the list)
  // or a while passes; the phone reads it again then.
  app.get(`${base}/changes`, async (req, res) => {
    const gone = new AbortController();
    res.on("close", () => gone.abort());
    const key =
      typeof req.query.key === "string" && req.query.key
        ? req.query.key
        : undefined;
    res.json(
      await client.changes({
        key,
        after: String(req.query.after ?? ""),
        ms: key ? 10000 : 25000,
        signal: gone.signal,
      }),
    );
  });
  app.get(`${base}/history`, async (req, res) =>
    res.json(await client.history(req.query.key, req.query.limit)),
  );
  app.get(`${base}/catalog`, async (_req, res) =>
    res.json(await client.catalog()),
  );
  app.get(`${base}/channels`, async (req, res) =>
    res.json(await client.channels({ refresh: req.query.refresh === "1" })),
  );
  app.post(`${base}/channels/whatsapp/link`, async (req, res) =>
    res.json(await client.linkWhatsApp(req.body || {}, authorize(req))),
  );
  app.post(`${base}/channels/whatsapp/wait`, async (req, res) =>
    res.json(await client.waitWhatsApp(req.body || {}, authorize(req))),
  );
  app.post(`${base}/automations/new`, async (req, res) =>
    res.json(await client.addAutomation(req.body || {}, authorize(req))),
  );
  app.post(`${base}/automations/run`, async (req, res) =>
    res.json(await client.runAutomation(req.body || {}, authorize(req))),
  );
  app.post(`${base}/automations/remove`, async (req, res) =>
    res.json(await client.removeAutomation(req.body || {}, authorize(req))),
  );
  app.get(`${base}/automations`, async (req, res) =>
    res.json(
      await client.automations({
        offset: req.query.offset,
        query: req.query.query,
      }),
    ),
  );
  app.post(`${base}/automations`, async (req, res) =>
    res.json(await client.setAutomation(req.body || {}, authorize(req))),
  );
  app.post(`${base}/settings`, async (req, res) =>
    res.json(await client.settings(req.body || {}, authorize(req))),
  );
  app.post(`${base}/send`, async (req, res) =>
    res.json(await client.send(req.body || {}, authorize(req))),
  );
  // A new chat from Reach: a webchat session of Reach's own, then its first
  // message (replies stay in Reach and OpenClaw).
  // An older phone sends no requestId: one is made for it.
  app.post(`${base}/new`, async (req, res) =>
    res.json(
      await client.start(
        {
          text: req.body?.text,
          requestId: req.body?.requestId ?? crypto.randomUUID(),
          agentId: req.body?.agentId,
          model: req.body?.model,
          thinkingLevel: req.body?.thinkingLevel,
        },
        authorize(req),
      ),
    ),
  );
  // Deletes a chat Reach made, in OpenClaw too.
  app.post(`${base}/remove`, async (req, res) =>
    res.json(await client.remove(req.body?.key, authorize(req))),
  );
  // OpenClaw's Gateway stopped: start it, then answer once it's listed.
  app.post(`${base}/gateway/start`, async (req, res) => {
    const current = authorize(req);
    current();
    await startGateway({ authorize: current });
    for (let i = 0; i < 20; i++) {
      current();
      const overview = await client.overview();
      current();
      if (overview.connected) return res.json(overview);
      await new Promise((r) => setTimeout(r, settleMs));
    }
    throw fail(
      503,
      "OpenClaw’s Gateway started but isn’t answering yet. Try again in a moment.",
    );
  });
  app.post(`${base}/stop`, async (req, res) =>
    res.json(await client.stop(req.body?.key, authorize(req))),
  );
  app.post(`${base}/approval`, async (req, res) =>
    res.json(
      await client.approve(req.body?.id, req.body?.decision, authorize(req)),
    ),
  );
}
