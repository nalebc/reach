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
        screen: "ask",
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

test("ask invitations grant requests and snapshots without direct control or commands", async (t) => {
  const { join, call, request, inputs } = await start(t);
  const browser = await join({ commandRequests: true });
  assert.ok(browser.scopes.includes("browser:request"));
  for (const scope of [
    "admin",
    "exec",
    "terminal",
    "screen",
    "screen:control",
    "files:write",
    "browser:scroll",
  ])
    assert.equal(browser.scopes.includes(scope), false, scope);
  const info = await browser.as("/api/browser");
  assert.equal(info.body.screen, "ask");
  assert.equal(info.body.commandRequests, true);
  const image = await request("/api/browser/screen", { token: browser.token });
  assert.equal(image.status, 200);
  assert.equal(await image.text(), "fixture-jpeg-original");
  for (const [route, body] of [
    ["/api/browser/scroll", { direction: "down" }],
    ["/api/screen/input", { type: "key", key: "enter" }],
    ["/api/screen/control", { enabled: true }],
    ["/api/jobs", { command: "echo forbidden", root: 0 }],
    ["/api/terminals", { root: 0 }],
  ])
    assert.equal(
      (await browser.as(route, { method: "POST", body })).status,
      403,
      route,
    );
  assert.equal((await browser.as("/api/screen")).status, 403);
  assert.equal((await call("/api/agents/browser-requests")).status, 200);
  assert.deepEqual(inputs, []);
});

test("one owner approval executes the immutable requested screen action once", async (t) => {
  const { join, call, request, decide, inputs } = await start(t);
  const browser = await join();
  const submitted = await browser.submit(click);
  assert.deepEqual(inputs, []);
  const pending = await call("/api/agents/browser-requests");
  assert.equal(pending.status, 200);
  assert.equal(pending.body.length, 1);
  assert.equal(pending.body[0].id, submitted.id);
  const image = await request(
    `/api/agents/browser-requests/${submitted.id}/screen`,
  );
  assert.equal(image.status, 200);
  assert.match(image.headers.get("content-type"), /^image\/jpeg/);
  assert.match(image.headers.get("cache-control"), /no-store/);
  assert.equal(await image.text(), "fixture-jpeg-original");
  assert.equal(
    (
      await decide(submitted.id, "approve", {
        body: {
          decision: "approve",
          action: { type: "text", text: "Replacement" },
        },
      })
    ).status,
    400,
  );
  assert.equal((await decide(submitted.id, "handled")).status, 400);
  assert.deepEqual(inputs, []);
  const decisions = await Promise.all([
    decide(submitted.id, "approve"),
    decide(submitted.id, "approve"),
  ]);
  assert.deepEqual(decisions.map((result) => result.status).sort(), [200, 409]);
  assert.deepEqual(inputs, [
    { type: "click", x: 0.25, y: 0.5, button: "left", count: 1 },
  ]);
  assert.equal(
    decisions.find((result) => result.status === 200).body.status,
    "executed",
  );
  assert.equal((await decide(submitted.id, "approve")).status, 409);
  const own = await browser.as("/api/browser/requests");
  assert.equal(own.status, 200);
  assert.equal(
    own.body.find((item) => item.id === submitted.id).status,
    "executed",
  );
  assert.deepEqual((await call("/api/agents/browser-requests")).body, []);
  assert.equal(
    (await request(`/api/agents/browser-requests/${submitted.id}/screen`))
      .status,
    404,
  );
});

test("changed screenshot fails approval without sending screen input", async (t) => {
  const { join, decide, inputs, setFrame } = await start(t);
  const browser = await join();
  const submitted = await browser.submit(click);
  setFrame("fixture-jpeg-another-window");
  const result = await decide(submitted.id, "approve");
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.status, "failed");
  assert.deepEqual(inputs, []);
  assert.equal(
    (await browser.as("/api/browser/requests")).body[0].status,
    "failed",
  );
  setFrame("fixture-jpeg-original");
  assert.equal((await decide(submitted.id, "approve")).status, 409);
  assert.deepEqual(inputs, []);
});

