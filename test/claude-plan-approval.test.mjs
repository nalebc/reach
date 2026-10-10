import test from "node:test";
import assert from "node:assert/strict";
import { claudeAnswer, describeClaudePrompt } from "../server/agent-sessions/claude-host.mjs";
import { startDom, settle } from "./dom/harness.mjs";

// A plan ready to go, as Claude Code 2.1.291 offers it: the plan in full,
// approved into a mode to work in (auto when it can, accept edits, ask each
// edit), or sent back with what to change.
const PLAN = "## Plan\n\n1. Add the card\n2. Test it\n" + "x".repeat(2000);
const request = (suggestions) => ({ tool_name: "ExitPlanMode", input: { plan: PLAN }, permission_suggestions: suggestions });

test("a plan shows whole, with Claude Code's own ways to start", () => {
  const p = describeClaudePrompt("p1", request([{ type: "setMode", mode: "auto", destination: "session" }, { type: "setMode", mode: "acceptEdits", destination: "session" }]));
  assert.equal(p.kind, "plan");
  assert.equal(p.plan, PLAN, "never cut short");
  assert.deepEqual(p.decisions, ["plan:auto", "plan:acceptEdits", "plan:default", "keepPlanning"]);
  // No suggestions: accept edits and ask each edit, never auto.
  assert.deepEqual(describeClaudePrompt("p2", request(undefined)).decisions, ["plan:acceptEdits", "plan:default", "keepPlanning"]);
});

test("approving switches the chat's mode for the session; keep planning says what to change", () => {
  const p = describeClaudePrompt("p1", request([{ type: "setMode", mode: "acceptEdits", destination: "session" }]));
  assert.deepEqual(claudeAnswer(p, { decision: "plan:acceptEdits" }), {
    behavior: "allow",
    updatedInput: { plan: PLAN },
    updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }],
  });
  assert.deepEqual(claudeAnswer(p, { decision: "keepPlanning", message: " Split step 2 " }), { behavior: "deny", message: "Split step 2" });
  assert.match(claudeAnswer(p, { decision: "keepPlanning" }).message, /Keep planning/);
  assert.throws(() => claudeAnswer(p, { decision: "plan:bypassPermissions" }), /not available/);
  assert.throws(() => claudeAnswer(p, { decision: "plan:auto" }), /not available/);
});

test("the phone shows the plan and sends the choice, or what to change", async () => {
  const dom = await startDom();
  try {
    // PromptCard isn't exported: render it the way a chat does, through a tiny harness module.
    const mod = await dom.load("/src/AgentSession.tsx");
    const PromptCard = mod.PromptCard;
    assert.equal(typeof PromptCard, "function", "PromptCard is exported for tests");
    const answers = [];
    const prompt = { id: "p1", kind: "plan", title: "Ready to start?", plan: "## Plan\n\n1. Add the card", decisions: ["plan:acceptEdits", "plan:default", "keepPlanning"] };
    const view = await dom.render(dom.React.createElement(PromptCard, { prompt, agent: "claude", logos: {}, word: "Mac", onAnswer: async (a) => answers.push(a) }));
    const c = view.container;
    assert.match(c.querySelector(".as-plan").textContent, /Add the card/);
    const buttons = [...c.querySelectorAll(".as-plan-actions button")].map((b) => b.textContent);
    assert.deepEqual(buttons, ["Yes, auto-accept edits", "Yes, manually approve edits"]);
    dom.update(() => c.querySelector(".as-plan-actions button").click());
    await settle();
    assert.deepEqual(answers[0], { decision: "plan:acceptEdits" });
    const input = c.querySelector('input[aria-label="What to change in the plan"]');
    dom.update(() => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value").set.call(input, "Split step 2");
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    dom.update(() => c.querySelector(".as-plan-feedback button").click());
    await settle();
    assert.deepEqual(answers[1], { decision: "keepPlanning", message: "Split step 2" });
    await view.unmount();
    assert.deepEqual(dom.errors, []);
  } finally {
    dom.close();
  }
});

// "Ran a command 1 failed" for a step the person said no to: declined, in
// Reach or on the Mac. Any other error stays a failure.
test("a tool the person declined reads as declined, not failed", async () => {
  const { parseClaudeTranscript } = await import("../server/agent-sessions/claude-transcript.mjs");
  const line = (e) => JSON.stringify(e) + "\n";
  const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
  const result = (id, content) => ({ type: "tool_result", tool_use_id: id, content, is_error: true });
  const source =
    line({ type: "user", uuid: "u1", parentUuid: null, cwd: "/w", message: { role: "user", content: "go" } }) +
    line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [
      tool("t1", "Bash", { command: "make deploy" }),
      tool("t2", "Write", { file_path: "/w/color.txt", content: "Red" }),
      tool("t3", "Bash", { command: "false" }),
    ] } }) +
    line({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [
      result("t1", "The user declined this from Reach."),
      result("t2", "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed."),
      result("t3", "Exit code 1"),
    ] } });
  const v = parseClaudeTranscript(source);
  assert.deepEqual(["t1", "t2", "t3"].map((id) => v.items.find((i) => i.id === id).status), ["declined", "declined", "failed"]);
});

