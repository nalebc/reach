import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callKind, createAgentTimings, STRETCH_GAP_MS } from "../server/agent-timings.mjs";
import { presetFixture, privateIngressTest } from "./helpers/preset-fixture.mjs";

// Oct 12: "agents using MCP to control the Mac are very slow". Each call an
// agent makes is timed (Reach's part) and so is the gap before its next one
// (the agent's part), with no content at all: only kinds and times.
const KEYS = ["at", "clientId", "kind", "reachMs", "agentMs", "ok"];

test("a call's kind comes from its method and path alone: fixed names, never a query or an id", () => {
  assert.equal(callKind("POST", "/api/browser/desktop/input"), "act");
  assert.equal(callKind("GET", "/api/browser/desktop/describe?query=my%20bank%20password"), "describe");
  assert.equal(callKind("get", "/api/browser/desktop/screen?maxWidth=800"), "screenshot");
  assert.equal(callKind("POST", "/api/browser/desktop/open-url"), "open-url");
  assert.equal(callKind("GET", "/api/browser/tools/operations/00000000-0000-4000-8000-000000000001"), "tool-check");
  assert.equal(callKind("GET", "/api/browser/terminals/reach:secret-name"), "terminal-read");
  assert.equal(callKind("GET", "/api/browser/whatever/typed-by-an-agent"), "other");
  assert.equal(callKind("POST", "/api/browser/desktop/describe"), "other", "a method a route doesn't take");
});

test("Reach's time and the agent's, per call, in stretches split by long pauses", () => {
  let clock = 1_000_000;
  const timings = createAgentTimings({ now: () => clock });
  const muse = { id: "c1", name: "Muse" }, grok = { id: "c2", name: "Grok" };
  const call = (client, kind, reachMs, thenMs) => {
    const startedAt = clock;
    clock += reachMs;
    timings.add(client, { kind, startedAt, finishedAt: clock, ok: true });
    clock += thenMs;
  };
  call(muse, "describe", 300, 28_000);
  call(muse, "act", 500, 30_000);
  call(grok, "screenshot", 100, 1_000);
  call(muse, "act", 400, STRETCH_GAP_MS + 1);
  call(muse, "describe", 200, 2_000);
  call(muse, "act", 600, 0);
  const listed = timings.list({ clientId: "c1" });
  assert.equal(listed.length, 5);
  for (const entry of listed) assert.deepEqual(Object.keys(entry).filter((key) => !KEYS.includes(key)), [], "only kinds and times");
  assert.equal(listed.at(-1).agentMs, undefined, "the first call has no agent time");
  assert.equal(listed.at(-2).agentMs, 28_000, "from Reach's answer to the next call");
  assert.equal(listed.at(-3).agentMs, 31_100, "another agent's call doesn't split its time");
  // Newest first: the stretch after the long pause, then the first one.
  const stretches = timings.stretches("c1");
  assert.equal(stretches.length, 2);
  assert.deepEqual(stretches.map(({ calls, reachMs, agentMs }) => ({ calls, reachMs, agentMs })),
    [{ calls: 2, reachMs: 400, agentMs: 2_000 }, { calls: 3, reachMs: 400, agentMs: 29_550 }]);
  assert.ok(stretches[0].from > stretches[1].to);
  // One call alone has no pace to show.
  assert.deepEqual(timings.stretches("c2"), []);
  assert.deepEqual(timings.stretches(""), []);
  assert.equal(timings.add(null, { kind: "act", startedAt: 1, finishedAt: 2 }), null);
});

