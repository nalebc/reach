import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import WebSocket from "ws";
import { object, compatibilityError, uncertainDelivery, validateCodexResult, readOnlyRpc, probeAgent, reportTooOld, tooOldError } from "./compatibility.mjs";
import { findCodexExecutable } from "../capabilities.mjs";
import { spawnable } from "../agent-cli.mjs";
import { computerWord } from "../computer-word.mjs";
import { trustedSocket } from "./trusted-socket.mjs";
import { PIPE } from "../windows-owners.mjs";
import { codexNativeFolder, openWindowsCodexSocket, windowsCodexSocketPath } from "./windows-codex-socket.mjs";

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

// `codex app-server daemon version` → the running service's version and the
// CLI's (verified Oct 13: {"managedCodexVersion":"0.158.0-alpha.2.1",
// "cliVersion":"0.162.0-alpha.17.2","appServerVersion":"0.158.0-alpha.2.1",…}).
// Either unreadable: null (never guessed).
export function parseDaemonVersion(text) {
  let value;
  try { value = JSON.parse(String(text || "").trim().split("\n").pop()); } catch { return { service: null, cli: null }; }
  const ok = (v) => (typeof v === "string" && /^\d+\.\d+\.\d+[\w.+-]*$/.test(v) ? v : null);
  if (!object(value)) return { service: null, cli: null };
  return { service: ok(value.appServerVersion) || ok(value.managedCodexVersion), cli: ok(value.cliVersion) };
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
  // How Windows reaches the service's pipe (ws+unix:// can't name a drive
  // path or a pipe: audit #2, Oct 12).
  connect = net.connect,
  // Codex 0.163's actual Windows shared daemon uses Winsock AF_UNIX. Its
  // connected peer is verified by a private native helper before ws sees it.
  connectWindowsSocket = openWindowsCodexSocket,
  dataDir = codexNativeFolder(),
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
  let preparingConnection = null;
  let version = null;
  let serviceVersion = null;
  // A Codex older than Reach works with (compatibility.mjs), as last read:
  // its chats are still listed and read (read and list calls); anything
  // else is refused with its version and the one to update to.
  let old = null;
  // Off until Codex changes version: a method Codex says it doesn't have
  // (-32601), except item pagination: support also depends on the thread's
  // store, so one unsupported store must never disable reading every chat.
  // Everything else odd (a message Reach can't read, a reply in a
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
    old = reportTooOld(report);
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
    if (!["available", "degraded"].includes(report.status) && !reportTooOld(report)) throw compatibilityError("codex", "CLI");
    const cli = spawnable(codex);
    const { stdout } = await run(cli.file, [...cli.args, "app-server", "daemon", "start"], {
      timeout: 20000,
      maxBuffer: 65536,
    });
    const status = JSON.parse(stdout.trim().split("\n").pop());
    if (!status.socketPath) throw new Error("Codex did not report its session service.");
    if (platform === "win32" && !PIPE.test(status.socketPath)) {
      // trustedSocket's named-pipe policy remains unchanged. AF_UNIX's
      // directory and actual connected peer are checked together by its
      // native connection; a path-only check could race the later connect.
      if (!windowsCodexSocketPath(status.socketPath))
        throw Object.assign(new Error("Codex reported a session service endpoint Reach can't securely open on this Windows PC."), { status: 503 });
      return status.socketPath;
    }
    return (await checkSocket(status.socketPath)) || status.socketPath;
  }
  // Said without the pipe's name, which Node's own errors carry.
  const unreachable = () => Object.assign(new Error(`Codex's session service didn't answer on this ${computerWord(platform)}.`), { status: 503 });
  async function open() {
    const path = await socketPath();
    if (closed) throw closedError();
    // Windows: localhost names no network endpoint. Existing named pipes
    // still use net.connect; AF_UNIX uses only the verified native Duplex.
    const windows = platform === "win32", pipe = windows && PIPE.test(path);
    let bridge, ws;
    const controller = windows && !pipe ? new AbortController() : null;
    if (controller) preparingConnection = controller;
    try {
      if (controller) bridge = await connectWindowsSocket(path, { dataDir, timeout: connectTimeout, signal: controller.signal });
      if (closed) throw closedError();
      ws = windows
        ? new Socket("ws://localhost/", { handshakeTimeout: connectTimeout, createConnection: () => pipe ? connect(path) : bridge })
        : new Socket(`ws+unix://${path}:/`, { handshakeTimeout: connectTimeout });
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", windows ? () => reject(unreachable()) : reject);
      });
    } catch (error) { ws?.terminate(); bridge?.destroy(); throw error; }
    finally { if (preparingConnection === controller) preparingConnection = null; }
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
            // Item pagination can be unsupported by one thread's store while
            // the same service supports it for other threads.
            if (message.error.code === -32601 && p.method !== "thread/items/list") issues.set(p.method, error);
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
          // Quoted: Codex's words stay on this one line of Reach's log.
          console.warn(`Codex deprecation: ${JSON.stringify(message.params.summary)}${message.params.details ? ` (${JSON.stringify(String(message.params.details))})` : ""}`);
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
  // The service's version against the CLI's: the hello's (what Reach is
  // connected to) first, else `daemon version` before any hello.
  async function serviceStatus() {
    const report = await compatibility().catch(() => null);
    let service = serviceVersion, cli = report?.version || null;
    if (!service) {
      const codex = await locate();
      if (codex) {
        const c = spawnable(codex);
        const read = await run(c.file, [...c.args, "app-server", "daemon", "version"], { timeout: 20000, maxBuffer: 65536 }).catch(() => null);
        const parsed = parseDaemonVersion(read?.stdout);
        service = parsed.service;
        cli ||= parsed.cli;
      }
    }
    return { service, cli, behind: olderVersion(service, cli) };
  }
  // Drop this connection; the next call opens a new one (a new hello).
  function reconnect() {
    preparingConnection?.abort();
    preparingConnection = null;
    const was = socket;
    socket = null;
    ready = null;
    serviceVersion = null;
    fail("Codex session service disconnected.");
    try { was?.terminate(); } catch {}
    if (was)
      for (const listener of closeListeners) {
        try { listener(); } catch { noteIssue("notifications", compatibilityError("codex", "notifications")); }
      }
  }
  // `codex app-server daemon update` with the Codex Reach runs (a fixed
  // command, nothing from the phone), then a new connection to whatever
  // service runs now: its hello says the version. Done only when that is no
  // longer older than the CLI (an exit code alone isn't proof). Nothing is
  // held or queued meanwhile: a send while it runs fails as any send to a
  // service that went away does.
  let updating = null;
  function updateService() {
    if (updating) return updating;
    updating = (async () => {
      if (closed) throw closedError();
      const codex = await locate();
      if (!codex) throw Object.assign(new Error(`Codex is not installed on this ${computerWord(platform)}.`), { status: 503 });
      const cli = spawnable(codex);
      const daemon = [...cli.args, "app-server", "daemon"];
      // --from-cli: the service becomes the very Codex Reach found (the one
      // the owner runs), pinned, so the two match; --yes: nobody is at a
      // terminal to answer Codex's question.
      try {
        await run(cli.file, [...daemon, "update", "--from-cli", "--yes"], { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 });
      } catch (e) {
        const said = String(e?.stderr || e?.stdout || "").trim().split("\n").filter(Boolean).pop() || (e?.killed ? "it took too long" : "");
        throw Object.assign(new Error(`Codex's service didn't update${said ? `: ${said.slice(0, 200)}` : "."}`), { status: 502 });
      } finally {
        reconnect();
        cliCatalog = null;
      }
      // The new connection's hello, as the next call would make it.
      await api.rpc("model/list", {}).catch(() => {});
      let now = await serviceStatus();
      // A service that kept running on the old package: started again once,
      // onto the new one (the owner already chose to interrupt it).
      if (now.service && now.behind) {
        await run(cli.file, [...daemon, "restart"], { timeout: 2 * 60 * 1000, maxBuffer: 1024 * 1024 }).catch(() => {});
        reconnect();
        await api.rpc("model/list", {}).catch(() => {});
        now = await serviceStatus();
      }
      if (!now.service || now.behind)
        throw Object.assign(new Error(now.service ? `Codex's service is still ${now.service}.` : "Codex's service didn't come back."), { status: 502 });
      return now;
    })().finally(() => { updating = null; });
    return updating;
  }
  const api = {
    compatibility,
    serviceStatus,
    updateService,
    updatingService: () => !!updating,
    reconnect,
    ...(cliModels ? { cliModels } : {}),
    ...(defaults ? { defaults: () => defaults() } : {}),
    async rpc(method, params = {}) {
      if (closed) throw closedError();
      // Too old: only reading goes to it, and what fails then is said as its
      // being too old (an older Codex's replies, or its service not opening).
      const work = !readOnlyRpc(method);
      // Looked at again first (cached; a Codex just updated is a new file).
      if (old && work) await compatibility().catch(() => {});
      if (old && work) throw tooOldError(old);
      const outdated = (error) => (old ? tooOldError(old) : error);
      if (issues.size) await compatibility();
      if (issues.has(method)) throw outdated(issues.get(method));
      if (recent.has("protocol") && Date.now() < protocolUntil) throw outdated(recent.get("protocol"));
      if (!ready)
        ready = open().catch((e) => {
          const failed = socket;
          socket = null;
          ready = null;
          failed?.terminate();
          fail("Codex initialization failed.");
          throw e;
        });
      try {
        await ready;
      } catch (error) {
        throw outdated(error);
      }
      // Found too old as this connection opened (its first check).
      if (old && work) throw tooOldError(old);
      return send(method, params).catch((error) => {
        throw error?.code === "AGENT_INCOMPATIBLE" ? outdated(error) : error;
      });
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
      preparingConnection?.abort();
      preparingConnection = null;
      fail("Codex session service closed.");
      socket?.terminate();
      socket = null;
      ready = null;
    },
  };
  return api;
}