test("Claude's edits show their diff; its todo list stands as it last left it", async () => {
  const { parseClaudeTranscript } = await import("../server/agent-sessions/claude-transcript.mjs");
  const line = (e) => JSON.stringify(e) + "\n";
  const tool = (id, name, input) => ({ type: "tool_use", id, name, input });
  const source =
    line({ type: "user", uuid: "u1", parentUuid: null, cwd: "/w", message: { role: "user", content: "go" } }) +
    line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [
      tool("t1", "TodoWrite", { todos: [{ content: "Add card", status: "completed", activeForm: "Adding card" }, { content: "Test it", status: "in_progress", activeForm: "Testing it" }, { content: "Ship", status: "pending", activeForm: "Shipping" }] }),
      tool("t2", "Edit", { file_path: "/w/src/a.ts", old_string: "const a = 1;", new_string: "const a = 2;\nconst b = 3;" }),
      tool("t3", "Write", { file_path: "/w/new.md", content: "x".repeat(20000) }),
    ] } }) +
    line({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: "ok" }] } });
  const v = parseClaudeTranscript(source);
  const edit = v.items.find((i) => i.id === "t2");
  assert.equal(edit.kind, "file-change");
  assert.equal(edit.detail, "--- a/src/a.ts\n+++ b/src/a.ts\n@@\n-const a = 1;\n+const a = 2;\n+const b = 3;");
  // A huge file is cut short, never kept whole.
  assert.ok(v.items.find((i) => i.id === "t3").detail.length < 13000);
  assert.equal(v.items.find((i) => i.id === "t1").text, "Updated the todo list");
  assert.deepEqual(v.todos, [
    { id: "0", text: "Add card", status: "completed" },
    { id: "1", text: "Testing it", status: "in_progress" },
    { id: "2", text: "Ship", status: "pending" },
  ]);
});

test("how full a chat's context is, as each agent counts it", async () => {
  const { parseClaudeTranscript } = await import("../server/agent-sessions/claude-transcript.mjs");
  const { createCodexLive } = await import("../server/agent-sessions/codex-live.mjs");
  const line = (e) => JSON.stringify(e) + "\n";
  const reply = (uuid, parentUuid, usage, extra = {}) =>
    line({ type: "assistant", uuid, parentUuid, message: { role: "assistant", model: "claude-opus-5-5", usage, content: [{ type: "text", text: "ok" }] }, ...extra });
  const v = parseClaudeTranscript(
    line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go" } }) +
      reply("a1", "u1", { input_tokens: 10, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000, output_tokens: 500 }) +
      // A sub-agent's own replies don't fill the chat's context.
      reply("s1", null, { input_tokens: 900000, output_tokens: 1 }, { isSidechain: true }),
  );
  assert.deepEqual(v.context, { used: 51510, window: null });
  const big = parseClaudeTranscript(line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "go" } }) + reply("a1", "u1", { input_tokens: 300000, output_tokens: 1 }));
  assert.equal(big.context.window, null, "usage alone does not establish capacity");
  // Codex says it itself.
  let notify;
  const live = createCodexLive({ daemon: { rpc: async () => ({}), onNotification: (fn) => (notify = fn), onRequest() {}, onClose() {} }, desktop: {} });
  notify({ method: "thread/tokenUsage/updated", params: { threadId: "t1", turnId: "x", tokenUsage: { last: { totalTokens: 64000 }, total: { totalTokens: 900000 }, modelContextWindow: 258000 } } });
  assert.deepEqual(live.contextOf("t1"), { used: 64000, window: 258000 });
  assert.equal(live.contextOf("t2"), null);
});

test("a chat shows as it stood at an earlier entry (a rewind waiting for its next message)", async () => {
  const { createClaudeTranscript } = await import("../server/agent-sessions/claude-transcript.mjs");
  const line = (e) => JSON.stringify(e) + "\n";
  const t = createClaudeTranscript();
  t.add(
    line({ type: "user", uuid: "u1", parentUuid: null, message: { role: "user", content: "first" } }) +
      line({ type: "assistant", uuid: "a1", parentUuid: "u1", message: { role: "assistant", content: [{ type: "text", text: "one" }] } }) +
      line({ type: "user", uuid: "u2", parentUuid: "a1", message: { role: "user", content: "second" } }) +
      line({ type: "assistant", uuid: "a2", parentUuid: "u2", message: { role: "assistant", content: [{ type: "text", text: "two" }] } }),
  );
  assert.equal(t.parentOf("u2"), "a1");
  assert.equal(t.parentOf("u1"), null);
  assert.deepEqual(t.view().items.map((i) => i.text), ["first", "one", "second", "two"]);
  assert.deepEqual(t.view({ from: "a1" }).items.map((i) => i.text), ["first", "one"]);
});