test("text, keys, and scrolls each require their own owner approval", async (t) => {
  const { join, decide, inputs } = await start(t);
  const browser = await join();
  const actions = [
    { type: "text", text: "Example document title" },
    { type: "key", key: "tab" },
    { type: "scroll", direction: "down", amount: 2 },
  ];
  for (const [index, action] of actions.entries()) {
    const submitted = await browser.submit({
      ...action,
      reason: "Review this exact action",
    });
    assert.equal(inputs.length, index);
    assert.equal((await decide(submitted.id, "approve")).status, 200);
    assert.deepEqual(
      inputs[index],
      action.type === "scroll" ? { type: "scroll", delta: -2 } : action,
    );
  }
  assert.deepEqual(inputs, [
    actions[0],
    actions[1],
    { type: "scroll", delta: -2 },
  ]);
});

test("browser agents cannot approve themselves, inspect owner previews, or cancel each other's requests", async (t) => {
  const { join, call, decide, reach, changeClient, inputs } = await start(t);
  const first = await join();
  const second = await join();
  const submitted = await first.submit(click);
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

test("request types require explicit grants and reject unreviewable or invalid payloads", async (t) => {
  const { join, invite, inputs, captures } = await start(t);
  for (const commandRequests of ["true", 1, null, {}, []])
    assert.equal((await invite({ commandRequests })).status, 400);
  const screen = await join();
  const commands = await join({ screen: "off", commandRequests: true });
  const view = await join({ screen: "view" });
  const submit = (browser, body) =>
    browser.as("/api/browser/requests", { method: "POST", body });
  assert.equal((await submit(view, click)).status, 403);
  assert.equal((await submit(commands, click)).status, 403);
  assert.equal(
    (
      await submit(screen, {
        type: "command",
        command: "sudo example",
        reason: "Review",
      })
    ).status,
    403,
  );
  for (const body of [
    {},
    { ...click, type: ["click"] },
    { type: ["text"], text: {}, reason: "Review" },
    { ...click, type: "launch" },
    { ...click, x: -1 },
    { ...click, y: 1.01 },
    { ...click, x: "0.5" },
    { ...click, button: "middle" },
    { ...click, count: 3 },
    { ...click, command: "sudo example" },
    { ...click, reason: "" },
    { ...click, reason: [] },
    { type: "text", text: 123, reason: "Review" },
    { type: "text", text: "a".repeat(2001), reason: "Review" },
    { type: "key", key: "unknown", reason: "Review" },
    { type: "scroll", delta: 0, reason: "Review" },
    { type: "scroll", delta: 11, reason: "Review" },
    { type: "scroll", delta: 1.5, reason: "Review" },
    { type: "scroll", direction: "left", reason: "Review" },
    { type: "scroll", direction: "down", amount: 0, reason: "Review" },
    { type: "scroll", direction: "down", amount: 6, reason: "Review" },
    { type: "scroll", direction: "down", amount: "2", reason: "Review" },
  ])
    assert.equal(
      (await submit(screen, body)).status,
      400,
      JSON.stringify(body),
    );
  for (const body of [
    { type: "command", command: "", reason: "Review" },
    { type: "command", command: 123, reason: "Review" },
    { type: "command", command: "echo example", cwd: "/", reason: "Review" },
  ])
    assert.equal(
      (await submit(commands, body)).status,
      400,
      JSON.stringify(body),
    );
  assert.deepEqual(inputs, []);
  assert.equal(captures(), 0);
});

test("denial and screen expiry never execute, and command handoffs have a bounded lifetime", async (t) => {
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => realNow() + offset);
  const { join, decide, inputs } = await start(t);
  const browser = await join({ commandRequests: true });
  const denied = await browser.submit(click);
  assert.equal((await decide(denied.id, "deny")).body.status, "denied");
  assert.equal((await decide(denied.id, "approve")).status, 409);
  const screen = await browser.submit(click);
  const command = await browser.submit({
    type: "command",
    command: "sudo example",
    reason: "Review",
  });
  assert.ok(
    screen.expiresAt > Date.now() && screen.expiresAt <= Date.now() + 60_000,
  );
  assert.ok(
    command.expiresAt > Date.now() + 60_000 &&
      command.expiresAt <= Date.now() + 300_000,
  );
  offset = 61_000;
  assert.ok([409, 410].includes((await decide(screen.id, "approve")).status));
  assert.equal(
    (await browser.as("/api/browser/requests")).body.find(
      (item) => item.id === screen.id,
    ).status,
    "expired",
  );
  offset = 301_000;
  assert.ok([409, 410].includes((await decide(command.id, "handled")).status));
  assert.equal(
    (await browser.as("/api/browser/requests")).body.find(
      (item) => item.id === command.id,
    ).status,
    "expired",
  );
  assert.deepEqual(inputs, []);
});

test("revocation and expired credentials invalidate pending approvals before execution", async (t) => {
  const { join, decide, call, changeClient, inputs } = await start(t);
  const revoked = await join();
  const revokedRequest = await revoked.submit(click);
  assert.equal(
    (await call(`/api/clients/${revoked.clientId}`, { method: "DELETE" }))
      .status,
    200,
  );
  assert.ok(
    [401, 403, 409, 410].includes(
      (await decide(revokedRequest.id, "approve")).status,
    ),
  );
  assert.equal((await revoked.as("/api/browser/requests")).status, 401);
  const expired = await join();
  const expiredRequest = await expired.submit(click);
  changeClient(expired.clientId, { expiresAt: Date.now() - 1 });
  assert.ok(
    [401, 403, 409, 410].includes(
      (await decide(expiredRequest.id, "approve")).status,
    ),
  );
  assert.deepEqual(inputs, []);
});

test("revocation while approval is capturing blocks the action at the final authorization check", async (t) => {
  let duringCapture;
  const { join, decide, reach, inputs } = await start(t, {
    capture: async () => {
      if (duringCapture) await duringCapture();
    },
  });
  const browser = await join();
  const submitted = await browser.submit(click);
  duringCapture = async () => {
    reach.auth.revoke(browser.clientId);
  };
  const result = await decide(submitted.id, "approve");
  assertNotExecuted(result);
  assert.deepEqual(inputs, []);
});

test("changing the requester's grant invalidates an already pending action", async (t) => {
  const { join, decide, reach, changeClient, inputs } = await start(t);
  const browser = await join();
  const submitted = await browser.submit(click);
  const previous = reach.auth.verify(browser.token);
  changeClient(browser.clientId, {
    policy: { ...previous.policy, screen: "view" },
  });
  assertNotExecuted(await decide(submitted.id, "approve"));
  assert.deepEqual(inputs, []);
});

test("owner revocation while approving and agent revocation at native input both fail closed", async (t) => {
  let duringCapture;
  let duringInput;
  const { join, decide, reach, owner, inputs } = await start(t, {
    capture: async () => {
      if (duringCapture) await duringCapture();
    },
    input: async () => {
      if (duringInput) await duringInput();
    },
  });
  const browser = await join();
  const ownerRequest = await browser.submit(click);
  duringCapture = async () => {
    reach.auth.revoke(owner.clientId);
  };
  assertNotExecuted(await decide(ownerRequest.id, "approve"));
  duringCapture = undefined;
  const nextOwner = reach.auth.issue("Another owner device", ALL_SCOPES);
  const inputRequest = await browser.submit(click);
  duringInput = async () => {
    reach.auth.revoke(browser.clientId);
  };
  assertNotExecuted(
    await decide(inputRequest.id, "approve", { token: nextOwner.token }),
  );
  assert.deepEqual(inputs, []);
});

test("native input delayed beyond the screenshot freshness deadline is refused without retry", async (t) => {
  const realNow = Date.now;
  let offset = 0;
  t.mock.method(Date, "now", () => realNow() + offset);
  const { join, decide, inputs } = await start(t, {
    input: async () => {
      offset = 1500;
    },
  });
  const browser = await join();
  const submitted = await browser.submit(click);
  const result = await decide(submitted.id, "approve");
  assertNotExecuted(result);
  assert.equal(result.body.status, "failed");
  assert.equal((await decide(submitted.id, "approve")).status, 409);
  assert.deepEqual(inputs, []);
});

test("pausing, disabling screen access, and an active control holder block approved screen actions", async (t) => {
  const { join, decide, call, reach, inputs } = await start(t);
  const browser = await join();
  const paused = await browser.submit(click);
  await reach.setPaused(true);
  assertNotExecuted(await decide(paused.id, "approve"));
  await reach.setPaused(false);
  const controlled = await browser.submit(click);
  assert.equal(
    (
      await call("/api/screen/control", {
        method: "POST",
        body: { enabled: true },
      })
    ).status,
    200,
  );
  assertNotExecuted(await decide(controlled.id, "approve"));
  await call("/api/screen/control", {
    method: "POST",
    body: { enabled: false },
  });
  const disabled = await browser.submit(click);
  await call("/api/settings", { method: "POST", body: { screen: false } });
  assertNotExecuted(await decide(disabled.id, "approve"));
  assert.deepEqual(inputs, []);
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
  assert.equal(result.body.status, "executed", JSON.stringify(result));
  assert.equal(result.body.output, "read-only result\n");
  assert.equal((await f.decide(requested.id, "approve")).status, 409);
  assert.equal((await browser.as("/api/browser/requests")).body[0].output, "read-only result\n");
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
    { restrictedTerminal: false, terminalApproval: true, folders: [{ root: 0, path: "" }], screen: "ask" },
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
    { name: "Muse", ttlSeconds: 600, screen: "view", exec: true },
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
  assert.equal((await f.decide(requested.id, "approve")).body.status, "executed");
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
  assert.equal(moved.body.directory, "nested");
  assert.equal(typeof moved.body.completedAt, "number");
  assert.equal((await f.decide(original.id, "approve")).body.output, "root notes");
  const read = await browser.submit({ type: "terminal", command: "cat notes.txt", root: 0, cwd: "nested", reason: "Read nested notes" });
  assert.equal(read.folder, path.join(f.dir, "shared/nested"));
  assert.equal((await f.decide(read.id, "approve")).body.output, "nested notes");
  const invalid = await browser.as("/api/browser/requests", { method: "POST", body: {
    type: "terminal", command: "cd ../..", root: 0, cwd: "nested", reason: "Escape",
  } });
  assert.equal(invalid.status, 403);
  const download = await f.request("/api/files/content?root=0&path=nested%2Fnotes.txt", { token: browser.token });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /attachment/);
  assert.equal(await download.text(), "nested notes");
  assert.equal((await browser.as("/api/files/content?root=0&path=..%2Fprivate%2Fclients.json")).status, 403);
  f.reach.auth.revoke(browser.clientId);
  assert.equal((await browser.as("/api/files/content?root=0&path=nested%2Fnotes.txt")).status, 401);
});

