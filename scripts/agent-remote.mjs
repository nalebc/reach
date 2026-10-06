#!/usr/bin/env node
// Reach for an AI agent on another computer. The owner invites it from the
// phone (Share → Agent); the agent runs one command and waits for the owner's
// connection approval in Reach: it joins the
// owner's tailnet with the invitation's one-time key, as its own small
// Tailscale node inside this process (nothing to install, the machine's own
// network is untouched), then serves Reach's MCP tools for that computer.
// If this machine is already on the tailnet (the Tailscale app), it goes
// direct instead, which is faster.
//
//   node agent.mjs join '<agent link>'     once
//   node agent.mjs mcp                     what the agent's MCP config runs
//   node agent.mjs status | call <tool> '<json>' | leave
//
// JSON-RPC and results go to stdout; everything else to stderr.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { callTool, serveMcp, toolsFor } from "./mcp-server.mjs";
import { createAgentClient } from "./agent-client.mjs";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const tailnetHost = (u) =>
  u.protocol === "https:" &&
  /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(u.hostname);
const loopback = (u) =>
  u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname);

// An agent link: <start>/agent#k=<one-time key>&h=<device name>&i=<computer>~<invitation>
// (the guest link's format on its own path, so a browser never redeems it).
export function parseAgentLink(text, { allowLocal = false } = {}) {
  let link;
  try {
    link = new URL(String(text || "").trim());
  } catch {
    throw Error("That isn't a Reach agent link.");
  }
  const ok = (u) => tailnetHost(u) || (allowLocal && loopback(u));
  if (!ok(link) || link.pathname !== "/agent")
    throw Error(
      "That isn't a Reach agent link. Ask the computer's owner to invite an agent in Reach (Share → Agent).",
    );
  const params = new URLSearchParams(link.hash.slice(1));
  const invites = params.getAll("i").flatMap((entry) => {
    const [origin, secret] = entry.split("~");
    try {
      const u = new URL(origin);
      return ok(u) && u.origin === origin && SECRET.test(secret || "")
        ? [{ origin, secret }]
        : [];
    } catch {
      return [];
    }
  });
  if (invites.length !== 1)
    throw Error("This agent link is incomplete. Copy the whole link again.");
  const key = params.get("k") || "";
  const hostname = params.get("h") || "";
  return {
    start: link.origin,
    ...invites[0],
    key: /^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(key) ? key : "",
    hostname: /^rg-[a-z0-9]{4}-[a-z0-9]{10}$/.test(hostname) ? hostname : "",
  };
}

// ~/.reach-agent: this file, the tailnet client, and one folder per computer.
export function agentHome() {
  const dir = path.resolve(
    process.env.REACH_AGENT_HOME || path.join(os.homedir(), ".reach-agent"),
  );
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() ||
    (process.platform !== "win32" && stat.uid !== process.getuid())
  )
    throw Error(`${dir} must be a folder that belongs to you.`);
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  return dir;
}
const writePrivate = (file, text) => {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
};

