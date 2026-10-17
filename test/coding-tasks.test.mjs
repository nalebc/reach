import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createCodingTasks, codingTaskInput, codingTaskResult, codingAgentAllowed, CODING_RESULT_BYTES } from "../server/coding-tasks.mjs";

const tick = () => new Promise(setImmediate);
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await tick(); }
  assert.fail("the controlled provider operation did not settle");
}
function fixture(t, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reach-coding-tasks-"));
  let clock = Date.now(), blocked = false;
  const clients = new Map(["first", "second"].map((id) => [id, { id, kind: "agent", expiresAt: clock + 3600000,
    scopes: ["browser:shell"], policy: { invite: true, browser: true, preset: "full", fullControlVersion: 1, roots: [dir] } }]));
  const runs = new Map(), stopped = [], reads = [];
  const sessions = {
    async startCodingTask(agent, body) {
      const threadId = crypto.randomUUID(), turnId = crypto.randomUUID();
      const run = { agent, threadId, turnId, body, status: "running", items: [{ id: "user", role: "user", kind: "text", text: body.text, turnId }] };
      runs.set(threadId, run);
      body.onCreated({ threadId });
      await options.beforeStarted?.(run);
      body.onStarted?.({ threadId, turnId, generation: "first-generation" });
      return { threadId, turnId, generation: "first-generation" };
    },
    async stopCodingTask(agent, threadId, boundary) {
      stopped.push({ agent, threadId, boundary });
      if (options.stop) return options.stop(agent, threadId, boundary);
      if (runs.has(threadId)) runs.get(threadId).status = "idle";
      return { stopped: true };
    },
    async read(agent, threadId, opts) {
      reads.push({ agent, threadId, opts });
      const r = runs.get(threadId);
      if (options.read) return options.read(r, opts);
      return { session: { status: r.status }, items: r.items, before: null };
    },
    view(agent, threadId) { return { status: runs.get(threadId)?.status }; },
  };
  const args = { file: path.join(dir, "state", "coding-tasks.json"), sessions, now: () => clock,
    authorize(id) { const client = clients.get(id); if (!client || client.expiresAt <= clock) throw Object.assign(Error("Access ended"), { status: 403 }); return client; },
    resolveProject(client, root, folder) { if (root !== 0 || folder.includes("..") || path.isAbsolute(folder)) throw Object.assign(Error("Outside roots"), { status: 403 }); return dir; },
    validateProject() { if (blocked) throw Object.assign(Error("Project no longer shared"), { status: 403 }); }, ...options.manager };
  let manager = createCodingTasks(args);
  t.after(async () => { await manager.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, clients, runs, stopped, reads, args, get manager() { return manager; }, set manager(value) { manager = value; },
    input: (requestId = "request-one", agent = "codex") => ({ requestId, agent, task: "Fix the fixture bug", root: 0, path: "" }),
    async start(requestId, agent = "codex", client = "first") {
      const task = manager.start(client, this.input(requestId, agent));
      await until(() => [...runs.values()].some((r) => r.body.text.includes(task.id)));
      await tick(); await tick();
      return { task, run: [...runs.values()].find((r) => r.body.text.includes(task.id)) };
    }, advance(ms) { clock += ms; }, blockProject() { blocked = true; } };
}

test("coding task creation is durable and idempotent across lost responses, rotation and restart", async t => {
  const h = fixture(t);
  const { task, run } = await h.start("lost-response");
  const duplicate = h.manager.start("first", h.input("lost-response"));
  assert.equal(duplicate.id, task.id);
  assert.equal(h.runs.size, 1);
  assert.throws(() => h.manager.start("first", { ...h.input("lost-response"), task: "A different task" }), { status: 409 });
  h.clients.set("first", { ...h.clients.get("first"), token: "rotated-credential" });
  await h.manager.sweep();
  assert.equal((await h.manager.get("first", task.id)).status, "running");
  const ledger = JSON.parse(fs.readFileSync(h.args.file));
  assert.equal(ledger.tasks[0].threadId, run.threadId);
  assert.equal(ledger.tasks[0].boundary.turnId, run.turnId);
  assert.equal(Object.hasOwn(ledger.tasks[0], "task"), false, "the full task prompt is not copied into the ledger");
  const recovered = createCodingTasks(h.args);
  assert.equal(recovered.ownsSession("codex", run.threadId), true);
  assert.equal(recovered.start("first", h.input("lost-response")).status, "interrupted");
  await recovered.sweep();
  assert.equal(h.runs.size, 1, "restart never replays a coding prompt");
  assert.equal(h.stopped.at(-1).boundary.turnId, run.turnId);
  await recovered.close();
});

test("task ownership is checked before provider reads, waits or cancellation", async t => {
  const h = fixture(t);
  const { task } = await h.start("private-task");
  const before = h.reads.length;
  await assert.rejects(h.manager.get("second", task.id), { status: 404 });
  await assert.rejects(h.manager.cancel("second", task.id), { status: 404 });
  assert.deepEqual(h.manager.list("second"), { tasks: [] });
  assert.equal(h.reads.length, before);
  assert.equal(h.stopped.length, 0);
  assert.equal(JSON.stringify(await h.manager.get("first", task.id)).includes("threadId"), false);
});

test("coding tools require Full control v1; legacy Codex access grants Codex only", () => {
  const legacy = { kind: "agent", scopes: ["codex"] };
  assert.equal(codingAgentAllowed(legacy, "codex"), true);
  assert.equal(codingAgentAllowed(legacy, "claude"), false);
  for (const kind of ["device", "guest", "future-kind"]) assert.equal(codingAgentAllowed({ ...legacy, kind }), false);
  for (const preset of ["apps", "files", "readonly", "full"]) {
    const client = { kind: "agent", scopes: ["browser:shell", "codex"], policy: { invite: true, browser: true, preset, roots: [os.tmpdir()] } };
    assert.equal(codingAgentAllowed(client), false, "even an unversioned Full invitation is denied");
  }
});

test("task input cannot inject permissions, attachments, config or provider commands", () => {
  const input = { requestId: "valid-request", agent: "codex", task: "Fix it" };
  for (const field of ["threadId", "mode", "modeName", "approvalPolicy", "approvalsReviewer", "sandbox", "config", "developerInstructions", "extra", "images", "files", "owner"]) {
    assert.throws(() => codingTaskInput({ ...input, [field]: "arbitrary" }), { status: 400 }, field);
  }
  for (const patch of [{ requestId: "short" }, { agent: "shell" }, { timeoutSeconds: 3601 }, { timeoutSeconds: 59 }, { task: " " }, { root: -1 }, { title: "two\nlines" }])
    assert.throws(() => codingTaskInput({ ...input, ...patch }), { status: 400 });
});

test("late provider success after cancellation is retained and interrupted", async t => {
  let release;
  const waiting = new Promise((r) => { release = r; });
  const h = fixture(t, { beforeStarted: () => waiting });
  const task = h.manager.start("first", h.input("late-cancel"));
  await until(() => h.runs.size === 1);
  assert.equal((await h.manager.cancel("first", task.id)).status, "cancelling");
  release();
  await until(() => h.stopped.length === 1);
  assert.equal((await h.manager.get("first", task.id)).status, "cancelled");
  assert.equal(h.stopped[0].threadId, [...h.runs.keys()][0]);
  assert.equal(h.stopped[0].boundary.turnId, [...h.runs.values()][0].turnId);
});

test("revoke, per-agent pause, root loss and deadline stop delegated work without a polling client", async t => {
  for (const cause of ["revoke", "pause", "project", "deadline"]) await t.test(cause, async t => {
    const h = fixture(t);
    const { task } = await h.start(`end-${cause}`);
    if (cause === "revoke") h.clients.delete("first");
    if (cause === "pause") h.clients.get("first").codingPaused = true;
    if (cause === "project") h.blockProject();
    if (cause === "deadline") h.advance(1800001);
    await h.manager.sweep();
    assert.equal(h.stopped.length, 1);
    const stored = JSON.parse(fs.readFileSync(h.args.file)).tasks.find((r) => r.id === task.id);
    assert.equal(stored.status, "cancelled");
    assert.equal(stored.cancelRequested, true);
  });
});

test("cancel is durable and uncertain stops remain active in the concurrency budget", async t => {
  let confirmed = false;
  const h = fixture(t, { stop: () => { if (!confirmed) throw Error("Provider unavailable"); return { stopped: true }; }, manager: { maxPerClient: 1 } });
  const { task } = await h.start("uncertain-stop");
  assert.equal((await h.manager.cancel("first", task.id)).status, "cancelling");
  assert.throws(() => h.manager.start("first", h.input("other-request")), { status: 429 });
  assert.equal(JSON.parse(fs.readFileSync(h.args.file)).tasks[0].cancelRequested, true);
  confirmed = true;
  await h.manager.sweep();
  assert.equal((await h.manager.get("first", task.id)).status, "cancelled");
});

test("results contain recorded commands and changes, and freeze before later owner turns", async t => {
  const h = fixture(t);
  const { task, run } = await h.start("bounded-results");
  run.items.push(
    { id: "c", role: "tool", kind: "command", text: "npm run test:file -- test/fixture.test.mjs", detail: "one failing assertion", status: "failed", turnId: run.turnId },
    { id: "f", role: "tool", kind: "file-change", text: "src/fixture.mjs", detail: "- broken\n+ fixed", status: "completed", turnId: run.turnId },
    { id: "a", role: "assistant", kind: "text", text: "Fixed the bug; one test still fails.", turnId: run.turnId },
    { id: "owner", role: "user", kind: "text", text: "PRIVATE OWNER QUESTION", turnId: "later-owner-turn" },
    { id: "private", role: "assistant", kind: "text", text: "PRIVATE OWNER ANSWER", turnId: "later-owner-turn" },
  );
  const result = await h.manager.get("first", task.id);
  assert.equal(result.status, "completed");
  assert.equal(result.commands[0].status, "failed");
  assert.equal(result.commands[0].output, "one failing assertion");
  assert.equal(result.changes[0].diff, "- broken\n+ fixed");
  assert.equal(result.summary, "Fixed the bug; one test still fails.");
  assert.equal(JSON.stringify(result).includes("PRIVATE OWNER"), false);
  const reads = h.reads.length;
  await h.manager.get("first", task.id);
  assert.equal(h.reads.length, reads, "a finished task never rereads an owner's subsequent work");
});

test("Claude results stop at its next user message and a missing anchor never exposes latest chat", async t => {
  const h = fixture(t);
  const { task, run } = await h.start("claude-results", "claude");
  run.items.push({ role: "assistant", kind: "text", text: "Task result" }, { role: "user", kind: "text", text: "Owner private request" }, { role: "assistant", kind: "text", text: "Owner private answer" });
  const result = await h.manager.get("first", task.id);
  assert.equal(result.summary, "Task result");
  assert.equal(JSON.stringify(result).includes("private"), false);
  const other = await h.start("missing-anchor", "claude");
  other.run.items = [{ role: "assistant", kind: "text", text: "Unattributed private text" }];
  const missing = await h.manager.get("first", other.task.id);
  assert.equal(missing.summary, "");
  assert.equal(missing.historyIncomplete, true);
  assert.equal(missing.status, "running");
});

test("encoded results stay bounded with multibyte and JSON-escaped output", () => {
  const large = "\u0001\"😀".repeat(100000);
  const items = [{ role: "assistant", kind: "text", text: large }];
  for (let i = 0; i < 40; i++) for (const kind of ["command", "file-change"]) items.push({ role: "tool", kind, text: large, detail: large, status: "completed" });
  const result = codingTaskResult(items);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) <= CODING_RESULT_BYTES);
  assert.equal(result.truncated, true);
  assert.ok(result.commands.length);
  assert.ok(result.changes.length);
});

