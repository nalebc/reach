import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { decodeOutput } from "../scripts/windows-task.mjs";
import { windowsFixture } from "./helpers/windows-fixtures.mjs";

// Background mode made by a standard account (workstreams K and L): `reach
// install` run as a Windows user made for the test, with no administrator
// rights, makes that user's own Scheduled Task as Reach writes it (that
// user's sign-in, its session's InteractiveToken, least privilege), Task
// Scheduler takes it, and what Windows then says about running it now is
// recorded. The user is let on through the secondary logon service (run-as
// run); Windows gives it no signed-in session of its own here, which an
// InteractiveToken task runs in, so whether its Reach starts is said, not
// required.
//
// Only on a disposable CI runner (it makes a Windows user, as the peer
// check's spike does): REACH_TEST_WINDOWS_PEER=1, CI=true.
const enabled = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_PEER === "1" && process.env.CI === "true";
const skip = enabled ? false : "a real Windows CI runner only (REACH_TEST_WINDOWS_PEER=1, CI=true): it makes a Windows user";
const here = path.dirname(fileURLToPath(import.meta.url));
const SYSTEM32 = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (file, args, options = {}) =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 180000, encoding: "buffer", ...options }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: decodeOutput(stdout), stderr: decodeOutput(stderr) })));

test("Windows background mode, made by a standard account: its own task, as Reach writes it, taken by Task Scheduler", { skip, timeout: 300000 }, async (t) => {
  const runAs = await windowsFixture("run-as");
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-standard-task-")));
  const theirs = path.join(base, "theirs");
  const root = path.join(theirs, "reach");
  const state = path.join(theirs, "state");
  const out = path.join(theirs, "out");
  for (const dir of [path.join(root, "scripts"), state, out]) fs.mkdirSync(dir, { recursive: true });
  // A stand-in Reach: the launcher's entry, saying it ran and as whom.
  fs.writeFileSync(path.join(root, "scripts", "bootstrap.mjs"), `import fs from "node:fs";
import os from "node:os";
fs.writeFileSync(${JSON.stringify(path.join(out, "ran.json"))}, JSON.stringify({ args: process.argv.slice(2), user: os.userInfo().username }));
`);
  const name = "reachtask";
  const password = `${crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "x")}Aa1!`;
  const added = await run(path.join(SYSTEM32, "net.exe"), ["user", name, password, "/add", "/Y"]);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const sid = (await run(runAs, ["sid", name])).stdout.trim();
  const task = `Reach-${sid}`;
  let right = false;
  t.after(async () => {
    await run(path.join(SYSTEM32, "schtasks.exe"), ["/Delete", "/TN", task, "/F"]);
    if (sid) await run(runAs, ["desktop", "revoke", sid]);
    if (right) await run(runAs, ["logon-right", "remove", name]);
    await run(path.join(SYSTEM32, "net.exe"), ["user", name, "/delete"]);
    await sleep(1000);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });
  assert.match(sid, /^S-1-5-21-[\d-]+$/);
  // A standard account: not an administrator (its token's groups, below).
  assert.equal((await run(runAs, ["desktop", "grant", sid])).code, 0);
  const shared = await run(path.join(SYSTEM32, "icacls.exe"), [theirs, "/grant", `*${sid}:(OI)(CI)F`, "/Q"]);
  assert.equal(shared.code, 0, shared.stdout);

  const install = path.join(here, "fixtures", "windows", "install-as-user.mjs");
  const groups = path.join(out, "groups.csv");
  const asUser = (commandLine) => run(runAs, ["run", name, password, theirs, "wait", commandLine]);
  let tried = await asUser(`cmd.exe /d /c whoami /groups /fo csv > "${groups}"`);
  if (/error 1385/.test(tried.stdout)) {
    assert.equal((await run(runAs, ["logon-right", "add", name])).code, 0);
    right = true;
    tried = await asUser(`cmd.exe /d /c whoami /groups /fo csv > "${groups}"`);
  }
  assert.match(tried.stdout, /exit 0/, tried.stdout + tried.stderr);
  assert.doesNotMatch(fs.readFileSync(groups, "utf8"), /S-1-5-32-544[^\r\n]*Enabled group/, "never an administrator");
  const installed = await asUser(`"${process.execPath}" "${install}" "${root}" "${state}" "${out}"`);
  assert.match(installed.stdout, /exit 0/, installed.stdout + installed.stderr);
  const result = JSON.parse(fs.readFileSync(path.join(out, "installed.json"), "utf8"));
  t.diagnostic(`as ${name}: ${JSON.stringify(result)}`);
  assert.equal(result.ok, true, result.error);
  assert.equal(result.name, task);

  // As Task Scheduler keeps it: that user's, at that user's sign-in, in its
  // session (InteractiveToken), least privilege.
  const xml = (await run(path.join(SYSTEM32, "schtasks.exe"), ["/Query", "/TN", task, "/XML"])).stdout;
  assert.match(xml, new RegExp(`<UserId>${sid}</UserId>`));
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.doesNotMatch(xml, /HighestAvailable/);
  assert.match(xml, /<LogonTrigger>/);
  // Run now, as install does: what Windows says of it.
  await sleep(10000);
  const ran = fs.existsSync(path.join(out, "ran.json")) ? JSON.parse(fs.readFileSync(path.join(out, "ran.json"), "utf8")) : null;
  const status = (await run(path.join(SYSTEM32, "schtasks.exe"), ["/Query", "/TN", task, "/V", "/FO", "LIST"])).stdout;
  t.diagnostic(`its Reach ran: ${JSON.stringify(ran)}; Task Scheduler: ${status.split(/\r?\n/).filter((line) => /^(Status|Last Run Time|Last Result|Logon Mode|Run As User):/.test(line)).join(" | ")}`);
  if (ran) assert.equal(ran.user.toLowerCase(), name, "as that user");
});