// Tailscale's node state, kept like the browser keeps it but in a private
// file; written synchronously so a crash never loses the node's identity.
export function fileState(file) {
  let state = {};
  try {
    state = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {}
  return {
    getState: (key) => (typeof state[key] === "string" ? state[key] : ""),
    setState: (key, value) => {
      state = { ...state, [key]: String(value) };
      writePrivate(file, JSON.stringify(state));
    },
  };
}

// Go's output goes to stderr only: stdout belongs to MCP.
const goFs = () => {
  const enosys = () =>
    Object.assign(Error("not implemented"), { code: "ENOSYS" });
  const no = (...args) => args.at(-1)(enosys());
  return {
    constants: {
      O_WRONLY: -1,
      O_RDWR: -1,
      O_CREAT: -1,
      O_TRUNC: -1,
      O_APPEND: -1,
      O_EXCL: -1,
      O_DIRECTORY: -1,
    },
    writeSync(fd, buf) {
      process.stderr.write(buf);
      return buf.length;
    },
    write(fd, buf, offset, length, position, callback) {
      if (offset !== 0 || length !== buf.length || position !== null)
        return callback(enosys());
      callback(null, this.writeSync(fd, buf));
    },
    fsync: (fd, callback) => callback(null),
    ...Object.fromEntries(
      [
        "chmod",
        "chown",
        "close",
        "fchmod",
        "fchown",
        "fstat",
        "ftruncate",
        "lchown",
        "link",
        "lstat",
        "mkdir",
        "open",
        "read",
        "readdir",
        "readlink",
        "rename",
        "rmdir",
        "stat",
        "symlink",
        "truncate",
        "unlink",
        "utimes",
      ].map((name) => [name, no]),
    ),
  };
};

// The same tailnet client phones use in the browser, run by Node.
export async function loadTailnet({ execFile, wasmFile }) {
  if (globalThis.reachTailnet) return globalThis.reachTailnet;
  globalThis.crypto ??= (await import("node:crypto")).webcrypto;
  if (typeof globalThis.WebSocket !== "function")
    globalThis.WebSocket = (await import("ws")).WebSocket;
  globalThis.fs = goFs();
  vm.runInThisContext(fs.readFileSync(execFile, "utf8"), {
    filename: execFile,
  });
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiate(
    fs.readFileSync(wasmFile),
    go.importObject,
  );
  // Go turns its HTTP client off when process.argv0 starts with "node" (its
  // own tests). It reads it once while starting, synchronously here; for that
  // moment it sees a process that isn't "node", so it uses Node's fetch.
  const real = globalThis.process;
  Object.defineProperty(globalThis, "process", {
    value: Object.create(real, { argv0: { value: "reach-agent" } }),
    configurable: true,
    writable: true,
  });
  try {
    go.run(instance).catch((e) =>
      process.stderr.write(`Reach: ${e.message}\n`),
    );
  } finally {
    Object.defineProperty(globalThis, "process", {
      value: real,
      configurable: true,
      writable: true,
    });
  }
  if (typeof globalThis.reachTailnet !== "function")
    throw Error("The tailnet client didn't start.");
  return globalThis.reachTailnet;
}

// The tailnet client comes from the computer's start page, once.
async function tailnetFiles(home, start) {
  const dir = path.join(home, "tailnet");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(dir, "tailnet.json");
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    const files = {
      execFile: path.join(dir, m.exec),
      wasmFile: path.join(dir, m.wasm),
    };
    if (fs.existsSync(files.execFile) && fs.existsSync(files.wasmFile))
      return files;
  } catch {}
  process.stderr.write(
    "Reach: getting the tailnet client (one time, about 6 MB)…\n",
  );
  const get = async (route) => {
    const r = await fetch(new URL(route, start), { redirect: "error" });
    if (!r.ok) throw Error(`The computer's start page returned ${r.status}.`);
    return r;
  };
  const { tailnet } = await (await get("/reach-start.json")).json();
  const name = /^[\w.-]+$/;
  if (!tailnet || !name.test(tailnet.wasm) || !name.test(tailnet.exec))
    throw Error(
      "This computer can't let agents join without the Tailscale app yet. Update Reach on it.",
    );
  for (const file of [tailnet.exec, tailnet.wasm])
    writePrivate(
      path.join(dir, file),
      Buffer.from(await (await get(`/tailnet/${file}`)).arrayBuffer()),
    );
  writePrivate(manifestFile, JSON.stringify(tailnet));
  return {
    execFile: path.join(dir, tailnet.exec),
    wasmFile: path.join(dir, tailnet.wasm),
  };
}

// One node per computer in this process, made once and reused (a second
// one with the same identity would fight the first).
const tailnets = new Map();
async function nodeFor({ home, conn, start, key, hostname }) {
  if (!tailnets.has(conn))
    tailnets.set(
      conn,
      (async () => {
        const factory = await loadTailnet(await tailnetFiles(home, start));
        const t = { state: "", asked: false };
        t.node = factory({
          hostname: hostname || "reach-agent",
          ...(key ? { authKey: key } : {}),
          stateStorage: fileState(path.join(conn, "tailnet-state.json")),
        });
        t.node.start({
          state: (s) => (t.state = s),
          authURL: () => (t.asked = true),
        });
        return t;
      })(),
    );
  try {
    return await tailnets.get(conn);
  } catch (e) {
    tailnets.delete(conn);
    throw e;
  }
}

