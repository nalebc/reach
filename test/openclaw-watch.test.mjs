import test from "node:test";
import assert from "node:assert/strict";
import { createOpenClawWatch } from "../server/openclaw-watch.mjs";
import { createNotifications, readAttention } from "../server/notifications.mjs";
import { notificationPush, publicNotification } from "../server/notification-items.mjs";

const SUB = "agent:main:subagent:1111";
const CRON = "agent:main:cron:job-1:run:abc";
function fixture({ jobs = [{ id: "job-1", name: "Morning brief", status: "running" }], wait = "timeout" } = {}) {
  let clock = 1_000_000;
  let listener;
  const timers = [];
  const calls = [];
  const client = {
    onEvent(fn) {
      listener = fn;
      return () => (listener = null);
    },
    async automations() {
      return { jobs, hasMore: false };
    },
    async catalog() {
      return { agents: [{ id: "main", name: "Scout" }] };
    },
    async call(method, params) {
      calls.push([method, params]);
      return { runId: params.runId, status: typeof wait === "function" ? wait() : wait };
    },
  };
  const watch = createOpenClawWatch({
    client,
    now: () => clock,
    setTimer: () => ({}),
    clearTimer: () => {},
    later: (fn, ms) => {
      const t = { fn, at: clock + ms, done: false };
      timers.push(t);
      return t;
    },
    cancel: (t) => t && (t.done = true),
  });
  const emit = (event, payload) => listener?.(event, payload);
  // The Gateway ticks every 30 s while connected.
  const advance = (ms, { live = true } = {}) => {
    for (let left = ms; left > 0; left -= 30000) {
      clock += Math.min(30000, left);
      if (live) listener?.("tick", { ts: clock });
      for (const t of timers) if (!t.done && t.at <= clock) (t.done = true), t.fn();
    }
  };
  const settle = () => new Promise((r) => setTimeout(r, 5));
  return { watch, client, emit, advance, settle, calls, tick: () => emit("tick", { ts: clock }) };
}

test("a schedule's run finishing or failing is told once, by its name, in fixed words", async () => {
  const f = fixture();
  f.emit("cron", { jobId: "job-1", action: "started", runAtMs: 5 });
  await f.settle();
  // Its agent events don't tell it a second time.
  f.emit("agent", { runId: "r1", sessionKey: CRON, stream: "lifecycle", data: { phase: "end" } });
  f.emit("cron", { jobId: "job-1", action: "finished", status: "ok", runAtMs: 5, sessionKey: CRON });
  // A one-shot job is removed right after: its name was learnt at start.
  f.emit("cron", { jobId: "job-1", action: "removed" });
  let items = f.watch.items();
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "Schedule Morning brief finished");
  assert.equal(items[0].category, "openclaw");
  assert.equal(items[0].bell, false);
  assert.equal(items[0].signature, "5");
  f.emit("cron", { jobId: "job-1", action: "started", runAtMs: 9 });
  f.emit("cron", {
    jobId: "job-1", action: "finished", status: "error", runAtMs: 9,
    error: "401 sk-secret-token leaked",
  });
  items = f.watch.items();
  assert.equal(items.length, 1, "same stable id, next run's signature");
  assert.equal(items[0].title, "Schedule Morning brief failed");
  assert.equal(items[0].signature, "9");
  assert.doesNotMatch(JSON.stringify(items), /secret|401/);
  // Skipped runs say nothing.
  f.emit("cron", { jobId: "job-2", action: "finished", status: "skipped" });
  assert.equal(f.watch.items().length, 1);
});

