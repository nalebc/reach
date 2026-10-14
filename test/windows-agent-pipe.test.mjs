import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { socketOf, viaShared } from "../scripts/agent-remote.mjs";
import { windowsFixture } from "./helpers/windows-fixtures.mjs";
import { windowsAcl, othersAllowed, WRITES } from "./helpers/windows-acl.mjs";

// Parity audit #24, the pipe an agent's runtime shares its connection
// through (scripts/agent-remote.mjs shareNode), on a real Windows PC: held as
// a standard account holds it (the runner's own, without elevation: run-as
// filtered), and tried by another Windows user made for the test. Its own
// account asks through it; the other may open it only to read, so it can't
// ask anything. Windows' own access check decides, not Reach.
//
// Only on a disposable CI runner (it makes a Windows user, as the peer
// check's spike does): REACH_TEST_WINDOWS_PEER=1, CI=true.
const enabled = process.platform === "win32" && process.env.REACH_TEST_WINDOWS_PEER === "1" && process.env.CI === "true";
const skip = enabled ? false : "a real Windows CI runner only (REACH_TEST_WINDOWS_PEER=1, CI=true): it makes a Windows user";
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");
const SYSTEM32 = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32");
const PIPES = "\\\\.\\pipe\\";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (file, args, options = {}) =>
  new Promise((resolve) =>
    execFile(file, args, { windowsHide: true, timeout: 120000, ...options }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, stdout: String(stdout), stderr: String(stderr) })));
const until = async (check, what, ms = 60000) => {
  for (const end = Date.now() + ms; ; await sleep(200)) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw Error(`timed out waiting: ${what}`);
  }
};

test("the agent's shared pipe on a real PC: its own account asks through it; another user may only open it to read, and asks nothing", { skip, timeout: 300000 }, async (t) => {
  const runAs = await windowsFixture("run-as");
  const probe = await windowsFixture("pipe-probe");
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-pipe-")));
  const conn = path.join(base, "home", "mac");
  const out = path.join(base, "out");
  const theirs = path.join(base, "theirs");
  for (const dir of [conn, out, theirs]) fs.mkdirSync(dir, { recursive: true });
  // Another standard user on this PC, with a folder of its own here.
  const name = "reachpipe";
  const password = `${crypto.randomBytes(18).toString("base64").replace(/[^A-Za-z0-9]/g, "x")}Aa1!`;
  const added = await run(path.join(SYSTEM32, "net.exe"), ["user", name, password, "/add", "/Y"]);
  assert.equal(added.code, 0, added.stdout + added.stderr);
  const sid = (await run(runAs, ["sid", name])).stdout.trim();
  let right = false;
  t.after(async () => {
    fs.writeFileSync(path.join(out, "stop"), "");
    if (sid) await run(runAs, ["desktop", "revoke", sid]);
    if (right) await run(runAs, ["logon-right", "remove", name]);
    await run(path.join(SYSTEM32, "net.exe"), ["user", name, "/delete"]);
    await sleep(1000);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });
  assert.match(sid, /^S-1-5-21-[\d-]+$/);
  const granted = await run(runAs, ["desktop", "grant", sid]);
  assert.equal(granted.code, 0, granted.stdout);
  const shared = await run(path.join(SYSTEM32, "icacls.exe"), [theirs, "/grant", `*${sid}:(OI)(CI)F`, "/Q"]);
  assert.equal(shared.code, 0, shared.stdout);
  fs.copyFileSync(probe, path.join(theirs, "pipe-probe.exe"));

  // The runtime holding the connection, as this account without elevation.
  const holder = path.join(here, "fixtures", "windows", "agent-pipe-holder.mjs");
  const started = await run(runAs, ["filtered", repo, "nowait", `"${process.execPath}" "${holder}" "${conn}" "${out}"`]);
  assert.match(started.stdout, /^pid \d+/, started.stdout + started.stderr);
  const held = await until(() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(out, "holder.json"), "utf8"));
    } catch {
      return null;
    }
  }, "the pipe held");
  assert.equal(held.error, undefined, held.error);
  assert.equal(held.pipe, socketOf(conn));
  const pipe = held.pipe.slice(PIPES.length);

  // As Windows keeps it: the account holding it owns it and may ask through
  // it; only it, SYSTEM and Administrators may write to it.
  const acl = await windowsAcl("pipe", pipe);
  t.diagnostic(`the pipe's ACL, held without elevation: ${JSON.stringify(acl)}`);
  assert.equal(acl.owner, acl.me, "owned by the account that holds it");
  assert.ok(acl.rules.some((rule) => rule.sid === acl.me && rule.allow && (rule.rights & 0x3) === 0x3), JSON.stringify(acl));
  assert.deepEqual(othersAllowed(acl, WRITES), [], JSON.stringify(acl));
  // Its own account asks through it, as a second agent session does.
  assert.deepEqual(await viaShared(conn)("/api/device"), { ok: "/api/device" });

  // The other user: let in to read, refused writing, so it asks nothing.
  const log = path.join(theirs, "probe.log");
  const asOther = () => run(runAs, ["run", name, password, theirs, "wait", `"${path.join(theirs, "pipe-probe.exe")}" ${pipe} "${log}"`]);
  let tried = await asOther();
  if (/error 1385/.test(tried.stdout)) {
    const added = await run(runAs, ["logon-right", "add", name]);
    assert.equal(added.code, 0, added.stdout);
    right = true;
    tried = await asOther();
  }
  assert.match(tried.stdout, /exit 0/, tried.stdout + tried.stderr);
  const said = fs.readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean);
  t.diagnostic(`another user: ${said.join(", ")}`);
  assert.deepEqual(said, ["readwrite error 5", "read ok"]);
  await sleep(500);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "asked.json"), "utf8")), ["/api/device"], "only its own account's request");
});
