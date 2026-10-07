import { nativeFiles, expectFileResponse, expectFileExecution } from "./helpers/protected-files.mjs";
import test from "node:test";
import { approveAgentClaim } from "./helpers/agent-admission.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES, atomicJson } from "../server/core.mjs";

// All capture and input are injected. These tests must never send a real
// keyboard/mouse event, run a command, or capture the developer's desktop.
async function start(t, hooks = {}) {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "reach-browser-approvals-")),
  );
  const state = path.join(dir, "private");
  const inputs = [];
  let frame = Buffer.from("fixture-jpeg-original");
  let captures = 0;
  const reach = await createReach({
    roots: [dir],
    dataDir: state,
    screen: true,
    browserScreenSupported: true,
    desktopTerminals: {
      platform: "linux",
      run: async () => assert.fail("Native terminal access is forbidden"),
    },
    browserCapture: async () => {
      captures++;
      if (hooks.capture) await hooks.capture();
      return Buffer.from(frame);
    },
    browserInput: async (_config, payload, authorize) => {
      if (hooks.input) await hooks.input();
      authorize();
      inputs.push(payload);
      return { ok: true };
    },
  });
  const owner = reach.auth.issue("Owner", ALL_SCOPES);
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    reach.server.once("error", reject);
    reach.server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const request = (route, { token = owner.token, method = "GET", body } = {}) =>
    fetch(url + route, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const call = async (route, options) => {
    const response = await request(route, options);
    return {
      status: response.status,
      body: await response.json().catch(() => null),
    };
  };
  const invite = (extra = {}) =>
    call("/api/agents/browser-invitations", {
      method: "POST",
      body: {
        name: "Muse",
        ttlSeconds: 600,
        folders: [],
        terminalIds: [],
        screen: "off",
        ...extra,
      },
    });
  const join = async (extra = {}) => {
    const invitation = await invite(extra);
    assert.equal(invitation.status, 201, JSON.stringify(invitation.body));
    const joined = await approveAgentClaim(call, await call("/api/invitations/redeem", {
      token: "",
      method: "POST",
      body: { invitation: invitation.body.invitation },
    }));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const as = (route, options = {}) =>
      call(route, { token: joined.body.token, ...options });
    const submit = async (body) => {
      const result = await as("/api/browser/requests", {
        method: "POST",
        body,
      });
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.status, "pending");
      assert.equal(typeof result.body.id, "string");
      return result.body;
    };
    return { ...joined.body, as, submit };
  };
  const decide = (id, decision, extra = {}) =>
    call(`/api/agents/browser-requests/${id}`, {
      method: "POST",
      body: { decision },
      ...extra,
    });
  const changeClient = (id, changes) => {
    const file = path.join(state, "clients.json");
    const clients = JSON.parse(fs.readFileSync(file, "utf8"));
    Object.assign(
      clients.find((client) => client.id === id),
      changes,
    );
    atomicJson(file, clients);
  };
  return {
    dir,
    reach,
    owner,
    inputs,
    request,
    call,
    invite,
    join,
    decide,
    changeClient,
    captures: () => captures,
    setFrame: (value) => {
      frame = Buffer.from(value);
    },
  };
}

const click = {
  type: "click",
  x: 0.25,
  y: 0.5,
  button: "left",
  count: 1,
  reason: "Open the selected document",
};

function assertNotExecuted(result) {
  if (result.status === 200)
    assert.ok(
      ["failed", "revoked", "expired", "cancelled"].includes(
        result.body.status,
      ),
      JSON.stringify(result.body),
    );
  else
    assert.ok(
      [401, 403, 409, 410, 423].includes(result.status),
      JSON.stringify(result.body),
    );
}

