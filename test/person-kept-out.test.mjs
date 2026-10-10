import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// While an agent has Full control or Apps, Reach answers only the phone that
// invited it (the host guard). A person kept out by it is told plainly that
// someone else has the Mac, their invitation is kept for later, and the owner
// hears who couldn't come in (Oct 10: "they should know someone else is
// controlling").
test("while an agent has Full control, a person is told someone else has the Mac, the invite is kept, and the owner hears who", async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-kept-out-")));
  fs.mkdirSync(path.join(root, "shared"));
  let agent = null, reach = null;
  reach = await createReach({
    name: "Fixture Mac", roots: [path.join(root, "shared")], dataDir: path.join(root, "state"), screen: false,
    browserHostGuard: {
      lookup: async () => ({ BackendState: "Running", Self: { ID: "nMac", KeyExpiry: "0001-01-01T00:00:00Z" }, Peer: {} }),
      clients: () => [...(reach?.auth.list() || []), ...(agent ? [agent] : [])],
    },
  });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { await reach.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const call = async (route, { token, method = "GET", body } = {}) => {
    const response = await fetch(url + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const { invitation } = reach.auth.inviteGuest({ name: "Aya", ttlSeconds: 3600, full: true });
  const takeControl = () => { agent = { id: "a1", kind: "agent", name: "Muse", policy: { browser: true, preset: "full" }, expiresAt: Date.now() + 600_000 }; };
  takeControl();
  const kept = await call("/api/guest/redeem", { method: "POST", body: { invitation } });
  assert.equal(kept.status, 403);
  assert.match(kept.body.error, /Someone else is controlling this Mac right now/);
  // Anyone else the guard keeps out reads what it always said.
  const other = await call("/api/clients", { token: owner.token });
  assert.equal(other.status, 403);
  assert.doesNotMatch(other.body.error, /Someone else/);
  agent = null;
  const told = async () => (await call("/api/activity", { token: owner.token })).body.filter((entry) => /Aya couldn't come in/.test(entry.title));
  assert.equal((await told()).length, 1, "the owner hears who couldn't come in");
  // The invitation was kept: with no agent in control, it opens.
  const opened = await call("/api/guest/redeem", { method: "POST", body: { invitation } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.ok(opened.body.token);
  // A person with access, while an agent takes control: told the same way.
  takeControl();
  const later = await call("/api/device", { token: opened.body.token });
  assert.equal(later.status, 403);
  assert.match(later.body.error, /Someone else is controlling this Mac right now/);
  agent = null;
  assert.equal((await told()).length, 1, "once per person every ten minutes");
  // An agent's own invitation, or an unknown one, gets no person wording.
  takeControl();
  const unknown = await call("/api/guest/redeem", { method: "POST", body: { invitation: "x".repeat(43) } });
  assert.equal(unknown.status, 403);
  assert.doesNotMatch(unknown.body.error, /Someone else/);
});