test("corrupt ledgers fail closed, suppress recovery and cannot duplicate unknown starts", async t => {
  const h = fixture(t);
  fs.mkdirSync(path.dirname(h.args.file), { recursive: true });
  fs.writeFileSync(h.args.file, "{torn");
  const blocked = createCodingTasks(h.args);
  assert.throws(() => blocked.start("first", h.input("after-crash")), { status: 503 });
  assert.equal(blocked.ownsSession("claude", crypto.randomUUID()), true, "unreadable ownership suppresses automatic recovery");
  assert.equal(h.runs.size, 0);
  await blocked.close();
});

test("long-poll wakes on a task change and rechecks the current grant", async t => {
  const h = fixture(t);
  const { task, run } = await h.start("long-poll");
  const first = await h.manager.get("first", task.id);
  const pending = h.manager.get("first", task.id, { after: first.version, waitSeconds: 25 });
  await tick();
  run.status = "waiting";
  await h.manager.sweep();
  assert.equal((await pending).needsOwner, true);
  const waiting = await h.manager.get("first", task.id);
  const revoked = h.manager.get("first", task.id, { after: waiting.version, waitSeconds: 25 });
  const rejected = assert.rejects(revoked, { status: 403 });
  await tick();
  h.clients.delete("first");
  await h.manager.cancelClient("first");
  await rejected;
});

