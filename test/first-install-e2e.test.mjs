import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { firstInstall, finishFirstSetup, setupMenu as menu, SIGN_IN_LINK } from "./helpers/first-install.mjs";
import { HOST } from "./helpers/fake-tailscale.mjs";

const options = { skip: process.platform === "win32", timeout: 60000 };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ready = { BackendState: "Running", closed: false };

async function approvePhone(reach, ip) {
  const method = await reach.request("/api/auth/method", { ip });
  assert.equal(method.status, 200);
  assert.equal(method.json.method, "tailscale");
  assert.equal(method.json.eligible, true);
  assert.equal((await reach.request("/api/files", { ip })).status, 401);
  const requested = await reach.request("/api/auth/requests", { ip, body: { name: "New phone" } });
  assert.equal(requested.status, 202, requested.text);
  const poll = () => reach.request(`/api/auth/requests/${requested.json.id}`, { ip, body: { secret: requested.json.secret } });
  assert.equal((await poll()).json.status, "pending", "joining Tailscale does not approve Reach access");
  reach.answer(requested.json.id.slice(0, 8));
  let result;
  for (let n = 0; n < 60; n++) {
    result = await poll();
    if (result.json.token) break;
    await sleep(30);
  }
  assert.equal(result.json.status, "approved", result.text);
  const files = await reach.request("/api/files/text?root=0&path=welcome.txt", { ip, token: result.json.token });
  assert.equal(files.status, 200, files.text);
  assert.match(files.text, /First installation works/);
  return result.json.token;
}

const desktops = [
  { name: "no Tailscale installed", missing: true, status: { BackendState: "NeedsLogin" }, enter: async reach => {
    await menu(reach, /Install Tailscale to continue/);
    await reach.until(/waiting for Tailscale to be installed/);
    await reach.installTailscale();
    await reach.until(SIGN_IN_LINK);
    await reach.fake.setStatus(ready);
  } },
  { name: "installed but signed out", status: { BackendState: "NeedsLogin" }, enter: async reach => {
    await reach.until(SIGN_IN_LINK);
    await reach.fake.setStatus(ready);
  } },
  { name: "installed but switched off", status: { BackendState: "Stopped" }, enter: reach => menu(reach, /Turn Tailscale on\?/) },
  { name: "installed but daemon closed", status: { closed: true }, enter: async reach => {
    await reach.until(/Tailscale is installed but not running/);
    await reach.fake.setStatus(ready);
  } },
  { name: "waiting for tailnet admin approval", status: { BackendState: "NeedsMachineAuth" }, enter: async reach => {
    await reach.until(/Approve it at https:\/\/login\.tailscale\.com\/admin\/machines/);
    await reach.fake.setStatus(ready);
  } },
  { name: "already connected", status: ready, enter: async () => {} },
];

for (const desktop of desktops) test(`fresh install: desktop ${desktop.name}, every phone entry path`, options, async t => {
  const reach = await firstInstall(t, desktop);
  await desktop.enter(reach);
  await finishFirstSetup(reach);
  assert.ok(reach.output().includes(`Open on your phone: https://${HOST}`), reach.output());
  const publicConfig = await reach.request("/reach-start.json", { public: true });
  assert.equal(publicConfig.status, 200);
  assert.ok(publicConfig.json.tailnet?.wasm, "a phone without Tailscale has the browser client in the package");

  await t.test("phone app on, same account: code approval, authenticated file, credential bound to its device", async () => {
    const token = await approvePhone(reach, "100.64.0.21");
    assert.equal((await reach.request("/api/files", { ip: "100.64.0.22", token })).status, 401);
  });
  for (const [index, phone] of ["no Tailscale app", "app switched off", "app signed out", "app on another tailnet"].entries())
    await t.test(`phone ${phone}: public start, browser sign-in, local approval, files`, async () => {
      // The prior phone closed the window. Owner bootstrap stays available;
      // browser joining itself is represented by its separate node identity.
      assert.equal((await reach.request("/reach-start.json", { public: true })).status, 200);
      assert.equal((await reach.request("/", { public: true })).status, 200);
      assert.equal((await reach.request("/api/files", { public: true })).status, 404);
      await approvePhone(reach, `100.64.0.${31 + index}`);
    });
  await t.test("different account cannot request approval or browse files", async () => {
    const ip = "100.64.0.23";
    assert.equal((await reach.request("/api/auth/method", { ip })).json.eligible, false);
    assert.equal((await reach.request("/api/auth/requests", { ip, body: { name: "Wrong account" } })).status, 403);
    assert.equal((await reach.request("/api/files", { ip })).status, 401);
  });
  await reach.stop();
  assert.equal(await fs.access(path.join(reach.state, "launcher.lock")).then(() => true, () => false), false, "the actual CLI releases its lock");
});

test("fresh install: MagicDNS and HTTPS disabled can each be enabled during setup", options, async t => {
  const reach = await firstInstall(t, { status: { CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: [] } });
  await finishFirstSetup(reach, { link: async () => {
    await reach.until(/Turn on MagicDNS/);
    await reach.fake.setStatus({ CurrentTailnet: { MagicDNSEnabled: true } });
    await reach.until(/Turn on HTTPS certificates/);
    await reach.fake.setStatus({ CertDomains: [HOST] });
  } });
  await approvePhone(reach, "100.64.0.21");
});

