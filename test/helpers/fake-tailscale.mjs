import fs from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// A stand-in for the `tailscale` command line (REACH_TAILSCALE), for running
// a real Reach in Tailscale mode without this computer's Tailscale: no route,
// Funnel or sign-in on the real daemon is ever read or changed. It keeps its
// Serve/Funnel routes in a JSON file, and records every call.
//
// Scenario fields: host, login, version (and daemonVersion, when the daemon
// runs another), funnelDenied (Funnel not allowed by
// the tailnet's policy), serve (routes already there, e.g. another service on
// port 443).
//
// `serve` without --bg is a foreground session, as Tailscale has it: shown
// under Foreground while that `tailscale` process lives, gone once it ends.
// It ends with its parent too, as Windows ends a non-detached child with the
// process that started it (a kill-on-close job object). Each session is kept
// in its own file by the process holding it, so no other call's write of the
// shared state can lose it.
export const HOST = "mac.example.ts.net";
const SESSION = /^fake-tailscale-session-\d+\.json$/;
// The live sessions (source, for the stand-in command and the preload alike).
const liveSessions = `(dir) => fs.readdirSync(dir).filter((f) => ${SESSION}.test(f)).flatMap((f) => {
  try {
    const s = JSON.parse(fs.readFileSync(dir + "/" + f, "utf8"));
    process.kill(s.pid, 0);
    return [s];
  } catch { return []; }
})`;
const sessionsIn = (dir) =>
  readdirSync(dir)
    .filter((f) => SESSION.test(f))
    .flatMap((f) => {
      try {
        const s = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        process.kill(s.pid, 0);
        return [s];
      } catch {
        return [];
      }
    });
const withSessions = (serve, sessions) =>
  sessions.length ? { ...serve, Foreground: Object.fromEntries(sessions.map((s) => [s.id, s.config])) } : serve;
