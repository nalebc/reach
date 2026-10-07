import test from "node:test";
import { admitAgent } from "./helpers/agent-admission.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createBrowserApprovals } from "../server/browser-approvals.mjs";
import { createAuth, ALL_SCOPES } from "../server/core.mjs";
import { applyAgentPolicy } from "../server/agent-policy.mjs";

function fixture(options = {}) {
  let time = 1000;
  const client = {
    id: "muse", kind: "agent", name: "Muse", expiresAt: 900000,
    scopes: ["browser:read", "browser:request"],
    agentRoots: ["/shared"],
    policy: { browser: true, screen: "off", restrictedTerminal: true, commandRequests: true },
  };
  const owner = { id: "phone", kind: "device", scopes: ["admin"] };
  const clients = new Map([[client.id, client]]);
  const calls = [], pushes = [], events = [];
  const queue = createBrowserApprovals({
    verifyClient: (id) => clients.get(id),
    execute: async (action, authorize, request) => {
      authorize();
      calls.push({ action, request });
    },
    notify: (message) => pushes.push(message),
    record: (...event) => events.push(event),
    now: () => time,
    ...options,
  });
  const requestCommand = () => queue.request(client, {
    type: "terminal", root: 0, command: "pwd", reason: "Inspect the shared folder",
  });
  const decide = (request, decision = "approve") =>
    queue.decide(owner, request.id, decision, () => owner);
  return { queue, client, clients, owner, calls, pushes, events, requestCommand, decide, advance: (ms) => { time += ms; } };
}

test("terminal approval binds exact immutable action and executes once", async () => {
  const f = fixture();
  const input = { type: "terminal", root: 0, command: "cat notes.txt", reason: "Read these notes" };
  const request = f.queue.request(f.client, input);
  assert.equal(request.expiresAt, 301000);
  input.command = "replacement";
  request.action.command = "replacement via response";
  f.queue.listOwner()[0].action.command = "replacement via list";
  const result = await f.decide(request);
  assert.equal(result.status, "executed");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].action, { type: "terminal", root: 0, command: "cat notes.txt" });
  assert.ok(Object.isFrozen(f.calls[0].action));
  assert.equal(f.calls[0].request.id, request.id);
  await assert.rejects(f.decide(request), { status: 409 });
  assert.equal(f.calls.length, 1);
  assert.equal(Object.hasOwn(result, "grant"), false);
});

test("simultaneous owner approvals claim an action before awaiting native work", async () => {
  let release;
  let executions = 0;
  const f = fixture({ execute: async (_, authorize) => {
    authorize();
    executions++;
    await new Promise((resolve) => { release = resolve; });
  } });
  const request = f.requestCommand();
  const first = f.decide(request);
  await assert.rejects(f.decide(request), { status: 409 });
  release();
  assert.equal((await first).status, "executed");
  assert.equal(executions, 1);
});

