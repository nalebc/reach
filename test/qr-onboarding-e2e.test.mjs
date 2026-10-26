import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { startCleanReach, cleanPreload } from "./helpers/clean-machine.mjs";
import { fakeTailscale, tailnetPreload, HOST, SELF_IP } from "./helpers/fake-tailscale.mjs";
import { phoneNetwork } from "./helpers/phone-network.mjs";
import { scanTerminalQRs } from "./helpers/scan-terminal-qr.mjs";
import { phone } from "./helpers/phone-onboarding.mjs";

const exec = promisify(execFile);
const windowsPreload = pathToFileURL(path.resolve("test/helpers/as-windows.mjs")).href;
const peerFixture = pathToFileURL(path.resolve("test/helpers/fake-peer-check.mjs")).href;
const until = async (check, what, output = () => "") => {
  for (const deadline = Date.now() + 30000; !(await check()); ) {
    if (Date.now() > deadline) throw Error(`Timed out: ${what}\n${output()}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
const occupied = {
  TCP: { 8443: { HTTPS: true }, 9443: { HTTPS: true } },
  Web: Object.fromEntries([8443, 9443].map(port => [`${HOST}:${port}`, { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } }])),
};

// No Windows skip and no opt-in flag. On Windows CI these are the host's
// actual Windows startup paths; POSIX CI explicitly simulates that platform.
// Tailscale, DNS, its OS peer check and browser WASM/login are fixtures. QR
// encoding/decoding, public readiness, TLS verification, HTTP, startup,
// approval and file reads execute real production code. No real tailnet is used.
test("Windows default QR: host-only success, public browser entry, and same-tailnet private fallback", { timeout: 300000 }, async t => {
  const packageRoot = path.resolve(process.env.REACH_TEST_PACKAGE || ".");
  const platformPreloads = process.platform === "win32" ? [] : [windowsPreload];
  const seen = {};
  const reach = await startCleanReach(t, {
    packageRoot,
    args: { local: false, stayAwake: false },
    env: { FAKE_TTY: "1" },
    preloads: platformPreloads,
    pair: false,
    ready: /Preparing your permanent phone link|Pairing code: \d{4} \d{4}/,
    prepare: async (root, home) => {
      seen.fake = await fakeTailscale(root, { version: "1.104.0", serve: structuredClone(occupied), identities: {
        ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => {
          const n = 50 + i;
          return [`100.64.0.${n}`, { Node: { StableID: `qr-phone-${n}`, User: 42, Name: `phone-${n}.example.ts.net.`, KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: "owner@example.test" } }];
        })),
        "100.64.0.99": { Node: { StableID: "wrong-account", User: 99, Name: "other.example.ts.net.", KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 99, LoginName: "other@example.test" } },
      } });
      seen.network = await phoneNetwork(t, root, seen.fake);
      fs.mkdirSync(path.join(root, ".reach"), { recursive: true });
      fs.writeFileSync(path.join(root, ".reach/preferences.json"), JSON.stringify({ version: 1, owner: { userId: "42", login: "owner@example.test" }, folders: [home], httpsPort: 8443 }));
      fs.writeFileSync(path.join(home, "welcome.txt"), "First installation works.");
      for (const name of ["dist", "tailnet"])
        fs.symlinkSync(path.join(packageRoot, name), path.join(root, name), process.platform === "win32" ? "junction" : "dir");
      seen.preloads = [cleanPreload, ...platformPreloads, tailnetPreload(seen.fake.state), seen.network.preload];
      return {
        env: { REACH_TAILSCALE: seen.fake.cli, REACH_HOME: path.join(root, ".reach"), REACH_DATA: path.join(root, ".reach/quick"), NODE_EXTRA_CA_CERTS: seen.network.certFile },
        preloads: [tailnetPreload(seen.fake.state), seen.network.preload],
        launchCode: `peerCheck: (await import(${JSON.stringify(peerFixture)})).fakePeerCheck(${JSON.stringify(root)}), privateFolders: async () => ({ ok: true, helper: () => async () => ({}) })`,
      };
    },
  });
  const { fake, network } = seen;
  assert.equal(reach.env.REACH_WINDOWS_ACCOUNT, undefined, "default onboarding, with no special flag");
  const statusFile = path.join(reach.root, ".reach/host-status.json");
  const status = () => JSON.parse(fs.readFileSync(statusFile));
  const privateOrigin = `https://${HOST}:8444`;
  const publicOrigin = `https://${HOST}`;
  assert.equal(status().tailscaleApproval, true, "normal Windows startup must enable browser approval without an opt-in flag");
  assert.equal(status().origin, privateOrigin, "occupied 8443 and 9443 recover to 8444");

  await t.test("laptop can load its own link while every off-network phone would fail", async () => {
    const host = await network.request(privateOrigin + "/api/health", { mode: "same-tailnet", ip: SELF_IP });
    assert.equal(host.status, 200);
    assert.equal(host.json.instance, status().instance);
    for (const mode of ["no-app", "app-off", "different-tailnet"])
      await assert.rejects(network.request(privateOrigin, { mode }), { code: "ENOTFOUND" });
    // One permanent owner link (docs/CONNECTION_POLICY.md): no QR stands in
    // for it while it's prepared; the private one is there on request (below).
    assert.deepEqual(scanTerminalQRs(reach.output()), [], "no QR replaces the permanent link while the browser connection waits");
    assert.ok(reach.output().includes(`Preparing your permanent phone link: https://${HOST}`));
    assert.equal(status().browserLink.ready, false);
    assert.equal(network.requests.filter(r => r.kind === "public").length, 0, "missing public DNS prevents the host probe from using its MagicDNS route");
  });

  network.publish(true);
  await until(() => scanTerminalQRs(reach.output()).includes(publicOrigin), "a publicly verified, decodable QR", reach.output);
  const initialQR = scanTerminalQRs(reach.output()).find(link => link === publicOrigin);
  assert.equal(initialQR, publicOrigin, "the QR itself, not just its caption, is the public entry");
  assert.equal(status().browserLink.ready, true);
  assert.ok(network.requests.some(r => r.kind === "public" && r.path === "/reach-start.json"), "production readiness crossed the real TLS public relay");
  const start = await network.request(initialQR, { mode: "no-app" });
  assert.equal(start.status, 200);
  assert.match(start.text, /<!doctype html/i);
  assert.equal((await network.request(initialQR + "/api/files", { mode: "no-app" })).status, 404, "public entry does not expose the owner API");

  const pair = async () => {
    const { stdout } = await exec(process.execPath, [...seen.preloads.flatMap(p => ["--import", p]), path.join(packageRoot, "bin/reach.mjs"), "pair"], { env: reach.env, timeout: 15000, maxBuffer: 1 << 20 });
    const [link] = scanTerminalQRs(stdout);
    assert.ok(link, "the installed CLI prints a decodable pairing QR");
    assert.equal(new URL(link).origin, `https://${HOST}`);
    return link;
  };
  const adapter = entryUrl => ({
    answer: line => reach.stdin.write(line + "\n"),
    request: (route, { ip, public: internet = false, body, token, method } = {}) =>
      network.request(new URL(route, entryUrl).href, { mode: internet ? "no-app" : "browser-node", ip, body, token, method }),
  });
  let device = 50;
  for (const platform of ["iPhone", "iPad", "Android"]) {
    for (const scenario of [
      { mode: "no-app", browser: true },
      { mode: "app-off", browser: true },
      { mode: "different-tailnet", browser: true, wrongAccount: true },
      { mode: "same-tailnet", browser: false },
    ]) await t.test(`${platform}, ${scenario.mode}: scanned QR → page → approval → file`, async sub => {
      const entryUrl = await pair();
      const page = await network.request(entryUrl, { mode: scenario.mode });
      assert.equal(page.status, 200);
      if (scenario.browser) {
        assert.match(page.text, /id="start"/);
        await assert.rejects(network.request(privateOrigin, { mode: scenario.mode }), { code: "ENOTFOUND" });
      } else {
        assert.equal((await network.request(privateOrigin + "/api/health", { mode: scenario.mode })).json.product, "Reach");
        assert.match(page.text, /id="root"/, "same-tailnet app receives the private app");
        assert.doesNotMatch(page.text, /id="start"/, "same-tailnet app bypasses browser sign-in");
      }
      const flow = await phone(sub, adapter(entryUrl), { platform, ip: `100.64.0.${device++}`, browser: scenario.browser, wrongAccount: scenario.wrongAccount, entryUrl });
      if (!scenario.browser) assert.equal(flow.calls.some(c => c.throughBrowser), false, "same-tailnet app never starts the browser Tailscale node");
    });
  }

  await t.test("an explicitly requested private QR works only for the same tailnet", async () => {
    const before = scanTerminalQRs(reach.output()).length;
    reach.stdin.write("private\n");
    await until(() => scanTerminalQRs(reach.output()).length > before, "the private fallback QR", reach.output);
    const qr = scanTerminalQRs(reach.output()).at(-1);
    assert.equal(qr, privateOrigin);
    await assert.rejects(network.request(qr, { mode: "no-app" }), { code: "ENOTFOUND" });
    await assert.rejects(network.request(qr, { mode: "different-tailnet" }), { code: "ENOTFOUND" });
    assert.equal((await network.request(qr + "/api/health", { mode: "same-tailnet" })).json.instance, status().instance);
  });
  const routes = await fake.read();
  assert.deepEqual(routes.serve.TCP, occupied.TCP, "existing services remain untouched");
  assert.deepEqual(routes.serve.Web, occupied.Web);
});