test("a sub-agent's end is told; a failure waits out OpenClaw's fallback", async () => {
  const f = fixture();
  f.emit("agent", { runId: "s1", sessionKey: SUB, stream: "lifecycle", data: { phase: "start" } });
  await f.settle(); // its agent's name from the catalog
  f.emit("agent", { runId: "s1", sessionKey: SUB, stream: "lifecycle", data: { phase: "error", error: "boom /Users/me" } });
  f.advance(5000);
  // The next model took over under the same runId.
  f.emit("agent", { runId: "s1", sessionKey: SUB, stream: "assistant", data: { text: "hi" } });
  f.advance(20000);
  assert.equal(f.watch.items().length, 0);
  f.emit("chat", { runId: "s1", sessionKey: SUB, state: "final" });
  f.emit("agent", { runId: "s1", sessionKey: SUB, stream: "lifecycle", data: { phase: "end" } });
  let items = f.watch.items();
  assert.equal(items.length, 1, "chat final and lifecycle end count once");
  assert.equal(items[0].title, "Scout sub-agent finished");
  assert.deepEqual(items[0].target, { page: "sessions", agent: "openclaw", id: SUB });

  f.emit("agent", { runId: "s2", sessionKey: SUB, stream: "lifecycle", data: { phase: "start" } });
  f.emit("agent", { runId: "s2", sessionKey: SUB, stream: "lifecycle", data: { phase: "error", error: "secret" } });
  f.advance(16000);
  items = f.watch.items();
  assert.equal(items[0].title, "Scout sub-agent failed");
  assert.equal(items[0].detail, "It stopped with an error.");
  // Late events of an ended run don't start it again.
  f.emit("chat", { runId: "s2", sessionKey: SUB, state: "delta" });
  assert.equal(f.watch.items().length, 2);
  // Stopped on purpose, and chats that aren't background work: nothing.
  f.emit("agent", { runId: "s3", sessionKey: SUB, stream: "lifecycle", data: { phase: "start" } });
  f.emit("chat", { runId: "s3", sessionKey: SUB, state: "aborted" });
  f.emit("agent", { runId: "m1", sessionKey: "agent:main:reach-1a2b", stream: "lifecycle", data: { phase: "start" } });
  f.emit("agent", { runId: "m1", sessionKey: "agent:main:reach-1a2b", stream: "lifecycle", data: { phase: "end" } });
  assert.equal(f.watch.items().length, 2);
});

test("quiet for 10 minutes while still running, confirmed first; activity clears it", async () => {
  let status = "timeout";
  const f = fixture({ wait: () => status });
  f.emit("agent", { runId: "q1", sessionKey: SUB, stream: "lifecycle", data: { phase: "start" } });
  f.emit("cron", { jobId: "job-1", action: "started", runAtMs: 1 });
  await f.settle();
  f.advance(9 * 60000);
  f.tick();
  await f.watch.check();
  assert.equal(f.watch.items().length, 0);
  f.advance(2 * 60000);
  f.tick();
  await f.watch.check();
  const titles = f.watch.items().map((i) => [i.title, i.detail]);
  assert.deepEqual(titles.sort(), [
    ["Quiet for 10 min", "Schedule Morning brief is still marked running."],
    ["Quiet for 10 min", "Scout sub-agent is still marked running."],
  ]);
  assert.deepEqual(f.calls[0], ["agent.wait", { runId: "q1", timeoutMs: 1 }]);
  // Told once per silence.
  await f.watch.check();
  assert.equal(f.watch.items().length, 2);
  f.emit("agent", { runId: "q1", sessionKey: SUB, stream: "assistant", data: {} });
  f.emit("agent", { runId: "c", sessionKey: CRON, stream: "assistant", data: {} });
  assert.equal(f.watch.items().length, 0);
  // A run whose end was missed: agent.wait tells it.
  status = "ok";
  f.advance(11 * 60000);
  f.tick();
  await f.watch.check();
  const sub = f.watch.items().filter((i) => !i.id.includes(":cron:"));
  assert.deepEqual(sub.map((i) => i.title), ["Scout sub-agent finished"]);
});

test("no events at all (connection down) proves nothing; a Gateway restart forgets runs", async () => {
  const f = fixture();
  f.emit("agent", { runId: "q2", sessionKey: SUB, stream: "lifecycle", data: { phase: "start" } });
  f.advance(15 * 60000, { live: false });
  await f.watch.check();
  assert.equal(f.watch.items().length, 0);
  assert.equal(f.calls.length, 0);
  // Back after the silence: the run's state is unknown, so it's dropped.
  f.advance(15 * 60000);
  await f.watch.check();
  assert.equal(f.watch.items().length, 0);
  assert.equal(f.calls.length, 0);
  f.emit("agent", { runId: "q3", sessionKey: SUB, stream: "lifecycle", data: { phase: "start" } });
  f.emit("shutdown", {});
  f.advance(15 * 60000);
  await f.watch.check();
  assert.equal(f.watch.items().length, 0);
  assert.equal(f.calls.length, 0);
});

