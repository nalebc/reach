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
import crypto from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { agentRequestTimeout, agentRequestError, agentErrorDetails } from "../server/agent-transport.mjs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { callTool, computerPlan, computerTools, serveMcp, toContent, toolsFor } from "./mcp-server.mjs";
import { createAgentClient, isScreenImageRoute } from "./agent-client.mjs";
import { agentKey, funnelApi, funnelGateway } from "./agent-funnel.mjs";

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const tailnetHost = (u) =>
  u.protocol === "https:" &&
  /^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/i.test(u.hostname);
const loopback = (u) =>
  u.protocol === "http:" && ["127.0.0.1", "localhost"].includes(u.hostname);
// "mac.tail1.ts.net" -> "tail1.ts.net": one owner's tailnet.
const tailnetOf = (u) => u.hostname.toLowerCase().split(".").slice(1).join(".");

// An agent link: <start>/agent#k=<one-time key>&h=<device name>&i=<computer>~<invitation>
// (the guest link's format on its own path, so a browser never redeems it).
// t=funnel: no key; the agent joins through the computer's public link
// (<start>), or its private address (<computer>: the same name, Reach's own
// port) when the agent is on the owner's tailnet.
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
  // The page that hands out the agent's code and the computer it joins are
  // on the same tailnet: a link can't mix in someone else's (connections
  // audit, Oct 10).
  if (tailnetHost(link) && tailnetOf(new URL(invites[0].origin)) !== tailnetOf(link))
    throw Error("This agent link is incomplete. Copy the whole link again.");
  const funnel = params.get("t") === "funnel";
  if (funnel && new URL(invites[0].origin).hostname !== link.hostname)
    throw Error("This agent link is incomplete. Copy the whole link again.");
  const key = params.get("k") || "";
  const hostname = params.get("h") || "";
  // r=: the SHA-256 of the runtime the computer named when it invited (its
  // steps checked the download against it; join checks itself too). One
  // that isn't a hash is a link cut short.
  const runtime = params.get("r");
  if (runtime !== null && !/^[0-9a-f]{64}$/.test(runtime))
    throw Error("This agent link is incomplete. Copy the whole link again.");
  return {
    start: link.origin,
    ...invites[0],
    ...(runtime ? { runtime } : {}),
    ...(funnel ? { funnel: true, public: link.origin, private: invites[0].origin !== link.origin ? invites[0].origin : null } : {}),
    key: /^tskey-auth-[A-Za-z0-9-]{10,200}$/.test(key) ? key : "",
    hostname: /^rg-[a-z0-9]{4}-[a-z0-9]{10}$/.test(hostname) ? hostname : "",
  };
}

// The runtime a line from `keep` restores with: this very one, by its
// SHA-256, which the computer keeps serving (dist/agent-runtimes) however
// Reach changes; the restored agent then updates itself as usual. Run from
// source, there's no such file to name (connections audit, Oct 10).
const keptRuntime = () => {
  if (!isBundle()) return "";
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(fileURLToPath(import.meta.url))).digest("hex");
  } catch {
    return "";
  }
};
// Windows has no curl, mv or ~ to count on, and a line can't be piped into a
// series of PowerShell commands: there (PowerShell 5.1 and later, as the
// join's steps, server/agent-steps.mjs), the line goes in place of this.
export const YOUR_LINE = "<YOUR LINE>";
export function restoreCommand(start, thumbprint = "", runtime = "", platform = process.platform) {
  if (platform === "win32") {
    const header = thumbprint ? ` -Headers @{ 'Reach-Key' = '${thumbprint}' }` : "";
    const head = `$L = '${YOUR_LINE}'; [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; $d = "$HOME\\.reach-agent"; New-Item -ItemType Directory -Force $d | Out-Null; `;
    const restore = `$L | node "$d\\agent.mjs" restore`;
    if (!/^[0-9a-f]{64}$/.test(runtime))
      return `${head}Invoke-WebRequest -UseBasicParsing${header} -Uri ${start}/agent.mjs -OutFile "$d\\agent.mjs"; ${restore}`;
    return `${head}Invoke-WebRequest -UseBasicParsing${header} -Uri ${start}/agent-runtimes/${runtime}.mjs -OutFile "$d\\agent.mjs.new"; if ((Get-FileHash "$d\\agent.mjs.new" -Algorithm SHA256).Hash -ne '${runtime}') { throw 'This is not the runtime your line was kept with.' }; Move-Item -Force "$d\\agent.mjs.new" "$d\\agent.mjs"; ${restore}`;
  }
  const key = thumbprint ? ` -H 'Reach-Key: ${thumbprint}'` : "";
  if (!/^[0-9a-f]{64}$/.test(runtime))
    return `curl -fsSL --create-dirs${key} -o ~/.reach-agent/agent.mjs ${start}/agent.mjs && node ~/.reach-agent/agent.mjs restore`;
  return `curl -fsSL --create-dirs${key} -o ~/.reach-agent/agent.mjs.new ${start}/agent-runtimes/${runtime}.mjs && node -e 'const [f,h]=process.argv.slice(1);if(require("crypto").createHash("sha256").update(require("fs").readFileSync(f)).digest("hex")!==h)throw Error("This is not the runtime your line was kept with.")' ~/.reach-agent/agent.mjs.new ${runtime} && mv ~/.reach-agent/agent.mjs.new ~/.reach-agent/agent.mjs && node ~/.reach-agent/agent.mjs restore`;
}

