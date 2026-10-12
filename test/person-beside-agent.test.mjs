import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// While an agent has Full control or Apps, a person still comes in (Oct 11:
// "let them in both"): opening their invitation binds it to their device and
// waits for the owner's Allow, once, so an agent that saw the link on the
// Mac's screen can't use it to step outside its limits. People who came in
// before, or once allowed, share the Mac with the agent.
test("a person opening their invite while an agent has Full control waits for the owner's Allow, then shares the Mac", async (t) => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-person-beside-")));
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
  const takeControl = () => { agent = { id: "a1", kind: "agent", name: "Muse", policy: { browser: true, preset: "full" }, expiresAt: Date.now() + 600_000 }; };

  // Before any agent: a person comes straight in.
  const early = reach.auth.inviteGuest({ name: "Sam", ttlSeconds: 3600, full: true });
  const sam = await call("/api/guest/redeem", { method: "POST", body: { invitation: early.invitation } });
  assert.equal(sam.status, 200, JSON.stringify(sam.body));
  assert.equal(sam.body.waiting, undefined);

  takeControl();
  // Who was in before keeps working beside the agent.
  assert.equal((await call("/api/device", { token: sam.body.token })).status, 200);
  // Other devices of the owner stay behind the guard, as before.
  assert.equal((await call("/api/clients", { token: owner.token })).status, 403);

  // A new person opens their invite now: in, bound, and waiting.
  const { invitation, clientId } = reach.auth.inviteGuest({ name: "Aya", ttlSeconds: 3600, full: true });
  const opened = await call("/api/guest/redeem", { method: "POST", body: { invitation } });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  assert.ok(opened.body.token);
  assert.equal(opened.body.waiting, true);
  const waiting = await call("/api/device", { token: opened.body.token });
  assert.equal(waiting.status, 403);
  assert.equal(waiting.body.waiting, true);
  assert.match(waiting.body.error, /Waiting for the owner to let you in/);
  assert.equal(reach.auth.list().find((c) => c.id === clientId).status, "waiting");

  // Still waiting with the agent gone: only the owner's Allow lets them in.
  agent = null;
  assert.equal((await call("/api/device", { token: opened.body.token })).body.waiting, true);
  const heard = (await call("/api/activity", { token: owner.token })).body.filter((entry) => /Aya is waiting to come in/.test(entry.title));
  assert.equal(heard.length, 1, "the owner hears who is waiting");
  // A person can't let themselves (or anyone) in.
  assert.equal((await call(`/api/guests/${clientId}/allow`, { method: "POST", token: sam.body.token })).status, 403);
  const allowed = await call(`/api/guests/${clientId}/allow`, { method: "POST", token: owner.token });
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal((await call(`/api/guests/${clientId}/allow`, { method: "POST", token: owner.token })).status, 404, "once");

  // Allowed: in beside the agent from then on.
  takeControl();
  const device = await call("/api/device", { token: opened.body.token });
  assert.equal(device.status, 200, JSON.stringify(device.body));
  assert.equal(device.body.access.kind, "guest");

  // Managing agents stays yours, even for a person with full access.
  for (const route of ["/api/browser/agents/pause", "/api/browser/agents/stop"])
    assert.equal((await call(route, { method: "POST", token: opened.body.token, body: { id: "a1", paused: true } })).status, 403, route);
  assert.equal((await call("/api/browser/agents", { token: opened.body.token })).status, 403);

  // Someone still waiting can leave; their access (and your card) ends.
  const late = reach.auth.inviteGuest({ name: "Lee", ttlSeconds: 3600, full: true });
  const lee = await call("/api/guest/redeem", { method: "POST", body: { invitation: late.invitation } });
  assert.equal(lee.body.waiting, true);
  assert.equal((await call("/api/device/access", { method: "DELETE", token: lee.body.token })).status, 200);
  assert.equal(reach.auth.list().some((c) => c.id === late.clientId), false);

  // An unknown invitation still meets the guard.
  const unknown = await call("/api/guest/redeem", { method: "POST", body: { invitation: "x".repeat(43) } });
  assert.equal(unknown.status, 403);
});
