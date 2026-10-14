import fs from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { windowsFixture } from "./windows-fixtures.mjs";

// A stand-in for the `tailscale` command line (REACH_TAILSCALE), for running
// a real Reach in Tailscale mode without this computer's Tailscale: no route,
// Funnel or sign-in on the real daemon is ever read or changed. It keeps its
// Serve/Funnel routes in a JSON file, and records every call.
//
// Scenario fields: host, login, version (and daemonVersion, when the daemon
// runs another; cliVersion, when the command line does), funnelDenied (Funnel
// not allowed by the tailnet's policy: stderr, exit 1), serve (routes already
// there, e.g. another service on port 443), TUN (false: userspace
// networking). Windows' browser sign-in (docs/parity/D-public-door.md §7.1):
// funnelEnable "exit" (Funnel not allowed yet: the page on stdout, exit 0) or
// "wait" (the same, then waits until setStatus({ funnelEnabled: true })),
// etagConflicts (the next n sessions are told another client is changing the
// serve config), sessionLingerMs (an ended session stays listed that long).
//
// `serve` (and `funnel`) without --bg is a foreground session, as Tailscale
// has it: shown under Foreground while that `tailscale` process lives, gone
// once it ends. It ends with its parent too, as Windows ends a non-detached
// child with the process that started it (a kill-on-close job object). Each
// session is kept in its own file by the process holding it, so no other
// call's write of the shared state can lose it.
//
// A session whose target is a keyed route (http://127.0.0.1:<port>/r-<key>)
// runs a small proxy, as tailscaled does: the key put in front of every path,
// identity and Funnel headers removed and set again, X-Forwarded-For from
// `x-fake-from` (default 100.64.0.20, a phone; 100.64.0.10 is this computer).
// Its port is `proxy` in the session; each connection it opens to Reach is
// noted in `from` ({ port, at }).
//
// On a real Windows runner, `cli` is tailscale.exe
// (test/fixtures/windows/tailscale-shim.cs), which runs the script with Node
// in a kill-on-close job of its own: ended, its session ends with it, as
// Tailscale's does. Windows gives a finished process's id to the next one
// at once, so there a session lives while the named pipe it holds does
// (`pipe`), not while some process has its id.
export const HOST = "mac.example.ts.net";
export const PHONE_IP = "100.64.0.20";
export const SELF_IP = "100.64.0.10";
const SESSION = /^fake-tailscale-session-\d+\.json$/;
const PIPES = "\\\\.\\pipe\\";
// Whether a session's process lives.
export const sessionAlive = (s) => {
  if (s.pipe)
    try {
      return readdirSync(PIPES).includes(s.pipe);
    } catch {
      return false;
    }
  try {
    process.kill(s.pid, 0);
    return true;
  } catch {
    return false;
  }
};
// The same, as source for the stand-in command and the preload (each has `fs`).
const aliveSource = `(s) => {
  if (s.pipe) try { return fs.readdirSync(${JSON.stringify(PIPES)}).includes(s.pipe); } catch { return false; }
  try { process.kill(s.pid, 0); return true; } catch { return false; }
}`;
// The live sessions (source, for the stand-in command and the preload alike).
const liveSessions = `(dir) => fs.readdirSync(dir).filter((f) => ${SESSION}.test(f)).flatMap((f) => {
  try {
    const s = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"));
    return (${aliveSource})(s) ? [s] : [];
  } catch { return []; }
})`;
const sessionsIn = (dir) =>
  readdirSync(dir)
    .filter((f) => SESSION.test(f))
    .flatMap((f) => {
      try {
        const s = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        return sessionAlive(s) ? [s] : [];
      } catch {
        return [];
      }
    });
const withSessions = (serve, sessions) =>
  sessions.length ? { ...serve, Foreground: Object.fromEntries(sessions.map((s) => [s.id, s.config])) } : serve;
