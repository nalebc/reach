import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";
import { admitAgent } from "./helpers/agent-admission.mjs";

const textEdit = "/Applications/TextEdit.app", notes = "/Applications/Notes.app", terminal = "/Applications/Terminal.app";
const apple = "a".repeat(64), noteSignature = "b".repeat(64), processInstance = "c".repeat(64);
const ownerAccount = { userId: "42", login: "owner@example.test" };
const ORIGIN = "https://computer.example.ts.net";
const addresses = { nPhone: "100.64.0.1", nHost: "100.64.0.2", nOther: "100.64.0.3", nWasm: "100.64.0.4", nAgent: "100.64.0.5" };
const identity = (nodeId) => ({ nodeId, userId: nodeId === "nAgent" ? "" : "42", tagged: nodeId === "nAgent", validUntil: Date.now() + 60000 });

// Real HTTP through the protected Unix listener exercises the actual trusted
// ingress marker. Only Tailscale's local lookups and native app IO are injected;
// no test may capture the desktop, type, or send a global mouse event.
async function fixture(t, hooks = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "reach-app-routes-")));
  const socketDir = fs.mkdtempSync("/tmp/reach-app-sock-");
  const socketPath = path.join(socketDir, "s"), dataDir = path.join(dir, "private");
  const inputs = [], captures = [], windowCalls = [];
  const applications = [
    { id: textEdit, name: "TextEdit", bundleId: "com.apple.TextEdit", protected: false, identity: apple },
    { id: notes, name: "Notes", bundleId: "com.apple.Notes", protected: false, identity: noteSignature },
    { id: terminal, name: "Terminal", bundleId: "com.apple.Terminal", protected: true, reason: "Protected app" },
  ];
  const native = {
    catalog: async (authorize) => { authorize(); return { apps: structuredClone(applications) }; },
    windows: async (appId, authorize, expected) => {
      authorize(); const app = applications.find((item) => item.id === appId);
      assert.equal(expected, app.identity); windowCalls.push(appId);
      return { windows: [{ id: appId === textEdit ? 11 : 12, pid: appId === textEdit ? 101 : 102,
        title: "Allowed window", instance: processInstance, identity: expected, width: 800, height: 600 }] };
    },
    capture: async (target, authorize) => {
      if (hooks.capture) await hooks.capture(target);
      authorize(); captures.push(target);
      return { jpeg: Buffer.from("only-this-app-jpeg").toString("base64"), width: 800, height: 600 };
    },
    input: async (target, action, authorize) => {
      if (hooks.input) await hooks.input(target, action);
      authorize(); inputs.push({ target, action }); return { done: true };
    },
  };
  const reach = await createReach({ roots: [dir], dataDir, port: 0, screen: true,
    tailscaleOwner: ownerAccount, publicOrigin: hooks.funnel ? ORIGIN : "", browserScreenSupported: true, browserAppSupported: true,
    browserAppNative: native,
    ...(hooks.publicName ? { publicName: hooks.publicName } : {}),
    browserCapture: async () => assert.fail("Full desktop capture must not run"),
    browserInput: async () => assert.fail("Global desktop input must not run"),
    desktopTerminals: { platform: "linux", run: async () => assert.fail("Native terminal access is forbidden") },
    tailscaleIdentity: { lookup: async (ip) => {
      const nodeId = Object.keys(addresses).find((node) => addresses[node] === ip);
      assert.ok(nodeId, "only fixture Tailscale nodes exist");
      return nodeId === "nAgent" ? { Node: { StableID: nodeId, Tags: ["tag:agent"] } } :
        { Node: { StableID: nodeId, User: 42 }, UserProfile: { ID: 42, LoginName: ownerAccount.login } };
    } },
    browserHostGuard: { lookup: async () => ({ BackendState: "Running", Self: { ID: "nHost", Online: true },
      Peer: {
        phone: { ID: "nPhone", OS: "iOS", UserID: 42, Online: true },
        other: { ID: "nOther", OS: "darwin", UserID: 42, Online: true },
        wasm: { ID: "nWasm", OS: "js", UserID: 42, Online: true },
        agent: { ID: "nAgent", OS: "js", Tags: ["tag:agent"] },
      } }) },
  });
  const owners = Object.fromEntries(["nPhone", "nHost", "nOther", "nWasm"].map((nodeId) =>
    [nodeId, reach.auth.issue(nodeId, ALL_SCOPES, "device", { tailscale: { nodeId, userId: "42" } })]));
  if (hooks.funnel) reach.setFunnelController(async () => {});
  t.after(async () => { await reach.close(); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(socketDir, { recursive: true, force: true }); });
  await new Promise((resolve) => reach.server.listen(0, "127.0.0.1", resolve));
  await reach.listenPrivate(socketPath, hooks.publicApp ? { publicApp: hooks.publicApp } : {});
  const call = (route, { node = "nPhone", token = owners[node]?.token || "", method = "GET", body, headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: route, method, headers: {
      Host: "localhost", "X-Forwarded-For": addresses[node], "Tailscale-User-Login": ownerAccount.login,
      ...(token ? { Authorization: `Bearer ${token}` } : {}), "Content-Type": "application/json", ...headers,
    } }, (res) => {
      const chunks = []; res.on("data", (chunk) => chunks.push(chunk)); res.once("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString(); let result; try { result = JSON.parse(text); } catch { result = text; }
        resolve({ status: res.statusCode, body: result });
      });
    });
    req.setTimeout(10000, () => req.destroy(Error("Fixture request timed out")));
    req.once("error", reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  const invite = (appAccess = [{ id: textEdit, mode: "view" }], options = {}) => call("/api/agents/browser-invitations", {
    method: "POST", body: { name: "Muse", ttlSeconds: 600, screen: "apps", appAccess }, ...options,
  });
  const join = async (choices) => {
    const created = await invite(choices); assert.equal(created.status, 201, JSON.stringify(created.body));
    // Admission has independent endpoint tests; use its real auth gate here so
    // tests below focus on app HTTP routes and actual bound agent credentials.
    const joined = admitAgent(reach.auth, created.body.invitation, identity("nAgent"));
    return { ...joined, invitation: created.body,
      as: (route, options = {}) => call(route, { node: "nAgent", token: joined.token, ...options }) };
  };
  const window = async (agent, appId = textEdit) => {
    const result = await agent.as(`/api/browser/apps/windows?appId=${encodeURIComponent(appId)}`);
    assert.equal(result.status, 200, JSON.stringify(result.body)); assert.equal(result.body.windows.length, 1);
    return result.body.windows[0];
  };
  const alter = (clientId, change) => {
    const file = path.join(dataDir, "clients.json"), clients = JSON.parse(fs.readFileSync(file));
    change(clients.find((client) => client.id === clientId)); atomicJson(file, clients);
  };
  return { reach, owners, call, invite, join, window, alter, inputs, captures, applications, windowCalls, socketPath, dir };
}