test("alerts expire, and change wakes notifications", async () => {
  const f = fixture();
  let woke = 0;
  f.watch.onChange(() => woke++);
  f.emit("cron", { jobId: "job-1", action: "finished", status: "ok", runAtMs: 1 });
  assert.equal(woke, 1);
  assert.equal(f.watch.items()[0].title, "Schedule finished", "no name known: fixed words");
  f.advance(31 * 60000);
  assert.equal(f.watch.items().length, 0);
});

test("names are capped and cleaned; unsafe agent ids fall back", () => {
  const f = fixture({ jobs: [] });
  f.emit("agent", { runId: "x", sessionKey: "agent:bad id‮:subagent:1", stream: "lifecycle", data: { phase: "start" } });
  f.emit("agent", { runId: "x", sessionKey: "agent:bad id‮:subagent:1", stream: "lifecycle", data: { phase: "end" } });
  assert.equal(f.watch.items()[0].title, "OpenClaw sub-agent finished");
});

test("notifications push background alerts once under their own openclaw category, never in the bell", async () => {
  const f = fixture();
  f.emit("cron", { jobId: "job-1", action: "started", runAtMs: 3 });
  await f.settle();
  f.emit("cron", { jobId: "job-1", action: "finished", status: "ok", runAtMs: 3, sessionKey: CRON });
  const sent = [];
  const notifications = createNotifications({
    read: () =>
      readAttention({
        agentSessions: { list: async () => ({ sessions: [] }) },
        openClaw: { overview: async () => ({ connected: false }) },
        handoffs: () => [],
        browserRequests: () => [],
        admissions: () => [],
        accessRequests: () => [],
        background: () => f.watch.items(),
      }),
    notify: async (message) => (sent.push(message), { sent: 1 }),
    enabled: () => true,
  });
  const first = await notifications.refresh({ fresh: true });
  assert.deepEqual(first.items, []);
  await notifications.refresh({ fresh: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].category, "openclaw");
  assert.equal(sent[0].title, "Schedule Morning brief finished");
  assert.equal(sent[0].body, "Its run is done.");
  assert.match(sent[0].url, /page=sessions&agent=openclaw&id=agent%3Amain%3Acron/);
  // The next run of the same job pushes again.
  f.emit("cron", { jobId: "job-1", action: "finished", status: "error", runAtMs: 4 });
  await notifications.refresh({ fresh: true });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].title, "Schedule Morning brief failed");
  notifications.close();
  const item = f.watch.items()[0];
  assert.equal("bell" in publicNotification(item), false);
  assert.equal(notificationPush(item).actions.length, 1);
});

test("a run seen on a phone (its chat, or the chat that spawned it) isn't pushed", async () => {
  const f = fixture();
  const handlers = {};
  const app = { get: (path, fn) => (handlers[path] = fn) };
  const { routes } = await import("../server/openclaw-watch.mjs");
  // The fixture's client: the same object openClawRoutes gets.
  const client = f.client;
  routes(app, client, { base: "/b" });
  let passed = 0;
  const open = (path, key) => handlers[path]({ query: { key } }, {}, () => passed++);
  open("/b/changes", SUB);
  f.emit("agent", { runId: "w1", sessionKey: SUB, stream: "lifecycle", data: { phase: "end" } });
  await f.settle();
  assert.equal(passed, 1, "openclaw.mjs's own handler still answers");
  assert.equal(f.watch.items().length, 0);
  // The parent chat open: sessions.list lists the sub-agent under it.
  open("/b/history", "agent:main:reach-parent");
  client.call = async (method, params) =>
    method === "sessions.list" && params.spawnedBy === "agent:main:reach-parent"
      ? { sessions: [{ key: "agent:main:subagent:2222" }] }
      : { sessions: [] };
  f.emit("agent", { runId: "w2", sessionKey: "agent:main:subagent:2222", stream: "lifecycle", data: { phase: "end" } });
  await f.settle();
  assert.equal(f.watch.items().length, 0);
  // Another sub-agent, nobody watching it: told.
  f.emit("agent", { runId: "w3", sessionKey: "agent:main:subagent:3333", stream: "lifecycle", data: { phase: "end" } });
  await f.settle();
  assert.deepEqual(f.watch.items().map((i) => i.id), ["openclaw-watch:sub:w3"]);
});