test("a stalled provider read cannot delay another task's revocation or deadline", async t => {
  let release;
  const blocked = new Promise((r) => { release = r; });
  const h = fixture(t, { read: async (run) => { await blocked; return { session: { status: run.status }, items: run.items, before: null }; } });
  await h.start("stalled-read-one");
  await h.start("stalled-read-two");
  const reading = h.manager.sweep();
  h.clients.delete("first");
  const revoked = h.manager.sweep();
  await until(() => h.stopped.length === 2);
  release();
  await Promise.all([reading, revoked]);
  assert.ok(JSON.parse(fs.readFileSync(h.args.file)).tasks.every((r) => r.status === "cancelled"));
});

test("unknown provider states cannot turn an assistant claim into a completed task", async t => {
  const h = fixture(t);
  const { task, run } = await h.start("future-status");
  run.status = "new-provider-state";
  run.items.push({ role: "assistant", kind: "text", text: "All tests passed", turnId: run.turnId });
  const result = await h.manager.get("first", task.id);
  assert.equal(result.status, "running");
  assert.deepEqual(result.commands, [], "an assistant's test claim is not recorded command evidence");
});

test("cancellation before the launch microtask finishes without dispatching or consuming quota", async t => {
  const h = fixture(t, { manager: { maxPerClient: 1 } });
  const task = h.manager.start("first", h.input("cancel-before-start"));
  await h.manager.cancel("first", task.id);
  await tick(); await tick();
  const result = await h.manager.get("first", task.id);
  assert.equal(result.status, "cancelled");
  assert.equal(h.runs.size, 0);
  assert.equal(h.stopped.length, 0);
  assert.equal(h.manager.start("first", h.input("quota-released")).status, "starting");
});