// Join (with a key) or rejoin (with saved state), then wait until the
// computer is visible: requests before that would only fail. Once ready,
// later calls return at once; after a failure, the next call waits again.
export async function connectTailnet({ timeoutMs = 90000, ...where }) {
  const t = await nodeFor(where);
  t.ready ||= waitFor(t, where.origin, !!where.key, timeoutMs).catch((e) => {
    t.ready = null;
    throw e;
  });
  await t.ready;
  return t.node;
}
function waitFor(t, origin, withKey, timeoutMs) {
  const host = new URL(origin).hostname.toLowerCase();
  const lost = withKey
    ? "Tailscale didn't accept this invitation's key: it was used or has expired. Ask for a new agent invitation."
    : "This agent isn't on the tailnet anymore (removed or expired). Ask for a new agent invitation.";
  return new Promise((resolve, reject) => {
    const began = Date.now();
    let needsLogin = 0;
    const check = () => {
      if (t.asked || (t.state === "NeedsLogin" && ++needsLogin > 60))
        return reject(Error(lost));
      if (t.state === "Running") {
        const peer = t.node
          .status()
          .peers.find(
            (p) => p.dnsName.toLowerCase().replace(/\.$/, "") === host,
          );
        if (peer?.online) return resolve();
      }
      if (Date.now() - began > timeoutMs)
        return reject(
          Error(
            t.state === "Running"
              ? `On the tailnet, but ${host} isn't reachable. Is Reach running there? (Its invite-links setup lets tag:reach-guest reach port 8443.)`
              : `Couldn't join the tailnet (state: ${t.state || "starting"}). Check this machine's internet connection.`,
          ),
        );
      setTimeout(check, 250);
    };
    check();
  });
}

// Requests through the agent's own tailnet node.
export function tailnetApi(node, origin, token, { timeoutMs = 35000 } = {}) {
  return async (
    route,
    method = "GET",
    body,
    contentType = "application/json",
  ) => {
    if (!route.startsWith("/api/") || route.startsWith("//"))
      throw Error("Invalid API route.");
    const data =
      body === undefined
        ? undefined
        : Buffer.isBuffer(body)
          ? body
          : Buffer.from(JSON.stringify(body));
    const call = node.fetch({
      url: new URL(route, origin).href,
      method,
      headers: [
        ...(token ? ["Authorization", `Bearer ${token}`] : []),
        "Content-Type",
        contentType,
      ],
      ...(data ? { body: new Uint8Array(data) } : {}),
      redirect: "error",
    });
    const deadline = setTimeout(() => call.abort(), timeoutMs);
    try {
      const head = await call.response;
      const screenImage = (route === "/api/browser/screen" || /^\/api\/browser\/apps\/screen\?target=[A-Za-z0-9_-]{1,128}$/.test(route)) && method === "GET" && body === undefined && head.status >= 200 && head.status < 300;
      const responseLimit = (screenImage ? 8 : 2) * 1024 * 1024;
      const chunks = [];
      let size = 0;
      for (let chunk; (chunk = await head.read());) {
        size += chunk.length;
        if (size > responseLimit) {
          head.cancel();
          throw Error(`Reach response exceeds ${screenImage ? 8 : 2} MiB.`);
        }
        chunks.push(Buffer.from(chunk));
      }
      if (screenImage) {
        let mimeType = "";
        for (let index = 0; index < head.headers.length; index += 2)
          if (String(head.headers[index]).toLowerCase() === "content-type") mimeType = String(head.headers[index + 1]).split(";")[0].trim();
        if (!["image/jpeg", "image/png"].includes(mimeType)) throw Error("Reach returned an unsupported screen image.");
        return { image: Buffer.concat(chunks).toString("base64"), mimeType };
      }
      const result = JSON.parse(
        Buffer.concat(chunks).toString("utf8") || "null",
      );
      if (head.status < 200 || head.status >= 300)
        throw Error(result?.error || `Reach returned HTTP ${head.status}.`);
      return result;
    } catch (e) {
      if (/abort|cancel/i.test(e.message))
        throw Error(
          "Reach request timed out. Mutating operations are not retried.",
        );
      throw e;
    } finally {
      clearTimeout(deadline);
    }
  };
}

