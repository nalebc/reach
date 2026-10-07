import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { findCodexExecutable } from "../capabilities.mjs";
import { compatibilityError, object, probeAgent, readOnlyRpc, uncertainDelivery, validateCodexResult } from "./compatibility.mjs";

const exec = promisify(execFile);

// The shared local daemon owns the sessions. Each approval belongs to the
// connection that requested it; an unacknowledged write must never be retried.
export function createCodexDaemon({
  locate = findCodexExecutable,
  run = exec,
  Socket = WebSocket,
  check = run === exec ? probeAgent : null,
  connectTimeout = 8000,
  requestTimeout = 30000,
} = {}) {
  let socket = null;
  let ready = null;
  let seq = 0;
  let version;
  let protocolBroken = false;
  const pending = new Map();
  const issues = new Map();
  const listeners = new Set();
  const closeListeners = new Set();
  let requestHandler = null;
  let closed = false;
  const closedError = () => new Error("Codex session service is closed.");
  const fail = (ws, message) => {
    for (const [id, p] of pending) {
      if (p.ws !== ws) continue;
      clearTimeout(p.timer);
      pending.delete(id);
      p.reject(readOnlyRpc(p.method) ? new Error(message) : uncertainDelivery("codex"));
    }
  };
  async function compatibility() {
    const file = await locate();
    const state = check ? await check("codex", file) : { status: "available", version: null };
    if (version !== undefined && version !== state.version) {
      issues.clear();
      protocolBroken = false;
      socket?.terminate();
      socket = null;
      ready = null;
    }
    version = state.version;
    return { ...state, ...(state.status === "available" && issues.size ? { status: "degraded" } : {}), issues: [...issues.values()] };
  }
  async function socketPath() {
    const codex = await locate();
    if (!codex) throw Object.assign(new Error("Codex is not installed on this computer."), { status: 503, code: "AGENT_NOT_INSTALLED" });
    const { stdout } = await run(codex, ["app-server", "daemon", "start"], { timeout: 20000, maxBuffer: 65536 });
    const status = JSON.parse(stdout.trim().split("\n").pop());
    if (!status.socketPath) throw compatibilityError("codex", "session service");
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
    if (closed) { ws.terminate(); throw closedError(); }
    socket = ws;
    ws.on("message", (data) => {
      let message;
      try {
        message = JSON.parse(data.toString());
        if (!object(message)) throw new Error("Invalid message");
      } catch {
        protocolBroken = true;
        issues.set("protocol", { feature: "protocol" });
        ws.terminate();
        return;
      }
      if (message.id !== undefined && pending.get(message.id)?.ws === ws && ("result" in message || "error" in message)) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error) {
          if ([-32601, -32602].includes(message.error.code)) {
            // Invalid parameters can be specific to this call; only an absent
            // method disables the capability for the entire installed version.
            if (message.error.code === -32601) issues.set(p.method, { feature: p.method });
            p.reject(compatibilityError("codex", p.method));
          } else p.reject(Object.assign(new Error(message.error.message || "Codex request failed."), { data: message.error }));
        } else {
          try { p.resolve(validateCodexResult(p.method, message.result)); }
          catch (error) { issues.set(p.method, { feature: p.method }); p.reject(error); }
        }
      } else if (typeof message.method === "string" && message.id !== undefined) {
        let attempted = false;
        const reply = (payload) => new Promise((resolve, reject) => {
          if (attempted) return reject(uncertainDelivery("codex"));
          if (socket !== ws || ws.readyState !== WebSocket.OPEN)
            return reject(new Error("The Codex connection ended. This answer was not sent."));
          attempted = true;
          try {
            ws.send(JSON.stringify({ id: message.id, ...payload }), (error) => error ? reject(uncertainDelivery("codex")) : resolve());
          } catch { reject(uncertainDelivery("codex")); }
        });
        const handler = requestHandler;
        if (!handler) void reply({ error: { code: -32601, message: "Not supported by Reach." } }).catch(() => {});
        else Promise.resolve()
          .then(() => handler(message, (result) => reply({ result }), (error) => reply({ error })))
          .catch(() => { if (!attempted) return reply({ error: { code: -32603, message: "Reach could not answer." } }).catch(() => {}); });
      } else if (typeof message.method === "string") {
        for (const listener of listeners) {
          try { listener(message); }
          catch { issues.set("notifications", { feature: "notifications" }); }
        }
      }
    });
    ws.on("close", () => {
      fail(ws, "Codex session service disconnected.");
      if (socket !== ws) return;
      socket = null;
      ready = null;
      for (const listener of closeListeners) {
        try { listener(); } catch { /* one subscriber cannot prevent cleanup */ }
      }
    });
    ws.on("error", () => {});
    await send("initialize", {
      clientInfo: { name: "reach", title: "Reach", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    ws.send(JSON.stringify({ method: "initialized" }));
  }
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const ws = socket;
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error("Codex session service is not connected."));
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(readOnlyRpc(method) ? new Error(`Codex did not answer (${method}).`) : uncertainDelivery("codex"));
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer, method, ws });
      const failed = () => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        reject(readOnlyRpc(method) ? new Error("Codex request could not be delivered.") : uncertainDelivery("codex"));
      };
      try { ws.send(JSON.stringify({ id, method, params }), (error) => { if (error) failed(); }); }
      catch { failed(); }
    });
  }
  return {
    compatibility,
    async rpc(method, params = {}) {
      if (closed) throw closedError();
      const state = await compatibility();
      if (!["available", "degraded"].includes(state.status) || protocolBroken || issues.has(method))
        throw compatibilityError("codex", method);
      if (!ready) ready = open().catch((e) => { ready = null; throw e; });
      await ready;
      return send(method, params);
    },
    onNotification(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onClose(listener) { closeListeners.add(listener); return () => closeListeners.delete(listener); },
    onRequest(handler) { requestHandler = handler; },
    close() {
      closed = true;
      socket?.terminate();
      socket = null;
      ready = null;
    },
  };
}
