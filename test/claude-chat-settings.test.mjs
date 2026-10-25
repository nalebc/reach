import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { createClaudeHost } from "../server/agent-sessions/claude-host.mjs";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createDesktopAutomation } from "../server/desktop-automation.mjs";

// The effort, folder and window a Claude chat really has (bug hunt, Oct 9).
const ID = "11111111-2222-4333-8444-555555555555";
const line = (o) => JSON.stringify(o);
const at = (s) => new Date(Date.UTC(2026, 9, 9, 10, 0, s)).toISOString();
const user = (uuid, parentUuid, cwd, text = "go") => line({ type: "user", uuid, parentUuid, cwd, sessionId: ID, timestamp: at(0), message: { role: "user", content: text } });
const reply = (uuid, parentUuid, cwd, extra = {}) =>
  line({ type: "assistant", uuid, parentUuid, cwd, sessionId: ID, timestamp: at(1), message: { model: "claude-haiku-5-5", content: [{ type: "text", text: "ok" }] }, ...extra });

test("a Claude chat's effort is the one its latest reply ran at, read as a word; unknown is null", () => {
  assert.equal(parseClaudeTranscript([user("u1", null, "/p"), reply("a1", "u1", "/p", { effort: "low", perTurnEffort: "low" })].join("\n")).effort, "low");
  // The newest main-chain reply wins; a sub-agent's never does.
  const later = [
    user("u1", null, "/p"),
    reply("a1", "u1", "/p", { effort: "max" }),
    user("u2", "a1", "/p"),
    reply("a2", "u2", "/p", { effort: "medium" }),
    reply("s1", "a2", "/p", { effort: "low", isSidechain: true }),
  ];
  assert.equal(parseClaudeTranscript(later.join("\n")).effort, "medium");
  // A level Claude Code adds later shows by its own name.
  assert.equal(parseClaudeTranscript([user("u1", null, "/p"), reply("a1", "u1", "/p", { perTurnEffort: "ultra" })].join("\n")).effort, "ultra");
  // Not a word, or a reply that names none: unknown, never a guess.
  assert.equal(parseClaudeTranscript([user("u1", null, "/p"), reply("a1", "u1", "/p", { effort: { level: "high" } })].join("\n")).effort, null);
  assert.equal(parseClaudeTranscript([user("u1", null, "/p"), reply("a1", "u1", "/p", { effort: "high" }), user("u2", "a1", "/p"), reply("a2", "u2", "/p")].join("\n")).effort, null);
});

test("a Claude chat's folder is where it began, never where a Bash cd left its shell", () => {
  const parsed = parseClaudeTranscript([user("u1", null, "/p"), reply("a1", "u1", "/p"), user("r1", "a1", "/p/sub"), reply("a2", "r1", "/p/sub")].join("\n"));
  assert.equal(parsed.cwd, "/p");
});

async function store(t, { record, lines, folder = "-p" }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "projects", folder), { recursive: true });
  await fs.mkdir(path.join(root, "records", "acct", "org"), { recursive: true });
  await fs.writeFile(path.join(root, "projects", folder, `${ID}.jsonl`), lines.join("\n") + "\n");
  if (record) await fs.writeFile(path.join(root, "records", "acct", "org", `local_${ID}.json`), JSON.stringify({ sessionId: `local_${ID}`, cliSessionId: ID, isArchived: false, ...record }));
  return createClaudeSessions({ projects: path.join(root, "projects"), appRecords: path.join(root, "records") });
}

test("a chat Reach started (no app record) lists the effort it ran at and its own folder", async (t) => {
  const claude = await store(t, { lines: [user("u1", null, "/p"), reply("a1", "u1", "/p", { effort: "low" }), user("r1", "a1", "/p/sub"), reply("a2", "r1", "/p/sub", { effort: "low" })] });
  const [listed] = await claude.list();
  assert.equal(listed.effort, "low");
  assert.equal(listed.cwd, "/p");
  assert.equal((await claude.read(ID, { limit: 1 })).session.effort, "low");
  assert.deepEqual((await claude.starts()).map((s) => s.cwd), ["/p"]);
});