test("shutdown's single cutoff includes a provider interrupt that never acknowledges", async t => {
  let release;
  const blocked = new Promise((r) => { release = r; });
  const h = fixture(t, { stop: () => blocked, manager: { shutdownMs: 20 } });
  const { task } = await h.start("bounded-shutdown");
  const closing = h.manager.close();
  const stored = JSON.parse(fs.readFileSync(h.args.file)).tasks.find((r) => r.id === task.id);
  assert.equal(stored.cancelRequested, true, "the stop request is durable before shutdown waits");
  await closing;
  assert.equal(h.stopped.length, 1);
  release({ stopped: true });
  await tick();
});

test("an owner's quoted task marker on a newer Claude page cannot replace the original task", async t => {
  let later = false;
  const h = fixture(t, { read(run, opts) {
    if (!later) return { session: { status: "running" }, items: run.items, before: null };
    if (opts.before === "earlier") return { session: { status: "running" }, items: run.items, before: null };
    return { session: { status: "running" }, items: [
      { role: "user", kind: "text", text: run.body.text + "\nOwner private follow-up" },
      { role: "assistant", kind: "text", text: "PRIVATE OWNER ANSWER" },
    ], before: "earlier" };
  } });
  const { task, run } = await h.start("quoted-marker", "claude");
  run.items.push({ role: "assistant", kind: "text", text: "Original task result" });
  later = true;
  const result = await h.manager.get("first", task.id);
  assert.equal(result.summary, "Original task result");
  assert.equal(result.status, "completed");
  assert.equal(JSON.stringify(result).includes("PRIVATE OWNER"), false);
});

