import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { selectPrivatePort, prepareTailscale } from "../scripts/tailscale.mjs";
import { readHttpsPort, rememberHttpsPort, readPreferences, applyPreferences } from "../scripts/configure.mjs";
import { parseOptions } from "../scripts/launcher-options.mjs";
import { backgroundService } from "../scripts/background-service.mjs";
import { importState } from "../scripts/import-state.mjs";
import { suites } from "../.github/scripts/run-tests.mjs";

const hostname = "computer.example.ts.net";
const route = (port, proxy = "http://127.0.0.1:3000") => ({
  TCP: { [port]: { HTTPS: true } },
  Web: { [`${hostname}:${port}`]: { Handlers: { "/": { Proxy: proxy } } } },
});
const temp = async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-port-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

test("a busy private port automatically gets a free port without touching another service", async () => {
  const config = route(8443);
  const before = structuredClone(config);
  const calls = [], printed = [];
  const origin = await prepareTailscale(8443, undefined, {
    json: async (args) => {
      calls.push(args);
      return args[0] === "status" ? { BackendState: "Running", Self: { DNSName: `${hostname}.` } } : config;
    },
    print: (line) => printed.push(line),
  });
  assert.equal(origin, `https://${hostname}:9443`);
  assert.deepEqual(config, before);
  assert.deepEqual(calls, [["status", "--json"], ["serve", "status", "--json"]], "selection only reads Tailscale");
  assert.deepEqual(printed, ["Reach: port 8443 is unavailable; using port 9443 automatically."]);
});

test("selection checks TCP, Web, nested foreground sessions and public Funnel flags", () => {
  const config = {
    TCP: { 8443: { TCPForward: "127.0.0.1:3000" } },
    Web: route(9443).Web,
    Foreground: { a: { Foreground: { b: route(8444) } } },
    // A stale public flag must never make the new Reach public.
    AllowFunnel: { [`${hostname}:8445`]: true },
  };
  assert.equal(selectPrivatePort(config, 8443), 8446);
  assert.equal(selectPrivatePort({}, 12000), 12000, "keeps an available preferred port");
  assert.equal(selectPrivatePort({ AllowFunnel: { [`${hostname}:8443`]: false } }, 8443), 8443);
});

test("an owned private route is reused; even an owned route with Funnel is skipped", async () => {
  const config = route(8443, "unix:/tmp/reach-501-abcdef/s");
  const accepted = [];
  const deps = {
    json: async (args) => args[0] === "status" ? { BackendState: "Running", Self: { DNSName: `${hostname}.` } } : config,
    print: () => {},
  };
  const accept = (seen, origin) => { accepted.push(origin); return seen === config; };
  assert.equal(await prepareTailscale(8443, accept, deps), `https://${hostname}:8443`);
  assert.deepEqual(accepted, [`https://${hostname}:8443`]);
  config.AllowFunnel = { [`${hostname}:8443`]: true };
  accepted.length = 0;
  assert.equal(await prepareTailscale(8443, accept, deps), `https://${hostname}:9443`);
  assert.deepEqual(accepted, [], "ownership cannot override private-only access");
});

test("Windows pairing-code routes choose a free private port just like socket routes", async (t) => {
  const config = { Foreground: { anotherApp: route(8443) }, ...route(9443) };
  assert.equal(selectPrivatePort(config, 8443), 8444);
  const root = await temp(t);
  assert.equal(rememberHttpsPort(root, 8444), true);
  assert.equal(readHttpsPort(root), 8444);
  assert.equal(readPreferences(root), null, "no Tailscale account configuration was created");
  assert.equal(rememberHttpsPort(root, 8444), false);
  assert.equal(rememberHttpsPort(root, 9443), true);
  assert.equal(readHttpsPort(root), 9443);
});

test("automatic ports also update account preferences and the next start", async (t) => {
  const root = await temp(t);
  await fs.mkdir(path.join(root, ".reach"));
  const prefs = { version: 1, owner: { userId: "42", login: "owner@example.test" }, folders: [root], httpsPort: 8443 };
  await fs.writeFile(path.join(root, ".reach/preferences.json"), JSON.stringify(prefs));
  rememberHttpsPort(root, 9443);
  assert.equal(readHttpsPort(root), 9443);
  const saved = readPreferences(root);
  assert.deepEqual(saved, { ...prefs, httpsPort: 9443 });
  assert.equal(applyPreferences(parseOptions([]), saved).httpsPort, 9443);
  assert.equal(applyPreferences(parseOptions(["--https-port", "10443"]), saved, ["--https-port", "10443"]).httpsPort, 10443);
});

test("invalid saved ports are ignored and invalid writes cannot replace the working port", async (t) => {
  const root = await temp(t);
  rememberHttpsPort(root, 9443);
  for (const port of [0, -1, 65536, 8443.5, "9443", null]) {
    assert.equal(rememberHttpsPort(root, port), false);
    assert.equal(readHttpsPort(root), 9443);
  }
  for (const saved of [{ version: 2, port: 9443 }, { version: 1, port: 65536 }, null, "bad JSON"]) {
    await fs.writeFile(path.join(root, ".reach/https-port.json"), typeof saved === "string" ? saved : JSON.stringify(saved));
    assert.equal(readHttpsPort(root), undefined);
  }
});

test("moving a paired Windows installation keeps its automatically selected port", async (t) => {
  const root = await temp(t);
  const from = path.join(root, "old"), to = path.join(root, "new", ".reach");
  rememberHttpsPort(from, 9443);
  await fs.mkdir(path.join(from, ".reach/quick"));
  await fs.writeFile(path.join(from, ".reach/quick/clients.json"), "[]");
  assert.ok(importState(from, to).includes("https-port.json"));
  assert.equal(readHttpsPort(path.dirname(to)), 9443);
});

test("port search keeps looking beyond the usual ports and stops if none are free", () => {
  const TCP = Object.fromEntries(Array.from({ length: 65535 - 1024 + 1 }, (_, i) => [1024 + i, { HTTPS: true }]));
  delete TCP[54321];
  assert.equal(selectPrivatePort({ TCP }, 8443), 54321);
  delete TCP[1024];
  TCP[54321] = { HTTPS: true };
  assert.equal(selectPrivatePort({ TCP }, 8443), 1024, "wraps to the remaining unprivileged ports");
  TCP[1024] = { HTTPS: true };
  assert.throws(() => selectPrivatePort({ TCP }, 8443), /no free private HTTPS port/);
});

test("a service saves and launches with the selected port rather than the busy requested one", async (t) => {
  const root = await temp(t);
  const origin = `https://${hostname}:9443`;
  const result = await backgroundService(parseOptions(["install"]), root, {
    platform: "darwin", home: root, uid: 501,
    privateNode: () => "/private/runtime/bin/node",
    allocatePort: async () => 54321,
    prepareOrigin: async () => origin,
    env: {}, print: () => {},
    run: (args) => { if (args[0] === "print") throw Error("not loaded"); return ""; },
  });
  assert.equal(result.options.httpsPort, 9443);
  const state = JSON.parse(await fs.readFile(path.join(root, ".reach/service.json")));
  assert.equal(state.origin, origin);
  assert.equal(state.options.httpsPort, 9443);
  const plist = await fs.readFile(path.join(root, "Library/LaunchAgents/com.reach.companion.plist"), "utf8");
  assert.match(plist, /<string>--https-port<\/string>\s*<string>9443<\/string>/);
});

test("Windows CI includes the shared port recovery and Windows startup regression suites", () => {
  assert.ok(suites.windows.includes("tailscale-port"));
  assert.ok(suites.windows.includes("windows-commands"));
});