const platform = { skip: process.platform === "win32" };
test("real app HTTP routes bind capture/input to exact allowed windows and reject all desktop bypasses", platform, async (t) => {
  const f = await fixture(t), agent = await f.join(), target = await f.window(agent);
  assert.match(target.id, /^[A-Za-z0-9_-]{32}$/);
  const image = await agent.as(`/api/browser/apps/screen?target=${target.id}`);
  assert.equal(image.status, 200); assert.equal(image.body, "only-this-app-jpeg");
  const action = { type: "click", x: 0.4, y: 0.5 };
  assert.equal((await agent.as("/api/browser/apps/input", { method: "POST", body: { target: target.id, action } })).status, 403);
  assert.deepEqual(f.inputs, []);
  assert.equal(f.captures[0].appId, textEdit);
  for (const [route, method, body] of [
    ["/api/browser/screen", "GET"], ["/api/screen", "GET"],
    ["/api/browser/scroll", "POST", { direction: "down" }],
    ["/api/screen/input", "POST", action], ["/api/screen/control", "POST", { enabled: true }],
    ["/api/browser/requests", "POST", { ...action, reason: "Use global screen" }],
    ["/api/browser/apps/windows?appId=" + encodeURIComponent(notes), "GET"],
  ]) assert.equal((await agent.as(route, { method, body })).status, 403, route);
  assert.equal((await agent.as("/api/browser/apps/input", { method: "POST", body: { target: "11", action } })).status, 403);
  assert.equal((await agent.as("/api/browser/apps/input", { method: "POST", body: { target: target.id, pid: 999, action } })).status, 403);
  assert.equal(f.inputs.length, 0);
});

