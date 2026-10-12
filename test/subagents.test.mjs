import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeSubagents, codexSubagents, doing, QUIET_MS, subagentStatus } from "../server/agent-sessions/subagents.mjs";
import { parseClaudeTranscript, taskNotes } from "../server/agent-sessions/claude-transcript.mjs";
import { codexItem } from "../server/agent-sessions/codex.mjs";
import { startDom, settle } from "./dom/harness.mjs";

const SESSION = "71515635-04b1-4660-94db-f68afb96f266";
const line = (e) => JSON.stringify(e) + "\n";
// A chat with three sub-agents, as Claude Code 2.1.291 writes them: a
// background one that finished (noted), one still working, and a foreground
// one whose call returned.
function chat() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "reach-subagents-"));
  const transcript = path.join(project, `${SESSION}.jsonl`);
  const agentCall = (id, description, type, background) => ({
    type: "tool_use",
    id,
    name: "Agent",
    input: { description, subagent_type: type, prompt: "…", ...(background ? { run_in_background: true } : {}) },
  });
  const note = (ids, calls, status) =>
    `<task-notification>\n${ids.map((id, i) => `<task-id>${id}</task-id>\n<tool-use-id>${calls[i]}</tool-use-id>`).join("\n")}\n<status>${status}</status>\n<summary>Agent "x" finished</summary>\n</task-notification>`;
  fs.writeFileSync(
    transcript,
    line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "Audit it" }, timestamp: "2026-10-07T19:00:00Z", sessionId: SESSION, cwd: "/w" }) +
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [agentCall("toolu_bg1", "Audit Claude", "Explore", true), agentCall("toolu_bg2", "Fix macOS", "general-purpose", true), agentCall("toolu_fg", "Find the file", "Explore", false)] }, timestamp: "2026-10-07T19:00:01Z" }) +
      line({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_bg1", content: "Async agent launched successfully." }, { type: "tool_result", tool_use_id: "toolu_bg2", content: "Async agent launched successfully." }, { type: "tool_result", tool_use_id: "toolu_fg", content: "It's in server/x.mjs" }] }, timestamp: "2026-10-07T19:00:02Z" }) +
      line({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-07T19:05:00Z", content: note(["agent-done1"], ["toolu_bg1"], "completed") }),
  );
  const dir = path.join(project, SESSION, "subagents");
  fs.mkdirSync(dir, { recursive: true });
  const agent = (id, meta, lines) => {
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta));
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), lines.map(line).join(""));
  };
  agent("agent-done1", { agentType: "Explore", description: "Audit Claude", toolUseId: "toolu_bg1", requestShape: "background" }, [
    { type: "user", isSidechain: true, message: { role: "user", content: "Audit" }, timestamp: "2026-10-07T19:00:01Z" },
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "Found **3** problems." }] }, timestamp: "2026-10-07T19:04:59Z" },
  ]);
  agent("agent-busy2", { agentType: "general-purpose", description: "Fix macOS", toolUseId: "toolu_bg2", requestShape: "background" }, [
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/server/platform.mjs" } }] }, timestamp: "2026-10-07T19:01:00Z" },
  ]);
  agent("agent-fg3", { agentType: "Explore", description: "Find the file", toolUseId: "toolu_fg" }, [
    { type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "It's in server/x.mjs" }] }, timestamp: "2026-10-07T19:00:02Z" },
  ]);
  return { project, transcript, dir };
}
const made = [];
after(() => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

test("a task notification can tell of several agents, and only well-formed ids count", () => {
  const text = "<task-notification>\n<task-id>a1</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<task-id>a2</task-id>\n<tool-use-id>toolu_2</tool-use-id>\n<task-id>../x</task-id>\n<status>stopped</status>\n</task-notification>";
  assert.deepEqual(
    taskNotes(text).map((n) => [n.id, n.toolUseId, n.status]),
    [
      ["a1", "toolu_1", "stopped"],
      ["a2", "toolu_2", "stopped"],
    ],
  );
  assert.deepEqual(taskNotes(null), []);
  assert.equal(subagentStatus("pendingInit"), "running");
  assert.equal(subagentStatus("errored"), "failed");
  assert.equal(subagentStatus("something new"), null);
  assert.equal(doing("Read", { file_path: "/a/b/App.tsx" }), "Reading App.tsx");
});

test("a Claude chat's sub-agents: done with its last words, running with what it's doing, foreground ended by its call", async () => {
  const { project, transcript, dir } = chat();
  made.push(project);
  const parsed = parseClaudeTranscript(fs.readFileSync(transcript, "utf8"));
  // The Agent calls are agent items, not generic tools.
  assert.deepEqual(
    parsed.items.filter((i) => i.kind === "agent").map((i) => [i.text, i.agentType, i.background]),
    [
      ["Audit Claude", "Explore", true],
      ["Fix macOS", "general-purpose", true],
      ["Find the file", "Explore", false],
    ],
  );
  const now = Date.now();
  const agents = await claudeSubagents({ transcript, sessionId: SESSION, notes: parsed.tasks, items: parsed.items, now });
  const by = Object.fromEntries(agents.map((a) => [a.id, a]));
  assert.equal(by["agent-done1"].status, "done");
  assert.equal(by["agent-done1"].result, "Found **3** problems.");
  assert.equal(by["agent-busy2"].status, "running");
  assert.equal(by["agent-busy2"].activity, "Reading platform.mjs");
  assert.equal(by["agent-busy2"].background, true);
  assert.equal(by["agent-fg3"].status, "done");
  assert.equal(by["agent-fg3"].toolUseId, "toolu_fg");
  // Nothing new from a running one for a long while: it went quiet.
  const later = await claudeSubagents({ transcript, sessionId: SESSION, notes: parsed.tasks, items: parsed.items, now: now + QUIET_MS + 60000 });
  assert.equal(later.find((a) => a.id === "agent-busy2").status, "quiet");
  // Files reshaped or missing: fewer details, never an error.
  fs.writeFileSync(path.join(dir, "agent-agent-busy2.meta.json"), "{not json");
  fs.writeFileSync(path.join(dir, "agent-agent-done1.jsonl"), "garbage\n");
  const reshaped = await claudeSubagents({ transcript, sessionId: SESSION, notes: parsed.tasks, items: parsed.items, now });
  assert.deepEqual(reshaped.map((a) => a.id).sort(), ["agent-busy2", "agent-done1", "agent-fg3"]);
  assert.equal(reshaped.find((a) => a.id === "agent-done1").result, 'Agent "x" finished');
  assert.deepEqual(await claudeSubagents({ transcript, sessionId: "../../etc", notes: [], items: [] }), []);
  assert.deepEqual(await claudeSubagents({ transcript: path.join(project, "none.jsonl"), sessionId: "abc", notes: [], items: [] }), []);
});

test("a workflow's agents show too: one folder per run, ended as its journal says", async () => {
  const { project, transcript, dir } = chat();
  made.push(project);
  const run = path.join(dir, "workflows", "wf_1234-abc");
  fs.mkdirSync(run, { recursive: true });
  for (const [id, label] of [["w1", "investigate:parity"], ["w2", "investigate:send"]]) {
    fs.writeFileSync(path.join(run, `agent-${id}.meta.json`), JSON.stringify({ agentType: "workflow-subagent", description: label, workflowPhase: "Investigate", requestShape: "foreground" }));
    fs.writeFileSync(path.join(run, `agent-${id}.jsonl`), line({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/w/a.mjs" } }] }, timestamp: "2026-10-09T09:00:00Z" }));
  }
  fs.writeFileSync(
    path.join(run, "journal.jsonl"),
    line({ type: "launched" }) +
      line({ type: "started", agentId: "w1", label: "investigate:parity" }) +
      line({ type: "started", agentId: "w2", label: "investigate:send" }) +
      line({ type: "result", key: "v2:abc", agentId: "w1" }) +
      line({ type: "something-new", agentId: "w2" }) +
      "not json\n",
  );
  const parsed = parseClaudeTranscript(fs.readFileSync(transcript, "utf8"));
  const by = Object.fromEntries((await claudeSubagents({ transcript, sessionId: SESSION, notes: parsed.tasks, items: parsed.items })).map((a) => [a.id, a]));
  assert.equal(by.w1.name, "investigate:parity");
  assert.equal(by.w1.phase, "Investigate");
  assert.equal(by.w1.workflow, true);
  assert.equal(by["agent-busy2"].workflow, undefined);
  assert.equal(by.w1.status, "done");
  // An entry Reach doesn't know never ends an agent.
  assert.equal(by.w2.status, "running");
  assert.equal(by.w2.activity, "Reading a.mjs");
  // The chat's own sub-agents are still there.
  assert.equal(by["agent-done1"].status, "done");
});

test("Codex's sub-agents come from its own collab items, with their reported status", () => {
  const spawn = { type: "collabAgentToolCall", id: "c1", tool: "spawnAgent", status: "completed", prompt: "Check the tests\nthoroughly", model: "gpt-5", senderThreadId: "t0", receiverThreadIds: ["t1"], agentsStates: { t1: { status: "pendingInit", message: null } } };
  const wait = { type: "collabAgentToolCall", id: "c2", tool: "wait", status: "completed", senderThreadId: "t0", receiverThreadIds: ["t1"], agentsStates: { t1: { status: "completed", message: "All green." } } };
  assert.deepEqual(
    codexSubagents([spawn, wait]).map((a) => [a.id, a.name, a.status, a.result]),
    [["t1", "Check the tests\nthoroughly", "done", "All green."]],
  );
  assert.deepEqual(codexItem({ item: spawn }), {
    id: "c1",
    role: "tool",
    kind: "agent",
    text: "Check the tests",
    agentType: "gpt-5",
    background: true,
    agentId: "t1",
    agentStatus: "running",
    detail: "",
    status: "completed",
    at: undefined,
    turnId: undefined,
  });
  assert.equal(codexItem({ item: wait }).text, "Waiting for agents");
});

test("the phone shows each sub-agent where the chat started it, and how many still run", async () => {
  const dom = await startDom();
  try {
    const { SubagentCard, SubagentBadge } = await dom.load("/src/Subagents.tsx");
    const R = dom.React;
    const agents = [
      { id: "a2", toolUseId: "toolu_2", name: "Fix macOS", type: "general-purpose", background: true, status: "running", activity: "Reading platform.mjs", result: "", startedAt: 0, updatedAt: 0 },
      { id: "a1", toolUseId: "toolu_1", name: "Audit Claude", type: "Explore", background: true, status: "done", activity: "", result: "Found **3** problems.", startedAt: 0, updatedAt: 0 },
    ];
    const view = await dom.render(
      R.createElement(
        "div",
        null,
        R.createElement(SubagentBadge, { agents }),
        R.createElement(SubagentCard, { item: { id: "toolu_1", role: "tool", kind: "agent", text: "Audit Claude", background: true }, agent: agents[1] }),
        R.createElement(SubagentCard, { item: { id: "toolu_2", role: "tool", kind: "agent", text: "Fix macOS", background: true }, agent: agents[0] }),
      ),
    );
    const c = view.container;
    // A small sign with how many run; the list only on a tap.
    const badge = c.querySelector(".sa-badge");
    assert.equal(badge.getAttribute("aria-label"), "1 agent running");
    assert.equal(badge.querySelector("small").textContent, "1");
    assert.equal(c.querySelector(".sa-menu"), null);
    dom.update(() => badge.click());
    await settle();
    assert.deepEqual([...c.querySelectorAll(".sa-menu .sa-strip-list strong")].map((s) => s.textContent), ["Fix macOS"]);
    assert.match(c.querySelector(".sa-menu").textContent, /Reading platform\.mjs/);
    // Each card is one quiet line: no details until it's opened.
    assert.equal(c.querySelector("#subagent-toolu_2").textContent, "Fix macOS");
    const done = c.querySelector("#subagent-toolu_1 .sa-card-head");
    dom.update(() => done.click());
    await settle();
    assert.match(c.querySelector("#subagent-toolu_1 .sa-result").textContent, /Found 3 problems/);
    const running = c.querySelector("#subagent-toolu_2 .sa-card-head");
    dom.update(() => running.click());
    await settle();
    assert.match(c.querySelector("#subagent-toolu_2").textContent, /Agent · background · Running · Reading platform\.mjs/);
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    dom.close();
  }
});

test("a sub-agent writing its own transcript tells its chat changed", async () => {
  const { createAgentWatch } = await import("../server/agent-sessions/agent-watch.mjs");
  const listeners = new Map();
  const watch = createAgentWatch({
    watch: (dir, options, listener) => (listeners.set(dir, listener), { on() {}, unref() {}, close() {} }),
    claudeProjects: "/projects",
    debounceMs: 1,
  });
  const told = [];
  watch.onChange((news) => told.push(news));
  listeners.get("/projects")("change", `-Users-me-site/${SESSION}/subagents/agent-a28230b100dfc3978.jsonl`);
  listeners.get("/projects")("change", "-Users-me-site/other/subagents/agent-x.jsonl");
  // A workflow's agent, one folder down, tells its chat too.
  const OTHER = "8ec9aa10-513d-46d2-82ab-e51b3ac7a965";
  listeners.get("/projects")("change", `-Users-me-site/${OTHER}/subagents/workflows/wf_37c2-72d/agent-a1.jsonl`);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(told.sort((a, b) => a.id.localeCompare(b.id)), [{ agent: "claude", kind: "history", id: SESSION }, { agent: "claude", kind: "history", id: OTHER }]);
  watch.close();
});
