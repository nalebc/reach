import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  accountApproval,
  configure,
  keyedSupportProblem,
  preferencesFile,
  windowsAccount,
} from "../scripts/configure.mjs";

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
