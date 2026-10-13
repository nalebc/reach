import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ALL_SCOPES, createAuth, hash } from "../server/core.mjs";
import { createReach } from "../server/index.mjs";

// An invitation nobody ever joined with goes for good a day after its chance
// to join ended (the owner, Oct 13: a 15-minute link to an Always grant sat
// in Agents & people as "Request expired", valid until 2036). Anything that
// ever joined, or that the owner approved, stays.
const MIN = 60_000, HOUR = 60 * MIN;
const key = () => crypto.randomBytes(32).toString("base64url");
// Frozen, moved by hand.
const clock = (t) => {
  const start = Date.now();
  let offset = 0;
  t.mock.method(Date, "now", () => start + offset);
  return (ms) => { offset += ms; };
};
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-unopened-")));
  const root = path.join(dir, "shared");
  fs.mkdirSync(root);
  const config = { dataDir: path.join(dir, "private"), roots: [root], agentPolicyFile: path.join(dir, "policy.json") };
  const auth = createAuth(config);
  const file = path.join(config.dataDir, "clients.json");
  const read = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const alter = (id, change) => {
    const all = read();
    change(all.find((c) => c.id === id));
    fs.writeFileSync(file, JSON.stringify(all));
  };
  const has = (id) => read().some((c) => c.id === id);
  let node = 0;
  const identity = () => ({ nodeId: `vm-${++node}`, userId: "", tagged: true, validUntil: Date.now() + 600000 });
  const cli = (name = "CLI", extra = {}) =>
    auth.inviteAgent({ name, ttlSeconds: 90 * 86400, joinSeconds: 900, folders: [{ root: 0, path: "" }], ...extra });
  // A command-line agent opens its link: a request the owner answers.
  const claim = (grant) => {
    const who = identity();
    return { who, receipt: auth.redeemGuest(grant.invitation, who) };
  };
  const person = (name = "Ali", ttlSeconds = 3600) =>
    auth.inviteGuest({ name, ttlSeconds, folders: [{ root: 0, path: "" }] });
  const page = (extra = {}) => auth.inviteBrowser({ name: "Muse", transport: "funnel", preset: "readonly", ...extra });
  const joinPage = (grant, browser = key()) => {
    const receipt = auth.redeemFunnelBrowser(grant.invitation, browser);
    auth.decideAgentAdmission(receipt.requestId, "approve");
    return auth.pollFunnelAdmission(receipt.requestId, receipt.requestSecret, browser);
  };
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { auth, file, read, alter, has, cli, claim, person, page, joinPage };
}

test("the owner's case: an unopened Always link stays a day after its 15 minutes, then goes with its link", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const always = f.page({ preset: "readonly", standing: true });
  const stored = f.read().find((c) => c.id === always.clientId);
  assert.ok(stored.expiresAt > Date.now() + 9 * 365 * 24 * HOUR, "valid for years");
  assert.equal(stored.inviteExpiresAt, Date.now() + 15 * MIN);

  advance(15 * MIN + 23 * HOUR);
  assert.deepEqual(f.auth.clearUnopened(), []);
  assert.equal(f.auth.list().find((c) => c.id === always.clientId).status, "expired", "Request expired, still there to send again");

  advance(2 * HOUR);
  assert.deepEqual(f.auth.clearUnopened().map((c) => c.id), [always.clientId]);
  assert.equal(f.has(always.clientId), false);
  assert.ok(!fs.readFileSync(f.file, "utf8").includes(hash(always.invitation)), "its link is gone from the computer");
  assert.throws(() => f.auth.redeemFunnelBrowser(always.invitation, key()), { status: 401 });
  assert.throws(() => f.auth.renewInvitation(always.clientId), { status: 404 });
  assert.equal(f.auth.unopenedInvitation(always.invitation), null);
});