test("browser agents cannot approve themselves, inspect owner previews, or cancel each other's requests", async (t) => {
  const { join, call, decide, reach, changeClient, inputs } = await start(t);
  const first = await join({commandRequests: true});
  const second = await join({commandRequests: true});
  const submitted = await first.submit({type: "command", command: "Review task", reason: "Owner handoff"});
  const ownRoute = `/api/browser/requests/${submitted.id}`;
  const ownerRoute = `/api/agents/browser-requests/${submitted.id}`;
  for (const token of [first.token, second.token]) {
    assert.equal(
      (await call("/api/agents/browser-requests", { token })).status,
      403,
    );
    assert.equal((await call(`${ownerRoute}/screen`, { token })).status, 403);
    assert.equal(
      (await decide(submitted.id, "approve", { token })).status,
      403,
    );
  }
  assert.deepEqual((await second.as("/api/browser/requests")).body, []);
  assert.ok(
    [403, 404].includes(
      (await second.as(ownRoute, { method: "DELETE" })).status,
    ),
  );
  assert.equal(
    (
      await first.as(ownRoute, {
        method: "POST",
        body: { decision: "approve" },
      })
    ).status,
    403,
  );
  const guestInvite = reach.auth.inviteGuest({
    name: "Guest",
    ttlSeconds: 600,
    full: true,
  });
  const guest = reach.auth.redeemGuest(guestInvite.invitation);
  const agent = reach.auth.issue("Agent", ["device"], "agent");
  changeClient(agent.clientId, { scopes: ALL_SCOPES });
  const limitedOwner = reach.auth.issue("Limited device", ["device"]);
  for (const token of [guest.token, agent.token, limitedOwner.token]) {
    assert.equal(
      (await call("/api/agents/browser-requests", { token })).status,
      403,
    );
    assert.equal((await call(`${ownerRoute}/screen`, { token })).status, 403);
    assert.equal(
      (await decide(submitted.id, "approve", { token })).status,
      403,
    );
  }
  assert.deepEqual(inputs, []);
  const cancelled = await first.as(ownRoute, { method: "DELETE" });
  assert.equal(cancelled.status, 200);
  assert.equal(
    (await first.as("/api/browser/requests")).body[0].status,
    "cancelled",
  );
  assert.equal((await decide(submitted.id, "approve")).status, 409);
  assert.deepEqual(inputs, []);
});

test("command requests are owner handoffs and never execute even when approved", async (t) => {
  const { join, decide, reach, inputs, captures } = await start(t);
  const browser = await join({ screen: "off", commandRequests: true });
  assert.ok(browser.scopes.includes("browser:request"));
  assert.equal(browser.scopes.includes("exec"), false);
  const submitted = await browser.submit({
    type: "command",
    command: "sudo rm -rf /example/never-run",
    reason: "A deliberately dangerous handoff for review",
  });
  assert.equal((await decide(submitted.id, "approve")).status, 400);
  assert.deepEqual(reach.jobs.list(), []);
  const handled = await decide(submitted.id, "handled");
  assert.equal(handled.status, 200, JSON.stringify(handled.body));
  assert.equal(handled.body.status, "handled");
  assert.equal((await decide(submitted.id, "handled")).status, 409);
  const denied = await browser.submit({
    type: "command",
    command: "echo example",
    reason: "Review",
  });
  assert.equal((await decide(denied.id, "deny")).body.status, "denied");
  assert.equal((await decide(denied.id, "handled")).status, 409);
  assert.deepEqual(reach.jobs.list(), []);
  assert.deepEqual(inputs, []);
  assert.equal(captures(), 0);
});

