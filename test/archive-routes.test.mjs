import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createWriteStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import tar from "tar-stream";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

async function writeTar(file, entries = [["notes.txt", "Archive fixture text"]]) {
  const pack = tar.pack();
  const writing = pipeline(pack, createWriteStream(file, { flags: "wx" }));
  for (const [name, content] of entries) pack.entry({ name, type: "file", mode: 0o644 }, content);
  pack.finalize();
  await writing;
}

async function fixture(t) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "reach-archive-api-")));
  const root = path.join(temp, "shared"), dataDir = path.join(temp, "private");
  await fs.mkdir(path.join(root, "nested"), { recursive: true });
  await fs.mkdir(dataDir);
  await writeTar(path.join(root, "nested", "Bundle.tar"));
  await writeTar(path.join(dataDir, "Private.tar"));
  const reach = await createReach({ roots: [root], dataDir, screen: false, agentDesktop: null,
    desktopTerminals: { platform: "linux", run: async () => assert.fail("No desktop terminal access") },
    browserCapture: async () => assert.fail("No screen capture"),
    browserInput: async () => assert.fail("No screen input"),
  });
  t.after(async () => { await reach.close(); await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  await new Promise(resolve => reach.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("Owner", ALL_SCOPES, "device");
  const call = async (body = { root: 0, path: "nested/Bundle.tar" }, token = owner.token) => {
    const response = await fetch(`${origin}/api/files/extract`, { method: "POST", headers: {
      Authorization: `Bearer ${token}`, "Content-Type": "application/json",
    }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { reach, root, dataDir, owner, origin, call };
}

test("the paired owner extracts beside the archive without overwriting an existing result", async t => {
  const f = await fixture(t);
  const first = await f.call();
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.deepEqual(first.body, { name: "Bundle", path: "nested/Bundle" });
  assert.equal(await fs.readFile(path.join(f.root, first.body.path, "notes.txt"), "utf8"), "Archive fixture text");
  await fs.writeFile(path.join(f.root, first.body.path, "notes.txt"), "Keep the first result");
  const second = await f.call();
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.deepEqual(second.body, { name: "Bundle 2", path: "nested/Bundle 2" });
  assert.equal(await fs.readFile(path.join(f.root, first.body.path, "notes.txt"), "utf8"), "Keep the first result");
  assert.equal(await fs.readFile(path.join(f.root, second.body.path, "notes.txt"), "utf8"), "Archive fixture text");
  assert.deepEqual((await fs.readdir(path.join(f.root, "nested"))).sort(), ["Bundle", "Bundle 2", "Bundle.tar"]);
});

test("archive extraction requires an owner device, admin, read and write; invited access stays restricted", async t => {
  const f = await fixture(t);
  const scopedInvite = f.reach.auth.inviteAgent({ name: "Scoped writer", ttlSeconds: 600, folders: [{ root: 0, path: "nested" }], write: true });
  const scoped = admitAgent(f.reach.auth, scopedInvite.invitation);
  const guestInvite = f.reach.auth.inviteGuest({ name: "Write guest", ttlSeconds: 600, roots: [0], write: true });
  const guest = f.reach.auth.redeemGuest(guestInvite.invitation);
  const fullGuestInvite = f.reach.auth.inviteGuest({ name: "Full guest", ttlSeconds: 600, full: true });
  const fullGuest = f.reach.auth.redeemGuest(fullGuestInvite.invitation);
  const browserInvite = f.reach.auth.inviteBrowser({ name: "Browser file editor", ttlSeconds: 600, preset: "files", folders: [{ root: 0, path: "nested" }], write: true });
  const browser = admitAgent(f.reach.auth, browserInvite.invitation);
  const denied = [
    [scoped, { root: 0, path: "Bundle.tar" }],
    [guest], [fullGuest], [browser],
    [f.reach.auth.issue("Service", ALL_SCOPES, "service")],
    [f.reach.auth.issue("Limited device", ["device", "files:read", "files:write"], "device")],
    [f.reach.auth.issue("Owner read only", ["admin", "files:read"], "device")],
    [f.reach.auth.issue("Owner write only", ["admin", "files:write"], "device")],
  ];
  for (const [credential, body] of denied) {
    const response = await f.call(body, credential.token);
    assert.equal(response.status, 403, JSON.stringify(response));
  }
  assert.deepEqual(await fs.readdir(path.join(f.root, "nested")), ["Bundle.tar"]);
  // The new owner-only operation does not disable ordinary granted file reads.
  const read = await fetch(`${f.origin}/api/files?root=0&path=`, { headers: { Authorization: `Bearer ${scoped.token}` } });
  const listing = await read.json();
  assert.equal(read.status, 200, JSON.stringify(listing));
  assert.ok(listing.items.some(item => item.name === "Bundle.tar"));
});

test("unauthenticated, revoked and invalid extraction requests leave shared files unchanged", async t => {
  const f = await fixture(t);
  assert.equal((await f.call(undefined, "")).status, 401);
  for (const body of [[], null, {}, { root: 0, path: "nested/Bundle.tar", extra: true }, { root: 0, path: 42 }])
    assert.equal((await f.call(body)).status, 400, JSON.stringify(body));
  for (const body of [{ root: 1, path: "Private.tar" }, { root: 0, path: "../private/Private.tar" }, { root: 0, path: path.join(f.dataDir, "Private.tar") }])
    assert.ok([400, 403].includes((await f.call(body)).status), JSON.stringify(body));
  f.reach.auth.revoke(f.owner.clientId);
  assert.equal((await f.call()).status, 401);
  assert.deepEqual(await fs.readdir(path.join(f.root, "nested")), ["Bundle.tar"]);
  assert.ok((await fs.readdir(f.dataDir)).includes("Private.tar"));
});

test("an in-flight extraction is exclusive and revocation prevents publication, then releases capacity", async t => {
  const f = await fixture(t);
  await writeTar(path.join(f.root, "nested", "Many.tar"), Array.from({ length: 400 }, (_, i) => [`notes-${i}.txt`, "safe fixture text"]));
  const secondOwner = f.reach.auth.issue("Second owner device", ALL_SCOPES, "device");
  let ended = false;
  const extraction = f.call({ root: 0, path: "nested/Many.tar" }).then(
    response => { ended = true; return { response }; },
    error => { ended = true; return { error }; },
  );
  // Observe real private staging, so revocation occurs during extraction rather
  // than depending on a fixed delay or substituting the extraction implementation.
  const until = Date.now() + 10000;
  while (!(await fs.readdir(f.dataDir)).some(name => name.startsWith("reach-archive-"))) {
    assert.equal(ended, false, "the fixture must reach its in-flight staging phase");
    assert.ok(Date.now() < until, "extraction did not enter staging");
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  const concurrent = await f.call(undefined, secondOwner.token);
  assert.equal(concurrent.status, 429, JSON.stringify(concurrent.body));
  f.reach.auth.revoke(f.owner.clientId);
  const result = await extraction;
  if (result.response) assert.equal(result.response.status, 401, JSON.stringify(result.response.body));
  else assert.match(String(result.error), /fetch failed|socket|network/i);
  assert.equal((await fs.readdir(f.root)).includes("Many"), false);
  assert.equal((await fs.readdir(path.join(f.root, "nested"))).includes("Many"), false);
  assert.equal((await fs.readdir(f.dataDir)).some(name => name.startsWith("reach-archive-")), false);
  const next = await f.call(undefined, secondOwner.token);
  assert.equal(next.status, 200, JSON.stringify(next.body));
});