test("view-only app grants reject input and do not implicitly share other apps", platform, async (t) => {
  const f = await fixture(t), agent = await f.join([{ id: textEdit, mode: "view" }]), target = await f.window(agent);
  assert.equal((await agent.as(`/api/browser/apps/screen?target=${target.id}`)).status, 200);
  for (const action of [{ type: "click", x: .1, y: .1 }, { type: "text", text: "hello" },
    { type: "key", key: "enter" }, { type: "scroll", direction: "down", amount: 2 }])
    assert.equal((await agent.as("/api/browser/apps/input", { method: "POST", body: { target: target.id, action } })).status, 403);
  const list = await agent.as("/api/browser/apps");
  assert.equal(list.body.apps.find((app) => app.id === notes).mode, "hidden");
  assert.deepEqual(f.inputs, []);
});

test("owner grants one requested app for one invitation and same-name new invite starts fresh", platform, async (t) => {
  const f = await fixture(t), agent = await f.join();
  const pending = await agent.as("/api/browser/apps/requests", { method: "POST", body: { appId: notes, mode: "view", reason: "Write the requested note" } });
  assert.equal(pending.status, 201); assert.equal(pending.body.status, "pending");
  const route = `/api/agents/browser-requests/${pending.body.id}`;
  assert.equal((await agent.as(route, { method: "POST", body: { decision: "approve" } })).status, 403);
  assert.equal((await f.call(route, { method: "POST", body: { decision: "approve", appId: textEdit } })).status, 400);
  assert.equal((await f.call(route, { method: "POST", body: { decision: "approve" } })).body.status, "executed");
  const note = await f.window(agent, notes);
  assert.equal((await agent.as(`/api/browser/apps/screen?target=${note.id}`)).status, 200);
  assert.equal((await agent.as("/api/browser/apps/input", { method: "POST", body: { target: note.id, action: { type: "text", text: "hello" } } })).status, 403);
  const next = await f.join(); assert.notEqual(next.clientId, agent.clientId);
  assert.equal((await next.as(`/api/browser/apps/screen?target=${note.id}`)).status, 409);
  assert.equal((await next.as(`/api/browser/apps/windows?appId=${encodeURIComponent(notes)}`)).status, 403);
  assert.equal((await next.as("/api/browser/apps")).body.apps.find((app) => app.id === notes).mode, "hidden");
  assert.equal((await next.as("/api/browser/apps/requests", { method: "POST", body: { appId: terminal, mode: "view" } })).status, 403);
});

test("private HTTP guard blocks host owner reads/admission and unpinned or browser-node owners", platform, async (t) => {
  const f = await fixture(t);
  for (const node of ["nHost", "nWasm"])
    assert.equal((await f.invite(undefined, { node })).status, 403);
  const created = await f.invite(); assert.equal(created.status, 201, JSON.stringify(created.body));
  for (const node of ["nHost", "nOther", "nWasm"])
    for (const [route, method, body] of [["/api/clients", "GET"], ["/api/device", "GET"],
      ["/api/auth/requests", "POST", { name: "Browser escalation" }]])
      assert.equal((await f.call(route, { node, method, body })).status, 403, `${node} ${route}`);
  assert.equal((await f.call("/api/clients")).status, 200);
  const stored = f.reach.auth.list().find((client) => client.id === created.body.clientId);
  assert.deepEqual(stored.browserAppApprover, { nodeId: "nPhone", userId: "42", clientId: f.owners.nPhone.clientId });
});

test("an existing owner download capability cannot bypass app-session protection", platform, async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.dir, "owner-only.txt"), "private owner file");
  const hostLink = await f.call("/api/files/download-link?root=0&path=owner-only.txt", { node: "nHost" });
  const phoneLink = await f.call("/api/files/download-link?root=0&path=owner-only.txt");
  assert.equal(hostLink.status, 200); assert.equal(phoneLink.status, 200);
  assert.equal((await f.call(hostLink.body.url, { node: "nHost", token: "" })).body, "private owner file");
  assert.equal((await f.invite()).status, 201);
  const blocked = await f.call(hostLink.body.url, { node: "nHost", token: "" });
  assert.equal(blocked.status, 403, JSON.stringify(blocked));
  assert.equal((await f.call(phoneLink.body.url, { token: "" })).body, "private owner file", "the pinned owner retains download access");
});

