import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { object, compatibilityError, uncertainDelivery, validateCodexResult, readOnlyRpc, probeAgent } from "./compatibility.mjs";
import { findCodexExecutable } from "../capabilities.mjs";
import { computerWord } from "../computer-word.mjs";

const exec = promisify(execFile);

// The shared local Codex app-server daemon (the one the Codex CLI and
// `codex agents` use). Verified: `codex app-server daemon start` is
// idempotent and reports the control socket, which speaks JSON-RPC over a
// WebSocket on that Unix socket. Threads created here appear in the Codex app.
export function createCodexDaemon({
  locate = findCodexExecutable,
  run = exec,
  connectTimeout = 8000,
  requestTimeout = 30000,
  Socket = WebSocket,
  check = run === exec ? (file) => probeAgent("codex", file) : async () => ({ status: "available", version: null }),
  // "Mac", "Windows PC" or "computer" in what the phone is told (computer-word.mjs).
  platform = process.platform,
} = {}) {
  let socket = null;
  let ready = null;
  let seq = 0;
  const pending = new Map();
  const listeners = new Set();
  const closeListeners = new Set();
  let requestHandler = null;
  // Set when Reach quits; nothing reconnects after that.
  let closed = false;
  let version = null;
  const issues = new Map();
  async function compatibility() {
    const report = await check(await locate());
    if (version !== report.version) {
      const upgraded = version !== null;
      issues.clear(); version = report.version;
      if (upgraded) socket?.terminate(); // Re-negotiate rather than use an old daemon connection.
    }
    return { ...report, status: issues.size && report.status === "available" ? "degraded" : report.status, issues: [...issues.values()].map(e => ({ feature: e.feature, reason: e.message })) };
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
    const { stdout } = await run(codex, ["app-server", "daemon", "start"], {
      timeout: 20000,
      maxBuffer: 65536,
    });
    const status = JSON.parse(stdout.trim().split("\n").pop());
    if (!status.socketPath) throw new Error("Codex did not report its session service.");
    return status.socketPath;
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
      try {
        message = JSON.parse(data.toString());
      } catch {
        issues.set("protocol", compatibilityError("codex", "protocol"));
        ws.terminate();
        return;
      }
      if (!object(message)) {
        issues.set("protocol", compatibilityError("codex", "protocol"));
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
          try { p.resolve(validateCodexResult(p.method, message.result)); }
          catch (e) { issues.set(p.method, e); p.reject(e); }
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
        for (const listener of listeners) {
          try { listener(message); }
          catch { issues.set("notifications", compatibilityError("codex", "notifications")); }
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
        try { listener(); } catch { issues.set("notifications", compatibilityError("codex", "notifications")); }
      }
    });
    ws.on("error", () => {});
    socket = ws;
    await send("initialize", {
      clientInfo: { name: "reach", title: "Reach", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized" }));
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
  return {
    compatibility,
    async rpc(method, params = {}) {
      if (closed) throw closedError();
      if (issues.size) await compatibility();
      if (issues.has(method)) throw issues.get(method);
      if (issues.has("protocol")) throw issues.get("protocol");
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