test("a chat moved to another folder keeps the one its transcript is kept under", async (t) => {
  const claude = await store(t, { lines: [user("u1", null, "/scratch/x"), reply("a1", "u1", "/scratch/x"), user("u2", "a1", "/p"), reply("a2", "u2", "/p"), user("r1", "a2", "/p/sub"), reply("a3", "r1", "/p/sub")] });
  assert.equal((await claude.list())[0].cwd, "/p");
});

test("the Claude app's record decides a chat's effort, folder and project; its Ultracode shows", async (t) => {
  const claude = await store(t, {
    folder: "-r--claude-worktrees-w",
    record: { cwd: "/r/.claude/worktrees/w", originCwd: "/r", effort: "xhigh", sessionSettings: { ultracode: true } },
    lines: [user("u1", null, "/r/.claude/worktrees/w"), reply("a1", "u1", "/r/.claude/worktrees/w", { effort: "medium" }), user("r1", "a1", "/side-session-notes/local_x"), reply("a2", "r1", "/side-session-notes/local_x", { effort: "medium" })],
  });
  const { session } = await claude.read(ID, { limit: 1 });
  // The app's pick applies before the next turn: it comes first.
  assert.equal(session.effort, "xhigh");
  assert.equal(session.appEffort, "xhigh");
  // A worktree chat runs in its worktree and groups under its repo.
  assert.equal(session.cwd, "/r/.claude/worktrees/w");
  assert.equal(session.project, "/r");
  assert.equal(session.ultracode, true);
});

test("Ultracode is read only when the app's record says true", async (t) => {
  for (const sessionSettings of [{ ultracode: false }, { ultracode: "yes" }, undefined]) {
    const claude = await store(t, { record: { cwd: "/p", ...(sessionSettings ? { sessionSettings } : {}) }, lines: [user("u1", null, "/p"), reply("a1", "u1", "/p", { effort: "medium" })] });
    const { session } = await claude.read(ID, { limit: 1 });
    assert.equal(session.ultracode, undefined);
    // No effort in the record: the level its latest reply ran at.
    assert.equal(session.effort, "medium");
    assert.equal(session.appEffort, null);
  }
});

// Claude Code in stream-json mode, played by a fake that answers its handshake.
function fakeClaude() {
  const runs = [];
  const spawn = (file, args, options) => {
    const proc = new EventEmitter();
    Object.assign(proc, { file, args, options, exitCode: null, lines: [], stdout: new EventEmitter(), stderr: new EventEmitter() });
    proc.print = (message) => proc.stdout.emit("data", `${JSON.stringify(message)}\n`);
    proc.kill = () => { proc.exitCode = 143; proc.emit("exit", 143); };
    proc.stdin = {
      on() {},
      end() {},
      write(text, callback) {
        for (const l of text.split("\n").filter(Boolean)) {
          const message = JSON.parse(l);
          proc.lines.push(message);
          if (message.type === "control_request")
            queueMicrotask(() => proc.print({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } }));
        }
        callback?.();
      },
    };
    runs.push(proc);
    return proc;
  };
  return { runs, spawn, last: () => runs.at(-1) };
}
const host = (claude) => createClaudeHost({ locate: async () => "/usr/local/bin/claude", spawn: claude.spawn, env: { PATH: "/usr/bin", HOME: "/Users/me" } });

test("Reach's own Claude Code says what it launched a chat with, and the window Claude Code reports", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await h.send(ID, { text: "one", cwd: "/p", model: "haiku", effort: "low" });
  assert.deepEqual(h.settingsOf(ID), { model: "haiku", effort: "low", mode: null });
  assert.equal(h.contextWindow(ID, "claude-opus-5-5"), null);
  claude.last().print({ type: "result", subtype: "success", is_error: false, modelUsage: { "claude-opus-5-5": { contextWindow: 1000000 }, odd: { contextWindow: "big" } } });
  assert.equal(h.contextWindow(ID, "claude-opus-5-5"), 1000000);
  assert.equal(h.contextWindow(ID, "odd"), null);
  assert.equal(h.settingsOf("22222222-2222-4222-8222-222222222222"), null);
  // Review (Oct 9): kept by model alone, one chat's 1M window showed in
  // every other chat on that model. Only the chat's own result counts.
  assert.equal(h.contextWindow("22222222-2222-4222-8222-222222222222", "claude-opus-5-5"), null);
});