test("revoking the supervising owner terminates app access before native effects", platform, async (t) => {
  let revoke;
  const f = await fixture(t, { capture: async () => revoke?.() });
  const agent = await f.join(), target = await f.window(agent);
  revoke = () => f.reach.auth.revoke(f.owners.nPhone.clientId);
  const acted = await agent.as(`/api/browser/apps/screen?target=${target.id}`);
  assert.ok([401, 403].includes(acted.status), JSON.stringify(acted));
  assert.deepEqual(f.inputs, []); assert.deepEqual(f.captures, []);
  assert.equal((await agent.as(`/api/browser/apps/screen?target=${target.id}`)).status, 403);
});

test("owner access editing cannot downgrade an app session to unrestricted desktop capture", platform, async (t) => {
  const f = await fixture(t), agent = await f.join();
  for (const screen of ["ask", "view", "scroll", "off"])
    assert.equal((await f.call(`/api/guests/${agent.clientId}/access`, { method: "POST", body: { screen } })).status, 409);
  assert.equal(f.reach.auth.list().find((client) => client.id === agent.clientId).policy.screen, "apps");
  assert.equal((await agent.as("/api/browser/screen")).status, 403);
});

test("revocation and expiry invalidate app targets before capture releases native data", platform, async (t) => {
  let revoke;
  const f = await fixture(t, { capture: async () => revoke?.() });
  const agent = await f.join(), target = await f.window(agent);
  revoke = () => f.reach.auth.revoke(agent.clientId);
  const result = await agent.as(`/api/browser/apps/screen?target=${target.id}`);
  assert.ok([401, 403].includes(result.status), JSON.stringify(result)); assert.deepEqual(f.inputs, []);
  const expiring = await f.join(), old = await f.window(expiring);
  f.alter(expiring.clientId, (client) => { client.expiresAt = Date.now() - 1; });
  assert.ok([401, 403].includes((await expiring.as(`/api/browser/apps/screen?target=${old.id}`)).status));
});

test("permission changes during awaited app capture fail closed", platform, async (t) => {
  let change;
  const f = await fixture(t, { capture: async () => change?.() });
  const agent = await f.join(), target = await f.window(agent);
  change = () => f.alter(agent.clientId, (client) => { client.policy.appAccess = []; });
  const result = await agent.as(`/api/browser/apps/screen?target=${target.id}`);
  assert.equal(result.status, 401, JSON.stringify(result)); assert.deepEqual(f.inputs, []);
});

test("real tailnet app admission permits only the current invite or receipt capability", platform, async (t) => {
  const f = await fixture(t), created = await f.invite();
  assert.equal(created.status, 201);
  const asAgent = (route, body, node = "nAgent") => f.call(route, { node, token: "", method: "POST", body });
  assert.equal((await asAgent("/api/invitations/redeem", { invitation: "x".repeat(43) })).status, 403);
  const claimed = await asAgent("/api/invitations/redeem", { invitation: created.body.invitation });
  assert.equal(claimed.status, 202, JSON.stringify(claimed)); assert.equal(claimed.body.token, undefined);
  const poll = `/api/invitations/claims/${claimed.body.requestId}/status`;
  assert.equal((await asAgent(poll, { secret: "x".repeat(43) })).status, 403);
  assert.equal((await asAgent(poll, { secret: claimed.body.requestSecret }, "nOther")).status, 401);
  assert.equal((await asAgent(poll, { secret: claimed.body.requestSecret })).body.status, "pending");
  assert.equal((await f.call(`/api/agents/admissions/${claimed.body.requestId}`, { method: "POST", body: { decision: "approve" } })).status, 200);
  const collected = await asAgent(poll, { secret: claimed.body.requestSecret });
  assert.equal(collected.status, 200, JSON.stringify(collected)); assert.equal(collected.body.status, "approved");
  assert.equal((await f.call("/api/browser/apps", { node: "nAgent", token: collected.body.token })).status, 200);
  assert.equal((await asAgent("/api/invitations/redeem", { invitation: created.body.invitation })).status, 403);
  assert.equal((await asAgent("/api/auth/requests", { name: "Agent owner" })).status, 403);
});