test("all command requests including sudo are manual handoffs and never execute", async () => {
  const f = fixture();
  f.client.policy.restrictedTerminal = false;
  for (const command of ["sudo rm -rf /example", "echo safe", "python -c 'print(1)'"]) {
    const request = f.queue.request(f.client, { type: "command", command, reason: "Please inspect and handle this" });
    assert.equal(request.expiresAt, 301000);
    await assert.rejects(f.decide(request), { status: 400 });
    assert.equal(f.queue.getOwner(request.id).status, "pending");
    assert.equal((await f.decide(request, "handled")).status, "handled");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(JSON.stringify([...f.pushes, ...f.events]).includes("sudo"), false);
});

test("browser, guest, and non-admin credentials cannot approve or mark handled", async () => {
  const f = fixture();
  const request = f.requestCommand();
  for (const client of [f.client, { ...f.owner, kind: "guest" }, { ...f.owner, scopes: [] }])
    await assert.rejects(f.queue.decide(client, request.id, "approve", () => client), { status: 403 });
  await assert.rejects(f.queue.decide({ ...f.owner, id: f.client.id }, request.id, "approve", () => ({ ...f.owner, id: f.client.id })), { status: 403 });
  await assert.rejects(f.queue.decide(f.owner, request.id, "approve"), { status: 403 });
  assert.equal(f.calls.length, 0);
});

test("only requesting browser sees and cancels its own requests", () => {
  const f = fixture();
  const another = { ...f.client, id: "other" };
  f.clients.set(another.id, another);
  const request = f.requestCommand();
  assert.deepEqual(f.queue.listClient(another), []);
  assert.throws(() => f.queue.cancel(another, request.id), { status: 404 });
  assert.equal(f.queue.cancel(f.client, request.id).status, "cancelled");
  assert.equal(f.queue.listClient(f.client)[0].status, "cancelled");
});

test("permission checks distinguish command handoffs, screen requests, and auto-scroll", () => {
  const f = fixture();
  const click = { type: "click", x: 0.2, y: 0.2, reason: "Click" };
  for (const screen of ["off", "view", "scroll", "ask", "apps"])
    assert.throws(() => f.queue.request({ ...f.client, policy: { ...f.client.policy, screen } }, click), { status: 403 });
  assert.throws(() => f.queue.request({ ...f.client, policy: { ...f.client.policy, commandRequests: false } }, { type: "command", command: "echo x", reason: "Run" }), { status: 403 });
  assert.throws(() => f.queue.request({ ...f.client, scopes: ["browser:read"] }, click), { status: 403 });
  assert.throws(() => f.queue.request({ ...f.client, kind: "device" }, click), { status: 403 });
});

test("unknown fields and malformed actions cannot enqueue or notify", () => {
  const f = fixture();
  for (const bad of [
    null, [], {}, { type: "__proto__" },
    { type: ["click"], x: 0.1, y: 0.2 },
    { type: ["click"], x: "invalid", y: {} },
    { type: ["text"], text: { hidden: "invalid" } },
    { type: ["key"], key: "enter" },
    { type: ["scroll"], direction: "down", amount: 1 },
    { type: ["command"], command: "echo example" },
    { type: "click", x: -0.01, y: 0.2 },
    { type: "click", x: NaN, y: 0.2 },
    { type: "click", x: 0.1, y: 0.2, button: "middle" },
    { type: "click", x: 0.1, y: 0.2, count: 3 },
    { type: "click", x: 0.1, y: 0.2, admin: true },
    { type: "text", text: "x".repeat(2001) },
    { type: "text", text: "x\0y" },
    { type: "text", text: "x\u001by" },
    { type: "text", text: "x\ry" },
    { type: "text", text: "" },
    { type: "key", key: "cmd" },
    { type: "scroll", direction: "left", amount: 1 },
    { type: "scroll", direction: "up", amount: 6 },
    { type: "scroll", direction: "up", amount: 0.5 },
    { type: "scroll", direction: "up", amount: null },
    { type: "command", command: "x".repeat(4001) },
    { type: "command", command: "" },
    { type: "command", command: "echo x", cwd: "/tmp" },
    { type: "key", key: "enter", reason: "" },
    { type: "key", key: "enter", reason: "x".repeat(1001) },
  ]) assert.throws(() => f.queue.request(f.client, bad && { reason: "test", ...bad }), { status: 400 });
  assert.equal(f.queue.listOwner().length, 0);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.calls.length, 0);
});

test("denial and all unsupported decisions leave no execution grant", async () => {
  const f = fixture();
  const request = f.requestCommand();
  for (const decision of ["handled", "allow-all", null])
    await assert.rejects(f.decide(request, decision), { status: 400 });
  assert.equal((await f.decide(request, "deny")).status, "denied");
  await assert.rejects(f.decide(request), { status: 409 });
  assert.equal(f.calls.length, 0);
});

test("expiry and policy changes invalidate pending requests", async () => {
  const f = fixture();
  const expired = f.requestCommand();
  f.advance(300000);
  assert.equal(f.queue.getOwner(expired.id).status, "expired");
  await assert.rejects(f.decide(expired), { status: 409 });
  const changed = f.requestCommand();
  f.client.policy.commandRequests = false;
  assert.equal(f.queue.getOwner(changed.id).status, "revoked", "even unrelated grant changes require review again");
  await assert.rejects(f.decide(changed), { status: 409 });
  f.client.expiresAt = 302000;
  const short = f.requestCommand();
  assert.equal(short.expiresAt, 302000);
  f.clients.delete(f.client.id);
  assert.equal(f.queue.getOwner(short.id).status, "revoked");
  assert.equal(f.calls.length, 0);
});