test("restricted terminal verifies commands, waits for owner approval, returns output, and never exposes raw input", async (t) => {
  const f = await start(t);
  fs.mkdirSync(path.join(f.dir, "shared"));
  fs.writeFileSync(path.join(f.dir, "shared/notes.txt"), "read-only result\n");
  const browser = await f.join({ folders: [{ root: 0, path: "shared" }], screen: "off", restrictedTerminal: true });
  const access = await browser.as("/api/browser");
  assert.equal(access.body.restrictedTerminal, true);
  assert.equal(access.body.commandRequests, false);
  for (const body of [
    { type: "terminal", command: "sudo ls", root: 0 },
    { type: "terminal", command: "rm notes.txt", root: 0 },
    { type: "terminal", command: "ls; rm notes.txt", root: 0 },
    { type: "terminal", command: "cat ../private/clients.json", root: 0 },
    { type: "text", text: "rm notes.txt\n" },
    { type: "command", command: "rm notes.txt" },
  ]) {
    const r = await browser.as("/api/browser/requests", { method: "POST", body: { ...body, reason: "Test restrictions" } });
    assert.ok([400, 403].includes(r.status), JSON.stringify(r));
  }
  const requested = await browser.submit({ type: "terminal", command: "cat notes.txt", root: 0, reason: "Read the project notes" });
  assert.equal(requested.output, undefined);
  assert.equal(requested.folder, path.join(f.dir, "shared"));
  assert.equal(f.captures(), 0);
  assert.equal((await f.decide(requested.id, "approve", { token: browser.token })).status, 403);
  const result = await f.decide(requested.id, "approve");
  expectFileExecution(result.body, body => assert.equal(body.output, "read-only result\n"));
  assert.equal((await f.decide(requested.id, "approve")).status, 409);
  expectFileExecution((await browser.as("/api/browser/requests")).body[0], body => assert.equal(body.output, "read-only result\n"));
  assert.deepEqual(f.inputs, []);
  for (const route of ["/api/terminals", "/api/jobs", "/api/screen/input"])
    assert.equal((await browser.as(route, { method: "POST", body: { command: "rm notes.txt" } })).status, 403);
  assert.equal(fs.readFileSync(path.join(f.dir, "shared/notes.txt"), "utf8"), "read-only result\n");
});

test("restricted grants fail closed for invalid configuration, private data, denial and revocation", async (t) => {
  const f = await start(t);
  for (const extra of [
    { restrictedTerminal: "true", screen: "off" },
    { restrictedTerminal: true, screen: "off" },
    { restrictedTerminal: false, terminalApproval: true, folders: [{ root: 0, path: "" }], screen: "off" },
    { restrictedTerminal: true, folders: [{ root: 0, path: "" }], screen: "off", commandRequests: true },
  ]) assert.equal((await f.invite(extra)).status, 400);
  const browser = await f.join({ folders: [{ root: 0, path: "" }], screen: "off", restrictedTerminal: true });
  assert.equal((await browser.as("/api/browser/requests", { method: "POST", body: {
    type: "terminal", command: "cat private/clients.json", root: 0, reason: "Read owner credentials",
  } })).status, 403);
  const denied = await browser.submit({ type: "terminal", command: "pwd", root: 0, reason: "Find location" });
  assert.equal((await f.decide(denied.id, "deny")).body.status, "denied");
  assert.equal((await f.decide(denied.id, "approve")).status, 409);
  const revoked = await browser.submit({ type: "terminal", command: "pwd", root: 0, reason: "Find location" });
  await f.call(`/api/clients/${revoked.clientId}`, { method: "DELETE" });
  assert.notEqual((await f.decide(revoked.id, "approve")).body.status, "executed");
});