// Already on the tailnet (the Tailscale app)? Then go direct: faster.
function reachableDirect(origin) {
  return new Promise((resolve) => {
    const u = new URL("/api/health", origin);
    const req = (u.protocol === "https:" ? https : http).get(
      u,
      { timeout: 2500, rejectUnauthorized: true },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            resolve(
              res.statusCode === 200 && JSON.parse(text).product === "Reach",
            );
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(false));
  });
}
const directApi = (origin, token, allowLocal) =>
  createAgentClient({ url: `${origin}/`, token }, { allowLocal, proxy: "" });
// Using the invitation needs no credential yet.
function admissionDirect(origin, route, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(route, origin);
    const data = JSON.stringify(body);
    const req = (u.protocol === "https:" ? https : http).request(
      u,
      {
        method: "POST",
        timeout: 35000,
        rejectUnauthorized: true,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => (text += c));
        res.on("end", () => {
          try {
            const result = JSON.parse(text);
            if (![200, 202].includes(res.statusCode))
              throw Error(
                result.error || `Reach returned HTTP ${res.statusCode}.`,
              );
            resolve(result);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(Error("Reach didn't answer.")));
    req.on("error", reject);
    req.end(data);
  });
}

// A receipt never becomes a credential locally. Only the approved server
// response supplies the token written to disk and used by MCP afterwards.
export async function waitForAgentAdmission(receipt, api, {
  now = Date.now,
  delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  announce = (code) => process.stderr.write(
    `Reach: waiting for your approval in Reach. Connection code: ${code}\nCompare this code in Home → Needs you before approving.\n`,
  ),
} = {}) {
  if (receipt.status !== "pending") return receipt;
  if (typeof receipt.requestId !== "string" || !receipt.requestId ||
      typeof receipt.requestSecret !== "string" || !SECRET.test(receipt.requestSecret) ||
      !/^\d{6}$/.test(receipt.verificationCode) ||
      !Number.isFinite(receipt.expiresAt))
    throw Error("Reach returned an invalid connection approval receipt.");
  const deadline = Math.min(receipt.expiresAt, now() + 5 * 60000);
  announce(receipt.verificationCode);
  while (now() < deadline) {
    const result = await api(
      `/api/invitations/claims/${encodeURIComponent(receipt.requestId)}/status`,
      "POST", { secret: receipt.requestSecret },
    );
    if (result.status === "approved") {
      if (result.kind !== "agent" || typeof result.token !== "string" || !result.token ||
          !Array.isArray(result.scopes) || !Number.isFinite(result.expiresAt) || result.expiresAt <= now())
        throw Error("Reach returned an invalid approved connection. Ask for a new invitation.");
      return result;
    }
    if (result.status === "denied")
      throw Error("The owner denied this connection. Ask them for a new agent invitation.");
    if (result.status !== "pending")
      throw Error("This connection approval expired or was revoked. Ask for a new agent invitation.");
    await delay(Math.min(2000, Math.max(0, deadline - now())));
  }
  throw Error("Connection approval timed out. Ask the owner for a new agent invitation.");
}

// One tailnet node per computer: two copies of one node would fight. The
// first process (usually an MCP server) holds it; others, such as a second
// agent session or `call`, use it through a private socket next to it, and
// take over when it's gone.
export function lock(conn) {
  const file = path.join(conn, "lock");
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      process.once("exit", () => {
        try {
          if (fs.readFileSync(file, "utf8") === String(process.pid))
            fs.rmSync(file, { force: true });
        } catch {}
      });
      return true;
    } catch {
      let pid = 0;
      try {
        pid = Number(fs.readFileSync(file, "utf8"));
        if (pid === process.pid) return true;
        if (pid) {
          process.kill(pid, 0);
          return false;
        }
      } catch (e) {
        if (e.code === "EPERM") return false;
      }
      fs.rmSync(file, { force: true });
    }
  }
  return false;
}
const socketOf = (conn) => path.join(conn, "agent.sock");
export function shareNode(conn, api) {
  const file = socketOf(conn);
  fs.rmSync(file, { force: true });
  const server = net.createServer((socket) => {
    // (readline repeats the socket's errors: a caller leaving isn't one.)
    const lines = readline.createInterface({ input: socket });
    lines.on("error", () => {});
    lines.on("line", async (line) => {
      let id = null;
      try {
        const r = JSON.parse(line);
        id = r.id;
        const result = await api(r.route, r.method, r.body);
        socket.write(JSON.stringify({ id, result }) + "\n");
      } catch (e) {
        socket.write(JSON.stringify({ id, error: e.message }) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  server.listen(file, () => fs.chmodSync(file, 0o600));
  server.unref();
  process.once("exit", () => fs.rmSync(file, { force: true }));
  return server;
}
export const GONE = "REACH_HOLDER_GONE";
export function viaShared(conn) {
  let socket,
    next = 0;
  const waiting = new Map();
  const connect = () =>
    new Promise((resolve, reject) => {
      const s = net.connect(socketOf(conn));
      s.once("connect", () => resolve(s));
      s.once("error", () =>
        reject(Object.assign(Error("gone"), { code: GONE })),
      );
      s.on("close", () => {
        socket = null;
        for (const w of waiting.values())
          w.reject(Object.assign(Error("gone"), { code: GONE }));
        waiting.clear();
      });
      const lines = readline.createInterface({ input: s });
      lines.on("error", () => {});
      lines.on("line", (line) => {
        const r = JSON.parse(line);
        const w = waiting.get(r.id);
        waiting.delete(r.id);
        if (r.error) w?.reject(Error(r.error));
        else w?.resolve(r.result);
      });
    });
  return async (route, method = "GET", body) => {
    socket ||= await connect();
    const id = ++next;
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      socket.write(JSON.stringify({ id, route, method, body }) + "\n");
    });
  };
}

// Joined: a saved credential (a join cut short leaves only a placeholder).
const joinedAt = (conn) => {
  try {
    return typeof readCredential(conn).token === "string";
  } catch {
    return false;
  }
};
const connections = (home) =>
  fs
    .readdirSync(home, { withFileTypes: true })
    .filter((d) => d.isDirectory() && joinedAt(path.join(home, d.name)))
    .map((d) => d.name);
function pick(home, wanted) {
  const all = connections(home);
  if (wanted) {
    if (!all.includes(wanted))
      throw Error(
        `Not connected to "${wanted}". Connected: ${all.join(", ") || "none"}.`,
      );
    return wanted;
  }
  if (all.length === 1) return all[0];
  throw Error(
    all.length
      ? `Connected to several computers (${all.join(", ")}): add --computer NAME.`
      : "Not connected yet. Run: node agent.mjs join '<agent link>'",
  );
}
const readCredential = (conn) =>
  JSON.parse(fs.readFileSync(path.join(conn, "credential.json"), "utf8"));

// A computer's API, however this agent reaches it.
async function open(home, name, allowLocal) {
  const conn = path.join(home, name);
  const credential = readCredential(conn);
  if (credential.expiresAt && Date.now() >= credential.expiresAt)
    throw Error(
      `Access to ${credential.computer} ended. Ask its owner for a new agent invitation.`,
    );
  if (credential.via === "direct")
    return {
      credential,
      api: directApi(credential.origin, credential.token, allowLocal),
    };
  // Hold the node, or use the one another process holds.
  const where = {
    home,
    conn,
    start: credential.start,
    origin: credential.origin,
    hostname: credential.hostname,
  };
  let shared = false;
  const become = async () => {
    for (let i = 0; i < 120; i++) {
      if (lock(conn)) {
        // Hold it: share it at once (callers wait for it with us).
        const api = async (...args) =>
          tailnetApi(
            await connectTailnet(where),
            credential.origin,
            credential.token,
          )(...args);
        if (!shared) {
          shareNode(conn, api);
          connectTailnet(where).catch(() => {}); // start joining now
        }
        shared = true;
        return { api };
      }
      if (fs.existsSync(socketOf(conn)))
        return { api: viaShared(conn), shared: true };
      await new Promise((r) => setTimeout(r, 250)); // it's still starting
    }
    throw Error("Reach's connection to this computer didn't start.");
  };
  let using;
  const api = async (...args) => {
    for (let i = 0; ; i++) {
      const current = await (using ||= become());
      try {
        return await current.api(...args);
      } catch (e) {
        if (!current.shared || e.code !== GONE || i > 2) throw e;
        using = null; // the holder ended: hold it now
      }
    }
  };
  using = become();
  using.catch(() => {});
  return { credential, api };
}

const flags = (args) => {
  const o = { _: [] };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-local") o.allowLocal = true;
    else if (args[i] === "--computer") o.computer = args[++i];
    else o._.push(args[i]);
  }
  return o;
};
const readStdin = () =>
  new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let text = "";
    process.stdin
      .on("data", (c) => (text += c))
      .on("end", () => resolve(text.trim()));
  });
const self = () =>
  path.resolve(process.argv[1] || fileURLToPath(import.meta.url));
const quote = (s) =>
  /^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;

export async function join(o) {
  const link = parseAgentLink(
    o._[1] && o._[1] !== "-" ? o._[1] : await readStdin(),
    o,
  );
  const home = agentHome();
  const name =
    new URL(link.origin).hostname
      .split(".")[0]
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "") || "computer";
  const conn = path.join(home, name);
  if (joinedAt(conn))
    throw Error(
      `Already connected to ${name}. To join again: node ${quote(self())} leave --computer ${name}`,
    );
  fs.mkdirSync(conn, { recursive: true, mode: 0o700 });
  if (!lock(conn)) throw Error(`Another join to ${name} is running.`);
  // What a join cut short left behind (its invitation is spent or unused).
  for (const file of ["credential.json", "tailnet-state.json", "agent.sock"])
    fs.rmSync(path.join(conn, file), { force: true });
  // Somewhere safe to keep the credential, before the invitation is used.
  const credentialFile = path.join(conn, "credential.json");
  writePrivate(credentialFile, "{}");
  fs.rmSync(credentialFile);
  try {
    const direct = await reachableDirect(link.origin);
    let admissionApi;
    if (direct)
      admissionApi = (route, _method, body) => admissionDirect(link.origin, route, body);
    else {
      if (!link.key)
        throw Error(
          "This machine isn't on that tailnet, and the link has no Tailscale key. Ask the owner to set up invite links in Reach (Share → Set up), then invite the agent again.",
        );
      process.stderr.write("Reach: joining the tailnet…\n");
      const node = await connectTailnet({ home, conn, ...link });
      admissionApi = tailnetApi(node, link.origin, "");
    }
    let joined = await admissionApi("/api/invitations/redeem", "POST", { invitation: link.secret });
    joined = await waitForAgentAdmission(joined, admissionApi);
    if (joined.kind !== "agent")
      throw Error("That invitation isn't for an agent.");
    const credential = {
      version: 1,
      via: direct ? "direct" : "tailnet",
      computer: joined.device?.name || name,
      start: link.start,
      origin: link.origin,
      hostname: link.hostname,
      token: joined.token,
      clientId: joined.clientId,
      scopes: joined.scopes,
      expiresAt: joined.expiresAt,
      joinedAt: new Date().toISOString(),
    };
    writePrivate(credentialFile, JSON.stringify(credential, null, 2));
    const several = connections(home).length > 1;
    const run = `node ${quote(self())} mcp${several ? ` --computer ${name}` : ""}`;
    const server = several ? `reach-${name}` : "reach";
    process.stdout.write(
      [
        `Connected to ${credential.computer}${direct ? " (direct, through Tailscale on this machine)" : ""}.`,
        `Access: ${joined.scopes.filter((s) => s !== "device").join(", ")}, until ${new Date(joined.expiresAt).toLocaleString()}.`,
        "",
        "Add it to your agent (once):",
        `  Claude Code:  claude mcp add --scope user ${server} -- ${run}`,
        `  Codex:        codex mcp add ${server} -- ${run}`,
        `  Other MCP clients: command "node", args ${JSON.stringify([self(), "mcp", ...(several ? ["--computer", name] : [])])}`,
        "",
      ].join("\n"),
    );
    return 0;
  } catch (e) {
    fs.rmSync(conn, { recursive: true, force: true });
    throw e;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const o = flags(argv);
  const verb = o._[0];
  if (!verb || ["help", "--help", "-h"].includes(verb)) {
    process.stdout.write(
      "Reach for agents\n  join '<agent link>'   connect to the computer that invited you (once)\n  mcp                   serve its tools over MCP (stdio)\n  status                computers you're connected to\n  tools                 what you can use there\n  call TOOL '{json}'    use one tool once\n  leave                 disconnect and forget it\nWith several computers, add --computer NAME.\n",
    );
    return 0;
  }
  if (verb === "join") return join(o);
  const home = agentHome();
  if (verb === "status") {
    const list = connections(home).map((name) => {
      const c = readCredential(path.join(home, name));
      return {
        name,
        computer: c.computer,
        via: c.via,
        scopes: c.scopes,
        expiresAt: new Date(c.expiresAt).toISOString(),
      };
    });
    process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    return 0;
  }
  const name = pick(home, o.computer);
  if (verb === "mcp") {
    // Nothing but JSON-RPC on stdout.
    for (const k of ["log", "info", "debug", "warn"])
      console[k] = console.error;
    const { api, credential } = await open(home, name, o.allowLocal);
    // Its access is fixed by the invitation (and checked by the computer):
    // the tool list doesn't wait for the tailnet.
    await serveMcp({
      api,
      scopes: credential.scopes,
      liveScopes: false,
      name: `reach-${name}`,
    });
    return 0;
  }
  if (verb === "call") {
    const { api } = await open(home, name, o.allowLocal);
    const args = o._[2] ? JSON.parse(o._[2]) : {};
    process.stdout.write(
      JSON.stringify(await callTool(api, o._[1], args), null, 2) + "\n",
    );
    return 0;
  }
  if (verb === "tools") {
    const c = readCredential(path.join(home, name));
    process.stdout.write(
      toolsFor(c.scopes)
        .map((t) => `${t.name}  ${t.description}`)
        .join("\n") + "\n",
    );
    return 0;
  }
  if (verb === "leave") {
    const conn = path.join(home, name);
    const credential = readCredential(conn);
    if (credential.via === "tailnet") {
      if (!lock(conn))
        throw Error(
          "Your agent's Reach MCP server is using this connection. Stop it (or remove it from your agent), then leave.",
        );
      try {
        const node = await connectTailnet({
          home,
          conn,
          ...credential,
          timeoutMs: 20000,
        });
        node.logout();
        await new Promise((r) => setTimeout(r, 1500));
      } catch {}
    }
    fs.rmSync(conn, { recursive: true, force: true });
    process.stdout.write(`Left ${credential.computer}.\n`);
    return 0;
  }
  throw Error(`Unknown command "${verb}". Run: node agent.mjs help`);
}

const entry = process.argv[1] && fs.realpathSync.native(process.argv[1]);
if (entry === fileURLToPath(import.meta.url))
  // Exit once everything written has gone out: the tailnet client would
  // otherwise keep the process running, and a pipe may still be draining.
  main()
    .then((code) => process.stdout.write("", () => process.exit(code ?? 0)))
    .catch((e) =>
      process.stderr.write(`Reach: ${e.message}\n`, () => process.exit(1)),
    );