test("revocation is rechecked immediately before dispatch", async () => {
  let release;
  let dispatched = 0;
  const f = fixture({ execute: async (_, authorize) => {
    await new Promise((resolve) => { release = resolve; });
    authorize();
    dispatched++;
  } });
  const request = f.requestCommand();
  const pending = f.decide(request);
  f.clients.delete(f.client.id);
  release();
  assert.equal((await pending).status, "revoked");
  assert.equal(dispatched, 0);
});

test("owner reauthorization is required again at native dispatch", async () => {
  let release;
  let revoked = false;
  let dispatched = 0;
  const f = fixture({ execute: async (_, authorize) => {
    await new Promise((resolve) => { release = resolve; });
    authorize();
    dispatched++;
  } });
  const request = f.requestCommand();
  const pending = f.queue.decide(f.owner, request.id, "approve", () => {
    if (revoked) throw Object.assign(Error("revoked"), { status: 401 });
    return f.owner;
  });
  revoked = true;
  release();
  assert.equal((await pending).status, "failed");
  assert.equal(dispatched, 0);
});

test("failed execution never retries automatically or exposes arbitrary native output", async () => {
  const f = fixture({ execute: async () => { throw Error("secret-output"); } });
  const request = f.requestCommand();
  const result = await f.decide(request);
  assert.equal(result.status, "failed");
  assert.equal(JSON.stringify(result).includes("secret-output"), false);
  await assert.rejects(f.decide(request), { status: 409 });
});

test("known pre-dispatch failures retain actionable owner messages", async () => {
  const f = fixture({ execute: async () => { throw Object.assign(Error("The shared folder changed. Request the command again."), { status: 409 }); } });
  const result = await f.decide(f.requestCommand());
  assert.equal(result.status, "failed");
  assert.match(result.error, /shared folder changed/);
});

test("pausing cancels existing requests without permanently closing the queue", async () => {
  const f = fixture();
  const request = f.requestCommand();
  f.queue.cancelPending();
  assert.equal(f.queue.getOwner(request.id).status, "cancelled");
  assert.deepEqual(f.queue.listOwner(), []);
  await assert.rejects(f.decide(request), { status: 409 });
  assert.equal(f.requestCommand().status, "pending");
});

test("outstanding requests are bounded per client and globally", async () => {
  const f = fixture();
  const first = f.requestCommand();
  f.requestCommand(); f.requestCommand();
  assert.throws(f.requestCommand, { status: 429 });
  await f.decide(first, "deny");
  f.requestCommand();
  for (let i = 0; i < 17; i++) {
    const client = { ...f.client, id: `agent-${i}` };
    f.clients.set(client.id, client);
    f.queue.request(client, { type: "terminal", root: 0, command: "pwd", reason: "Inspect folder" });
  }
  const client = { ...f.client, id: "overflow" };
  f.clients.set(client.id, client);
  assert.throws(() => f.queue.request(client, { type: "terminal", root: 0, command: "pwd", reason: "Inspect folder" }), { status: 429 });
});

test("request cancellation cannot bypass notification rate limits", () => {
  const f = fixture();
  for (let i = 0; i < 10; i++) {
    const request = f.requestCommand();
    f.queue.cancel(f.client, request.id);
  }
  assert.throws(f.requestCommand, { status: 429 });
  assert.equal(f.pushes.length, 10);
  assert.equal(new Set(f.pushes.map((push) => push.tag)).size, 1);
  f.advance(60000);
  assert.equal(f.requestCommand().status, "pending");
  assert.equal(f.pushes.length, 11);
});

test("notification rate limits apply across distinct invitations", () => {
  const f = fixture();
  for (let i = 0; i < 60; i++) {
    const client = { ...f.client, id: `agent-${i}` };
    f.clients.set(client.id, client);
    const request = f.queue.request(client, { type: "terminal", root: 0, command: "pwd", reason: "Inspect folder" });
    f.queue.cancel(client, request.id);
  }
  assert.throws(f.requestCommand, { status: 429 });
  assert.equal(f.pushes.length, 60);
  f.advance(60000);
  assert.equal(f.requestCommand().status, "pending");
});