test("app control cannot be granted through invitations, requests or input", platform, async (t) => {
  const f = await fixture(t), agent = await f.join(), target = await f.window(agent);
  assert.equal((await f.invite([{ id: textEdit, mode: "control" }])).status, 403);
  const request = await agent.as("/api/browser/apps/requests", { method: "POST", body: { appId: textEdit, mode: "control" } });
  assert.equal(request.status, 403);
  for (const action of [{ type: "click", x: .2, y: .2 }, { type: "key", key: "enter" }, { type: "text", text: "blocked" }])
    assert.equal((await agent.as("/api/browser/apps/input", { method: "POST", body: { target: target.id, action } })).status, 403);
  const list = await agent.as("/api/browser/apps");
  assert.equal(list.body.controlAvailable, false);
  assert.deepEqual(f.inputs, []);
});

test("changed app signature prevents an already displayed owner request from granting access", platform, async (t) => {
  const f = await fixture(t), agent = await f.join();
  const pending = await agent.as("/api/browser/apps/requests", { method: "POST", body: { appId: notes, mode: "view" } });
  assert.equal(pending.status, 201);
  f.applications.find((app) => app.id === notes).identity = "d".repeat(64);
  assert.equal((await f.call(`/api/agents/browser-requests/${pending.body.id}`, { method: "POST", body: { decision: "approve" } })).status, 409);
  assert.equal((await agent.as(`/api/browser/apps/windows?appId=${encodeURIComponent(notes)}`)).status, 403);
});

test("the held public route gives the internet nothing unless an invitation is live", platform, async (t) => {
  const served = [];
  const f = await fixture(t, { funnel: true, publicApp: (req, res) => { served.push(req.url); res.end("start page"); } });
  const internet = () => f.call("/", { token: "", headers: { "Tailscale-Funnel-Request": "?1" } });
  assert.deepEqual(await internet(), { status: 404, body: "Not found." });
  assert.deepEqual(served, []);
  const created = await f.invite(undefined, { body: { name: "Muse", ttlSeconds: 600, screen: "apps", appAccess: [{ id: textEdit, mode: "view" }], transport: "funnel" } });
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.deepEqual(await internet(), { status: 200, body: "start page" });
  assert.deepEqual(served, ["/"]);
  f.reach.auth.revoke(created.body.clientId);
  assert.deepEqual(await internet(), { status: 404, body: "Not found." });
  assert.deepEqual(served, ["/"]);
});

test("a Funnel invite whose public name Tailscale hasn't published still issues, and says so", platform, async (t) => {
  const asked = [];
  const f = await fixture(t, { funnel: true, publicName: async (host) => { asked.push(host); return "missing"; } });
  const created = await f.invite(undefined, { body: { name: "Muse", ttlSeconds: 600, screen: "apps", appAccess: [{ id: textEdit, mode: "view" }], transport: "funnel" } });
  assert.equal(created.status, 201, JSON.stringify(created));
  assert.equal(created.body.publicName, "missing");
  assert.deepEqual(asked, [new URL(ORIGIN).hostname]);
});

test("a published or unknown public name adds nothing to the invite", platform, async (t) => {
  for (const state of ["published", "unknown"]) {
    const f = await fixture(t, { funnel: true, publicName: async () => state });
    const created = await f.invite(undefined, { body: { name: "Muse", ttlSeconds: 600, screen: "apps", appAccess: [{ id: textEdit, mode: "view" }], transport: "funnel" } });
    assert.equal(created.status, 201, JSON.stringify(created));
    assert.equal("publicName" in created.body, false);
  }
});

