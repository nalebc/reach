import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentAsks, hasAskRules, stillAsked, switchesAlone } from "../server/agent-sessions/agent-asks.mjs";
import { askKey } from "../server/agent-sessions/claude-transcript.mjs";

const SESSION = "34ab778a-0bc2-4a3d-a86b-887f8209431d";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await delay(5);
  return check();
};
// Exercise the broker's real connection handler without opening a socket.
// agent-asks.test.mjs separately covers the child hook.
function setup(t, options = {}) {
  let server;
  const create = net.createServer;
  net.createServer = (...args) => (server = create(...args));
  let asks;
  try {
    asks = createAgentAsks({ socketPath: "/unused-test.sock", everyMs: 5, unseenMs: 50, waiting: async () => true, ...options });
  } finally {
    net.createServer = create;
  }
  t.after(() => asks.close());
  const socket = new EventEmitter();
  socket.setEncoding = () => {};
  socket.end = (data) => {
    socket.result = JSON.parse(data);
    socket.emit("close");
  };
  socket.destroy = () => socket.emit("close");
  server.emit("connection", socket);
  const send = (tool_name, tool_input, extra = {}) =>
    socket.emit("data", JSON.stringify({ agent: "claude", session_id: SESSION, tool_name, tool_input, ...extra }) + "\n");
  return { asks, socket, send };
}
const questions = [
  { question: "Choose one", options: [{ label: "A" }, { label: "B" }] },
  { question: "Choose several", multiSelect: true, options: [{ label: "C" }, { label: "D" }] },
];

// Claude Code shows its dialog while the hook runs: the phone keeps the
// question however long it's read, someone using the Mac or not.
test("a question stays answerable on the phone while Claude Code waits on it", async (t) => {
  const { asks, socket, send } = setup(t);
  send("AskUserQuestion", { questions });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  await delay(80); // several checks, all still waiting
  const [prompt] = asks.prompts("claude", SESSION);
  assert.equal(prompt.questions.length, 2);
  assert.equal(prompt.canAnswerOnMac, undefined);
  assert.throws(() => asks.answer("codex", SESSION, prompt.id, { answers: {} }), { status: 409 });
  assert.throws(() => asks.answer("claude", SESSION, prompt.id, { answers: {} }), { status: 400 });
  asks.answer("claude", SESSION, prompt.id, { answers: { "Choose one": ["B"], "Choose several": ["C", "D"] } });
  assert.deepEqual(socket.result.decision.updatedInput.answers, { "Choose one": "B", "Choose several": "C, D" });
  assert.equal(asks.has("claude", SESSION), false);
});