test("revoking one client and closing queue invalidate work without affecting another client", async () => {
  const f = fixture();
  const first = f.requestCommand();
  const other = { ...f.client, id: "other" };
  f.clients.set(other.id, other);
  const second = f.queue.request(other, { type: "terminal", root: 0, command: "pwd", reason: "Inspect folder" });
  f.queue.cancelClient(f.client.id);
  assert.equal(f.queue.getOwner(first.id).status, "revoked");
  assert.equal(f.queue.getOwner(second.id).status, "pending");
  f.queue.close();
  assert.equal(f.queue.getOwner(second.id).status, "revoked");
  assert.throws(f.requestCommand, { status: 503 });
  await assert.rejects(f.decide(second), { status: 409 });
});

test("approval invitation grants do not inherit shell, direct input, or admin scopes", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-approval-auth-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = { dataDir: dir, roots: [], agentPolicyFile: path.join(dir, "policy.json") };
  const auth = createAuth(config);
  for (const choice of [{ screen: "ask" }, { commandRequests: true }, { screen: "ask", commandRequests: true }]) {
    const grant = auth.inviteBrowser({ name: "Muse", ttlSeconds: 300, ...choice });
    const joined = admitAgent(auth, grant.invitation);
    const client = auth.verify(joined.token);
    assert.deepEqual(client.scopes, ["device", "browser:read", "browser:request"]);
    assert.equal(client.policy.commandRequests === true, choice.commandRequests === true);
    const broad = applyAgentPolicy({ ...client, scopes: [...client.scopes, ...ALL_SCOPES, "browser:scroll"] }, config);
    assert.deepEqual(new Set(broad.scopes), new Set(client.scopes));
    assert.equal(applyAgentPolicy({ ...client, policy: { ...client.policy, commandRequests: "yes" } }, config), null);
  }
  assert.throws(() => auth.inviteBrowser({ name: "Muse", ttlSeconds: 300, commandRequests: "yes" }), { status: 400 });
  assert.throws(() => auth.issue("CLI", ["browser:request"], "agent"), { status: 400 });
});

test("restricted terminal binds the folder and exact command, requires owner approval, and returns output once", async () => {
  let executions = 0;
  const f = fixture({ execute: async (action, authorize) => {
    authorize();
    executions++;
    assert.deepEqual(action, { type: "terminal", command: "ls", root: 0 });
    return "notes.txt";
  } });
  f.client.policy = { browser: true, restrictedTerminal: true, roots: ["/shared"], screen: "off" };
  const r = f.queue.request(f.client, { type: "terminal", command: "ls", root: 0, reason: "Inspect project files" });
  assert.equal(r.folder, "/shared");
  assert.equal(r.status, "pending");
  assert.equal(executions, 0);
  await assert.rejects(f.queue.decide(f.client, r.id, "approve", () => f.client), { status: 403 });
  const result = await f.decide(r);
  assert.equal(result.status, "executed");
  assert.equal(result.output, "notes.txt");
  assert.equal(executions, 1);
  await assert.rejects(f.decide(r), { status: 409 });
  assert.equal(f.queue.listClient(f.client)[0].output, "notes.txt");
});

test("restricted terminal cannot request screen typing, manual handoffs, unshared roots or destructive commands", async () => {
  const f = fixture();
  f.client.policy = { browser: true, restrictedTerminal: true, roots: ["/shared"], screen: "off" };
  for (const input of [
    { type: "terminal", command: "rm file", root: 0 },
    { type: "terminal", command: "sudo ls", root: 0 },
    { type: "terminal", command: "ls; rm file", root: 0 },
    { type: "terminal", command: "ls", root: -1 },
    { type: "terminal", command: "ls", root: "0" },
    { type: "terminal", command: "ls", root: 10 },
    { type: "text", text: "rm file\n" },
    { type: "command", command: "ls" },
  ]) assert.throws(() => f.queue.request(f.client, { ...input, reason: "Do this" }));
  assert.equal(f.queue.listOwner().length, 0);
  assert.equal(f.calls.length, 0);
  const r = f.queue.request(f.client, { type: "terminal", command: "ls", root: 0, reason: "Read" });
  f.client.policy.roots = ["/replacement"];
  await assert.rejects(f.decide(r), { status: 409 });
  assert.equal(f.queue.getOwner(r.id).status, "revoked");
  assert.equal(f.calls.length, 0);
});
