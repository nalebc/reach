import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { findCodexExecutable } from "../capabilities.mjs";

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
  const closedError = () => new Error("Codex session service is closed.");
  const fail = (message) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(message));
    }
    pending.clear();
  };
  async function socketPath() {
    const codex = await locate();
    if (!codex) throw Object.assign(new Error("Codex is not installed on this computer."), { status: 503 });
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
    const ws = new WebSocket(`ws+unix://${path}:/`, { handshakeTimeout: connectTimeout });
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
        return;
      }
      if (message.id !== undefined && pending.has(message.id) && ("result" in message || "error" in message)) {
        const p = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(p.timer);
        if (message.error)
          p.reject(Object.assign(new Error(message.error.message || "Codex request failed."), { data: message.error }));
        else p.resolve(message.result);
      } else if (message.method && message.id !== undefined) {
        // A request from Codex to this client (approvals, questions). Exactly
        // one handler answers; unhandled requests get a JSON-RPC error.
        const reply = (payload) =>
          socket?.readyState === WebSocket.OPEN &&
          socket.send(JSON.stringify({ id: message.id, ...payload }));
        const handler = requestHandler;
        if (!handler) reply({ error: { code: -32601, message: "Not supported by Reach." } });
        else
          Promise.resolve()
            .then(() => handler(message, (result) => reply({ result }), (error) => reply({ error })))
            .catch(() => reply({ error: { code: -32603, message: "Reach could not answer." } }));
      } else if (message.method) {
        for (const listener of listeners) listener(message);
      }
    });
    ws.on("close", () => {
      if (socket === ws) {
        socket = null;
        ready = null;
      }
      fail("Codex session service disconnected.");
      // Subscriptions belong to the connection; a new one starts clean.
      for (const listener of closeListeners) listener();
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
        reject(new Error(`Codex did not answer (${method}).`));
      }, requestTimeout);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  return {
    async rpc(method, params = {}) {
      if (closed) throw closedError();
      if (!ready)
        ready = open().catch((e) => {
          ready = null;
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
      socket?.terminate();
      socket = null;
      ready = null;
    },
  };
}
