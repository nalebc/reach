import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { startCleanReach } from "./helpers/clean-machine.mjs";
import { fakeTailscale, tailnetPreload, HOST } from "./helpers/fake-tailscale.mjs";

// First-run matrix T16, W1, W5, W6: ./reach in Tailscale mode, as a new
// person runs it, against a stand-in Tailscale (this computer's own is never
// asked or changed). What the terminal says, and whether the start page opens
// for a phone without the Tailscale app.
const mac = { skip: process.platform !== "darwin" && process.platform !== "linux", timeout: 60000 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tailscaleMode = (scenario = {}, env = {}) => async (root, home) => {
  const fake = await fakeTailscale(root, scenario);
  await fs.mkdir(path.join(root, ".reach"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".reach", "preferences.json"),
    JSON.stringify({ version: 1, owner: { userId: "42", login: "owner@example.test" }, folders: [home], stayAwake: "always", httpsPort: 8443 }),
  );
  return { env: { REACH_TAILSCALE: fake.cli, ...env }, preloads: [tailnetPreload(fake.state)], fake };
};
const start = (t, scenario, env) => {
  let fake;
  const prepare = tailscaleMode(scenario, env);
  return startCleanReach(t, {
    args: { local: false, stayAwake: false },
    pair: false,
    ready: /Approve new devices here/,
    prepare: async (root, home) => {
      const prepared = await prepare(root, home);
      fake = prepared.fake;
      return prepared;
    },
  }).then((reach) => ({ ...reach, fake }));
};
const windowFile = (root) => path.join(root, ".reach", "quick", "pairing-window.json");
const exists = (file) => fs.access(file).then(() => true, () => false);

test("someone at the terminal: the one address, its QR, both ways in, and a pairing window", mac, async (t) => {
  const reach = await start(t, {}, { FAKE_TTY: "1" });
  const text = reach.output();
  assert.match(text, new RegExp(`Open on your phone: https://${HOST.replace(/\./g, "\\.")}\\n`));
  assert.match(text, /With the Tailscale app on your phone, it opens straight away/);
  assert.match(text, /No Tailscale app\? Sign in to Tailscale in the phone's browser in the next 15 minutes/);
  assert.match(text, /▄|█/, "a QR");
  assert.equal(await exists(windowFile(reach.root)), true, "the start page answers for now");
  const state = await reach.fake.read();
  // Its own routes, through the stand-in only.
  assert.equal(state.serve.Web[`${HOST}:8443`].Handlers["/"].Proxy.startsWith("unix:"), true);
  assert.equal(state.serve.AllowFunnel[`${HOST}:443`], true);
  const status = JSON.parse(await fs.readFile(path.join(reach.root, ".reach", "host-status.json"), "utf8"));
  assert.equal(status.link, `https://${HOST}`, "./reach status and ./reach pair know the one address");
});

test("nobody at the terminal (piped, or the background service): no window by itself", mac, async (t) => {
  const reach = await start(t, {});
  assert.match(reach.output(), /No Tailscale app on the phone\? Run \.\/reach pair: browser sign-in then opens for 15 minutes/);
  assert.equal(await exists(windowFile(reach.root)), false);
});

test("Funnel not allowed by the tailnet: the private link, and the phone needs the Tailscale app", mac, async (t) => {
  const reach = await start(t, { funnelDenied: true }, { FAKE_TTY: "1" });
  const text = reach.output();
  assert.match(text, new RegExp(`Open on your phone: https://${HOST.replace(/\./g, "\\.")}:8443\\n`));
  assert.match(text, /Your phone needs the Tailscale app/);
  // Tailscale's own words and the page that allows it; no internal paths.
  assert.match(text, /isn't available: Funnel is not enabled on your tailnet\./);
  assert.match(text, /Reach: finish Tailscale setup: https:\/\/login\.tailscale\.com\/f\/funnel\?node=nMac/);
  const why = text.split("\n").find((line) => line.includes("isn't available"));
  assert.doesNotMatch(why, /Command failed|tailscale funnel|unix:/);
  assert.equal(await exists(windowFile(reach.root)), false, "nothing to open");
});

test("port 443 used by another service: left alone, and the phone needs the Tailscale app", mac, async (t) => {
  const other = { TCP: { 443: { HTTPS: true } }, Web: { [`${HOST}:443`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } };
  const reach = await start(t, { serve: other }, { FAKE_TTY: "1" });
  assert.match(reach.output(), /Your phone needs the Tailscale app/);
  assert.match(reach.output(), /used by another service/);
  const state = await reach.fake.read();
  assert.equal(state.serve.Web[`${HOST}:443`].Handlers["/"].Proxy, "http://127.0.0.1:3000", "never replaced");
  await sleep(10);
});

test("a Terminal window Reach opened by itself (a restart from the phone) opens no window", mac, async (t) => {
  const reach = await start(t, {}, { FAKE_TTY: "1", REACH_OPENED_BY: "restart" });
  assert.match(reach.output(), /Run \.\/reach pair: browser sign-in then opens for 15 minutes/);
  assert.equal(await exists(windowFile(reach.root)), false);
});

test("the restart and sign-in scripts say Reach was opened for you", async () => {
  const { loginScript } = await import("../scripts/login-start.mjs");
  assert.match(loginScript("/r", "/n", { restart: true, env: {} }), /^export REACH_OPENED_BY=restart$/m);
  assert.match(loginScript("/r", "/n", { env: {} }), /^export REACH_OPENED_BY=login$/m);
});

// T15: the Tailscale command line and its daemon at different versions drop
// long connections; said once, at start.
test("Tailscale's command line and daemon at different versions: said at start", mac, async (t) => {
  const reach = await start(t, { version: "1.90.0", daemonVersion: "1.84.2" });
  assert.match(reach.output(), /Tailscale's command line \(1\.90\.0\) and its daemon \(1\.84\.2\) are different versions/);
});

// W7: Tailscale hasn't published the one address on the internet yet: the
// phone with the app is fine, browser sign-in waits; said next to the link.
test("the public name not published yet: said next to the link", mac, async (t) => {
  const reach = await start(t, {}, { FAKE_TTY: "1", FAKE_DNS: "missing" });
  const deadline = Date.now() + 5000;
  while (!/hasn't published this address/.test(reach.output()) && Date.now() < deadline) await sleep(50);
  assert.match(reach.output(), /Tailscale hasn't published this address on the internet yet\. Phones with the Tailscale app are fine/);
});

test("the public name published (or unknown): nothing is said", mac, async (t) => {
  const reach = await start(t, {}, { FAKE_TTY: "1" });
  await sleep(500);
  assert.doesNotMatch(reach.output(), /hasn't published/);
});