// Answered on the Mac: Claude Code no longer waits (its registry says so at
// once). The ask ends with no decision, and a late tap is told why.
test("an answer on the Mac ends the phone's request with no decision", async (t) => {
  let waiting = true;
  const { asks, socket, send } = setup(t, { waiting: async () => waiting });
  send("Bash", { command: "npm test" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  const [prompt] = asks.prompts("claude", SESSION);
  waiting = false;
  assert.ok(await until(() => !asks.has("claude", SESSION)));
  assert.deepEqual(socket.result, {});
  assert.throws(() => asks.answer("claude", SESSION, prompt.id, { decision: "allow" }), /Answered on your/);
});

// Claude Code says it waits a moment after the hook starts: not seen waiting
// yet is not taken as answered until unseenMs has passed.
test("a request Claude Code hasn't reported yet isn't taken as answered at once", async (t) => {
  const { asks, socket, send } = setup(t, { waiting: async () => false, unseenMs: 200 });
  send("Bash", { command: "ls" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  await delay(60);
  assert.equal(asks.has("claude", SESSION), true);
  assert.ok(await until(() => !asks.has("claude", SESSION)));
  assert.deepEqual(socket.result, {});
});

// A mode for a chat Reach doesn't run goes in with the phone's next allow
// there (Claude Code's setMode); a plan's own pick wins; never Bypass.
test("a mode picked on the phone goes in with the next allow", async (t) => {
  const { asks, socket, send } = setup(t);
  assert.throws(() => asks.queueMode("claude", SESSION, "bypassPermissions"), { status: 400 });
  asks.queueMode("claude", SESSION, "acceptEdits");
  send("Bash", { command: "npm test" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  const [prompt] = asks.prompts("claude", SESSION);
  asks.answer("claude", SESSION, prompt.id, { decision: "allow" });
  assert.deepEqual(socket.result.decision.updatedPermissions, [{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  assert.equal(asks.queuedMode("claude", SESSION), null);
});

// "Make permission changing not UI dependent ... It should be a command line
// or direct method call" (2026-10-08): it waited for a tap on the phone.
test("a picked mode switches by itself on a step every mode takes without asking", async (t) => {
  const { asks, socket, send } = setup(t);
  const site = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-site-")));
  t.after(() => fs.rmSync(site, { recursive: true, force: true }));
  fs.mkdirSync(path.join(site, "src"));
  fs.writeFileSync(path.join(site, "src", "app.ts"), "");
  asks.queueMode("claude", SESSION, "auto");
  send("Read", { file_path: path.join(site, "src", "app.ts") }, { cwd: site });
  assert.ok(await until(() => socket.result));
  assert.deepEqual(socket.result.decision, { behavior: "allow", updatedPermissions: [{ type: "setMode", mode: "auto", destination: "session" }] });
  assert.equal(asks.has("claude", SESSION), false);
  assert.equal(asks.queuedMode("claude", SESSION), null);
});

test("a step that might have asked still asks the phone, with the picked mode going in on its allow", async (t) => {
  for (const [tool, input, mode] of [
    ["Read", { file_path: "/etc/hosts" }, "auto"],
    ["Edit", { file_path: "/work/site/a.ts" }, "plan"],
    ["Bash", { command: "ls" }, "auto"],
  ]) {
    const { asks, socket, send } = setup(t);
    asks.queueMode("claude", SESSION, mode);
    send(tool, input, { cwd: "/work/site" });
    assert.ok(await until(() => asks.has("claude", SESSION)), tool);
    assert.equal(socket.result, undefined);
    assert.equal(asks.queuedMode("claude", SESSION), mode);
  }
});

test("a denied request keeps the picked mode for the next one", async (t) => {
  const { asks, socket, send } = setup(t);
  asks.queueMode("claude", SESSION, "plan");
  send("Bash", { command: "rm -rf build" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  const [prompt] = asks.prompts("claude", SESSION);
  asks.answer("claude", SESSION, prompt.id, { decision: "deny" });
  assert.equal(socket.result.decision.behavior, "deny");
  assert.equal(socket.result.decision.updatedPermissions, undefined);
  assert.equal(asks.queuedMode("claude", SESSION), "plan");
});

// Answered on the Mac, the pick wasn't taken: no longer queued (every later
// tool call, reads too, was made to ask for it), and the phone sees the mode
// the chat is in. Taken another way (clearMode): the same.
test("a request answered on the Mac lets go of the picked mode", async (t) => {
  let waiting = true;
  const { asks, send } = setup(t, { waiting: async () => waiting });
  asks.queueMode("claude", SESSION, "acceptEdits");
  send("Bash", { command: "npm test" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  waiting = false;
  assert.ok(await until(() => !asks.has("claude", SESSION)));
  assert.equal(asks.queuedMode("claude", SESSION), null);
  asks.queueMode("claude", SESSION, "plan");
  asks.clearMode("claude", SESSION);
  assert.equal(asks.queuedMode("claude", SESSION), null);
});

// One odd registry read ("not waiting" once, then waiting again) doesn't
// take a request off the phone while the Mac still shows it.
test("one not-waiting read alone doesn't end a held request", async (t) => {
  const reads = [true, false, true, true, true, true, true, true];
  const { asks, send } = setup(t, { waiting: async () => (reads.length ? reads.shift() : true) });
  send("Bash", { command: "npm test" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  await until(() => !reads.length, 2000);
  assert.equal(asks.has("claude", SESSION), true);
});

// A read Reach can't tell about ("can't tell") is no evidence either way:
// it doesn't join two "not waiting" reads apart into a pair.
test("a can't-tell read between two not-waiting reads doesn't end a held request", async (t) => {
  const reads = [true, false, null, false, true, true, true, true];
  const { asks, send } = setup(t, { waiting: async () => (reads.length ? reads.shift() : true) });
  send("Bash", { command: "npm test" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  await until(() => !reads.length, 2000);
  assert.equal(asks.has("claude", SESSION), true);
});

// Review (Oct 9): asked again after a restart, a request was shown while
// Claude Code waited on anything at all, so one the Mac had answered came
// back. It's shown only when Reach can tell it's still that very request.
test("a request asked again is shown only when it's still the one Claude Code waits on", async (t) => {
  const seen = [];
  let still = false;
  const { asks, socket, send } = setup(t, { asking: async (agent, id, request) => (seen.push(request), still) });
  send("Bash", { command: "npm test" }, { again: true, tool_use_id: "toolu_1" });
  assert.ok(await until(() => socket.result));
  assert.deepEqual(socket.result, {});
  assert.equal(asks.has("claude", SESSION), false);
  assert.equal(seen[0].tool_use_id, "toolu_1");
  assert.equal(seen[0].key, askKey("Bash", { command: "npm test" }));
  still = true;
  const again = setup(t, { asking: async () => still });
  again.send("Bash", { command: "npm test" }, { again: true });
  assert.ok(await until(() => again.asks.has("claude", SESSION)));
});

test("a request asked again never takes a mode picked on the phone", async (t) => {
  const { asks, socket, send } = setup(t, { asking: async () => true });
  asks.queueMode("claude", SESSION, "auto");
  // A step every mode takes alone: not allowed by Reach itself on a re-ask.
  send("TodoWrite", { todos: [] }, { again: true });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  assert.equal(socket.result, undefined);
  const [prompt] = asks.prompts("claude", SESSION);
  asks.answer("claude", SESSION, prompt.id, { decision: "allow" });
  assert.equal(socket.result.decision.behavior, "allow");
  assert.equal(socket.result.decision.updatedPermissions, undefined);
  assert.equal(asks.queuedMode("claude", SESSION), "auto");
  // Nor lets go of it when the Mac answers it.
  let waiting = true;
  const mac = setup(t, { asking: async () => true, waiting: async () => waiting });
  mac.asks.queueMode("claude", SESSION, "plan");
  mac.send("Bash", { command: "ls" }, { again: true });
  assert.ok(await until(() => mac.asks.has("claude", SESSION)));
  waiting = false;
  assert.ok(await until(() => !mac.asks.has("claude", SESSION)));
  assert.equal(mac.asks.queuedMode("claude", SESSION), "plan");
});

// What a re-ask is checked against: Claude Code's registry waiting on a
// permission (a question: "input needed"), and a running call in its
// transcript that is this request (by its id, else its tool and input).
test("a re-asked request matches Claude Code's wait and its running call", () => {
  const key = askKey("Bash", { command: "npm test" });
  const running = [{ id: "toolu_1", role: "tool", status: "running", key }];
  const bash = { tool_name: "Bash", key };
  assert.equal(stillAsked("permission prompt", running, bash), true);
  assert.equal(stillAsked("dialog open", running, bash), false);
  assert.equal(stillAsked("input needed", running, bash), false);
  assert.equal(stillAsked(null, running, bash), false);
  // Answered on the Mac and on to another call: not this one.
  assert.equal(stillAsked("permission prompt", [{ ...running[0], status: "completed" }, { id: "toolu_2", role: "tool", status: "running", key: askKey("Bash", { command: "rm -rf build" }) }], bash), false);
  assert.equal(stillAsked("permission prompt", [], bash), false);
  // By id when Claude Code gives one.
  assert.equal(stillAsked("permission prompt", running, { ...bash, tool_use_id: "toolu_1" }), true);
  assert.equal(stillAsked("permission prompt", running, { ...bash, tool_use_id: "toolu_9" }), false);
  // The transcript can't be read: the registry alone.
  assert.equal(stillAsked("permission prompt", null, bash), true);
  const ask = { tool_name: "AskUserQuestion", key: askKey("AskUserQuestion", { questions }) };
  assert.equal(stillAsked("input needed", [{ id: "q", role: "tool", status: "running", key: ask.key }], ask), true);
  // The key reads the input whole, in any key order.
  assert.equal(askKey("Edit", { a: 1, b: { c: 2, d: 3 } }), askKey("Edit", { b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(askKey("Edit", { a: 1 }), askKey("Write", { a: 1 }));
});

// Reach quitting answers "ask again", not the Mac's empty answer: the hook
// asks the next Reach (agent-asks.test.mjs runs it end to end).
test("a request held when Reach quits is told to ask again", async (t) => {
  const { asks, socket, send } = setup(t);
  send("Bash", { command: "npm test" });
  assert.ok(await until(() => asks.has("claude", SESSION)));
  asks.close();
  assert.deepEqual(socket.result, { retry: true });
});

// Fail-open audit (Oct 8): Reach can't see why Claude Code asked, so only a
// read it reads whole switches alone. Edits (a sensitive file, the person's
// own ask rules) and anything unclear go to the phone.
test("only a read Reach reads whole switches alone", (t) => {
  const site = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-site-")));
  const away = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-away-")));
  t.after(() => [site, away].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  fs.writeFileSync(path.join(site, "a.ts"), "");
  fs.mkdirSync(path.join(site, ".claude"));
  fs.writeFileSync(path.join(site, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(site, ".env"), "");
  fs.writeFileSync(path.join(away, "id_ed25519"), "");
  fs.symlinkSync(path.join(away, "id_ed25519"), path.join(site, "link"));
  const at = (name) => path.join(site, name);
  assert.equal(switchesAlone("Read", { file_path: at("a.ts") }, site, "auto", { askRules: () => false }), true);
  assert.equal(switchesAlone("Glob", { pattern: "**/*.ts" }, site, "auto", { askRules: () => false }), true);
  assert.equal(switchesAlone("Grep", { pattern: "x", path: site, output_mode: "content" }, site, "auto", { askRules: () => false }), true);
  assert.equal(switchesAlone("TodoWrite", { todos: [] }, site, "auto"), true);
  for (const [why, tool, input, mode] of [
    ["an edit in acceptEdits", "Write", { file_path: at(".claude/settings.json"), content: '{"permissions":{"allow":["Bash"]}}' }, "acceptEdits"],
    ["an edit in auto", "Edit", { file_path: at("a.ts"), old_string: "", new_string: "x" }, "auto"],
    ["a hidden folder", "Read", { file_path: at(".claude/settings.json") }, "auto"],
    ["a hidden file", "Read", { file_path: at(".env") }, "auto"],
    ["a link out of the folder", "Read", { file_path: at("link") }, "auto"],
    ["a home path", "Read", { file_path: "~/.ssh/id_rsa" }, "auto"],
    ["a home folder", "Glob", { pattern: "*", path: "~" }, "auto"],
    ["a relative path", "Read", { file_path: "a.ts" }, "auto"],
    ["no path field", "Read", { paths: ["/etc/passwd"] }, "auto"],
    ["a second path", "Read", { file_path: at("a.ts"), path: "/etc" }, "auto"],
    ["a path in the pattern", "Glob", { pattern: "/etc/*" }, "auto"],
    ["climbing in the pattern", "Glob", { pattern: "../**" }, "auto"],
    ["outside", "Read", { file_path: "/etc/hosts" }, "auto"],
    ["a file that isn't there", "Read", { file_path: at("missing.ts") }, "auto"],
    ["no input", "Read", null, "auto"],
    ["no folder", "Read", { file_path: at("a.ts") }, undefined],
    ["a tool Reach doesn't know", "ReadEverything", { file_path: at("a.ts") }, "auto"],
  ])
    assert.equal(switchesAlone(tool, input, why === "no folder" ? undefined : site, mode), false, why);
});

// Claude Code's hook doesn't say which ask was Reach's: the person's own ask
// rules (Read(./private/**), say) mean nothing switches alone.
test("with ask rules of the person's own, nothing switches alone", (t) => {
  const site = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-site-")));
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reach-home-")));
  t.after(() => [site, home].forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  fs.mkdirSync(path.join(site, "private"));
  fs.writeFileSync(path.join(site, "private", "notes.md"), "");
  const read = { file_path: path.join(site, "private", "notes.md") };
  const rules = (cwd) => hasAskRules(cwd, { home });
  assert.equal(switchesAlone("Read", read, site, "auto", { askRules: rules }), true);
  fs.mkdirSync(path.join(site, ".claude"));
  fs.writeFileSync(path.join(site, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: ["Read(./private/**)"] } }));
  assert.equal(switchesAlone("Read", read, site, "auto", { askRules: rules }), false);
  fs.writeFileSync(path.join(site, ".claude", "settings.local.json"), "{ not json");
  assert.equal(switchesAlone("Read", read, site, "auto", { askRules: rules }), false);
  fs.writeFileSync(path.join(site, ".claude", "settings.local.json"), JSON.stringify({ permissions: { ask: [] } }));
  assert.equal(switchesAlone("Read", read, site, "auto", { askRules: rules }), true);
});