test("fresh install: no terminal and no Tailscale fails with instructions and creates no routes", options, async t => {
  const reach = await firstInstall(t, { missing: true, interactive: false });
  const [code] = await reach.exit();
  assert.equal(code, 1);
  assert.match(reach.output(), /Tailscale isn't on this computer yet/);
  assert.match(reach.output(), /Run Reach in a terminal to set it up/);
  assert.deepEqual((await reach.fake.read()).serve, {});
});

test("first install resumes after Tailscale signed out while HTTPS setup was paused", options, async t => {
  const reach = await firstInstall(t, { status: { CertDomains: [] } });
  await menu(reach, /Which Tailscale account should Reach use\?/);
  await reach.until(/Turn on HTTPS certificates/);
  reach.interrupt();
  assert.equal((await reach.exit())[0], 130);
  assert.equal((await reach.read("onboarding.json")).steps.account, "done");
  await reach.fake.setStatus({ BackendState: "NeedsLogin", CertDomains: [] });
  await reach.restart();
  await reach.until(SIGN_IN_LINK, 5000);
  assert.doesNotMatch(reach.output(), /Turn on HTTPS certificates/, "sign in before diagnosing HTTPS");
  await reach.fake.setStatus({ ...ready, CertDomains: [HOST] });
  await reach.until(/Type a device request code to approve/);
  assert.equal((await reach.read("onboarding.json")).done, true);
  await approvePhone(reach, "100.64.0.21");
  // Setup's step 3 ends with the phone in, said by the launcher.
  await reach.until(/✔ 3\. Your phone {2}— {2}approved\. Finish browser connection setup in Reach/);
});

test("a returning setup detects a different desktop Tailscale account before offering a broken phone link", options, async t => {
  const reach = await firstInstall(t);
  await finishFirstSetup(reach);
  await reach.stop();
  await reach.fake.setStatus({
    Self: { UserID: 99, DNSName: HOST + ".", TailscaleIPs: ["100.64.0.10"] },
    User: { 99: { ID: 99, LoginName: "other@example.test" } },
  });
  await reach.restart();
  await reach.until(/set up for owner@example.test/);
  assert.equal((await reach.exit())[0], 1);
  assert.match(reach.output(), /other@example.test/);
  assert.match(reach.output(), /setup account/);
  assert.doesNotMatch(reach.output(), /Open on your phone/);
  assert.equal((await reach.read("preferences.json")).owner.userId, "42", "account never silently replaced");
});

test("fresh install without Funnel: connected phone works, phone without Tailscale gets explicit setup instructions", options, async t => {
  const reach = await firstInstall(t, { funnelDenied: true });
  await finishFirstSetup(reach);
  assert.match(reach.output(), /Preparing your permanent phone link: https:\/\/mac.example.ts.net/);
  assert.doesNotMatch(reach.output(), /Your phone needs the Tailscale app/);
  assert.match(reach.output(), /finish Tailscale setup: https:\/\/login.tailscale.com\/f\/funnel\?node=nMac/);
  assert.equal((await reach.fake.read()).serve.AllowFunnel?.[`${HOST}:443`], undefined);
  await approvePhone(reach, "100.64.0.21");
  await reach.fake.setStatus({ funnelDenied: false });
  await reach.until(/Public link on:/, 8000);
  assert.equal((await reach.request("/reach-start.json", { public: true, port: 443 })).status, 200, "owner bootstrap is independent of the closed pairing window");
  assert.match(await reach.cli(["pair"]), /15 minutes/);
  assert.equal((await reach.request("/reach-start.json", { public: true, port: 443 })).status, 200);
});

test("fresh Mac install discovers Tailscale under ~/Applications without PATH or an override", { ...options, skip: process.platform !== "darwin" }, async t => {
  const reach = await firstInstall(t, { userApp: true });
  await finishFirstSetup(reach);
  assert.doesNotMatch(reach.output(), /Install Tailscale to continue|not running/);
  await approvePhone(reach, "100.64.0.21");
});

test("fresh install from nothing: enabling Funnel after setup opens browser pairing without a restart", options, async t => {
  const reach = await firstInstall(t, { missing: true, funnelDenied: true, status: {
    BackendState: "NeedsLogin", CurrentTailnet: { MagicDNSEnabled: false }, CertDomains: [],
  } });
  await menu(reach, /Install Tailscale to continue/);
  await reach.until(/waiting for Tailscale to be installed/);
  assert.deepEqual((await reach.fake.read()).serve, {});
  await reach.installTailscale();
  await reach.until(SIGN_IN_LINK);
  await reach.fake.setStatus(ready);
  await finishFirstSetup(reach, { link: async () => {
    await reach.until(/Turn on MagicDNS/);
    await reach.fake.setStatus({ CurrentTailnet: { MagicDNSEnabled: true } });
    await reach.until(/Turn on HTTPS certificates/);
    await reach.fake.setStatus({ CertDomains: [HOST] });
  } });
  assert.match(reach.output(), /Preparing your permanent phone link/);
  await reach.fake.setStatus({ funnelDenied: false });
  await reach.until(/Public link on:/, 8000);
  assert.equal((await reach.read("host-status.json")).link, `https://${HOST}`, "the running host advertises the recovered public link");
  assert.equal((await reach.request("/reach-start.json", { public: true, port: 443 })).status, 200, "the waiting first phone can sign in without restarting Reach");
  assert.match(await reach.cli(["pair"]), /15 minutes/, "later pairing also uses the recovered link");
  await approvePhone(reach, "100.64.0.22");
});

for (const [BackendState, message] of [
  ["NeedsLogin", /needs you to sign in/],
  ["Stopped", /switched off/],
  ["Starting", /is starting/],
  ["NeedsMachineAuth", /admin has to approve/],
  ["Running", /interactive terminal to confirm your Tailscale account/],
]) test(`fresh install without a terminal: ${BackendState} reports the next step and exits`, options, async t => {
  const reach = await firstInstall(t, { interactive: false, status: { BackendState } });
  assert.equal((await reach.exit())[0], 1);
  assert.match(reach.output(), message);
  assert.deepEqual((await reach.fake.read()).serve, {});
});
