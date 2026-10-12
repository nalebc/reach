import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  accountApproval,
  configure,
  keyedSupportProblem,
  preferencesFile,
  windowsAccount,
} from "../scripts/configure.mjs";
import { setupInvites } from "../scripts/invites.mjs";
import { linkComputers } from "../scripts/link.mjs";
import { approveDevice, describeApproval } from "../scripts/approve-device.mjs";
import { windowsStatusText } from "../scripts/instances.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { newIngressKey } from "../server/tailscale-auth.mjs";

// Windows' browser sign-in (docs/parity/D-public-door.md), behind
// REACH_WINDOWS_ACCOUNT=1 until a real PC's acceptance: the flag, what the
// keyed route needs from Tailscale, and setup's answers with and without it.

const ON = { REACH_WINDOWS_ACCOUNT: "1" };
const tmp = (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-win-flag-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const status = (version = "1.104.0", extra = {}) => ({
  BackendState: "Running",
  Version: `${version}-t0123abcd`,
  TUN: true,
  Self: { UserID: 42 },
  User: { 42: { LoginName: "owner@example.test" } },
  ...extra,
});
const READY = { status: status(), cliVersion: "1.104.0" };

test("accountApproval: macOS and Linux whatever the environment; Windows only with exactly REACH_WINDOWS_ACCOUNT=1", () => {
  for (const platform of ["darwin", "linux"]) {
    assert.equal(accountApproval(platform, {}), true);
    assert.equal(accountApproval(platform, { REACH_WINDOWS_ACCOUNT: "0" }), true);
  }
  assert.equal(accountApproval("win32", {}), false);
  assert.equal(accountApproval("win32", ON), true);
  for (const value of ["true", "yes", "on", " 1", "1 ", "01", ""])
    assert.equal(accountApproval("win32", { REACH_WINDOWS_ACCOUNT: value }), false, JSON.stringify(value));
  assert.equal(windowsAccount(ON), true);
  assert.equal(windowsAccount({}), false);
});

test("keyedSupportProblem: Tailscale 1.104 or newer, both daemon and command line, with its network adapter", () => {
  assert.equal(keyedSupportProblem(READY), "");
  for (const version of ["1.104.0", "1.110.1", "2.0", "2.0.0"])
    assert.equal(keyedSupportProblem({ status: status(version), cliVersion: version }), "", version);
  assert.match(keyedSupportProblem({ status: status("1.103.9"), cliVersion: "1.104.0" }), /^Tailscale 1\.103\.9 is older than 1\.104; update Tailscale\.$/);
  assert.match(keyedSupportProblem({ status: status(""), cliVersion: "1.104.0" }), /^Tailscale \? is older than 1\.104/);
  assert.match(keyedSupportProblem({ cliVersion: "1.104.0" }), /^Tailscale \? is older/);
  assert.match(keyedSupportProblem({}), /older than 1\.104/);
  // A new daemon with an old command line: the command line is what holds the route.
  assert.match(keyedSupportProblem({ status: status("1.110.0"), cliVersion: "1.90.0" }), /^Tailscale's command line \(1\.90\.0\) is older than 1\.104/);
  assert.match(keyedSupportProblem({ status: status("1.110.0"), cliVersion: "" }), /command line \(\?\)/);
  // Userspace networking forwards peers onto this PC's loopback ports.
  assert.match(keyedSupportProblem({ status: status("1.104.0", { TUN: false }), cliVersion: "1.104.0" }), /without its network adapter/);
  const { TUN, ...noTun } = status();
  assert.match(keyedSupportProblem({ status: noTun, cliVersion: "1.104.0" }), /without its network adapter/);
  assert.match(keyedSupportProblem({ status: status("1.104.0", { TUN: "true" }), cliVersion: "1.104.0" }), /without its network adapter/);
});

test("keyedSupportProblem: this PC as an exit node or a subnet router is allowed, as on a Mac (owner, Oct 12)", () => {
  // Advertised routes aren't even read: the key keeps the route closed to
  // whatever Tailscale forwards (test/windows-account-launch.test.mjs).
  for (const routes of [["0.0.0.0/0", "::/0"], ["127.0.0.0/8"], ["10.0.0.0/8"]])
    assert.equal(keyedSupportProblem({ ...READY, prefs: { AdvertiseRoutes: routes } }), "", routes.join());
});

test("configure on Windows: without the flag today's refusal, with the line when sign-in was set up here", async (t) => {
  const root = tmp(t);
  const deps = { platform: "win32", env: {}, select: async () => "use", print() {} };
  await assert.rejects(configure(root, deps), (error) =>
    /^On Windows, Reach has no account settings to configure: start it with /.test(error.message) &&
    !error.message.includes("REACH_WINDOWS_ACCOUNT"));
  fs.mkdirSync(path.dirname(preferencesFile(root)), { recursive: true });
  fs.writeFileSync(preferencesFile(root), "{}");
  await assert.rejects(configure(root, deps), (error) =>
    /^On Windows, Reach has no account settings to configure/.test(error.message) &&
    error.message.endsWith(" Browser sign-in was set up here; it needs REACH_WINDOWS_ACCOUNT=1 in this terminal."));
  // The other platforms never hear of the flag.
  await assert.rejects(configure(root, { ...deps, platform: "darwin" }), (error) => !error.message.includes("REACH_WINDOWS_ACCOUNT"));
});

test("configure on Windows with the flag: the keyed route's check, never Serve's Unix-socket one", async (t) => {
  const root = tmp(t);
  const asked = [];
  const base = {
    platform: "win32",
    env: ON,
    status: async () => status(),
    select: async () => "use",
    print() {},
    ask: async () => "",
  };
  const preferences = await configure(root, { ...base, keyedState: async () => (asked.push("keyed"), READY) });
  assert.deepEqual(asked, ["keyed"]);
  assert.equal(preferences.owner.userId, "42");
  assert.ok(fs.existsSync(preferencesFile(root)));
  // An old Tailscale or one without its adapter: nothing is saved.
  for (const [state, why] of [
    [{ status: status("1.103.0"), cliVersion: "1.104.0" }, /^Tailscale 1\.103\.0 is older than 1\.104; update Tailscale\. No settings changed\.$/],
    [{ status: status("1.104.0"), cliVersion: "1.90.0" }, /command line \(1\.90\.0\).* No settings changed\.$/],
    [{ status: status("1.104.0", { TUN: false }), cliVersion: "1.104.0" }, /userspace networking\)\. No settings changed\.$/],
  ]) {
    const fresh = tmp(t);
    await assert.rejects(configure(fresh, { ...base, keyedState: async () => state }), { message: why });
    assert.equal(fs.existsSync(preferencesFile(fresh)), false);
  }
  // An exit node is fine (owner, Oct 12: the same as a Mac).
  const exitNode = tmp(t);
  await configure(exitNode, { ...base, keyedState: async () => ({ ...READY, prefs: { AdvertiseRoutes: ["0.0.0.0/0", "::/0"] } }) });
  assert.ok(fs.existsSync(preferencesFile(exitNode)));
});

// A computer set up for browser sign-in, as `.\reach.cmd configure` leaves it.
const computer = (t) => {
  const root = tmp(t);
  fs.mkdirSync(path.join(root, ".reach", "quick"), { recursive: true });
  fs.writeFileSync(preferencesFile(root), JSON.stringify({ version: 1, owner: { userId: "42", login: "me@x.test" }, folders: [root], httpsPort: 8443 }));
  fs.writeFileSync(path.join(root, ".reach", "quick", "device.json"), JSON.stringify({ id: "dev-a" }));
  return root;
};

test("linking computers stays off on Windows, with the flag or without", async (t) => {
  const root = computer(t);
  const fleet = { status: async () => assert.fail("no Tailscale call on Windows") };
  await assert.rejects(linkComputers(root, "mac-b", { platform: "win32", print() {}, fleet }), { message: /^Linking computers isn't available on Windows yet: it needs phones approved/ });
  const before = process.env.REACH_WINDOWS_ACCOUNT;
  process.env.REACH_WINDOWS_ACCOUNT = "1";
  t.after(() => (before === undefined ? delete process.env.REACH_WINDOWS_ACCOUNT : (process.env.REACH_WINDOWS_ACCOUNT = before)));
  await assert.rejects(linkComputers(root, "mac-b", { platform: "win32", print() {}, fleet }), { message: "Linking computers isn't available on Windows yet." });
});

test("invites on Windows: without the flag today's refusal (and why, once set up); with it, Reach's folders made private before anything is saved", async (t) => {
  delete process.env.REACH_DATA;
  const root = computer(t);
  const oauth = path.join(root, ".reach", "quick", "tailscale-oauth.json");
  const never = { status: async () => assert.fail("nothing asked of Tailscale"), select: async () => assert.fail("no question"), ask: async () => assert.fail("no question"), print() {} };
  await assert.rejects(setupInvites(root, { ...never, platform: "win32", env: {} }), (error) =>
    /^Invite links for people and agents without Tailscale aren't available on Windows yet/.test(error.message) &&
    error.message.endsWith(" Browser sign-in was set up here; it needs REACH_WINDOWS_ACCOUNT=1 in this terminal."));
  const asked = [];
  await assert.rejects(
    setupInvites(root, {
      ...never,
      platform: "win32",
      env: ON,
      privateFolders: async (options) => (asked.push(options), { ok: false, reason: `Reach's folder ${root} can be changed by other people on this PC, so browser sign-in stays off.` }),
    }),
    { message: `Reach's folder ${root} can be changed by other people on this PC, so browser sign-in stays off. Invite links weren't set up.` },
  );
  assert.deepEqual(asked.map((a) => a.protect), [[path.join(root, ".reach"), path.join(root, ".reach", "quick")]]);
  assert.equal(asked[0].check.length, 1);
  assert.equal(fs.existsSync(oauth), false, "no OAuth client saved");
  // Private: on to the setup itself (here, as far as asking Tailscale).
  let reached = false;
  await assert.rejects(setupInvites(root, { ...never, platform: "win32", env: ON, privateFolders: async () => ({ ok: true }), status: async () => { reached = true; throw Error("stop here"); } }), { message: "stop here" });
  assert.equal(reached, true);
});

test("approve and status on Windows say why browser sign-in fell back to pairing codes", (t) => {
  const root = computer(t);
  fs.writeFileSync(path.join(root, ".reach", "host-status.json"), JSON.stringify({ pid: 1, dataDir: path.join(root, ".reach", "quick"), tailscaleApproval: false, signInOff: "Tailscale's Windows service isn't running." }));
  return assert.rejects(approveDevice(root, { platform: "win32", env: ON, print() {} }), { message: /^Browser sign-in is off on this PC for now: Tailscale's Windows service isn't running\. A phone joins with the pairing code/ }).then(() => {
    assert.equal(
      windowsStatusText({ pid: 7, origin: "https://pc.example.ts.net:8443", signInOff: "Tailscale's Windows service isn't running." }, { command: ".\\reach.cmd" }),
      "Reach: running in a terminal (process 7)\nLink: https://pc.example.ts.net:8443\nBrowser sign-in is off for now: Tailscale's Windows service isn't running.",
    );
    assert.equal(windowsStatusText({ pid: 7, origin: "https://pc.example.ts.net:8443" }, { command: ".\\reach.cmd" }), "Reach: running in a terminal (process 7)\nLink: https://pc.example.ts.net:8443");
  });
});

// A Windows Reach with browser sign-in, in this process: its keyed route with
// a peer check that knows this process is Tailscale's.
const ORIGIN = "https://pc.example.ts.net";
const OWNER = { userId: "42", login: "owner@example.test" };
const PHONE = { Node: { StableID: "nPhone", User: 42, Name: "owner-iphone.example.ts.net.", ComputedName: "owner-iphone", KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: OWNER.login } };
const SELF = { Node: { StableID: "nPC", User: 42, Name: "pc.example.ts.net.", ComputedName: "pc", KeyExpiry: "0001-01-01T00:00:00Z" }, UserProfile: { ID: 42, LoginName: OWNER.login } };
async function windowsReach(t, { platform = "win32", owner = OWNER } = {}) {
  const root = tmp(t);
  const reach = await createReach({
    name: "Fixture PC",
    roots: [root],
    dataDir: path.join(root, "state"),
    agentPolicyFile: path.join(root, "state", "none.json"),
    publicOrigin: `${ORIGIN}:8443`,
    allowedOrigins: [ORIGIN],
    tailscaleOwner: owner,
    platform,
    tailscaleIdentity: { lookup: async (ip) => (ip === "100.64.0.10" ? SELF : PHONE) },
  });
  t.after(() => reach.close());
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  return { root, reach };
}
const ask = (port, route, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: route, method, agent: false, headers: { Host: "pc.example.ts.net:8443", "X-Forwarded-Host": "pc.example.ts.net:8443", ...headers, ...(body && { "Content-Type": "application/json" }) } }, (res) => {
      let text = "";
      res.on("data", (chunk) => (text += chunk));
      res.on("end", () => {
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

test("a Windows Reach with browser sign-in: invite keys, no linked computers or Face ID join yet, the public link through its controller", async (t) => {
  const { reach } = await windowsReach(t);
  assert.equal(reach.fleet, null);
  assert.ok(reach.guestKeys);
  assert.equal(reach.faceIdAvailable(), false);
  const key = newIngressKey();
  const port = await reach.listenKeyed({ key, peerCheck: { check: async () => true } });
  const phone = reach.auth.issue("iPhone", ALL_SCOPES, "device", { tailscale: { userId: "42", nodeId: "nPhone" } });
  const keys = await ask(port, `/r-${key}/api/guests/keys`, { headers: { "X-Forwarded-For": "100.64.0.20", "Tailscale-User-Login": OWNER.login, Authorization: `Bearer ${phone.token}` } });
  assert.equal(keys.status, 200, keys.text);
  assert.equal(keys.json.available, undefined, "no 'not on Windows' here");
  assert.equal(keys.json.why, undefined);
  // Face ID join from the internet: not on Windows yet.
  const faceIdServer = http.createServer((req, res) => reach.publicFaceId(req, res) || (res.writeHead(418), res.end()));
  await new Promise((resolve) => faceIdServer.listen(0, "127.0.0.1", resolve));
  t.after(() => faceIdServer.close());
  const face = await ask(faceIdServer.address().port, "/faceid/options", { method: "POST", headers: { Host: "pc.example.ts.net" }, body: {} });
  assert.equal(face.status, 404);
  // Invite links from the phone, before the public link is held: the general
  // answer, not "not on Windows".
  const invite = await ask(port, `/r-${key}/api/agents/browser-invitations`, {
    method: "POST",
    headers: { "X-Forwarded-For": "100.64.0.20", "Tailscale-User-Login": OWNER.login, Authorization: `Bearer ${phone.token}` },
    body: { name: "Muse", transport: "funnel", preset: "readonly", ttlSeconds: 600, folders: [{ root: 0, path: "" }] },
  });
  assert.doesNotMatch(invite.text, /aren't available on Windows yet/);
});

test("this PC's own browser on Windows' keyed route: allowed, its request marked and said so where you approve it; one from elsewhere unchanged", async (t) => {
  const { reach } = await windowsReach(t);
  const key = newIngressKey();
  const port = await reach.listenKeyed({ key, peerCheck: { check: async () => true }, selfIps: () => ["100.64.0.10"] });
  const fromPc = { "X-Forwarded-For": "100.64.0.10", "Tailscale-User-Login": OWNER.login };
  const method = await ask(port, `/r-${key}/api/auth/method`, { headers: fromPc });
  assert.deepEqual(method.json, { method: "tailscale", eligible: true, login: OWNER.login });
  const asked = await ask(port, `/r-${key}/api/auth/requests`, { method: "POST", headers: fromPc, body: { name: "This PC's Edge" } });
  assert.equal(asked.status, 202, asked.text);
  const fromPhone = await ask(port, `/r-${key}/api/auth/requests`, { method: "POST", headers: { "X-Forwarded-For": "100.64.0.20", "Tailscale-User-Login": OWNER.login }, body: { name: "Phone" } });
  assert.equal(fromPhone.status, 202);
  const requests = reach.approvals.list();
  const pc = requests.find((r) => r.name === "This PC's Edge");
  const other = requests.find((r) => r.name === "Phone");
  assert.equal(pc.thisComputer, true);
  assert.equal("thisComputer" in other, false);
  assert.match(describeApproval(pc, "win32"), /\n  From this PC itself: anyone signed in to Windows here could have asked\. Approve only if you just asked from this PC's browser\.$/);
  assert.doesNotMatch(describeApproval(other, "win32"), /From this PC itself/);
  // A request from elsewhere (a Mac's marks only its own browser's:
  // passkeys-route.test.mjs): the record and prompt are as before.
  const mac = await windowsReach(t, { platform: "darwin" });
  const created = mac.reach.approvals.request({ userId: "42", nodeId: "nPC", login: OWNER.login, nodeName: "pc", tagged: false, validUntil: Date.now() + 60000 }, "Mac Safari", OWNER);
  const [stored] = mac.reach.approvals.list();
  assert.deepEqual(Object.keys(stored).sort(), ["expiresAt", "id", "identity", "login", "name", "nodeName", "status"]);
  assert.equal(describeApproval(stored), `${created.id.slice(0, 8)} · Mac Safari\n  Tailscale: ${OWNER.login} · pc\n  Grants owner access (including terminals and files); screen control stays separately enabled.`);
});
