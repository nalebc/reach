import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAuth, takeCredentialLock } from "../server/core.mjs";

// A lock left by a Reach that died mid-change used to block every credential
// change for good, Revoke included (reliability audit, Oct 10).
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), "reach-lock-"));

test("Revoke works after a Reach died holding the credential lock", () => {
  const dataDir = dir();
  const config = { dataDir, agentPolicyFile: path.join(dataDir, "none.json"), roots: [dataDir] };
  const auth = createAuth(config, { rotatePairing: false });
  const phone = auth.issue("phone", ["files"], "device");
  // Left by a process that's gone (pid 2^22 + 1 isn't running).
  fs.writeFileSync(path.join(dataDir, "clients.json.lock"), JSON.stringify({ pid: 4194305, at: Date.now() }), { mode: 0o600 });
  auth.revoke(phone.id);
  assert.equal(auth.list().some((client) => client.id === phone.id), false);
  assert.equal(fs.existsSync(path.join(dataDir, "clients.json.lock")), false);
});

test("a lock held by a running Reach is respected; an old or unnamed one is taken over", () => {
  const lock = path.join(dir(), "clients.json.lock");
  let clock = 1_000_000;
  const now = () => clock;
  const write = (content, ageMs) => {
    fs.writeFileSync(lock, content, { mode: 0o600 });
    const t = (clock - ageMs) / 1000;
    fs.utimesSync(lock, t, t);
  };
  // Held right now by a live process: busy.
  write(JSON.stringify({ pid: process.pid, at: clock }), 100);
  assert.throws(() => takeCredentialLock(lock, { now }), (e) => e.status === 409);
  // Its holder gone: taken.
  write(JSON.stringify({ pid: 4194305, at: clock }), 100);
  let fd = takeCredentialLock(lock, { now });
  fs.closeSync(fd);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  // A live pid but held 11 s (a pid reused since): taken.
  write(JSON.stringify({ pid: process.pid, at: clock }), 11000);
  fd = takeCredentialLock(lock, { now });
  fs.closeSync(fd);
  // Unnamed (an older Reach's lock, or a holder still writing its name).
  write("", 500);
  assert.throws(() => takeCredentialLock(lock, { now }), (e) => e.status === 409);
  write("", 3000);
  fd = takeCredentialLock(lock, { now });
  fs.closeSync(fd);
});