export async function fakeTailscale(dir, scenario = {}) {
  const state = path.join(dir, "fake-tailscale.json");
  const setup = path.join(dir, "fake-tailscale-setup.json");
  const cli = path.join(dir, "tailscale");
  await fs.writeFile(setup, JSON.stringify({ BackendState: "Running", CurrentTailnet: { MagicDNSEnabled: true }, ...scenario.setup }));
  await fs.writeFile(
    state,
    JSON.stringify({ host: HOST, login: "owner@example.test", version: "1.90.0", funnelDenied: false, serve: {}, calls: [], ...scenario }),
  );
  await fs.writeFile(
    cli,
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
const save = () => {
  const temp = file + "." + process.pid;
  fs.writeFileSync(temp, JSON.stringify(state));
  fs.renameSync(temp, file);
};
const out = (v) => process.stdout.write(typeof v === "string" ? v : JSON.stringify(v));
const [command, ...rest] = args;
const self = { ID: "nMac", UserID: 42, DNSName: state.host + ".", HostName: "mac", KeyExpiry: "0001-01-01T00:00:00Z", TailscaleIPs: ["100.64.0.10"] };
save();
if (command === "version") out(state.version + "\\n  tailscale commit: fake\\n");
else if (command === "status") {
  if (setup.closed) { process.stderr.write("failed to connect to local tailscaled\\n"); process.exit(1); }
  out({ BackendState: "Running", Version: (state.daemonVersion || state.version) + "-tfake", Self: self, User: { 42: { ID: 42, LoginName: state.login } }, Peer: {}, CertDomains: [state.host], MagicDNSSuffix: "example.ts.net", ...setup });
}
else if (command === "whois") {
  const ip = rest.at(-1);
  if (state.identities?.[ip]) out(state.identities[ip]);
  else if (ip === "100.64.0.10") out({ Node: { ...self, User: 42, StableID: "nMac", Name: self.DNSName, ComputedName: "mac" }, UserProfile: { ID: 42, LoginName: state.login } });
  else out({ Node: { ID: 7, User: 42, StableID: "nPhone", Name: "owner-iphone.example.ts.net.", ComputedName: "owner-iphone", KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: state.login } });
} else if (command === "serve" && rest[0] === "--help") process.stderr.write("USAGE\\n  tailscale serve [flags] <target>\\n  <target> can be a port, http://, https+insecure:// or unix:/path/to/socket\\n");
else if (command === "serve" && rest[0] === "status") {
  const live = sessions(dir);
  out(live.length ? { ...state.serve, Foreground: Object.fromEntries(live.map((s) => [s.id, s.config])) } : state.serve);
} else if (command === "serve" && !rest.includes("--bg") && rest.filter((a) => !a.startsWith("--")).at(-1) !== "off") {
  // In the foreground: held while this process lives.
  const port = Number((rest.find((a) => a.startsWith("--https=")) || "--https=443").split("=")[1]);
  const target = rest.filter((a) => !a.startsWith("--")).at(-1);
  const key = state.host + ":" + port;
  if (state.serve.TCP?.[port] || sessions(dir).some((s) => s.config.TCP?.[port])) {
    process.stderr.write("listener already exists for port " + port + "\\n");
    process.exit(1);
  }
  const session = dir + "/fake-tailscale-session-" + process.pid + ".json";
  const config = { TCP: { [port]: { HTTPS: true } }, Web: { [key]: { Handlers: { "/": { Proxy: target } } } } };
  fs.writeFileSync(session + ".next", JSON.stringify({ id: "fake-session-" + process.pid, pid: process.pid, args, config }));
  fs.renameSync(session + ".next", session);
  out("Available within your tailnet:\\n\\nhttps://" + key + "\\n|-- proxy " + target + "\\n\\nPress Ctrl+C to exit.\\n");
  const parent = process.ppid;
  const end = () => {
    try { fs.rmSync(session, { force: true }); } catch {}
    process.exit(0);
  };
  process.on("SIGTERM", end);
  process.on("SIGINT", end);
  setInterval(() => process.ppid !== parent && end(), 100);
  // Never outlives a test run.
  setTimeout(end, 600000);
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
    process.stderr.write("Funnel is not enabled on your tailnet.\\nTo enable, visit:\\n\\n         https://login.tailscale.com/f/funnel?node=nMac\\n");
    process.exit(1);
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
  return {
    cli,
    state,
    // As `serve status` would show it now (live sessions under Foreground).
    read: async () => {
      const value = JSON.parse(await fs.readFile(state, "utf8"));
      return { ...value, serve: withSessions(value.serve, sessionsIn(dir)) };
    },
    // The foreground sessions held now: { id, pid, args, config }.
    sessions: async () => sessionsIn(dir),
    setStatus: async (value) => {
      const current = JSON.parse(await fs.readFile(setup, "utf8"));
      const temporary = setup + ".next";
      await fs.writeFile(temporary, JSON.stringify({ ...current, ...value }));
      await fs.rename(temporary, setup);
    },
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
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const state = JSON.parse(fs.readFileSync(STATE, "utf8"));
    if (url.hostname !== state.host) return realFetch(input, init);
    const key = state.host + ":" + (url.port || 443);
    // A background route, or a foreground session's while it lives.
    const target = [state.serve, ...sessions(${JSON.stringify(path.dirname(statePath))}).map((s) => s.config)]
      .map((serve) => serve?.Web?.[key]?.Handlers?.["/"]?.Proxy)
      .find(Boolean);
    // A Windows Reach's route: its local address (no Unix socket there).
    if (target?.startsWith("http://127.0.0.1:"))
      return realFetch(target + url.pathname + url.search, { ...init, headers: { ...init.headers, Host: url.host, "X-Forwarded-For": "100.64.0.10" } });
    if (!target?.startsWith("unix:")) throw new TypeError("fetch failed");
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: target.slice(5), path: url.pathname + url.search, method: init.method || "GET", headers: { Host: url.host, "X-Forwarded-For": "100.64.0.10", "Tailscale-User-Login": state.login } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
        },
      );
      req.once("error", reject);
      req.end(init.body);
    });
  };
  const spawn = cp.spawn;
  cp.spawn = function (command, args, options) {
    if (["open", "/usr/bin/open", "caffeinate", "/usr/bin/caffeinate", "explorer.exe"].includes(command))
      return spawn.call(this, process.execPath, ["-e", "setTimeout(() => {}, 10)"], { stdio: "ignore" });
    return spawn.apply(this, arguments);
  };
  syncBuiltinESMExports();
`);