// The addresses in a line from `keep`: the computer's Tailscale name, its
// private address the same computer, and where its code comes from on the
// same tailnet. A credential is never restored toward anywhere else
// (connections audit, Oct 10).
export function keptAddresses(credential) {
  const parse = (value) => { try { return new URL(String(value)); } catch { return null; } };
  const origin = parse(credential?.origin);
  if (!origin || !tailnetHost(origin) || origin.origin !== credential.origin) return false;
  for (const [key, same] of [["private", (u) => u.hostname === origin.hostname], ["start", (u) => tailnetOf(u) === tailnetOf(origin)]]) {
    if (credential[key] == null) continue;
    const u = parse(credential[key]);
    if (!u || !tailnetHost(u) || u.origin !== credential[key] || !same(u)) return false;
  }
  return true;
}

// ~/.reach-agent: this file, the tailnet client, and one folder per computer.
export function agentHome() {
  const dir = path.resolve(
    process.env.REACH_AGENT_HOME || path.join(os.homedir(), ".reach-agent"),
  );
  if (process.platform === "win32") {
    const home = path.win32.resolve(os.homedir()).toLowerCase();
    const chosen = path.win32.resolve(dir).toLowerCase();
    const relative = path.win32.relative(chosen, home);
    if (chosen === path.win32.parse(chosen).root.toLowerCase() || !relative ||
        (!path.win32.isAbsolute(relative) && relative !== ".." && !relative.startsWith("..\\")))
      throw Error("Choose a separate folder for Reach's agent credentials, not your home or a whole drive.");
    for (const system of [process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]].filter(Boolean)) {
      const base = path.win32.resolve(system).toLowerCase();
      if (chosen === base || chosen.startsWith(base + "\\"))
        throw Error("Keep Reach's agent credentials outside Windows and installed-program folders.");
    }
    if (process.env.ProgramData && chosen === path.win32.resolve(process.env.ProgramData).toLowerCase())
      throw Error("Choose a separate folder for Reach's agent credentials, not the shared system-data folder.");
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (
    !stat.isDirectory() || stat.isSymbolicLink() ||
    (process.platform !== "win32" && stat.uid !== process.getuid())
  )
    throw Error(`${dir} must be a folder that belongs to you.`);
  if (process.platform !== "win32") fs.chmodSync(dir, 0o700);
  else {
    // The standalone agent is one bundled JS file, so this fixed system API
    // call needs no downloaded helper. Make the home private before creating
    // any connection/key: files and child folders inherit only these grants.
    const script = `& {
try {
$ErrorActionPreference='Stop'
$dir=$env:REACH_PRIVATE_AGENT_DIR
$info=Get-Item -LiteralPath $dir -Force
if($info.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'A private folder cannot be a link'}
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User
$trusted=@($me.Value,'S-1-5-18','S-1-5-32-544')
$acl=[IO.Directory]::GetAccessControl($dir)
if($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value){throw 'The folder belongs to another account'}
$acl.SetAccessRuleProtection($true,$false)
foreach($rule in @($acl.GetAccessRules($true,$false,[Security.Principal.SecurityIdentifier]))){[void]$acl.RemoveAccessRuleSpecific($rule)}
foreach($sid in $trusted){$who=New-Object Security.Principal.SecurityIdentifier($sid);$rule=New-Object Security.AccessControl.FileSystemAccessRule($who,'FullControl','ContainerInherit,ObjectInherit','None','Allow');$acl.AddAccessRule($rule)}
[IO.Directory]::SetAccessControl($dir,$acl)
$check=[IO.Directory]::GetAccessControl($dir)
if(!$check.AreAccessRulesProtected){throw 'Inheritance was not removed'}
foreach($rule in $check.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){if($rule.AccessControlType -eq 'Allow' -and $trusted -notcontains $rule.IdentityReference.Value){throw 'Another account can access the folder'}}
} catch { exit 1 }
[Console]::WriteLine('reach-agent-private')
exit 0
}

`;
    const system = process.env.SystemRoot || process.env.SYSTEMROOT;
    if (!system) throw Error("Reach couldn't locate Windows to protect the agent's credentials.");
    try {
      const answer = execFileSync(path.win32.join(system, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", "-"],
        { input: script, env: { ...process.env, REACH_PRIVATE_AGENT_DIR: dir }, windowsHide: true, timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
      if (!answer.toString("utf8").split(/\r?\n/).includes("reach-agent-private")) throw Error("Private-folder confirmation missing");
    } catch { throw Error("Reach couldn't make its agent folder private to your Windows account. No credentials were saved."); }
  }
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

// The tailnet client's files as this runtime pins them (scripts/build-agent.mjs
// tailnetPins): the runtime's own hash is pinned by the invitation, so a
// download or a cached copy that isn't exactly them never runs. A runtime run
// from source checks the hash its file names carry (connections audit, Oct 10).
const tailnetPinned = () =>
  typeof REACH_TAILNET_PINS !== "undefined" && REACH_TAILNET_PINS ? REACH_TAILNET_PINS : null;
export function tailnetFileTrusted(name, data, pins = tailnetPinned()) {
  const sha = crypto.createHash("sha256").update(data).digest("hex");
  if (pins) return [pins.exec, pins.wasm].some((p) => p?.name === name && p.sha256 === sha);
  const m = /\.([0-9a-f]{12})\.[a-z]+$/.exec(name);
  return !!m && sha.startsWith(m[1]);
}

// The tailnet client comes from the computer's start page, once per
// computer: one computer's client never handles another's node (security
// audit M8).
async function tailnetFiles(home, start, pins = tailnetPinned()) {
  const dir = path.join(home, "tailnet", new URL(start).host.replace(/[^\w.-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(dir, "tailnet.json");
  const trusted = (file) => {
    try {
      return tailnetFileTrusted(file, fs.readFileSync(path.join(dir, file)), pins);
    } catch {
      return false;
    }
  };
  try {
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    if (trusted(m.exec) && trusted(m.wasm))
      return {
        execFile: path.join(dir, m.exec),
        wasmFile: path.join(dir, m.wasm),
      };
  } catch {}
  process.stderr.write(
    "Reach: getting the tailnet client (one time, about 6 MB)…\n",
  );
  const get = async (route) => {
    const r = await fetch(new URL(route, start), { redirect: "error" });
    if (!r.ok) throw Error(`The computer's start page returned ${r.status}.`);
    return r;
  };
  const tailnet = pins
    ? { exec: pins.exec.name, wasm: pins.wasm.name }
    : (await (await get("/reach-start.json")).json()).tailnet;
  const name = /^[\w.-]+$/;
  if (!tailnet || !name.test(tailnet.wasm) || !name.test(tailnet.exec))
    throw Error(
      "This computer can't let agents join without the Tailscale app yet. Update Reach on it.",
    );
  for (const file of [tailnet.exec, tailnet.wasm]) {
    const data = Buffer.from(await (await get(`/tailnet/${file}`)).arrayBuffer());
    if (!tailnetFileTrusted(file, data, pins))
      throw Error("The tailnet client from that computer isn't the one this runtime names. Ask for a new invitation.");
    writePrivate(path.join(dir, file), data);
  }
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
export function tailnetApi(node, origin, token, { timeoutMs } = {}) {
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
    const deadline = setTimeout(() => call.abort(), timeoutMs ?? agentRequestTimeout(route, method));
    try {
      const head = await call.response;
      const screenImage = isScreenImageRoute(route) && method === "GET" && body === undefined && head.status >= 200 && head.status < 300;
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
        throw agentRequestError(head.status, result);
      return result;
    } catch (e) {
      if (!(Number.isInteger(e.status) && e.status >= 400 && e.status <= 599) && /abort|cancel/i.test(e.message))
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
// Processes share one connection through a local socket: a file next to the
// credential on macOS and Linux, a named pipe on Windows (it has no socket
// files). The pipe's default access, read on a real PC: only its owner,
// SYSTEM and Administrators may write to it, so only they can ask anything;
// anyone may open it to read, which gets no answer.
export const socketOf = (conn, platform = process.platform) =>
  platform === "win32"
    ? `\\\\.\\pipe\\reach-agent-${crypto.createHash("sha256").update(path.resolve(conn)).digest("hex").slice(0, 24)}`
    : path.posix.join(conn, "agent.sock");
const pipes = process.platform === "win32";
// Whether a process already shares this connection.
const listening = (file) => pipes
  ? new Promise((resolve) => {
      const s = net.connect(file);
      s.once("connect", () => { s.destroy(); resolve(true); });
      s.once("error", () => resolve(false));
    })
  : Promise.resolve(fs.existsSync(file));
export function shareNode(conn, api) {
  const file = socketOf(conn);
  if (!pipes) fs.rmSync(file, { force: true });
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
        socket.write(JSON.stringify({ id, error: agentErrorDetails(e).error, details: agentErrorDetails(e) }) + "\n");
      }
    });
    socket.on("error", () => {});
  });
  server.listen(file, () => { if (!pipes) fs.chmodSync(file, 0o600); });
  server.unref();
  if (!pipes) process.once("exit", () => fs.rmSync(file, { force: true }));
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
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          return;
        }
        if (!r || typeof r !== "object") return;
        const w = waiting.get(r.id);
        waiting.delete(r.id);
        if (r.error) w?.reject(agentRequestError(r.details?.status, r.details || { error: r.error }));
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

// Hourly while it works, an agent on its own tailnet device trades its
// credential for a new one (server/core.mjs rotateCredential). A copy of this
// folder then stops working, and using it ends the access on the computer
// (security audit M6). Only the process holding the connection does this;
// the others go through it. The new credential is saved before its first
// use, which is when the computer switches to it.
const ROTATE_EVERY_MS = 3600_000;
const rotations = new WeakMap();
export function rotateIfDue(conn, credential, call, { now = Date.now } = {}) {
  if (!["tailnet", "funnel"].includes(credential.via)) return Promise.resolve();
  const last = credential.rotatedAt || Date.parse(credential.joinedAt || "") || 0;
  if (now() - last < ROTATE_EVERY_MS) return Promise.resolve();
  if (!rotations.has(credential))
    rotations.set(credential, (async () => {
      const fresh = await call("/api/device/rotate", "POST", {});
      if (typeof fresh?.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(fresh.token)) return;
      const next = { ...credential, token: fresh.token, rotatedAt: now() };
      writePrivate(path.join(conn, "credential.json"), JSON.stringify(next, null, 2));
      Object.assign(credential, next);
    })().finally(() => rotations.delete(credential)));
  return rotations.get(credential);
}

// The computer's own runtime, when it serves a newer one than this (its
// tools change as Reach does): fetched over this agent's authenticated
// route, its bytes checked against the hash the computer named, then its
// tools loaded beside these and saved over this file for the next start.
// Only ever the bytes that computer serves (security audit M8). Only the
// bundle (dist/agent.mjs) does it, never a source checkout; never with
// REACH_AGENT_UPDATES=off. Anything that doesn't check out keeps this one.
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
export const isBundle = () => typeof REACH_AGENT_BUNDLE !== "undefined" && REACH_AGENT_BUNDLE === true;
export const updatesOff = (env = process.env) => /^(0|off|false|no)$/i.test(String(env.REACH_AGENT_UPDATES || "").trim());
// This bundle's own hash, for telling the computer which runtime it runs
// (with updates off too); none from a source checkout.
export function ownRuntime({ file = self(), bundle = isBundle() } = {}) {
  if (!bundle) return undefined;
  try { return sha256(fs.readFileSync(file)); } catch { return undefined; }
}
// What the computer tells a joined agent about its access (its guide on
// /api/device), as plain lines: "" when it doesn't say in time. Nothing in
// it can drive the terminal it's printed to.
export async function joinedGuide(api, { waitMs = 15000 } = {}) {
  let timer;
  try {
    const sha = ownRuntime();
    const device = await Promise.race([
      api(sha ? `/api/device?runtime=${sha}` : "/api/device"),
      new Promise((_, reject) => { timer = setTimeout(reject, waitMs, Error("The computer didn't say in time.")); }),
    ]);
    return typeof device?.guide === "string"
      ? device.guide.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069]/g, "").trim()
      : "";
  } catch {
    return "";
  } finally {
    clearTimeout(timer);
  }
}
export function runtimeUpdater({ home, api, file = self(), bundle = isBundle(), env = process.env, replaceSelf = true, log = (line) => process.stderr.write(line + "\n") }) {
  if (!bundle || updatesOff(env)) return null;
  let current;
  try { current = sha256(fs.readFileSync(file)); } catch { return null; }
  return {
    get current() { return current; },
    async update(wanted) {
      if (!/^[a-f0-9]{64}$/.test(wanted || "")) throw Error("The computer named no runtime.");
      const got = await api("/api/device/runtime");
      if (typeof got?.text !== "string" || got.sha256 !== wanted || sha256(Buffer.from(got.text, "utf8")) !== wanted)
        throw Error("its runtime didn't match the hash it named");
      // Loaded from its own name: it never starts as a program here.
      const dir = path.join(home, "runtime");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const copy = path.join(dir, `agent-${wanted.slice(0, 16)}.mjs`);
      writePrivate(copy, got.text);
      if (sha256(fs.readFileSync(copy)) !== wanted) throw Error("its runtime changed on disk");
      const loaded = await import(pathToFileURL(copy).href);
      if (typeof loaded.toolsFor !== "function" || typeof loaded.callTool !== "function")
        throw Error("its runtime offers no tools to load");
      for (const name of fs.readdirSync(dir))
        if (name !== path.basename(copy) && /^agent-[a-f0-9]{16}\.mjs$/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
      // The next start runs it whole. Connected to several computers, this
      // file stays as it is: each may serve its own runtime.
      if (replaceSelf && connections(home).length <= 1)
        try {
          const temp = `${file}.${process.pid}.tmp`;
          fs.writeFileSync(temp, got.text, { mode: fs.statSync(file).mode & 0o777 });
          fs.renameSync(temp, file);
        } catch { /* read-only: its tools still load from the copy */ }
      current = wanted;
      log(`Reach: updated to this computer's runtime (${wanted.slice(0, 12)}).`);
      return { toolsFor: loaded.toolsFor, callTool: loaded.callTool, ...(typeof loaded.toContent === "function" ? { toContent: loaded.toContent } : {}) };
    },
  };
}
// This runtime's tools, or the computer's newer ones, for a one-off command.
async function liveTools(home, api, device, runtime = runtimeUpdater({ home, api })) {
  const own = { toolsFor, callTool, toContent };
  if (!runtime || !/^[a-f0-9]{64}$/.test(device?.runtime || "") || device.runtime === runtime.current) return own;
  try { return await runtime.update(device.runtime); }
  catch (error) { process.stderr.write(`Reach: kept this runtime; the computer's newer one didn't load (${error.message}).\n`); return own; }
}

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
  // Through the computer's public link (or its private address), signed by
  // this agent's own key. Several processes may share this folder (an MCP
  // server, a call): the one holding the folder's lock trades the credential
  // hourly; the others read what it saved before each request.
  if (credential.via === "funnel") {
    const file = path.join(conn, "credential.json");
    let seen = fs.statSync(file).mtimeMs;
    const save = (next) => { writePrivate(file, JSON.stringify(next, null, 2)); seen = fs.statSync(file).mtimeMs; };
    const reload = () => {
      try {
        const now = fs.statSync(file).mtimeMs;
        if (now !== seen) { seen = now; Object.assign(credential, readCredential(conn)); }
      } catch { /* kept as it was */ }
    };
    const rotator = lock(conn);
    const api = funnelApi({ conn, credential, save, reload });
    return {
      credential,
      api: async (...args) => {
        if (rotator) await rotateIfDue(conn, credential, api).catch(() => {});
        return api(...args);
      },
    };
  }
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
        const api = async (...args) => {
          const node = await connectTailnet(where);
          // A trade that fails leaves the current credential as it was.
          await rotateIfDue(conn, credential, tailnetApi(node, credential.origin, credential.token, { timeoutMs: 15000 })).catch(() => {});
          return tailnetApi(node, credential.origin, credential.token)(...args);
        };
        if (!shared) {
          shareNode(conn, api);
          connectTailnet(where).catch(() => {}); // start joining now
        }
        shared = true;
        return { api };
      }
      if (await listening(socketOf(conn)))
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
// A path as the agent's shell reads it: single quotes on macOS and Linux,
// double quotes on Windows (cmd and PowerShell alike).
export const quote = (s, platform = process.platform) =>
  platform === "win32"
    ? /^[\w.:\\/~-]+$/.test(s) ? s : `"${s}"`
    : /^[\w./~-]+$/.test(s) ? s : `'${s.replace(/'/g, "'\\''")}'`;


// Whether this copy is the runtime its link names (r=): the second check,
// on the agent's own machine, after its steps checked the download (security
// audit M8). Run from source there is no one file to name, so it can't say.
export function runtimeMismatch(link, { file = self(), bundle = isBundle() } = {}) {
  if (!link?.runtime || !bundle) return false;
  try {
    return sha256(fs.readFileSync(file)) !== link.runtime;
  } catch {
    return true;
  }
}

export async function join(o) {
  const link = parseAgentLink(
    o._[1] && o._[1] !== "-" ? o._[1] : await readStdin(),
    o,
  );
  // Before anything is used or made: the invitation is good once.
  if (runtimeMismatch(link))
    throw Error("This copy of Reach for agents isn't the runtime your link names. Open your link and follow its steps again: they download the right one.");
  const home = agentHome();
  const name =
    new URL(link.origin).hostname
      .split(".")[0]
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "") || "computer";
  const conn = path.join(home, name);
  // A connection still good is kept; one whose access ended (its time ran
  // out) is replaced by the new invitation, with no leave first.
  if (joinedAt(conn) && !(readCredential(conn).expiresAt <= Date.now()))
    throw Error(
      `Already connected to ${name}. To join again: node ${quote(self())} leave --computer ${name}`,
    );
  fs.mkdirSync(conn, { recursive: true, mode: 0o700 });
  if (!lock(conn)) throw Error(`Another join to ${name} is running.`);
  // What a join cut short left behind (its invitation is spent or unused).
  for (const file of ["credential.json", "tailnet-state.json", "agent.sock", "key.pem"])
    fs.rmSync(path.join(conn, file), { force: true });
  // Somewhere safe to keep the credential, before the invitation is used.
  const credentialFile = path.join(conn, "credential.json");
  writePrivate(credentialFile, "{}");
  fs.rmSync(credentialFile);
  try {
    const funnel = link.funnel === true;
    const direct = !funnel && (await reachableDirect(link.origin));
    // A public-link invitation, from a machine on the owner's tailnet: the
    // computer's private address first; the public link only when it
    // doesn't answer. Checked again on every call.
    const privately = funnel && !!link.private && (await reachableDirect(link.private));
    let admissionApi, node;
    if (funnel) {
      // No Tailscale key: every request signed by this agent's own key
      // (scripts/agent-funnel.mjs), to whichever address answers.
      const gateway = funnelGateway(link.public, agentKey(conn), { endpoints: [...(privately ? [link.private] : []), link.public], ...(o.send ? { send: o.send } : {}) });
      admissionApi = async (route, _method, body) => {
        const status = /^\/api\/invitations\/claims\/([a-f0-9-]{36})\/status$/.exec(route);
        const answer = status ? await gateway.status(status[1], body.secret) : await gateway.claim(body.invitation);
        if (answer.status >= 400) throw agentRequestError(answer.status, answer.json);
        return answer.json;
      };
    } else if (direct)
      admissionApi = (route, _method, body) => admissionDirect(link.origin, route, body);
    else {
      if (!link.key)
        throw Error(
          "This machine isn't on that tailnet, and the link has no Tailscale key. Ask the owner to set up invite links in Reach (Share → Set up), then invite the agent again.",
        );
      process.stderr.write("Reach: joining the tailnet…\n");
      node = await connectTailnet({ home, conn, ...link });
      admissionApi = tailnetApi(node, link.origin, "");
    }
    let joined = await admissionApi("/api/invitations/redeem", "POST", { invitation: link.secret });
    joined = await waitForAgentAdmission(joined, admissionApi);
    if (joined.kind !== "agent")
      throw Error("That invitation isn't for an agent.");
    const credential = {
      version: 1,
      via: funnel ? "funnel" : direct ? "direct" : "tailnet",
      computer: joined.device?.name || name,
      start: link.start,
      origin: funnel ? link.public : link.origin,
      hostname: link.hostname,
      token: joined.token,
      // Its link: the same key reconnects through it when a session ends;
      // its private address, tried first on every call.
      ...(funnel ? { invitation: link.secret, private: link.private } : {}),
      clientId: joined.clientId,
      scopes: joined.scopes,
      expiresAt: joined.expiresAt,
      joinedAt: new Date().toISOString(),
    };
    writePrivate(credentialFile, JSON.stringify(credential, null, 2));
    const several = connections(home).length > 1;
    const run = `node ${quote(self())} mcp${several ? ` --computer ${name}` : ""}`;
    const server = several ? `reach-${name}` : "reach";
    // What it may do and the rules, as the computer says them now (the
    // invite message is two lines): with its new credential, the way it
    // came in. A guide that doesn't come never undoes the join.
    const guide = await joinedGuide(
      funnel
        ? funnelApi({ conn, credential, gatewayOptions: o.send ? { send: o.send } : {} })
        : direct
          ? directApi(link.origin, joined.token, o.allowLocal)
          : tailnetApi(node, link.origin, joined.token, { timeoutMs: 15000 }),
    );
    process.stdout.write(
      [
        `Connected to ${credential.computer}${direct ? " (direct, through Tailscale on this machine)" : funnel ? privately ? " (through the owner's tailnet; its public link when that's away)" : " (through its public link)" : ""}.`,
        `Access: ${joined.scopes.filter((s) => s !== "device").join(", ")}, until ${new Date(joined.expiresAt).toLocaleString()}.`,
        "",
        ...(guide
          ? ["Your instructions from the owner (Reach's tools give them again any time):", ...guide.split("\n").map((line) => `  ${line}`)]
          : ["Your instructions from the owner: once Reach is added below, reach_device or reach_access gives them."]),
        "",
        "Add it to your agent (once):",
        `  Claude Code:  claude mcp add --scope user ${server} -- ${run}`,
        `  Codex:        codex mcp add ${server} -- ${run}`,
        `  Gemini CLI:   gemini mcp add -s user ${server} ${run}`,
        "                Gemini uses it only in a folder you trust: trust the one you run it in when it asks, or list it in ~/.gemini/trustedFolders.json.",
        `  Claude Desktop, Cursor, Windsurf, VS Code, any other: paste the JSON from  node ${quote(self())} config${several ? ` --computer ${name}` : ""}`,
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
      "Reach for agents\n  join '<agent link>'   connect to the computer that invited you (once)\n  mcp                   serve its tools over MCP (stdio)\n  config                its MCP settings as JSON (Claude Desktop, Cursor, Windsurf, VS Code, Gemini)\n  status                computers you're connected to\n  tools                 tools and argument schemas as JSON\n  call TOOL '{json}'    use one tool once\n  keep                  your access as one line, for your vault (restore it on another machine)\n  restore               your access back, from that line on standard input\n  leave                 disconnect and forget it\nWith several computers, add --computer NAME.\nIt takes the tools of the computer it joined as Reach there changes (REACH_AGENT_UPDATES=off to keep this copy).\n",
    );
    return 0;
  }
  if (verb === "join") return join(o);
  const home = agentHome();
  // The agent's whole access to a computer, as one line for its vault: its
  // credential, its signing key, its tailnet node if it has one. Restored on
  // another machine, it reconnects by itself (the computer knows its key).
  if (verb === "restore") {
    let blob;
    try { blob = JSON.parse(Buffer.from((await readStdin()).trim(), "base64url").toString("utf8")); } catch { blob = null; }
    if (blob?.reach !== 1 || !/^[a-z0-9-]{1,64}$/.test(blob.name || "") || typeof blob.credential?.token !== "string" ||
        !["funnel", "direct", "tailnet"].includes(blob.credential.via) || !keptAddresses(blob.credential))
      throw Error("That isn't a line from `keep`. Paste the whole line on standard input.");
    const conn = path.join(home, blob.name);
    if (joinedAt(conn) && !(readCredential(conn).expiresAt <= Date.now()))
      throw Error(`Already connected to ${blob.name}. To replace it: node ${quote(self())} leave --computer ${blob.name}`);
    fs.mkdirSync(conn, { recursive: true, mode: 0o700 });
    for (const stale of ["credential.json", "tailnet-state.json", "agent.sock", "key.pem", "lock"]) fs.rmSync(path.join(conn, stale), { force: true });
    writePrivate(path.join(conn, "credential.json"), JSON.stringify(blob.credential, null, 2));
    if (typeof blob.key === "string" && new RegExp("^-----BEGIN " + "PRIVATE KEY-----").test(blob.key)) writePrivate(path.join(conn, "key.pem"), blob.key);
    if (typeof blob.tailnet === "string") writePrivate(path.join(conn, "tailnet-state.json"), blob.tailnet);
    process.stdout.write(`Restored ${blob.credential.computer || blob.name}. It reconnects by itself: node ${quote(self())} tools\n`);
    return 0;
  }
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
  // Its MCP server as the JSON most clients' settings take: on stdout alone,
  // where to paste it on stderr.
  if (verb === "config") {
    const several = connections(home).length > 1;
    const args = [self(), "mcp", ...(several ? ["--computer", name] : []), ...(o.allowLocal ? ["--allow-local"] : [])];
    process.stdout.write(JSON.stringify({ mcpServers: { [several ? `reach-${name}` : "reach"]: { command: "node", args } } }, null, 2) + "\n");
    process.stderr.write([
      "Paste it into your client's MCP settings, then restart the client:",
      "  Claude Desktop  ~/Library/Application Support/Claude/claude_desktop_config.json  (Windows: %APPDATA%\\Claude\\claude_desktop_config.json)",
      "  Cursor          ~/.cursor/mcp.json",
      "  Windsurf        ~/.codeium/windsurf/mcp_config.json",
      "  VS Code         .vscode/mcp.json, with \"servers\" in place of \"mcpServers\"",
      "  Gemini CLI      ~/.gemini/settings.json",
      "",
    ].join("\n"));
    return 0;
  }
  if (verb === "mcp") {
    // Nothing but JSON-RPC on stdout.
    for (const k of ["log", "info", "debug", "warn"])
      console[k] = console.error;
    const { api, credential } = await open(home, name, o.allowLocal);
    // Owner edits may change a browser preset during this process's lifetime.
    // Refresh the grant when the client asks for its current tools. A newer
    // runtime on the computer brings its tools in while this keeps running.
    const runtime = runtimeUpdater({ home, api });
    const report = ownRuntime();
    await serveMcp({
      api,
      scopes: credential.scopes,
      name: `reach-${name}`,
      ...(runtime ? { runtime } : {}),
      ...(report ? { report } : {}),
    });
    return 0;
  }
  if (verb === "call") {
    const { api } = await open(home, name, o.allowLocal);
    const args = o._[2] ? JSON.parse(o._[2]) : {};
    // Some tool names (notably reach_open_app) exist in both the original
    // apps:drive API and browser presets, with different arguments/routes.
    // Resolve the live grant exactly as MCP does, including owner edits.
    const runtime = runtimeUpdater({ home, api });
    const said = (route) => { const sha = runtime?.current || ownRuntime(); return sha ? `${route}?runtime=${sha}` : route; };
    const device = await api(said("/api/device"));
    const scopes = device.access?.scopes || [];
    const tools = await liveTools(home, api, device, runtime);
    // The request Reach plans for this call, when it can (mcp-server.mjs).
    const planned = scopes.includes("browser:read") ? await computerPlan(api, o._[1], args, said) : null;
    if (planned) {
      process.stdout.write(JSON.stringify(await api(planned.plan.route, planned.plan.method, planned.plan.body), null, 2) + "\n");
      return 0;
    }
    const access = scopes.includes("browser:read") ? await api(said("/api/browser")) : undefined;
    process.stdout.write(
      JSON.stringify(await tools.callTool(api, o._[1], args, access), null, 2) + "\n",
    );
    return 0;
  }
  if (verb === "tools") {
    const { api } = await open(home, name, o.allowLocal);
    const runtime = runtimeUpdater({ home, api });
    const said = (route) => { const sha = runtime?.current || ownRuntime(); return sha ? `${route}?runtime=${sha}` : route; };
    const device = await api(said("/api/device"));
    const scopes = device.access?.scopes || [];
    const tools = await liveTools(home, api, device, runtime);
    // Reach's own list when it has one: every tool it has now.
    const served = scopes.includes("browser:read") ? await computerTools(api, said) : null;
    if (served) {
      process.stdout.write(JSON.stringify(served.tools, null, 2) + "\n");
      return 0;
    }
    const access = scopes.includes("browser:read") ? await api(said("/api/browser")) : undefined;
    process.stdout.write(
      JSON.stringify(tools.toolsFor(scopes, access), null, 2) + "\n",
    );
    return 0;
  }
  if (verb === "keep") {
    const conn = path.join(home, name);
    const credential = readCredential(conn);
    const read = (file) => { try { return fs.readFileSync(path.join(conn, file), "utf8"); } catch { return undefined; } };
    const key = read("key.pem"), tailnet = read("tailnet-state.json");
    const line = Buffer.from(JSON.stringify({ reach: 1, name, credential, ...(key ? { key } : {}), ...(tailnet ? { tailnet } : {}) })).toString("base64url");
    const thumbprint = credential.via === "funnel" ? agentKey(conn).thumbprint : "";
    process.stderr.write([
      `This line is your whole access to ${credential.computer}: keep it in your vault, nowhere else.`,
      process.platform === "win32"
        ? `On another machine, get Reach for agents and restore it, in PowerShell with your line in place of ${YOUR_LINE}:`
        : "On another machine, get Reach for agents, then paste the line on standard input:",
      `  ${restoreCommand(credential.start, thumbprint, keptRuntime())}`,
      "",
    ].join("\n"));
    process.stdout.write(line + "\n");
    return 0;
  }
  if (verb === "leave") {
    const conn = path.join(home, name);
    const credential = readCredential(conn);
    // The computer ends this access first (its device leaves the owner's
    // tailnet there too), so a copy of this folder is worth nothing after.
    const end = async (api) => { try { await api()("/api/device/access", "DELETE"); } catch {} };
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
        await end(() => tailnetApi(node, credential.origin, credential.token, { timeoutMs: 10000 }));
        node.logout();
        await new Promise((r) => setTimeout(r, 1500));
      } catch {}
    } else if (credential.via === "direct")
      await end(() => directApi(credential.origin, credential.token, o.allowLocal));
    else if (credential.via === "funnel")
      await end(() => funnelApi({ conn, credential }));
    fs.rmSync(conn, { recursive: true, force: true });
    process.stdout.write(`Left ${credential.computer}.\n`);
    return 0;
  }
  throw Error(`Unknown command "${verb}". Run: node agent.mjs help`);
}

// What an older runtime loads from this one when the computer serves it.
export { callTool, toContent, toolsFor };

// Run, not imported: the same file however its path was written. Windows'
// own spelling of it (fs.realpathSync.native: its 8.3 short names written
// long, its case as on disk) on both sides; Node names this module as it was
// given, so a run through C:\Users\RUNNER~1\… did nothing at all.
const realFile = (file) => { try { return fs.realpathSync.native(file); } catch { return ""; } };
const entry = process.argv[1] && realFile(process.argv[1]);
if (entry && entry === realFile(fileURLToPath(import.meta.url)))
  // Exit once everything written has gone out: the tailnet client would
  // otherwise keep the process running, and a pipe may still be draining.
  main()
    .then((code) => process.stdout.write("", () => process.exit(code ?? 0)))
    .catch((e) =>
      process.stderr.write(JSON.stringify(agentErrorDetails(e)) + "\n", () => process.exit(1)),
    );