test("signed Funnel app requests retain the validated inner API route through dispatch", platform, async (t) => {
  const f = await fixture(t, { funnel: true });
  const created = await f.invite(undefined, { body: { name: "Muse", ttlSeconds: 600, screen: "apps", appAccess: [{ id: textEdit, mode: "view" }], transport: "funnel" } });
  assert.equal(created.status, 201, JSON.stringify(created));
  const pair = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const publicKey = { ...pair.publicKey.export({ format: "jwk" }), ext: true, key_ops: ["verify"] };
  const gateway = (input) => {
    const payload = JSON.stringify({ v: 1, audience: ORIGIN, issuedAt: Date.now(), nonce: crypto.randomBytes(24).toString("base64url"), ...input });
    return f.call("/agent-gateway", { node: "nHost", token: "", method: "POST", headers: { Host: new URL(ORIGIN).host, Origin: ORIGIN, "Sec-Fetch-Site": "same-origin" },
      body: { payload, publicKey, signature: crypto.sign("sha256", Buffer.from(payload), { key: pair.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") } });
  };
  const claimed = await gateway({ operation: "claim", invitation: created.body.invitation });
  assert.equal(claimed.status, 202, JSON.stringify(claimed));
  assert.equal((await f.call(`/api/agents/admissions/${claimed.body.requestId}`, { method: "POST", body: { decision: "approve" } })).status, 200);
  const joined = await gateway({ operation: "status", requestId: claimed.body.requestId, secret: claimed.body.requestSecret });
  assert.equal(joined.status, 200, JSON.stringify(joined)); assert.equal(joined.body.status, "approved");
  const listed = await gateway({ operation: "request", token: joined.body.token, method: "GET", path: "/api/browser/apps", body: null });
  assert.equal(listed.status, 200, JSON.stringify(listed)); assert.equal(listed.body.apps.find((app) => app.id === textEdit).mode, "view");
  assert.equal((await gateway({ operation: "request", token: joined.body.token, method: "GET", path: "/api/clients", body: null })).status, 403);
});

test("owner app restriction invalidates queued capture and pending access requests", platform, async (t) => {
  let restrict;
  const f = await fixture(t, { capture: async () => restrict?.() });
  const agent = await f.join(), target = await f.window(agent);
  const requested = await agent.as("/api/browser/apps/requests", { method: "POST", body: { appId: textEdit, mode: "view" } });
  const route = `/api/agents/browser-app-access/${agent.clientId}`;
  assert.equal((await agent.as(route, { method: "POST", body: { appId: textEdit, mode: "hidden" } })).status, 403);
  assert.equal((await f.call(route, { method: "POST", body: { appId: notes, mode: "view" } })).status, 403);
  restrict = async () => {
    const response = await f.call(route, { method: "POST", body: { appId: textEdit, mode: "hidden" } });
    assert.equal(response.status, 200, JSON.stringify(response));
  };
  const acted = await agent.as(`/api/browser/apps/screen?target=${target.id}`);
  assert.ok([401, 403, 409].includes(acted.status), JSON.stringify(acted));
  assert.deepEqual(f.inputs, []);
  assert.deepEqual(f.captures, [], "an in-flight grant change must not expose a capture");
  assert.equal((await agent.as(`/api/browser/apps/screen?target=${target.id}`)).status, 409);
  assert.equal((await f.call(`/api/agents/browser-requests/${requested.body.id}`, { method: "POST", body: { decision: "approve" } })).status, 409);
});

test("hiding a base app grant remains effective after pause and resume", platform, async (t) => {
  const f = await fixture(t), agent = await f.join();
  const response = await f.call(`/api/agents/browser-app-access/${agent.clientId}`, { method: "POST", body: { appId: textEdit, mode: "hidden" } });
  assert.equal(response.status, 200, JSON.stringify(response));
  const persisted = f.reach.auth.list().find((client) => client.id === agent.clientId);
  assert.equal(persisted.policy.appAccess.some((app) => app.id === textEdit), false, "host restart must not restore the removed base grant");
  assert.equal((await agent.as("/api/browser/apps")).body.apps.find((app) => app.id === textEdit).mode, "hidden");
  f.reach.setPaused(true); f.reach.setPaused(false);
  const after = await agent.as("/api/browser/apps");
  assert.equal(after.status, 200, JSON.stringify(after));
  assert.equal(after.body.apps.find((app) => app.id === textEdit).mode, "hidden", "Resume must not restore access the owner removed");
  assert.equal((await agent.as(`/api/browser/apps/windows?appId=${encodeURIComponent(textEdit)}`)).status, 403);
});

test("long app captures keep the signed agent route exception during identity reauthorization", platform, async (t) => {
  const f = await fixture(t, { capture: async () => new Promise((resolve) => setTimeout(resolve, 2300)) });
  const agent = await f.join(), target = await f.window(agent);
  const captured = await agent.as(`/api/browser/apps/screen?target=${target.id}`);
  assert.equal(captured.status, 200, JSON.stringify(captured));
  assert.equal(captured.body, "only-this-app-jpeg");
});

test("HTTP image responses retain per-agent slots until completion and release them afterward", { ...platform, timeout: 15000 }, async (t) => {
  let entered = 0, announceReady, release;
  const ready = new Promise((resolve) => { announceReady = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const f = await fixture(t, { capture: async () => {
    entered++;
    if (entered <= 2) {
      if (entered === 2) announceReady();
      await gate;
    }
  } });
  const agent = await f.join(), target = await f.window(agent);
  const route = `/api/browser/apps/screen?target=${target.id}`;
  const first = agent.as(route), second = agent.as(route);
  try {
    await Promise.race([ready, Promise.all([first, second]).then((results) => {
      throw Error(`Image requests completed before both capture hooks entered: ${JSON.stringify(results)}`);
    })]);
    const third = await agent.as(route);
    assert.equal(third.status, 429, JSON.stringify(third));
    assert.equal(entered, 2, "a throttled response must not start native capture");
    assert.deepEqual(f.captures, [], "both authorized captures remain pending");
  } finally { release(); }
  for (const response of await Promise.all([first, second])) {
    assert.equal(response.status, 200, JSON.stringify(response));
    assert.equal(response.body, "only-this-app-jpeg");
  }
  assert.equal((await agent.as(route)).status, 200, "completed responses release their slots");
  assert.equal(entered, 3);
});

test("existing host owner sockets terminate when an app invitation activates the guard", platform, async (t) => {
  const f = await fixture(t);
  const ws = new WebSocket(`ws+unix:${f.socketPath}:/ws/presence`, {
    headers: { Host: "localhost", "X-Forwarded-For": addresses.nHost, "Tailscale-User-Login": ownerAccount.login },
  });
  ws.on("error", () => {}); t.after(() => ws.terminate());
  const ready = new Promise((resolve, reject) => {
    ws.once("error", reject);
    ws.once("open", () => ws.send(JSON.stringify({ type: "auth", token: f.owners.nHost.token })));
    ws.once("message", () => resolve());
  });
  await ready;
  let timer;
  const closed = Promise.race([
    new Promise((resolve) => ws.once("close", resolve)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Existing owner socket kept access")), 5000); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal((await f.invite()).status, 201);
  await closed;
});

test("overlapping owner grant changes cannot restore a concurrently hidden app", platform, async (t) => {
  const f = await fixture(t), agent = await f.join();
  // Both apps have remembered positive grants; TextEdit also has a base grant.
  // Hiding TextEdit changes the policy fingerprint while hiding Notes does not.
  for (const appId of [textEdit, notes]) {
    const pending = await agent.as("/api/browser/apps/requests", { method: "POST", body: { appId, mode: "view" } });
    assert.equal(pending.status, 201);
    assert.equal((await f.call(`/api/agents/browser-requests/${pending.body.id}`, { method: "POST", body: { decision: "approve" } })).status, 200);
  }
  let signalEntered, release;
  const entered = new Promise((resolve) => { signalEntered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  const original = f.reach.auth.restrictBrowserApp;
  f.reach.auth.restrictBrowserApp = async (...args) => {
    original(...args);
    if (args[1] === notes) { signalEntered(); await gate; }
  };
  const route = `/api/agents/browser-app-access/${agent.clientId}`;
  try {
    const first = f.call(route, { method: "POST", body: { appId: notes, mode: "hidden" } });
    await entered;
    const overlap = await f.call(route, { method: "POST", body: { appId: textEdit, mode: "hidden" } });
    assert.equal(overlap.status, 409, JSON.stringify(overlap));
    release(); assert.equal((await first).status, 200);
    f.reach.auth.restrictBrowserApp = original;
    assert.equal((await f.call(route, { method: "POST", body: { appId: textEdit, mode: "hidden" } })).status, 200);
    const listed = await agent.as("/api/browser/apps");
    for (const appId of [textEdit, notes]) assert.equal(listed.body.apps.find((app) => app.id === appId).mode, "hidden");
  } finally { release(); f.reach.auth.restrictBrowserApp = original; }
});
