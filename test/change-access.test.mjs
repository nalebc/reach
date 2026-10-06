import test from "node:test";
import { approveAgentClaim } from "./helpers/agent-admission.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Changing what someone you invited may use, without a new link: the same
// choices and checks as inviting them; their link, device and time stay.
// More access works on their next request; less ends at once, open screens
// and terminals included; their phone hears of it through its live connection.
async function start(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-access-"));
  const shared = path.join(dir, "shared");
  fs.mkdirSync(path.join(shared, "work"), { recursive: true });
  fs.mkdirSync(path.join(shared, "other"), { recursive: true });
  const reach = await createReach({ roots: [shared], dataDir: path.join(dir, "private"), port: 0 });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await reach.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${reach.server.address().port}`;
  const call = async (route, { token, method = "GET", body } = {}) => {
    const r = await fetch(base + route, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  const owner = reach.auth.issue("iPhone", ALL_SCOPES).token;
  const work = [{ root: 0, path: "work" }];
  // Invite and open the link, as the guest's phone does.
  const invite = async (choice, open = true) => {
    const made = await call("/api/guests", { token: owner, method: "POST", body: { name: "Ali", ttlSeconds: 3600, ...choice } });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    if (!open) return { id: made.body.clientId, invitation: made.body.invitation };
    const joined = await call("/api/guest/redeem", { method: "POST", body: { invitation: made.body.invitation } });
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    return { id: made.body.clientId, token: joined.body.token };
  };
  const change = (id, body, token = owner) => call(`/api/guests/${id}/access`, { token, method: "POST", body });
  const socket = (channel, auth) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${reach.server.address().port}${channel}`, { headers: { Host: "localhost" } });
      const messages = [];
      ws.on("message", (m) => messages.push(JSON.parse(m)));
      ws.once("open", () => {
        ws.send(JSON.stringify(auth));
        resolve({ ws, messages, closed: new Promise((r) => ws.once("close", (code, reason) => r({ code, reason: String(reason) }))) });
      });
      ws.once("error", reject);
    });
  return { reach, call, owner, work, invite, change, socket };
}
const waitFor = async (check, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw Error(`Timed out waiting for ${check}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

test("view only → edit files: the same link and credential can edit at once", async (t) => {
  const { call, owner, work, invite, change } = await start(t);
  const ali = await invite({ folders: work, write: false });
  assert.equal((await call("/api/files?root=0", { token: ali.token })).status, 200);
  const mkdir = (name) => call("/api/files/folder", { token: ali.token, method: "POST", body: { root: 0, name } });
  assert.equal((await mkdir("try-1")).status, 403, "view only");
  const changed = await change(ali.id, { folders: "keep", write: true });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.ok(changed.body.scopes.includes("files:write"));
  assert.equal(changed.body.guestRoots.length, 1, "the same folder");
  assert.equal((await mkdir("try-2")).status, 200, "edits now, no new link");
  // Back to view only: refused again from the next request.
  assert.equal((await change(ali.id, { folders: "keep", write: false })).status, 200);
  assert.equal((await mkdir("try-3")).status, 403);
  // Only you change access: never the guest (nor with their own credential).
  assert.equal((await change(ali.id, { folders: "keep", write: true }, ali.token)).status, 403);
});

test("the same checks as inviting: folders to keep or choose, valid choices, live invitations only", async (t) => {
  const { reach, call, owner, work, invite, change } = await start(t);
  const watcher = await invite({ screen: "view" });
  // Folders are chosen when they had none (or had everything, with full access).
  assert.equal((await change(watcher.id, { folders: "keep", write: true })).status, 400);
  const files = await change(watcher.id, { folders: [{ root: 0, path: "other" }], write: true });
  assert.equal(files.status, 200);
  assert.deepEqual(files.body.scopes, ["device", "files:read", "files:write"], "the screen goes: it wasn't chosen again");
  const full = await invite({ full: true });
  assert.equal((await change(full.id, { folders: "keep" })).status, 400, "full access isn't a folder choice");
  for (const wrong of [{ screen: "everything" }, { write: "yes", folders: "keep" }, {}, { apps: [] }, { folders: [{ root: 9, path: "" }] }])
    assert.equal((await change(watcher.id, wrong)).status, 400, JSON.stringify(wrong));
  // Your own devices aren't invitations; unknown or ended ones are gone.
  const own = reach.auth.list().find((c) => c.kind === "device");
  assert.equal((await change(own.id, { screen: "view" })).status, 404);
  assert.equal((await change("nope", { screen: "view" })).status, 404);
  await call(`/api/clients/${watcher.id}`, { token: owner, method: "DELETE" });
  assert.equal((await change(watcher.id, { screen: "view" })).status, 404);
  // An invitation not opened yet: the link works, with the new access.
  const later = await invite({ folders: work }, false);
  assert.equal((await change(later.id, { folders: "keep", write: true, terminal: true })).status, 200);
  const joined = await call("/api/guest/redeem", { method: "POST", body: { invitation: later.invitation } });
  assert.equal(joined.status, 200);
  assert.ok(joined.body.scopes.includes("files:write") && joined.body.scopes.includes("terminal"));
});

test("an agent: more or less in its folders, never the screen, apps or access", async (t) => {
  const { call, owner, work, change } = await start(t);
  const made = await call("/api/agents/invitations", { token: owner, method: "POST", body: { name: "Claude", ttlSeconds: 86400, folders: work } });
  assert.equal(made.status, 201);
  const run = await change(made.body.clientId, { folders: "keep", write: true, exec: true, screen: "control", apps: "all", full: true });
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.scopes, ["device", "files:read", "files:write", "exec"]);
  assert.equal(run.body.policy.roots.length, 1);
  assert.equal((await change(made.body.clientId, { folders: [] })).status, 400, "always a folder");
});

test("less access ends at once: an open terminal is cut, and the phone hears the change live", async (t) => {
  const { call, work, invite, change, socket } = await start(t);
  const ali = await invite({ folders: work, terminal: true });
  const presence = await socket("/ws/presence", { type: "auth", token: ali.token, kind: "phone" });
  await waitFor(() => presence.messages.some((m) => m.changes?.access));
  const first = presence.messages.findLast((m) => m.changes?.access).changes.access;
  const shell = await call("/api/terminals", { token: ali.token, method: "POST", body: { root: 0, path: "" } });
  assert.equal(shell.status, 200, JSON.stringify(shell.body));
  const terminal = await socket("/ws/terminal", { type: "auth", token: ali.token, sessionId: shell.body.id });
  await waitFor(() => terminal.messages.some((m) => m.type === "snapshot"));
  const at = Date.now();
  assert.equal((await change(ali.id, { folders: "keep" })).status, 200);
  const closed = await terminal.closed;
  assert.equal(closed.code, 4002, "cut by the change itself, not a later check");
  assert.ok(Date.now() - at < 900);
  // Their phone's live connection stays, and carries the change.
  await waitFor(() => presence.messages.some((m) => m.changes?.access && m.changes.access !== first), 2500);
  assert.equal(presence.ws.readyState, WebSocket.OPEN);
  // More access cuts nothing.
  const files = await socket("/ws/presence", { type: "auth", token: ali.token, kind: "phone" });
  await waitFor(() => files.messages.length > 0);
  assert.equal((await change(ali.id, { folders: "keep", write: true })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(files.ws.readyState, WebSocket.OPEN);
  presence.ws.close();
  files.ws.close();
  await call(`/api/terminals/${shell.body.id}`, { token: ali.token, method: "DELETE" }).catch(() => {});
});

test("a full-access guest can't change anyone's access, its own included", async (t) => {
  const { work, invite, change } = await start(t);
  const boss = await invite({ full: true });
  const ali = await invite({ folders: work });
  assert.equal((await change(ali.id, { folders: "keep", write: true }, boss.token)).status, 403);
  assert.equal((await change(boss.id, { screen: "view" }, boss.token)).status, 403);
});

test("an agent's running command stops when running commands is taken away", async (t) => {
  const { call, owner, work, change } = await start(t);
  const made = await call("/api/agents/invitations", { token: owner, method: "POST", body: { name: "Claude", ttlSeconds: 86400, folders: work, write: true, exec: true } });
  const joined = await approveAgentClaim((route, options) => call(route, { token: owner, ...options }), await call("/api/invitations/redeem", { method: "POST", body: { invitation: made.body.invitation } }));
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  const job = await call("/api/jobs", { token: joined.body.token, method: "POST", body: { root: 0, command: "sleep 30", timeoutMs: 60000 } });
  assert.equal(job.status, 202, JSON.stringify(job.body));
  const status = async () => (await call(`/api/jobs/${job.body.id}`, { token: owner })).body.status;
  // Still allowed to run commands there: it keeps running.
  assert.equal((await change(made.body.clientId, { folders: "keep", write: false, exec: true })).status, 200);
  assert.equal(await status(), "running");
  assert.equal((await change(made.body.clientId, { folders: "keep", write: true })).status, 200);
  assert.equal(await status(), "cancelled");
});

test("one invitation over several computers keeps one id on each", async (t) => {
  const { call, owner, work } = await start(t);
  const made = await call("/api/guests", { token: owner, method: "POST", body: { name: "Ali", ttlSeconds: 3600, folders: work, group: "grp-0123456789" } });
  assert.equal(made.status, 201);
  const listed = (await call("/api/clients", { token: owner })).body.clients.find((c) => c.id === made.body.clientId);
  assert.equal(listed.group, "grp-0123456789");
  for (const group of ["short", "has space here", 42])
    assert.equal((await call("/api/guests", { token: owner, method: "POST", body: { name: "Bo", ttlSeconds: 3600, folders: work, group } })).status, 400, String(group));
});