test("blanket control is unavailable and approving one action never authorizes the next", async (t) => {
  const f = await start(t);
  const browser = await f.join();
  const first = await browser.submit({ type: "click", x: 0.2, y: 0.4, reason: "Open a selected item" });
  for (const body of [
    { decision: "allow-control" },
    { decision: "allow-control", acknowledgeRisk: true },
    { decision: "approve", acknowledgeRisk: true },
  ]) {
    const rejected = await f.call(`/api/agents/browser-requests/${first.id}`, { method: "POST", body });
    assert.equal(rejected.status, 400, JSON.stringify(rejected));
  }
  assert.deepEqual(f.inputs, []);
  assert.equal((await browser.as("/api/browser")).body.controlUntil, undefined);
  assert.equal((await f.decide(first.id, "approve")).body.status, "executed");
  assert.equal(f.inputs.length, 1);
  const next = await browser.submit({ type: "key", key: "enter", reason: "Continue after review" });
  assert.equal(next.status, "pending");
  assert.equal(f.inputs.length, 1, "the next input still waits for an exact owner approval");
});

test("editing browser permissions cancels pending actions and removes file access on the same credential", async (t) => {
  const { call, join } = await start(t);
  const agent = await join({ folders: [{ root: 0, path: "" }] });
  const listed = await call("/api/clients");
  const client = listed.body.clients.find((c) => c.policy?.browser);
  const pending = await agent.as("/api/browser/requests", { method: "POST", body: { type: "click", x: 0.2, y: 0.4, reason: "Click" } });
  assert.equal(pending.status, 201, JSON.stringify(pending.body));
  const route = `/api/guests/${client.id}/access`;
  assert.equal((await agent.as(route, { method: "POST", body: { folders: [], screen: "view" } })).status, 403);
  assert.equal((await call(route, { method: "POST", body: { folders: [], screen: "view", terminalIds: ["reach:not-open"] } })).status, 400);
  assert.equal((await call(route, { method: "POST", body: { folders: [], screen: "view" } })).status, 200);
  assert.equal((await agent.as("/api/files?root=0")).status, 403);
  assert.equal((await agent.as("/api/browser")).body.screen, "view");
  const decision = await call(`/api/agents/browser-requests/${pending.body.id}`, { method: "POST", body: { decision: "approve" } });
  assert.notEqual(decision.body.status, "completed");
});