test("kept on disk beside the action log, bounded as it is, read back after a restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "reach-agent-timings-"));
  const file = path.join(directory, "agent-timings.jsonl");
  try {
    let clock = 5_000;
    const timings = createAgentTimings({ file, now: () => clock, max: 6, ring: 4 });
    const muse = { id: "c1", name: "Muse" };
    for (let i = 0; i < 9; i++) {
      timings.add(muse, { kind: "act", startedAt: clock, finishedAt: clock + 100, ok: i !== 4 });
      clock += 1_100;
    }
    await timings.flushed();
    const lines = fs.readFileSync(file, "utf8").trim().split("\n");
    assert.ok(lines.length <= 6 && lines.length >= 3, `bounded: ${lines.length} lines`);
    for (const line of lines) assert.deepEqual(Object.keys(JSON.parse(line)).filter((key) => !KEYS.includes(key)), []);
    assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600");
    assert.equal(timings.list({ clientId: "c1", limit: 100 }).length, 4, "a small ring in memory");
    // A restart reads the newest back, and the agent's time goes on from them.
    fs.appendFileSync(file, "{torn");
    const again = createAgentTimings({ file, now: () => clock, ring: 4 });
    assert.equal(again.list({ clientId: "c1" }).length, 4);
    again.add(muse, { kind: "describe", startedAt: clock + 2_000, finishedAt: clock + 2_100 });
    assert.equal(again.list({ clientId: "c1" })[0].agentMs, 3_000);
    assert.throws(() => again.list({}), (error) => error.status === 400);
    await again.flushed();
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

// Through the real routes: looks are timed too, a tool call through
// /api/browser/mcp/call once (as the route it ran), the agent's copy keeping
// up with its access not at all, and nothing it typed or asked for is kept.
test("every agent call is timed through the routes, with no content, and the owner sees the pace", privateIngressTest, async (t) => {
  const timings = createAgentTimings();
  const screen = { snapshot: "s1", app: "Bank", title: "Accounts", truncated: false,
    items: [{ n: 1, role: "TextField", name: "Search", value: "", x: 0.1, y: 0.1, w: 0.2, h: 0.02 }], texts: [{ text: "Balance $1,234", x: 0.1, y: 0.2, w: 0.2, h: 0.02 }] };
  const f = await presetFixture(t, { desktopExtras: {
    act: async (client, action, authorize) => { authorize(); return { ok: true, app: "Bank", bundle: "com.bank" }; },
    elements: async (client, authorize) => { authorize(); return structuredClone(screen); },
  }, overrides: { agentTimings: timings } });
  const agent = await f.join({ preset: "full" });
  const id = agent.created.clientId;
  assert.equal((await agent.as("/api/browser/desktop/describe?query=Balance")).status, 200);
  assert.equal((await agent.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "type", text: "hunter2-secret" } } })).status, 200);
  const viaCall = await agent.as("/api/browser/mcp/call", { method: "POST", body: { name: "reach_describe_screen", arguments: {} } });
  assert.equal(viaCall.status, 200, JSON.stringify(viaCall.body));
  // Upkeep: its access, its tools, a plan.
  await agent.as("/api/browser");
  await agent.as("/api/browser/mcp/tools");
  await agent.as("/api/device");
  // A refusal is timed as one that failed.
  assert.equal((await agent.as("/api/browser/desktop/input", { method: "POST", body: { action: { type: "click", x: 5, y: 5 } } })).status, 400);
  // The owner's own calls aren't an agent's.
  await f.call("/api/browser/agents");
  const calls = timings.list({ clientId: id });
  assert.deepEqual(calls.map((entry) => [entry.kind, entry.ok]).reverse(), [["describe", true], ["act", true], ["describe", true], ["act", false]]);
  const kept = JSON.stringify(calls);
  for (const secret of ["hunter2", "Balance", "1,234", "Search", "Bank", "query"]) assert.ok(!kept.includes(secret), secret);
  assert.ok(calls.every((entry) => entry.reachMs >= 0 && entry.reachMs < 5_000));
  assert.ok(calls.slice(0, -1).every((entry) => Number.isFinite(entry.agentMs)));
  // The owner reads its pace with what it did; the agent can't.
  const owner = await f.call(`/api/agents/actions?${new URLSearchParams({ clientId: id })}`);
  assert.equal(owner.status, 200, JSON.stringify(owner.body));
  assert.equal(owner.body.pace.length, 1);
  assert.equal(owner.body.pace[0].calls, 4);
  assert.deepEqual(Object.keys(owner.body.pace[0]).sort(), ["agentMs", "calls", "from", "reachMs", "to"]);
  assert.equal((await agent.as(`/api/agents/actions?clientId=${id}`)).status, 403);
  // Every agent at once (no clientId): no pace.
  assert.equal((await f.call("/api/agents/actions")).body.pace, undefined);
});