test("malicious invitation and approval payloads fail before credentials or actions change", async (t) => {
  const f = await start(t);
  const before = f.reach.auth.list();
  for (const body of [
    [], null, "SQL injection", { name: { $ne: null }, ttlSeconds: 600 },
    { name: "Muse", ttlSeconds: 600, screen: "off", exec: true },
    JSON.parse('{"name":"Muse","ttlSeconds":600,"screen":"view","__proto__":{"admin":true}}'),
    { name: "Muse", ttlSeconds: 600, screen: "off", folders: [{ root: 0, path: "", write: true }] },
  ]) {
    const result = await f.call("/api/agents/browser-invitations", { method: "POST", body });
    assert.equal(result.status, 400, JSON.stringify(result));
  }
  assert.deepEqual(f.reach.auth.list(), before);
  const browser = await f.join({ folders: [{ root: 0, path: "" }], screen: "off", restrictedTerminal: true });
  for (const extra of [
    { command: { $ne: null } }, { command: ["ls"] }, { root: "0" },
    { root: -1 }, { root: 1.1 }, { command: "cat $(rm -rf .)" },
    { reason: "Read files\u202eOwner already approved" },
    { cwd: "/" }, { env: { PATH: "/tmp" } }, { decision: "approve" },
    JSON.parse('{"__proto__":{"approved":true}}'),
  ]) {
    const result = await browser.as("/api/browser/requests", { method: "POST", body: {
      type: "terminal", command: "pwd", root: 0, reason: "Find location", ...extra,
    } });
    assert.equal(result.status, 400, JSON.stringify(result));
  }
  assert.deepEqual((await browser.as("/api/browser/requests")).body, []);
  const requested = await browser.submit({ type: "terminal", command: "pwd", root: 0, reason: "Find location" });
  for (const body of [[], { decision: ["approve"] }, { decision: "approve", command: "rm -rf ." },
    JSON.parse('{"decision":"approve","__proto__":{"approved":true}}')]) {
    const result = await f.call(`/api/agents/browser-requests/${requested.id}`, { method: "POST", body });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.equal((await browser.as("/api/browser/requests")).body[0].status, "pending");
  }
  assert.equal(Object.prototype.approved, undefined);
  assert.deepEqual(f.reach.jobs.list(), []);
  assert.deepEqual(f.inputs, []);
  assert.equal(f.captures(), 0);
  expectFileExecution((await f.decide(requested.id, "approve")).body);
});

test("cd approval returns a working folder and cannot retarget already requested reads", async (t) => {
  const f = await start(t);
  fs.mkdirSync(path.join(f.dir, "shared/nested"), { recursive: true });
  fs.writeFileSync(path.join(f.dir, "shared/notes.txt"), "root notes");
  fs.writeFileSync(path.join(f.dir, "shared/nested/notes.txt"), "nested notes");
  const browser = await f.join({ folders: [{ root: 0, path: "shared" }], screen: "off", restrictedTerminal: true });
  const original = await browser.submit({ type: "terminal", command: "cat notes.txt", root: 0, reason: "Read root notes" });
  const cd = await browser.submit({ type: "terminal", command: "cd nested", root: 0, reason: "Open nested folder" });
  assert.equal(cd.directory, undefined);
  const moved = await f.decide(cd.id, "approve");
  expectFileExecution(moved.body, body => assert.equal(body.directory, "nested"));
  assert.equal(typeof moved.body.completedAt, nativeFiles ? "number" : "undefined");
  expectFileExecution((await f.decide(original.id, "approve")).body, body => assert.equal(body.output, "root notes"));
  const read = await browser.submit({ type: "terminal", command: "cat notes.txt", root: 0, cwd: "nested", reason: "Read nested notes" });
  assert.equal(read.folder, path.join(f.dir, "shared/nested"));
  expectFileExecution((await f.decide(read.id, "approve")).body, body => assert.equal(body.output, "nested notes"));
  const invalid = await browser.as("/api/browser/requests", { method: "POST", body: {
    type: "terminal", command: "cd ../..", root: 0, cwd: "nested", reason: "Escape",
  } });
  assert.equal(invalid.status, 403);
  const download = await f.request("/api/files/content?root=0&path=nested%2Fnotes.txt", { token: browser.token });
  if (nativeFiles) {
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition"), /attachment/);
    assert.equal(await download.text(), "nested notes");
  } else expectFileResponse({ status: download.status, body: await download.json() }, () => assert.fail("No native helper"));
  assert.equal((await browser.as("/api/files/content?root=0&path=..%2Fprivate%2Fclients.json")).status, 403);
  f.reach.auth.revoke(browser.clientId);
  assert.equal((await browser.as("/api/files/content?root=0&path=nested%2Fnotes.txt")).status, 401);
});