test("a Claude app chat in Ultracode stays in it when Reach continues it", async () => {
  const claude = fakeClaude();
  const h = host(claude);
  await h.send(ID, { text: "one", cwd: "/p", effort: "xhigh", ultracode: true });
  const args = claude.last().args;
  assert.deepEqual(args.slice(args.indexOf("--settings"), args.indexOf("--settings") + 2), ["--settings", '{"ultracode":true}']);
  claude.last().print({ type: "result", subtype: "success", is_error: false });
  // Turned off in the app: the next launch goes without it.
  await h.send(ID, { text: "two", ultracode: false });
  assert.equal(claude.runs.length, 2);
  assert.equal(claude.last().args.includes("--settings"), false);
});

const sessionsWith = ({ claude, claudeHost, ...rest }) =>
  createAgentSessions({
    daemon: { rpc: async () => ({}), onNotification() {}, onRequest() {}, onClose() {} },
    codex: { list: async () => [], health: async () => ({}), read: async () => ({}) },
    claude: { list: async () => [], starts: async () => [], health: async () => ({ agent: "claude", installed: true, signedIn: true }), ...claude },
    claudeHost: { onRelease() {}, drives: () => false, running: () => false, ...claudeHost },
    live: async () => new Map(),
    signIn: {},
    liveMs: -1,
    claudeImports: { add: async () => {}, close() {} },
    ...rest,
  });

test("while Reach runs a chat, it reads as launched (model and effort) from the first frame", async (t) => {
  const bare = { agent: "claude", id: ID, cwd: "/p", status: "idle", inApp: false, model: null, effort: null, updatedAt: Date.now() };
  const sessions = sessionsWith({
    claude: { list: async () => [{ ...bare }], read: async () => ({ session: { ...bare }, items: [], before: null }) },
    claudeHost: {
      drives: () => true,
      running: () => true,
      settingsOf: () => ({ model: "haiku", effort: "low", mode: "manual" }),
      view: () => ({ status: "running", version: 1, prompts: [], streaming: "", activity: null, error: null, items: 0 }),
    },
  });
  t.after(() => sessions.close());
  const { session } = await sessions.read("claude", ID);
  assert.deepEqual([session.model, session.effort], ["haiku", "low"]);
  const [listed] = (await sessions.list()).sessions;
  assert.deepEqual([listed.model, listed.effort], ["haiku", "low"]);
});

test("a chat's context window is the one Claude Code reported for its model", async (t) => {
  const sessions = sessionsWith({
    claude: { read: async () => ({ session: { agent: "claude", id: ID, cwd: "/p", status: "idle", model: "claude-opus-5-5", context: { used: 300000, window: null } }, items: [], before: null }) },
    claudeHost: { contextWindow: (id, model) => (id === ID && model === "claude-opus-5-5" ? 1000000 : null) },
  });
  t.after(() => sessions.close());
  assert.deepEqual((await sessions.read("claude", ID)).session.context, { used: 300000, window: 1000000 });
});

test("Reach continues a chat at its own effort when no new one was picked", async (t) => {
  const sent = [];
  let session = { agent: "claude", id: ID, cwd: "/p", status: "idle", inApp: false, effort: "max" };
  const sessions = sessionsWith({
    claude: { read: async () => ({ session: { ...session }, items: [], before: null }) },
    claudeHost: { modeOf: () => null, send: async (id, message) => (sent.push(message), { turnId: null }) },
  });
  t.after(() => sessions.close());
  await sessions.send("claude", ID, { text: "go on" });
  assert.equal(sent.at(-1).effort, "max");
  // A pick goes instead.
  await sessions.send("claude", ID, { text: "quick", effort: "low" });
  assert.equal(sent.at(-1).effort, "low");
  // Unknown: none named (Claude Code's own default), never a guess.
  session = { ...session, effort: null };
  await sessions.send("claude", ID, { text: "again" });
  assert.equal("effort" in sent.at(-1), false);
});

