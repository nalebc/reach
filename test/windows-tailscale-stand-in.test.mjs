import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { fakeTailscale, sessionAlive, HOST } from "./helpers/fake-tailscale.mjs";

// The stand-in Tailscale the Windows launch tests run against
// (test/helpers/fake-tailscale.mjs), checked on its own: on a real Windows
// runner it's a tailscale.exe (test/fixtures/windows/tailscale-shim.cs)
// running the stand-in's script. Reach's arguments reach the script exactly
// as Reach gave them, what it says and its exit code come back, and a
// foreground session ends with the process Reach holds, as Tailscale's does.
const run = (file, args) =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 30000 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout, stderr })));
const until = async (check, what, ms = 15000) => {
  for (const end = Date.now() + ms; ; ) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

test("the stand-in Tailscale: arguments exactly as given, its output and exit code back", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach stand-in "));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }));
  const fake = await fakeTailscale(dir);
  if (process.platform === "win32") assert.match(fake.cli, /\\tailscale\.exe$/);
  // What a shell would read as quoting, variables, pipes or escapes.
  const odd = ["weird", "two words", 'a "quoted" word', "trailing\\", "back\\\\slashes\\", "", "%PATH%", "&|<>^!", "é✓ 漢字", "--https=8443"];
  const refused = await run(fake.cli, odd);
  assert.equal(refused.code, 2, refused.stderr);
  assert.match(refused.stderr, /^fake tailscale: unsupported weird /);
  assert.deepEqual((await fake.read()).calls.at(-1), odd);
  const version = await run(fake.cli, ["version"]);
  assert.equal(version.code, 0);
  assert.match(version.stdout, /^1\.90\.0\n/);
  const status = JSON.parse((await run(fake.cli, ["status", "--json"])).stdout);
  assert.equal(status.Self.DNSName, `${HOST}.`);
});

test("the stand-in Tailscale: a foreground session lives while its process does, and ends with it", { timeout: 60000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-stand-in-"));
  const fake = await fakeTailscale(dir);
  const child = spawn(fake.cli, ["serve", "--https=8443", "http://127.0.0.1:9"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let said = "";
  child.stdout.on("data", (chunk) => (said += chunk));
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(async () => {
    child.kill("SIGKILL");
    await exited;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const [session] = await until(async () => {
    const sessions = await fake.sessions();
    return sessions.length ? sessions : null;
  }, "the session");
  assert.deepEqual(session.args, ["serve", "--https=8443", "http://127.0.0.1:9"]);
  await until(() => said.includes("Available within your tailnet:"), "its words");
  assert.deepEqual(Object.keys((await fake.read()).serve), ["Foreground"]);
  // On Windows, the process Reach holds is tailscale.exe, the session the
  // script's: ending the first ends the second.
  if (process.platform === "win32") {
    assert.notEqual(session.pid, child.pid);
    assert.match(session.pipe, /^fake-tailscale-\d+-[0-9a-f]{12}$/);
  }
  child.kill();
  await exited;
  await until(() => !sessionAlive(session), "the session to end with its process");
  assert.deepEqual(await fake.sessions(), []);
  assert.deepEqual((await fake.read()).serve, {});
});