test("an agent's link lapsed 23 hours ago stays; one lapsed 25 hours ago is removed", (t) => {
  const f = fixture(t);
  const recent = f.cli("Recent"), old = f.cli("Old");
  f.alter(recent.clientId, (c) => { c.inviteExpiresAt = Date.now() - 23 * HOUR; });
  f.alter(old.clientId, (c) => { c.inviteExpiresAt = Date.now() - 25 * HOUR; });
  assert.deepEqual(f.auth.clearUnopened().map((c) => c.name), ["Old"]);
  assert.equal(f.has(recent.clientId), true);
  assert.equal(f.has(old.clientId), false);
  assert.throws(() => f.auth.redeemGuest(old.invitation), { status: 401 });
  // Run again: nothing more goes.
  assert.deepEqual(f.auth.clearUnopened(), []);
});

test("a new link sent within the day starts a new window", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const grant = f.cli("Builder");
  advance(15 * MIN + 23 * HOUR);
  assert.equal(f.auth.list().find((c) => c.id === grant.clientId).status, "expired");
  const renewed = f.auth.renewInvitation(grant.clientId);
  assert.equal(renewed.joinBy, Date.now() + 15 * MIN, "a fresh 15 minutes");

  advance(2 * HOUR);
  assert.deepEqual(f.auth.clearUnopened(), [], "a day from the new window, not the first");
  assert.equal(f.auth.list().find((c) => c.id === grant.clientId).status, "expired");
  advance(23 * HOUR);
  assert.deepEqual(f.auth.clearUnopened().map((c) => c.id), [grant.clientId], "unopened again, a day after the new window");
});

test("joined, standing, approved, collected, waiting and recently declined grants and the owner's devices stay", (t) => {
  const advance = clock(t);
  const f = fixture(t);
  const owner = f.auth.issue("owner", ALL_SCOPES);
  // Joined: its request approved and its credential collected.
  const joined = f.cli("Joined");
  const j = f.claim(joined);
  f.auth.decideAgentAdmission(j.receipt.requestId, "approve");
  assert.match(f.auth.pollAgentAdmission(j.receipt.requestId, j.receipt.requestSecret, j.who).token, /^[A-Za-z0-9_-]{43}$/);
  // Approved, never collected: the owner said yes.
  const approved = f.cli("Approved");
  const a = f.claim(approved);
  f.auth.decideAgentAdmission(a.receipt.requestId, "approve");
  // An Always agent on its page, joined.
  const standing = f.page({ standing: true });
  f.joinPage(standing);
  // A timed page agent that joined, then its link reopened for another
  // browser: an older record, from before approvals were stamped.
  const reopened = f.page({ ttlSeconds: 86400 });
  f.joinPage(reopened);
  f.alter(reopened.clientId, (c) => { delete c.approvedAt; delete c.approvedBinding; c.admission.grant = "changed"; });
  assert.equal(f.auth.reopenBrowserInvitation(reopened.clientId).clientId, reopened.clientId);
  const reopenedStored = f.read().find((c) => c.id === reopened.clientId);
  assert.equal(typeof reopenedStored.inviteHash, "string", "its link works again, unopened");
  assert.equal(reopenedStored.admission, undefined);
  // Declined: kept for the day.
  const declined = f.cli("Declined");
  f.auth.decideAgentAdmission(f.claim(declined).receipt.requestId, "deny");

  advance(30 * MIN);
  // Waiting for the owner now.
  const waiting = f.cli("Waiting");
  f.claim(waiting);
  const kept = [owner.clientId, joined.clientId, approved.clientId, standing.clientId, reopened.clientId, declined.clientId, waiting.clientId];
  assert.deepEqual(f.auth.clearUnopened(), []);
  assert.equal(f.auth.list().find((c) => c.id === declined.clientId).status, "denied");
  assert.equal(f.auth.list().find((c) => c.id === waiting.clientId).status, "pending");

  // Well past a day: only the declined request (and the waiting one, never
  // answered: its request ran out) go.
  advance(26 * HOUR);
  assert.deepEqual(f.auth.clearUnopened().map((c) => c.name).sort(), ["Declined", "Waiting"]);
  for (const id of kept.filter((id) => ![declined.clientId, waiting.clientId].includes(id)))
    assert.equal(f.has(id), true, id);
  assert.ok(f.auth.verify(owner.token), "the owner's device still works");
});