const etagTokens = async (dir, count) => {
  for (let i = 0; i < count; i++) await fs.writeFile(path.join(dir, `fake-tailscale-etag-${Date.now()}-${i}`), "");
};
export async function fakeTailscale(dir, scenario = {}) {
  const state = path.join(dir, "fake-tailscale.json");
  const setup = path.join(dir, "fake-tailscale-setup.json");
  const script = path.join(dir, "tailscale");
  // Windows runs programs, not scripts: its stand-in tailscale.exe runs this one.
  const cli = process.platform === "win32" ? path.join(dir, "tailscale.exe") : script;
  if (cli !== script) {
    await fs.copyFile(await windowsFixture("tailscale-shim"), cli);
    await fs.writeFile(path.join(dir, "fake-tailscale-shim.txt"), `${process.execPath}\r\n${script}\r\n`);
  }
  await fs.writeFile(setup, JSON.stringify({ BackendState: "Running", CurrentTailnet: { MagicDNSEnabled: true }, ...scenario.setup }));
  await fs.writeFile(
    state,
    JSON.stringify({ host: HOST, login: "owner@example.test", version: "1.90.0", funnelDenied: false, serve: {}, calls: [], ...scenario }),
  );
  await etagTokens(dir, scenario.etagConflicts || 0);
  await fs.writeFile(
    script,
    `#!${process.execPath}
const fs = require("fs");
const file = ${JSON.stringify(state)};
const setupFile = ${JSON.stringify(setup)};
const dir = ${JSON.stringify(dir)};
const sessions = ${liveSessions};
// Several run at once (Reach asks for its version and status together):
// written whole (a rename), so none reads another's half-written file.
const state = JSON.parse(fs.readFileSync(file, "utf8"));
const setup = JSON.parse(fs.readFileSync(setupFile, "utf8"));
const args = process.argv.slice(2);
state.calls.push(args);
// Replaced whole; Windows may refuse a moment while another reads it.
const replace = (to, text) => {
  const temp = to + "." + process.pid;
  fs.writeFileSync(temp, text);
  for (let i = 0; ; i++)
    try { return fs.renameSync(temp, to); } catch (e) {
      if (i >= 50 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
};
const save = () => replace(file, JSON.stringify(state));
const alive = ${aliveSource};
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const [command, ...rest] = args;
const self = { ID: "nMac", UserID: 42, DNSName: state.host + ".", HostName: "mac", KeyExpiry: "0001-01-01T00:00:00Z", TailscaleIPs: ["100.64.0.10"] };
// What \`serve status\` lists: live sessions, and (sessionLingerMs) an ended
// one for that long after a status first saw it ended, its going noted then.
const listed = (dir) => fs.readdirSync(dir).filter((f) => ${SESSION}.test(f)).flatMap((f) => {
  let s;
  try { s = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8")); } catch { return []; }
  if (alive(s)) return [s];
  if (!state.sessionLingerMs) return [];
  const now = Date.now();
  if (!s.deadSeenAt) {
    s.deadSeenAt = now;
    try { replace(dir + "/" + f, JSON.stringify(s)); } catch {}
    return [s];
  }
  if (now - s.deadSeenAt < state.sessionLingerMs) return [s];
  try { fs.writeFileSync(dir + "/fake-tailscale-gone-" + s.pid + ".json", JSON.stringify({ id: s.id, args: s.args, at: now })); fs.rmSync(dir + "/" + f, { force: true }); } catch {}
  return [];
});
// Told another client is changing the serve config: one token each, taken
// whole (an unlink only one process can win).
const takeEtag = () => {
  for (const f of fs.readdirSync(dir).filter((f) => f.startsWith("fake-tailscale-etag-")))
    try { fs.unlinkSync(dir + "/" + f); return true; } catch {}
  return false;
};
const ALLOW = "Funnel is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         https://login.tailscale.com/f/funnel?node=nMac\\n";
save();
if (command === "version") out((state.cliVersion || state.version) + "\\n  tailscale commit: fake\\n");
else if (command === "status") {
  if (setup.closed) { process.stderr.write("failed to connect to local tailscaled\\n"); process.exit(1); }
  out({ BackendState: "Running", Version: (state.daemonVersion || state.version) + "-tfake", TUN: state.TUN ?? true, Self: self, User: { 42: { ID: 42, LoginName: state.login } }, Peer: {}, CertDomains: [state.host], MagicDNSSuffix: "example.ts.net", ...setup });
}
else if (command === "whois") {
  const ip = rest.at(-1);
  if (state.identities?.[ip]) out(state.identities[ip]);
  else if (ip === "100.64.0.10") out({ Node: { ...self, User: 42, StableID: "nMac", Name: self.DNSName, ComputedName: "mac" }, UserProfile: { ID: 42, LoginName: state.login } });
  else out({ Node: { ID: 7, User: 42, StableID: "nPhone", Name: "owner-iphone.example.ts.net.", ComputedName: "owner-iphone", KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: state.login } });
} else if (command === "serve" && rest[0] === "--help") process.stderr.write("USAGE\\n  tailscale serve [flags] <target>\\n  <target> can be a port, http://, https+insecure:// or unix:/path/to/socket\\n");
else if (command === "serve" && rest[0] === "status") {
  const live = listed(dir);
  out(live.length ? { ...state.serve, Foreground: Object.fromEntries(live.map((s) => [s.id, s.config])) } : state.serve);
} else if ((command === "serve" || command === "funnel") && !rest.includes("--bg") && rest.filter((a) => !a.startsWith("--")).at(-1) !== "off") {
  // In the foreground: held while this process lives.
  const port = Number((rest.find((a) => a.startsWith("--https=")) || "--https=443").split("=")[1]);
  const target = rest.filter((a) => !a.startsWith("--")).at(-1);
  const key = state.host + ":" + port;
  const funnel = command === "funnel";
  const session = dir + "/fake-tailscale-session-" + process.pid + ".json";
  const parent = process.ppid;
  const end = () => {
    if (!state.sessionLingerMs) try { fs.rmSync(session, { force: true }); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
  setInterval(() => process.ppid !== parent && end(), 100);
  // Never outlives a test run.
  setTimeout(end, 600000);
  const hold = () => {
    if (state.serve.TCP?.[port] || sessions(dir).some((s) => s.config.TCP?.[port])) {
      process.stderr.write("listener already exists for port " + port + "\\n");
      process.exit(1);
    }
    if (takeEtag()) {
      process.stderr.write("Another client is changing the serve config; please try again.\\n");
      process.exit(1);
    }
    const config = { TCP: { [port]: { HTTPS: true } }, Web: { [key]: { Handlers: { "/": { Proxy: target } } } }, ...(funnel && { AllowFunnel: { [key]: true } }) };
    const record = { id: "fake-session-" + process.pid, pid: process.pid, args, config, from: [], ...(pipe && { pipe }) };
    const write = () => replace(session, JSON.stringify(record));
    const announce = () => {
      write();
      out((funnel ? "Available on the internet:" : "Available within your tailnet:") + "\\n\\nhttps://" + key + "\\n|-- proxy " + target + "\\n\\nPress Ctrl+C to exit.\\n");
    };
    if (!/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/r-/.test(target)) return announce();
    // tailscaled's proxy: the key in front of every path, its own headers.
    const http = require("http");
    const net = require("net");
    const upstream = new URL(target);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 16 });
    const note = (socket) => {
      if (socket.fakeNoted) return;
      socket.fakeNoted = true;
      const add = () => {
        record.from.push({ port: socket.localPort, at: Date.now() });
        if (record.from.length > 500) record.from.splice(0, 100);
        write();
      };
      if (socket.localPort) add();
      else socket.once("connect", add);
    };
    const clean = (req) => {
      const headers = {};
      for (const [name, value] of Object.entries(req.headers)) {
        const lower = name.toLowerCase();
        if (lower.startsWith("tailscale-") || lower === "forwarded" || lower.startsWith("x-forwarded-") || lower === "x-fake-from") continue;
        headers[name] = value;
      }
      const source = typeof req.headers["x-fake-from"] === "string" ? req.headers["x-fake-from"] : "100.64.0.20";
      headers["x-forwarded-host"] = req.headers.host;
      headers["x-forwarded-for"] = source;
      if (funnel) headers["tailscale-funnel-request"] = "?1";
      else headers["tailscale-user-login"] = state.identities?.[source]?.UserProfile?.LoginName || state.login;
      return headers;
    };
    const server = http.createServer((req, res) => {
      const headers = clean(req);
      delete headers.connection;
      delete headers["keep-alive"];
      const forward = http.request({ host: "127.0.0.1", port: Number(upstream.port), method: req.method, path: upstream.pathname + req.url, headers, agent }, (answer) => {
        res.writeHead(answer.statusCode, answer.headers);
        answer.pipe(res);
      });
      forward.on("socket", note);
      forward.on("error", () => res.destroy());
      req.pipe(forward);
    });
    server.on("upgrade", (req, socket, head) => {
      const to = net.connect(Number(upstream.port), "127.0.0.1");
      note(to);
      to.on("error", () => socket.destroy());
      socket.on("error", () => to.destroy());
      to.once("connect", () => {
        const headers = clean(req);
        to.write(req.method + " " + upstream.pathname + req.url + " HTTP/1.1\\r\\n" + Object.entries(headers).map(([k, v]) => k + ": " + v + "\\r\\n").join("") + "\\r\\n");
        if (head?.length) to.write(head);
        to.pipe(socket);
        socket.pipe(to);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      record.proxy = server.address().port;
      announce();
    });
  };
  // Windows: the session's own pipe, held from before it's first written.
  const pipe = process.platform === "win32" ? "fake-tailscale-" + process.pid + "-" + require("crypto").randomBytes(6).toString("hex") : "";
  const start = (then) => (pipe ? require("net").createServer().listen(${JSON.stringify(PIPES)} + pipe, then) : then());
  const enable = setup.funnelEnable ?? state.funnelEnable;
  if (funnel && (setup.funnelDenied ?? state.funnelDenied)) {
    process.stderr.write(ALLOW);
    process.exit(1);
  } else if (funnel && enable === "exit" && !setup.funnelEnabled) {
    out(ALLOW);
    process.exit(0);
  } else if (funnel && enable === "wait" && !setup.funnelEnabled) {
    // Waits, watching, until Funnel is allowed; then the session.
    out(ALLOW);
    const wait = setInterval(() => {
      try {
        if (JSON.parse(fs.readFileSync(setupFile, "utf8")).funnelEnabled !== true) return;
      } catch { return; }
      clearInterval(wait);
      start(hold);
    }, 50);
  } else start(hold);
} else if (command === "serve" || command === "funnel") {
  const port = Number((rest.find((a) => a.startsWith("--https=")) || "--https=443").split("=")[1]);
  const target = rest.filter((a) => !a.startsWith("--")).at(-1);
  const key = state.host + ":" + port;
  const serve = state.serve;
  if (target !== "off" && sessions(dir).some((s) => s.config.TCP?.[port])) {
    process.stderr.write("foreground listener already exists for port " + port + "\\n");
    process.exit(1);
  }
  if (target === "off") {
    if (serve.TCP) delete serve.TCP[port];
    if (serve.Web) delete serve.Web[key];
    if (serve.AllowFunnel) delete serve.AllowFunnel[key];
    for (const k of ["TCP", "Web", "AllowFunnel"]) if (serve[k] && !Object.keys(serve[k]).length) delete serve[k];
  } else if (command === "funnel" && (setup.funnelDenied ?? state.funnelDenied)) {
    process.stderr.write(ALLOW);
    process.exit(1);
  } else if (rest.some((a) => a.startsWith("--tcp="))) {
    // A TCP forward: tailscale serve --bg --tcp=<port> tcp://<host>:<port>
    const tcp = Number(rest.find((a) => a.startsWith("--tcp=")).split("=")[1]);
    serve.TCP = { ...serve.TCP, [tcp]: { TCPForward: target.replace(/^tcp:\\/\\//, "") } };
  } else {
    serve.TCP = { ...serve.TCP, [port]: { HTTPS: true } };
    serve.Web = { ...serve.Web, [key]: { Handlers: { "/": { Proxy: target } } } };
    if (command === "funnel") serve.AllowFunnel = { ...serve.AllowFunnel, [key]: true };
  }
  save();
} else if (command === "login") out("https://login.tailscale.com/a/fixture-login\\n");
else if (command === "up") {
  const setup = JSON.parse(fs.readFileSync(setupFile, "utf8"));
  fs.writeFileSync(setupFile, JSON.stringify({ ...setup, BackendState: "Running" }));
} else if (command === "debug" && rest[0] === "prefs") out({});
else { process.stderr.write("fake tailscale: unsupported " + args.join(" ") + "\\n"); process.exit(2); }
`,
    { mode: 0o755 },
  );
  const update = async (patch) => {
    const current = JSON.parse(await fs.readFile(state, "utf8"));
    const temporary = state + ".next";
    await fs.writeFile(temporary, JSON.stringify({ ...current, ...(typeof patch === "function" ? patch(current) : patch) }));
    await fs.rename(temporary, state);
  };
  return {
    cli,
    state,
    // As `serve status` would show it now (live sessions under Foreground).
    read: async () => {
      const value = JSON.parse(await fs.readFile(state, "utf8"));
      return { ...value, serve: withSessions(value.serve, sessionsIn(dir)) };
    },
    // The foreground sessions held now: { id, pid, args, config, proxy, from }.
    sessions: async () => sessionsIn(dir),
    setStatus: async (value) => {
      const current = JSON.parse(await fs.readFile(setup, "utf8"));
      const temporary = setup + ".next";
      await fs.writeFile(temporary, JSON.stringify({ ...current, ...value }));
      await fs.rename(temporary, setup);
    },
    // Changes the stand-in's own state (its background routes, versions…).
    update,
    // The next n sessions are told another client is changing the config.
    etagConflicts: (count) => etagTokens(dir, count),
    // Sessions that ended and were then dropped (sessionLingerMs): when.
    gone: async () =>
      (await fs.readdir(dir))
        .filter((f) => /^fake-tailscale-gone-\d+\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8"))),
  };
}

// In the Reach under test: its own address reaches it the way Tailscale's
// Serve route would (a tailnet device asking, through the route's socket),
// and nothing it would open on this computer (a browser page, caffeinate)
// is started. With FAKE_TTY, its terminal reads as one someone is watching.
export const tailnetPreload = (statePath) =>
  "data:text/javascript," +
  encodeURIComponent(`
  import fs from "node:fs";
  import http from "node:http";
  import cp from "node:child_process";
  import { syncBuiltinESMExports } from "node:module";
  const STATE = ${JSON.stringify(statePath)};
  const sessions = ${liveSessions};
  if (process.env.FAKE_TTY) Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
  // FAKE_DNS=missing: the zone's own nameservers don't know the public name
  // yet (server/public-dns.mjs); otherwise no lookup leaves this computer.
  const dns = (await import("node:dns")).default;
  const unknown = () => Promise.reject(Object.assign(new Error("not here"), { code: "ESERVFAIL" }));
  dns.promises.resolveNs = process.env.FAKE_DNS === "missing" ? async () => ["ns1.example.net"] : unknown;
  dns.promises.resolve4 = async () => ["192.0.2.53"];
  dns.promises.Resolver = class {
    setServers() {}
    resolve4() {
      return Promise.reject(Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }));
    }
  };
  const asked = (options, url, init, resolve, reject) => {
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.once("error", reject);
    req.end(init.body);
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (url.hostname !== state.host) return realFetch(input, init);
    const key = state.host + ":" + (url.port || 443);
    const live = sessions(${JSON.stringify(path.dirname(statePath))});
    // A background route, or a foreground session's while it lives.
    const target = [state.serve, ...live.map((s) => s.config)]
      .map((serve) => serve?.Web?.[key]?.Handlers?.["/"]?.Proxy)
      .find(Boolean);
    // A Windows Reach's keyed route: through the session's stand-in for
    // tailscaled's proxy, as a phone on the tailnet.
    if (/^http:\\/\\/127\\.0\\.0\\.1:\\d+\\/r-/.test(target || "")) {
      const session = live.find((s) => s.config?.Web?.[key] && s.proxy);
      if (!session) throw new TypeError("fetch failed");
      return new Promise((resolve, reject) =>
        asked({ host: "127.0.0.1", port: session.proxy, path: url.pathname + url.search, method: init.method || "GET", headers: { ...init.headers, Host: url.host } }, url, init, resolve, reject),
      );
    }
    // A Windows Reach's route: its local address (no Unix socket there).
    if (target?.startsWith("http://127.0.0.1:"))
      return realFetch(target + url.pathname + url.search, { ...init, headers: { ...init.headers, Host: url.host, "X-Forwarded-For": "100.64.0.10" } });
    if (!target?.startsWith("unix:")) throw new TypeError("fetch failed");
    return new Promise((resolve, reject) =>
      asked({ socketPath: target.slice(5), path: url.pathname + url.search, method: init.method || "GET", headers: { Host: url.host, "X-Forwarded-For": "100.64.0.10", "Tailscale-User-Login": state.login } }, url, init, resolve, reject),
    );
  };
  const spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (["open", "/usr/bin/open", "caffeinate", "/usr/bin/caffeinate", "explorer.exe"].includes(command))
      return spawn.call(this, process.execPath, ["-e", "setTimeout(() => {}, 10)"], { stdio: "ignore" });
    return spawn.apply(this, arguments);
  };
  syncBuiltinESMExports();
`);
