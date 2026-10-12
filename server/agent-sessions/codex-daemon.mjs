import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { object, compatibilityError, uncertainDelivery, validateCodexResult, readOnlyRpc, probeAgent } from "./compatibility.mjs";
import { findCodexExecutable } from "../capabilities.mjs";
import { spawnable } from "../agent-cli.mjs";
import { computerWord } from "../computer-word.mjs";
import { trustedSocket } from "./trusted-socket.mjs";

const exec = promisify(execFile);

// The shared local Codex app-server daemon (the one the Codex CLI and
// `codex agents` use). Verified: `codex app-server daemon start` is
// idempotent and reports the control socket, which speaks JSON-RPC over a
// WebSocket on that Unix socket. Threads created here appear in the Codex app.
// "codex_cli_rs/0.158.0-alpha.2.1 (Mac OS 26.6.2; arm64) …" → its version.
export const serviceVersionOf = (agent) =>
  typeof agent === "string" ? /^[\w.-]+\/(\d+\.\d+\.\d+[\w.+-]*)/.exec(agent.trim())?.[1] || null : null;

// "0.158.0-alpha.2.1" older than "0.162.0-alpha.2" (major.minor.patch);
// either unreadable: not older.
export function olderVersion(a, b) {
  const parts = (v) => /^(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""))?.slice(1).map(Number);
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// The model and effort new chats use, as config.toml sets them at its top
// level (a [profile] table's own `model` is not the default), or in the
// profile its top level picks (`profile = "x"`), which Codex reads first.
export function codexDefaults(home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  let text = "";
  try { text = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch { return {}; }
  const top = text.split(/^\s*\[/m)[0];
  const tables = text.slice(top.length).split(/^(?=\s*\[)/m);
  const value = (key, part = top) => new RegExp(`^\\s*${key}\\s*=\\s*(?:"([^"\\n]+)"|'([^'\\n]+)')`, "m").exec(part)?.slice(1).find(Boolean) || null;
  const profile = value("profile");
  // [profiles.x], [profiles."x"] or [profiles.'x'] itself, not a table inside it.
  const table = profile
    ? tables.find((t) => {
        const name = /^\s*\[\s*profiles\s*\.\s*(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*\]/.exec(t);
        return name && name.slice(1).find(Boolean) === profile;
      })
    : null;
  const body = table ? table.slice(table.indexOf("]") + 1) : "";
  const pick = (key) => (body && value(key, body)) || value(key);
  return { model: pick("model"), effort: pick("model_reasoning_effort") };
}

// The installed CLI's own model catalog, from a one-shot app-server of its
// own over stdio (initialize, model/list, gone). The shared daemon can run an
// older Codex than the CLI (verified: service 0.158 while the CLI is 0.162),
// and its catalog then lacks newer models the Codex app offers.
export function cliModelList(file, { timeout = 8000, start = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const cli = spawnable(file);
    const child = start(cli.file, [...cli.args, "app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    // Whole characters: a chunk can end inside one (a model's description).
    child.stdout.setEncoding("utf8");
    const done = (settle, value) => {
      clearTimeout(timer);
      try { child.kill(); } catch {}
      settle(value);
    };
    const timer = setTimeout(() => done(reject, new Error("Codex did not answer (model/list).")), timeout);
    const send = (message) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
    child.on("error", (e) => done(reject, e));
    child.on("exit", () => done(reject, new Error("Codex stopped before listing its models.")));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      for (let i; (i = buffer.indexOf("\n")) >= 0; ) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        // Replies only (a request from the server has a method).
        if (!object(message) || message.method) continue;
        if (message.id === 1) {
          if (message.error) return done(reject, new Error("Codex did not start."));
          send({ method: "initialized" });
          send({ id: 2, method: "model/list", params: {} });
        } else if (message.id === 2) {
          if (message.error) return done(reject, new Error(message.error.message || "Codex could not list its models."));
          try { done(resolve, validateCodexResult("model/list", message.result)); }
          catch (e) { done(reject, e); }
        }
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "reach", title: "Reach", version: "0.1.0" } } });
  });
}

// The session service's socket, held to Reach's rule for Codex sockets
// (trusted-socket.mjs); the socket to connect to, or why it isn't trusted.
export async function ownSocket(file, options) {
  try {
    return await trustedSocket(file, options);
  } catch (e) {
    throw Object.assign(new Error(`Codex's session service isn't one Reach can trust here: ${e.because || "it couldn't be checked"}.`), { status: 503 });
  }
}
export function createCodexDaemon({
  locate = findCodexExecutable,
  run = exec,
  connectTimeout = 8000,
  requestTimeout = 30000,
  // After a message Reach can't read, calls fail at once for this long, then
  // one new connection is tried (not a Codex start on every poll).
  protocolCooldown = 30000,
  Socket = WebSocket,
  check = run === exec ? (file) => probeAgent("codex", file) : async () => ({ status: "available", version: null }),
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
  // Only the real Codex is asked for its CLI catalog and config defaults.
  listCliModels = run === exec ? cliModelList : null,
  defaults = run === exec ? codexDefaults : null,
  // The session service's socket must be yours, in a folder no one else can
  // swap it in, as the Codex app's is (codex-desktop.mjs; connections audit,
  // Oct 10). Only the real Codex is checked.
  checkSocket = run === exec ? ownSocket : async () => {},
} = {}) {
  let socket = null;
  let ready = null;
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  const deprecations = new Set();
  const closeListeners = new Set();
  const readyListeners = new Set();
  let requestHandler = null;
  // Set when Reach quits; nothing reconnects after that.
  let closed = false;
  let version = null;
  let serviceVersion = null;
  // Off until Codex changes version: a method Codex says it doesn't have
  // (-32601). Everything else odd (a message Reach can't read, a reply in a
  // shape it doesn't know, a notification it couldn't take) fails that call
  // or message alone, shows Codex as degraded, and clears once it works
  // again: one odd reply used to switch a feature off for every chat until
  // Reach restarted (reliability audit, Oct 10).
  const issues = new Map();
  const recent = new Map();
  let protocolUntil = 0;
  const noteIssue = (key, error) => {
    if (key === "protocol") protocolUntil = Date.now() + protocolCooldown;
    if (!recent.has(key)) console.warn(`Reach: Codex ${key === "protocol" ? "sent a message Reach can't read" : key === "notifications" ? "sent an update Reach couldn't take" : `answered ${key} in a shape Reach doesn't know`}; that alone failed.`);
    recent.set(key, error);
  };
  async function compatibility() {
    const report = await check(await locate());
    if (version !== report.version) {
      const upgraded = version !== null;
      issues.clear(); recent.clear(); version = report.version;
      if (upgraded) socket?.terminate(); // Re-negotiate rather than use an old daemon connection.
    }
    const all = new Map([...recent, ...issues]);
    return { ...report, ...(serviceVersion ? { serviceVersion } : {}), status: all.size && report.status === "available" ? "degraded" : report.status, issues: [...all.values()].map(e => ({ feature: e.feature, reason: e.message })) };
  }
  const closedError = () => new Error("Codex session service is closed.");
  const fail = (message) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(readOnlyRpc(p.method) ? new Error(message) : uncertainDelivery("codex"));
    }
    pending.clear();
  };
  async function socketPath() {
    const codex = await locate();
    if (!codex) throw Object.assign(new Error(`Codex is not installed on this ${computerWord(platform)}.`), { status: 503, code: "AGENT_NOT_INSTALLED" });
    const report = await compatibility();
    if (!["available", "degraded"].includes(report.status)) throw compatibilityError("codex", "CLI");
    const cli = spawnable(codex);
    const { stdout } = await run(cli.file, [...cli.args, "app-server", "daemon", "start"], {
      timeout: 20000,
      maxBuffer: 65536,
    });
    const status = JSON.parse(stdout.trim().split("\n").pop());
    if (!status.socketPath) throw new Error("Codex did not report its session service.");
    return (await checkSocket(status.socketPath)) || status.socketPath;
  }
  async function open() {
    const path = await socketPath();
    if (closed) throw closedError();
    const ws = new Socket(`ws+unix://${path}:/`, { handshakeTimeout: connectTimeout });
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    // Reach quit while this connection was being made.
    if (closed) {
      ws.terminate();
      throw closedError();
    }
    ws.on("message", (data) => {
      let message;
      // Unreadable: this connection ends (what it was doing fails); the next
      // call opens a new one.
      try {
        message = JSON.parse(data.toString());
      } catch {
        noteIssue("protocol", compatibilityError("codex", "protocol"));
        ws.terminate();
        return;
      }
      if (!object(message)) {
        noteIssue("protocol", compatibilityError("codex", "protocol"));
        ws.terminate();
        return;
      }
      if (message.id !== undefined && pending.has(message.id) && ("result" in message || "error" in message)) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) {
          if (message.error.code === -32601 || message.error.code === -32602) {
            const error = compatibilityError("codex", p.method);
            // Invalid params can be one invalid user selection, not a removed API.
            // Do not permanently disable every conversation for that case.
            if (message.error.code === -32601) issues.set(p.method, error);
            p.reject(error);
          } else p.reject(Object.assign(new Error(message.error.message || "Codex request failed."), { data: message.error }));
        } else {
          let result;
          try { result = validateCodexResult(p.method, message.result); }
          catch (e) { noteIssue(p.method, e); p.reject(e); return; }
          recent.delete(p.method);
          p.resolve(result);
        }
      } else if (message.method && message.id !== undefined) {
        // A request from Codex to this client (approvals, questions). Exactly
        // one handler answers; unhandled requests get a JSON-RPC error.
        let replied = false;
        const reply = (payload) => new Promise((resolve, reject) => {
          if (replied || socket !== ws || ws.readyState !== WebSocket.OPEN)
            return reject(new Error("This approval connection ended or the answer was already attempted. Check Codex."));
          replied = true; // Even an uncertain write must never replay an approval.
          const timer = setTimeout(() => reject(uncertainDelivery("codex")), requestTimeout);
          try {
            ws.send(JSON.stringify({ id: message.id, ...payload }), (error) => {
              clearTimeout(timer);
              error ? reject(uncertainDelivery("codex")) : resolve();
            });
          } catch { clearTimeout(timer); reject(uncertainDelivery("codex")); }
        });
        const handler = requestHandler;
        if (!handler) void reply({ error: { code: -32601, message: "Not supported by Reach." } }).catch(() => {});
        else
          Promise.resolve()
            .then(() => handler(message, (result) => reply({ result }), (error) => reply({ error })))
            .catch(() => reply({ error: { code: -32603, message: "Reach could not answer." } }).catch(() => {}));
      } else if (message.method) {
        // Codex saying something Reach uses is going away: in Reach's log
        // once each, ahead of the update that removes it.
        if (message.method === "deprecationNotice" && typeof message.params?.summary === "string" && !deprecations.has(message.params.summary)) {
          deprecations.add(message.params.summary);
          console.warn(`Codex deprecation: ${message.params.summary}${message.params.details ? ` (${message.params.details})` : ""}`);
        }
        for (const listener of listeners) {
          try { listener(message); }
          catch { noteIssue("notifications", compatibilityError("codex", "notifications")); }
        }
      }
    });
    ws.on("close", () => {
      if (socket !== ws) return;
      socket = null;
      ready = null;
      fail("Codex session service disconnected.");
      // Subscriptions belong to the connection; a new one starts clean.
      for (const listener of closeListeners) {
        try { listener(); } catch { noteIssue("notifications", compatibilityError("codex", "notifications")); }
      }
    });
    ws.on("error", () => {});
    socket = ws;
    const hello = await send("initialize", {
      clientInfo: { name: "reach", title: "Reach", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    // The service's own version ("codex_cli_rs/0.158.0 (…)"): it updates
    // apart from the CLI Reach checks, so it's said as it is, or unknown.
    serviceVersion = serviceVersionOf(hello?.userAgent);
    ws.send(JSON.stringify({ method: "initialized" }));
    // A new connection that works: what the last one couldn't read is past.
    recent.delete("protocol");
    recent.delete("notifications");
    for (const listener of readyListeners) {
      try { listener(); } catch {}
    }
  }
  function send(method, params) {
    return new Promise((resolve, reject) => {
      if (!socket || socket.readyState !== WebSocket.OPEN)
        return reject(new Error("Codex session service is not connected."));
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(readOnlyRpc(method) ? new Error(`Codex did not answer (${method}).`) : uncertainDelivery("codex"));
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer, method });
      try { socket.send(JSON.stringify({ id, method, params })); }
      catch { pending.delete(id); clearTimeout(timer); reject(readOnlyRpc(method) ? new Error("Codex disconnected.") : uncertainDelivery("codex")); }
    });
  }
  // The CLI's catalog, kept a while per CLI version (a fresh app-server each
  // time would be slow); a failure too, so a stuck CLI doesn't hold every
  // model sheet for its timeout. Started, never waited for: the first model
  // sheet doesn't wait on it (up to its timeout), the next one has it; the
  // list it had stays in use while a newer one comes.
  let cliCatalog = null;
  const cliModels = listCliModels && (async (cliVersion) => {
    if (!cliCatalog || cliCatalog.version !== cliVersion || Date.now() - cliCatalog.at > 10 * 60 * 1000) {
      const file = await locate();
      if (!file) throw new Error("Codex is not installed.");
      const entry = { version: cliVersion, at: Date.now(), list: cliCatalog?.version === cliVersion ? cliCatalog.list : null };
      cliCatalog = entry;
      listCliModels(file).then((list) => { entry.list = list; }, () => {});
    }
    return cliCatalog.list;
  });
  return {
    compatibility,
    ...(cliModels ? { cliModels } : {}),
    ...(defaults ? { defaults: () => defaults() } : {}),
    async rpc(method, params = {}) {
      if (closed) throw closedError();
      if (issues.size) await compatibility();
      if (issues.has(method)) throw issues.get(method);
      if (recent.has("protocol") && Date.now() < protocolUntil) throw recent.get("protocol");
      if (!ready)
        ready = open().catch((e) => {
          const failed = socket;
          socket = null;
          ready = null;
          failed?.terminate();
          fail("Codex initialization failed.");
          throw e;
        });
      await ready;
      return send(method, params);
    },
    onNotification(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onReady(listener) {
      readyListeners.add(listener);
      return () => readyListeners.delete(listener);
    },
    // handler(message, resolve(result), reject(error))
    onRequest(handler) {
      requestHandler = handler;
    },
    // Reach is quitting: drop the connection at once (a closing handshake can
    // wait 30 s on a stuck daemon) and never reconnect.
    close() {
      closed = true;
      fail("Codex session service closed.");
      socket?.terminate();
      socket = null;
      ready = null;
    },
  };
}