test("a declined request goes a day after it was declined, and a run-out one a day after its deadline", (t) => {
  const f = fixture(t);
  const recent = f.cli("Recent"), old = f.cli("Old"), unanswered = f.cli("Unanswered");
  f.auth.decideAgentAdmission(f.claim(recent).receipt.requestId, "deny");
  f.auth.decideAgentAdmission(f.claim(old).receipt.requestId, "deny");
  f.claim(unanswered);
  f.alter(recent.clientId, (c) => { c.admission.expiresAt = Date.now() - 1 * HOUR; });
  f.alter(old.clientId, (c) => { c.admission.expiresAt = Date.now() - 25 * HOUR; });
  f.alter(unanswered.clientId, (c) => { c.admission.expiresAt = Date.now() - 25 * HOUR; });
  assert.deepEqual(f.auth.clearUnopened().map((c) => c.name).sort(), ["Old", "Unanswered"]);
  assert.equal(f.has(recent.clientId), true);
});

test("people: an unopened invitation goes a day after it ran out; one opened stays", (t) => {
  const f = fixture(t);
  const recent = f.person("Recent"), old = f.person("Old"), joined = f.person("Joined");
  assert.ok(f.auth.redeemGuest(joined.invitation).token);
  f.alter(recent.clientId, (c) => { c.expiresAt = Date.now() - 23 * HOUR; });
  f.alter(old.clientId, (c) => { c.expiresAt = Date.now() - 25 * HOUR; });
  f.alter(joined.clientId, (c) => { c.expiresAt = Date.now() - 25 * HOUR; });
  assert.deepEqual(f.auth.clearUnopened().map((c) => c.name), ["Old"]);
  assert.equal(f.has(recent.clientId), true);
  assert.equal(f.has(joined.clientId), true);
  assert.ok(!fs.readFileSync(f.file, "utf8").includes(hash(old.invitation)));
});

test("Reach's sweep removes them as removing does, and says so in the security record", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-unopened-sweep-"));
  const files = path.join(dir, "files");
  fs.mkdirSync(path.join(files, "work"), { recursive: true });
  const reach = await createReach({ roots: [files], dataDir: path.join(dir, "private") });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES).token;
  const call = (route, { token = owner, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const agent = await call("/api/agents/invitations", {
    method: "POST",
    body: { name: "Builder", ttlSeconds: 7 * 86400, joinSeconds: 900, folders: [{ root: 0, path: "work" }] },
  });
  assert.equal(agent.status, 201, JSON.stringify(agent.body));
  const guest = await call("/api/guests", { method: "POST", body: { name: "Ali", ttlSeconds: 3600, folders: [{ root: 0, path: "work" }] } });
  assert.equal(guest.status, 201, JSON.stringify(guest.body));
  const fresh = await call("/api/guests", { method: "POST", body: { name: "Sam", ttlSeconds: 3600, folders: [{ root: 0, path: "work" }] } });

  const file = path.join(reach.config.dataDir, "clients.json");
  const clients = JSON.parse(fs.readFileSync(file, "utf8"));
  clients.find((c) => c.id === agent.body.clientId).inviteExpiresAt = Date.now() - 25 * HOUR;
  clients.find((c) => c.id === guest.body.clientId).expiresAt = Date.now() - 25 * HOUR;
  fs.writeFileSync(file, JSON.stringify(clients));

  assert.deepEqual(reach.clearUnopened().map((c) => c.name).sort(), ["Ali", "Builder"]);
  const listed = (await call("/api/clients")).body;
  const ids = (Array.isArray(listed) ? listed : listed.clients).map((c) => c.id);
  assert.ok(!ids.includes(agent.body.clientId) && !ids.includes(guest.body.clientId));
  assert.ok(ids.includes(fresh.body.clientId), "a person's link still open stays");
  const titles = (await call("/api/activity")).body.filter((e) => e.kind === "security").map((e) => e.title);
  assert.ok(titles.includes("Unopened invitation for Builder cleared"), JSON.stringify(titles));
  assert.ok(titles.includes("Unopened invitation for Ali cleared"), JSON.stringify(titles));
  // Gone: no new link for it.
  assert.equal((await call(`/api/guests/${agent.body.clientId}/link`, { method: "POST", body: {} })).status, 404);
  assert.deepEqual(reach.clearUnopened(), []);
});