test("a marker on incomplete history never substitutes for proof of the first task user", async t => {
  const h = fixture(t, { read(run, opts) { return { session: { status: "running" }, items: [
    { role: "user", kind: "text", text: run.body.text },
    { role: "assistant", kind: "text", text: "UNATTRIBUTED OWNER RESULT" },
  ], before: opts.before === undefined ? "page-1" : `${opts.before}-older` }; } });
  const { task } = await h.start("unproven-marker", "claude");
  const result = await h.manager.get("first", task.id);
  assert.equal(result.historyIncomplete, true);
  assert.equal(result.summary, "");
});

test("a turn handed to the owner is interrupted rather than reported as a confirmed cancellation", async t => {
  const h = fixture(t, { stop: () => ({ stopped: false, turnChanged: true }) });
  const { task } = await h.start("owner-takeover", "claude");
  const result = await h.manager.cancel("first", task.id);
  assert.equal(result.status, "interrupted");
  assert.match(result.reason, /left that work with the owner/);
});

test("a provider error cannot orphan active work outside cancellation and quota checks", async t => {
  let confirmed = false;
  const h = fixture(t, { stop: () => { if (!confirmed) throw Error("Stop not acknowledged"); return { stopped: true }; }, manager: { maxPerClient: 1 } });
  const { task } = await h.start("failed-running-turn");
  h.args.sessions.view = () => ({ status: "running", error: "Provider connection lost" });
  const result = await h.manager.get("first", task.id);
  assert.equal(result.status, "failed");
  assert.equal(result.cancellationPending, true);
  assert.throws(() => h.manager.start("first", h.input("quota-still-held")), { status: 429 });
  confirmed = true;
  await h.manager.sweep();
  assert.equal((await h.manager.get("first", task.id)).status, "failed");
  assert.equal((await h.manager.get("first", task.id)).cancellationPending, undefined);
});

test("task lists respect the encoded response limit even with long project selectors", async t => {
  const h = fixture(t);
  for (let i = 0; i < 15; i++) {
    const task = h.manager.start("first", { ...h.input(`long-project-${i}`), path: "x".repeat(4096) });
    await h.manager.cancel("first", task.id);
    await tick(); await tick();
  }
  const listed = h.manager.list("first");
  assert.equal(listed.truncated, true);
  assert.ok(listed.tasks.length > 0 && listed.tasks.length < 15);
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) <= CODING_RESULT_BYTES);
});

test("a shorter live owner policy also shortens an already-running task deadline", async t => {
  const h = fixture(t);
  const { task } = await h.start("shorter-owner-policy");
  h.clients.get("first").maxJobMs = 1000;
  h.advance(1001);
  await h.manager.sweep();
  const result = await h.manager.get("first", task.id);
  assert.equal(result.status, "cancelled");
  assert.equal(result.deadline, result.createdAt + 1000);
  assert.equal(h.stopped.length, 1);
});