// Review (Oct 9): the level a chat last ran at went to --effort as is,
// though the model it goes on with may not take it (a Max chat moved to
// Haiku, a level a newer Claude Code wrote). Only one the model takes.
test("Reach continues a chat at its own effort only when the model takes that level", async (t) => {
  const sent = [];
  let session = { agent: "claude", id: ID, cwd: "/p", status: "idle", inApp: false, model: "claude-haiku-5-5", effort: "max" };
  let catalog = async () => [
    { value: "haiku", resolvedModel: "claude-haiku-5-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] },
    { value: "sonnet", resolvedModel: "claude-sonnet-5", supportsEffort: false },
  ];
  const sessions = sessionsWith({
    claude: { read: async () => ({ session: { ...session }, items: [], before: null }) },
    claudeHost: { modeOf: () => null, models: () => catalog(), send: async (id, message) => (sent.push(message), { turnId: null }) },
  });
  t.after(() => sessions.close());
  const effortOf = async (body = {}) => (await sessions.send("claude", ID, { text: "go on", ...body }), sent.at(-1).effort);
  assert.equal(await effortOf(), undefined);
  session = { ...session, effort: "medium" };
  assert.equal(await effortOf(), "medium");
  // Moved to a model without levels: none.
  assert.equal(await effortOf({ model: "sonnet" }), undefined);
  // A pick goes as picked.
  assert.equal(await effortOf({ effort: "max" }), "max");
  // The catalog can't be read: the levels Claude Code knows.
  catalog = async () => { throw new Error("no handshake"); };
  session = { ...session, effort: "xhigh" };
  assert.equal(await effortOf(), "xhigh");
  session = { ...session, effort: "ultra" };
  assert.equal(await effortOf(), undefined);
});

// Reach runs it, launched without a level (Claude Code's own): the level the
// transcript says it ran at is that one, not a new pick that relaunches it.
test("a chat Reach runs, launched without an effort, isn't relaunched for the level it ran at", async (t) => {
  const sent = [];
  const sessions = sessionsWith({
    claude: { read: async () => ({ session: { agent: "claude", id: ID, cwd: "/p", status: "idle", inApp: false, effort: "medium" }, items: [], before: null }) },
    claudeHost: { drives: () => true, settingsOf: () => ({ model: null, effort: null, mode: null }), modeOf: () => null, send: async (id, message) => (sent.push(message), { turnId: null }) },
  });
  t.after(() => sessions.close());
  await sessions.send("claude", ID, { text: "go on" });
  assert.equal("effort" in sent.at(-1), false);
  await sessions.send("claude", ID, { text: "harder", effort: "high" });
  assert.equal(sent.at(-1).effort, "high");
});

// Review (Oct 9): a message the Claude app put in Claude Code's queue
// showed as waiting for good once that app crashed (no line ever took it).
// Shown only while another app's Claude Code holds the chat.
test("a chat's queued messages show only while another app's Claude Code holds it", async (t) => {
  const waiting = [{ id: "queued:0", text: "zq9", images: 0, at: 1 }];
  let holders = new Map();
  let drives = false;
  const sessions = sessionsWith({
    claude: { read: async () => ({ session: { agent: "claude", id: ID, cwd: "/p", status: "idle", waiting }, items: [], before: null }) },
    claudeHost: { drives: () => drives, running: () => drives, view: () => ({ status: "idle", version: 1, prompts: [], items: 0 }) },
    live: async () => holders,
  });
  t.after(() => sessions.close());
  const shown = async () => (await sessions.read("claude", ID)).session.waiting;
  assert.deepEqual(await shown(), []);
  holders = new Map([[ID, { where: "claude-app", pid: 7, exact: true, busy: true }]]);
  assert.deepEqual(await shown(), waiting);
  holders = new Map([[ID, { where: "reach", pid: 7, exact: true, busy: true }]]);
  assert.deepEqual(await shown(), []);
  drives = true;
  assert.deepEqual(await shown(), []);
});

test("Claude's catalog names no default effort: settings' effortLevel isn't what chats run at", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "reach-claude-effort-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const claudeSettingsPath = path.join(dir, "settings.json");
  await fs.writeFile(claudeSettingsPath, JSON.stringify({ effortLevel: "high" }));
  const sessions = sessionsWith({
    claudeSettingsPath,
    claudeHost: { models: async () => [{ value: "opus", resolvedModel: "claude-opus-5-5", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"] }], modes: async () => [] },
  });
  t.after(() => sessions.close());
  assert.equal((await sessions.models("claude")).models[0].defaultEffort, null);
});

test("a model pick the Mac can't take now says it wasn't changed, never that it goes in by itself; an effort pick needs no Mac", async (t) => {
  const automation = createDesktopAutomation();
  automation.noteForeground("com.apple.finder");
  let release;
  const held = automation.run(() => new Promise((r) => (release = r)));
  const native = { agent: "claude", id: ID, inApp: true, appTitle: "Chat", model: "claude-opus-5-5", effort: "medium" };
  // The Mac's: only there is the Claude app's own window worked (appWindow,
  // server/agent-sessions/index.mjs, decided as Reach starts); a Windows PC
  // is the test below.
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
  let sessions;
  try {
    sessions = sessionsWith({
      claude: { read: async () => ({ session: { ...native }, items: [] }) },
      claudeHost: { models: async () => [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5" }] },
      claudeOpen: async () => true,
      typeIntoApp: true, claudeCompose: {
        effort: (id, value) => automation.run(async () => ({ effort: value.effort })),
        model: (id, value) => automation.run(async () => ({ model: value.model })),
      },
    });
  } finally {
    Object.defineProperty(process, "platform", real);
  }
  t.after(() => { release(); sessions.close(); });
  // Effort: kept for the chat, never a click in the app (Oct 10).
  assert.deepEqual(await sessions.model("claude", ID, { effort: "high" }), { model: undefined, effort: "high", applied: true });
  for (const pick of [{ model: "sonnet" }])
    await assert.rejects(sessions.model("claude", ID, pick), (e) => {
      assert.equal(e.status, 409);
      assert.equal(e.kind, "busy");
      assert.doesNotMatch(e.message, /goes in by itself/);
      assert.match(e.message, /^Not changed: another chat is updating the Claude app\. Try again in a moment\.$/);
      return true;
    });
  release();
  await held;
});

// A Windows PC has no helper for the Claude app's own window yet: with the
// app open there, nothing goes to the Mac's helper (claude-compose.mjs).
test("on a Windows PC with the Claude app open, its window isn't worked: the model goes with the next message, Stop goes to Claude Code, a draft stays on the phone", async (t) => {
  const native = { agent: "claude", id: ID, inApp: true, appTitle: "Chat", model: "claude-opus-5-5", effort: "medium" };
  const stopped = [];
  const real = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32" });
  let sessions;
  try {
    sessions = sessionsWith({
      claude: { read: async () => ({ session: { ...native }, items: [] }) },
      claudeHost: { models: async () => [{ value: "sonnet", resolvedModel: "claude-sonnet-5-5" }], stop: async (id) => (stopped.push(id), { stopped: true }) },
      claudeOpen: async () => true,
      claudeCompose: {
        model: async () => assert.fail("picked in the app's menu"),
        draft: async () => assert.fail("typed into the app's box"),
        stop: async () => assert.fail("pressed the app's Stop"),
      },
    });
  } finally {
    Object.defineProperty(process, "platform", real);
  }
  t.after(() => sessions.close());
  assert.deepEqual(await sessions.model("claude", ID, { model: "sonnet" }), { model: "sonnet", effort: undefined, applied: false });
  assert.deepEqual(await sessions.draft("claude", ID, { text: "half a thought" }), { synced: false, supported: false });
  assert.deepEqual(await sessions.stop("claude", ID), { stopped: true });
  assert.deepEqual(stopped, [ID]);
});