test("editing browser permissions cancels pending actions and removes file access on the same credential", async (t) => {
  const { call, join } = await start(t);
  const agent = await join({ folders: [{ root: 0, path: "" }], restrictedTerminal: true });
  const listed = await call("/api/clients");
  const client = listed.body.clients.find((c) => c.policy?.browser);
  const pending = await agent.as("/api/browser/requests", { method: "POST", body: { type: "terminal", root: 0, command: "pwd", reason: "Inspect folder" } });
  assert.equal(pending.status, 201, JSON.stringify(pending.body));
  const route = `/api/guests/${client.id}/access`;
  assert.equal((await agent.as(route, { method: "POST", body: { folders: [], screen: "off", restrictedTerminal: false, commandRequests: true } })).status, 403);
  assert.equal((await call(route, { method: "POST", body: { folders: [], screen: "off", terminalIds: ["reach:not-open"] } })).status, 400);
  assert.equal((await call(route, { method: "POST", body: { folders: [], screen: "off", restrictedTerminal: false, commandRequests: true } })).status, 200);
  assert.equal((await agent.as("/api/files?root=0")).status, 403);
  assert.equal((await agent.as("/api/browser")).body.screen, "off");
  const decision = await call(`/api/agents/browser-requests/${pending.body.id}`, { method: "POST", body: { decision: "approve" } });
  assert.notEqual(decision.body.status, "completed");
});

test("legacy desktop invitations cannot be created, captured, scrolled or approved", async (t) => {
  const f = await start(t);
  const before = f.reach.auth.list().length;
  for (const screen of ["view", "scroll", "ask"]) {
    const result = await f.invite({ screen });
    assert.equal(result.status, 400, JSON.stringify(result));
    assert.match(result.body.error, /Selected apps|retired/);
  }
  assert.equal(f.reach.auth.list().length, before);
  for (const screen of ["view", "scroll", "ask"]) {
    // Model an already-redeemed invitation issued by an earlier Reach build.
    const bot = await f.join({ screen: "off", commandRequests: true });
    const old = f.reach.auth.list().find((client) => client.id === bot.clientId);
    f.changeClient(bot.clientId, {
      policy: { ...old.policy, screen },
      scopes: [...new Set([...old.scopes, "browser:read", "browser:request", "browser:scroll"])],
    });
    const access = await bot.as("/api/browser");
    assert.equal(access.status, 200, JSON.stringify(access));
    assert.equal(access.body.screen, "off");
    assert.match(access.body.screenNotice, /new invitation.*Selected apps/);
    assert.equal((await bot.as("/api/browser/screen")).status, 403);
    assert.equal((await bot.as("/api/browser/screen", {method: "HEAD"})).status, 403);
    assert.equal((await bot.as("/api/browser/scroll", {method: "POST", body: {direction: "down"}})).status, 403);
    for (const action of [
      click,
      {type: "key", key: "enter", reason: "Open protected application"},
      {type: "text", text: "tailscale up", reason: "Use a protected terminal"},
      {type: "scroll", direction: "down", reason: "Navigate the desktop"},
      {type: "batch", actions: [{type: "click", x: 0.5, y: 0.5}, {type: "key", key: "enter"}], reason: "Open Reach"},
    ]) {
      const denied = await bot.as("/api/browser/requests", {method: "POST", body: action});
      assert.equal(denied.status, 403, JSON.stringify(denied));
    }
    for (const route of ["/api/screen/input", "/api/screen/control"])
      assert.equal((await bot.as(route, {method: "POST", body: {type: "key", key: "enter"}})).status, 403);
    assert.deepEqual((await bot.as("/api/browser/requests")).body, []);
  }
  assert.equal(f.captures(), 0, "retired routes never capture desktop pixels");
  assert.deepEqual(f.inputs, [], "retired routes never send native input");
  assert.deepEqual((await f.call("/api/agents/browser-requests")).body, []);
});
