import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentSessions } from "../server/agent-sessions/index.mjs";
import { createClaudeSessions } from "../server/agent-sessions/claude.mjs";
import { createCodexLive } from "../server/agent-sessions/codex-live.mjs";
import { parseClaudeTranscript } from "../server/agent-sessions/claude-transcript.mjs";
import { createReach } from "../server/index.mjs";
import { ALL_SCOPES } from "../server/core.mjs";

// Continuing a chat with the other agent, as if forked in the same app: the
// new agent gets what the old one knows, in its own form; Reach shows the
// old messages above the new ones, once; the old chat says where it went.
const CLAUDE = "11111111-2222-4333-8444-555555555555";
const CODEX = "0199aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const NEW_CODEX = "0199ffff-bbbb-7ccc-8ddd-eeeeeeeeeeee";
const line = (o) => JSON.stringify(o);
const at = (s) => new Date(Date.UTC(2026, 9, 5, 10, 0, s)).toISOString();

function fakeDaemon(replies = {}) {
  const calls = [];
  return {
    calls,
    methods: () => calls.map(([method]) => method),
    async rpc(method, params) {
      calls.push([method, params]);
      const reply = replies[method];
      const value = typeof reply === "function" ? reply(params) : reply;
      if (value instanceof Error) throw value;
      return value ?? {};
    },
    onNotification() {},
    onRequest() {},
    onClose() {},
    close() {},
  };
}

// A Claude Code chat that compacted once: what came before is in its summary.
function claudeChat(dir) {
  const base = { sessionId: CLAUDE, cwd: "/work/app", entrypoint: "claude-desktop" };
  const said = (uuid, parentUuid, s, content) =>
    line({ ...base, type: "assistant", uuid, parentUuid, timestamp: at(s), message: { model: "claude-opus-5-5", role: "assistant", content } });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${CLAUDE}.jsonl`),
    [
      line({ type: "custom-title", customTitle: "Login page", sessionId: CLAUDE }),
      line({ ...base, type: "user", uuid: "u1", parentUuid: null, timestamp: at(1), message: { role: "user", content: "Build the login page" } }),
      said("a1", "u1", 2, [{ type: "text", text: "Done: the login page is built." }]),
      line({ ...base, type: "system", subtype: "compact_boundary", uuid: "b1", parentUuid: null, logicalParentUuid: "a1", timestamp: at(3) }),
      line({ ...base, type: "user", uuid: "s1", parentUuid: "b1", isCompactSummary: true, timestamp: at(4), message: { role: "user", content: "We built the login page together." } }),
      line({ ...base, type: "user", uuid: "u2", parentUuid: "s1", timestamp: at(5), message: { role: "user", content: "Now add tests" } }),
      said("a2", "u2", 6, [
        { type: "text", text: "Adding tests." },
        { type: "tool_use", id: "tu1", name: "Bash", input: { command: "npm test" } },
      ]),
      line({ ...base, type: "user", uuid: "r2", parentUuid: "a2", timestamp: at(7), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "all 12 passed" }] } }),
      said("a3", "r2", 8, [{ type: "text", text: "Tests pass." }]),
    ].join("\n") + "\n",
  );
}

const setup = (replies = {}, extra = {}, codexItems = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-move-"));
  const projects = path.join(root, "projects");
  claudeChat(path.join(projects, "-work-app"));
  const daemon = fakeDaemon({
    "model/list": { data: [{ id: "gpt-6-sol" }, { id: "gpt-6-astra", isDefault: true }] },
    "thread/fork": ({ path: file }) => {
      const imported = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse).filter(e => e.type === "response_item" && e.payload.type === "message").map((e, n) => ({ id: `imported-${n}`, role: e.payload.role, kind: "text", text: e.payload.content.filter(c => c.text).map(c => c.text).join("\n"), at: Date.parse(e.timestamp) }));
      codexItems[NEW_CODEX] = [...imported, ...(codexItems[NEW_CODEX] || [])];
      return { thread: { id: NEW_CODEX } };
    },
    ...replies,
  });
  const imported = [];
  const claude = createClaudeSessions({
    projects,
    appRecords: path.join(root, "records"),
    run: async (cmd, args) => ({ stdout: args[0] === "--version" ? "2.1.289 (Claude Code)\n" : '{"loggedIn":true}' }),
  });
  const sessions = createAgentSessions({
    daemon,
    codexLive: createCodexLive({ daemon }),
    claude,
    codex: {
      read: async (id, { before, cursor, limit = 200 } = {}) => {
        const all = codexItems[id] || []; const end = Number(before ?? cursor ?? all.length); const start = Math.max(0, end - limit);
        return { session: { agent: "codex", id, title: "New thread", cwd: "/work/app", status: "idle" }, items: all.slice(start, end), before: start ? String(start) : null };
      },
      list: async () => [{ agent: "codex", id: NEW_CODEX, title: "Login page", updatedAt: 9, status: "idle" }],
      health: async () => ({ agent: "codex", signedIn: true }),
    },
    live: async () => new Map(),
    detect: async () => [],
    dataDir: root,
    claudeImports: { add: async (id) => imported.push(id), close() {} },
    ...extra,
  });
  return { root, projects, daemon, sessions, imported, claude };
};
const text = (items) => items.map((i) => `${i.role}:${i.kind}:${i.text}`);

test("Claude to Codex preserves visible pre-compaction messages and full tool output using a native fork", async () => {
  const { root, daemon, sessions } = setup();
  assert.deepEqual(await sessions.move("claude", CLAUDE, { to: "codex" }), { agent: "codex", id: NEW_CODEX });
  assert.deepEqual(daemon.methods(), ["model/list", "thread/fork", "thread/name/set", "thread/unsubscribe"]);
  const params = daemon.calls[1][1];
  assert.equal(params.model, "gpt-6-astra");
  assert.ok(!("approvalPolicy" in params) && !("sandbox" in params));
  const archive = fs.readFileSync(params.path, "utf8");
  for (const content of ["Build the login page", "Done: the login page is built.", "Now add tests", "all 12 passed", "Tests pass."]) assert.ok(archive.includes(content), content);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an oversized Claude transfer continues from its compaction summary without losing the full archive", async t => {
  const { root, projects, daemon, sessions } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(projects, "-work-app", `${CLAUDE}.jsonl`);
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const original = rows.find(row => row.uuid === "a1");
  original.message.content[0].text += "x".repeat(600_000);
  fs.writeFileSync(file, rows.map(line).join("\n") + "\n");
  await sessions.move("claude", CLAUDE, { to: "codex", resume: true });
  const params = daemon.calls.find(([method]) => method === "thread/fork")[1];
  const imported = fs.readFileSync(params.path, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(imported.find(row => row.type === "response_item" && row.payload.role === "assistant").payload.content[0].text, original.message.content[0].text);
  const compact = imported.at(-1);
  assert.equal(compact.type, "compacted");
  const context = compact.payload.replacement_history.map(t => t.content[0].text).join("\n");
  assert.match(context, /We built the login page together\./);
  assert.match(context, /Now add tests/);
  assert.match(context, /Tests pass\./);
  assert.doesNotMatch(context, /xxxx/);
  assert.ok(daemon.calls.some(([method]) => method === "turn/start"));
});

test("a large imported Codex fork excludes future messages from its compacted Claude context", async t => {
  const codexItems = {};
  const { root, projects, sessions, claude } = setup({}, {}, codexItems);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(projects, "-work-app", `${CLAUDE}.jsonl`);
  const rows = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  rows.find(row => row.uuid === "a1").message.content[0].text += "x".repeat(600_000);
  fs.writeFileSync(file, rows.map(line).join("\n") + "\n");
  await sessions.move("claude", CLAUDE, { to: "codex" });
  codexItems[NEW_CODEX].push({ id: "future", role: "user", kind: "text", text: "Future request must stay out" });
  const fork = await sessions.fork("codex", NEW_CODEX, { to: "claude", through: "imported-1" });
  const archive = await claude.history(fork.id);
  assert.ok(archive.memory, "the selected history is large enough to need bounded context");
  assert.match(archive.memory.summary, /Build the login page/);
  assert.doesNotMatch(archive.memory.summary, /Future request|Now add tests|Tests pass/);
  assert.ok(!archive.items.some(item => /Future request|Now add tests/.test(item.text)), "the complete visible archive stops at the selected reply too");
});

test("a moved chat remains readable without the source and pages its own complete history exactly once", async () => {
  const { root, projects, sessions } = setup();
  await sessions.move("claude", CLAUDE, { to: "codex" });
  const old = await sessions.read("claude", CLAUDE, {});
  assert.deepEqual(old.session.movedTo.map(m => [m.agent, m.id]), [["codex", NEW_CODEX]]);
  const before = await sessions.read("codex", NEW_CODEX, {});
  fs.renameSync(path.join(projects, "-work-app"), path.join(root, "source-retired"));
  const pages = []; let cursor;
  do { const p = await sessions.read("codex", NEW_CODEX, { limit: 3, before: cursor }); pages.unshift(p.items); cursor = p.before; } while (cursor);
  assert.deepEqual(text(pages.flat()), text(before.items));
  assert.equal(pages.flat().filter(i => i.text === "Build the login page").length, 1);
  assert.deepEqual(before.session.movedFrom, { agent: "claude", id: CLAUDE, title: "Login page" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("there and back preserves the full original conversation plus the new agent's replies", async () => {
  const codexItems = {};
  const { root, sessions } = setup({}, {}, codexItems);
  await sessions.move("claude", CLAUDE, { to: "codex" });
  codexItems[NEW_CODEX].push({ id: "new-user", role: "user", kind: "text", text: "Ship it" }, { id: "new-answer", role: "assistant", kind: "text", text: "Shipped." });
  const back = await sessions.move("codex", NEW_CODEX, { to: "claude" });
  const page = await sessions.read("claude", back.id, {});
  const all = page.items.map(i => i.text).join("\n");
  for (const content of ["Build the login page", "all 12 passed", "Ship it", "Shipped."]) assert.ok(all.includes(content), content);
  assert.equal(page.items.filter(i => i.text === "Build the login page").length, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("a failed native fork does not mark a conversation moved or retry by silently dropping history", async () => {
  const { root, daemon, sessions } = setup({ "thread/fork": new Error("Import failed") });
  await assert.rejects(sessions.move("claude", CLAUDE, { to: "codex" }), /Import failed/);
  assert.ok(!daemon.methods().includes("thread/inject_items"));
  assert.equal((await sessions.read("codex", NEW_CODEX, {})).session.movedFrom, undefined);
  await assert.rejects(sessions.move("claude", CLAUDE, { to: "claude" }), e => e.status === 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test("Codex to Claude Code: a transcript of its own (the move noted first), in the Claude app's list once nobody is at the Mac", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-move-"));
  const projects = path.join(root, "projects");
  const imported = [];
  // A Codex thread read in pages, newest first.
  const pages = {
    null: { items: [{ id: "c3", role: "user", kind: "text", text: "Ship it" }, { id: "c4", role: "assistant", kind: "text", text: "Shipped." }], before: "p2" },
    p2: {
      items: [
        { id: "c1", role: "user", kind: "text", text: "Fix CI" },
        { id: "c2", role: "tool", kind: "command", text: "npm test", status: "failed" },
        { id: "c2b", role: "assistant", kind: "text", text: "Fixed the flaky test." },
      ],
      before: null,
    },
  };
  const claude = createClaudeSessions({
    projects,
    appRecords: path.join(root, "records"),
    run: async (cmd, args) => ({ stdout: args[0] === "--version" ? "2.1.289 (Claude Code)\n" : '{"loggedIn":true}' }),
  });
  const sessions = createAgentSessions({
    daemon: fakeDaemon(),
    claude,
    codex: {
      read: async (id, { cursor = null } = {}) => ({
        session: { agent: "codex", id, title: "Fix CI", cwd: root, status: "idle", model: "gpt-6-astra" },
        ...pages[cursor],
      }),
      list: async () => [],
      health: async () => ({ agent: "codex", signedIn: true }),
    },
    live: async () => new Map(),
    detect: async () => [],
    dataDir: root,
    claudeImports: { add: async (id) => imported.push(id), close() {} },
  });
  const moved = await sessions.move("codex", CODEX, { to: "claude" });
  assert.equal(moved.agent, "claude");
  assert.deepEqual(imported, [moved.id]);
  const folder = path.join(projects, fs.realpathSync(root).replace(/[^a-zA-Z0-9]/g, "-"));
  const written = parseClaudeTranscript(fs.readFileSync(path.join(folder, `${moved.id}.jsonl`), "utf8"));
  assert.equal(written.title, "Fix CI");
  assert.deepEqual(text(written.items), [
    "user:text:Fix CI", "assistant:text:[Historical command · failed]\nnpm test", "assistant:text:Fixed the flaky test.", "user:text:Ship it", "assistant:text:Shipped.", "assistant:text:Continued with Claude Code · earlier messages are from Codex",
  ]);
  const page = await sessions.read("claude", moved.id, {});
  assert.deepEqual(text(page.items), text(written.items));
  // Claude Code carries on in it: its own messages follow.
  const file = path.join(folder, `${moved.id}.jsonl`);
  const lastUuid = JSON.parse(fs.readFileSync(file, "utf8").trim().split("\n").at(-1)).uuid;
  fs.appendFileSync(
    file,
    [
      line({ type: "user", uuid: "n1", parentUuid: lastUuid, sessionId: moved.id, cwd: root, timestamp: new Date().toISOString(), message: { role: "user", content: "And the docs?" } }),
      line({ type: "assistant", uuid: "n2", parentUuid: "n1", sessionId: moved.id, cwd: root, timestamp: new Date().toISOString(), message: { model: "claude-opus-5-5", role: "assistant", content: [{ type: "text", text: "Updated." }] } }),
    ].join("\n") + "\n",
  );
  assert.deepEqual(text((await sessions.read("claude", moved.id, {})).items).slice(-3), [
    "assistant:text:Continued with Claude Code · earlier messages are from Codex",
    "user:text:And the docs?",
    "assistant:text:Updated.",
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("moving a chat is the owner's alone, like every session", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-move-route-"));
  const calls = [];
  const reach = await createReach({
    roots: [root],
    dataDir: path.join(root, ".reach"),
    agentSessions: { move: async (agent, id, body) => (calls.push([agent, id, body]), { agent: "codex", id: NEW_CODEX }) },
  });
  await new Promise((r) => reach.server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${reach.server.address().port}`;
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const move = (token) =>
    fetch(`${url}/api/sessions/claude/${CLAUDE}/move`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: "codex" }),
    });
  try {
    assert.equal((await move(agent.token)).status, 403);
    const r = await move(owner.token);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { agent: "codex", id: NEW_CODEX });
    assert.equal(typeof calls[0][2].authorize, "function");
    assert.deepEqual(calls.map(([agent, id, { to }]) => [agent, id, { to }]), [["claude", CLAUDE, { to: "codex" }]]);
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a move asked to keep going tells the new agent to continue, and a failed message leaves the move done", async () => {
  const { root, daemon, sessions } = setup({
    "thread/resume": ({ threadId }) => ({ thread: { id: threadId, turns: [] } }),
    "turn/start": () => ({ turn: { id: "turn-9", status: "inProgress", items: [] } }),
  });
  const moved = await sessions.move("claude", CLAUDE, { to: "codex", resume: true, owner: "phone" });
  assert.deepEqual([moved.agent, moved.id, moved.resumed], ["codex", NEW_CODEX, true]);
  const started = daemon.calls.find(([method]) => method === "turn/start");
  assert.ok(started, "a turn started in the new chat");
  assert.equal(started[1].threadId, NEW_CODEX);
  assert.match(JSON.stringify(started[1].input), /Continue where Claude Code left off/);
  fs.rmSync(root, { recursive: true, force: true });

  // The message can't go: the move stands, and says why.
  const failing = setup({ "turn/start": new Error("Codex is busy.") });
  const kept = await failing.sessions.move("claude", CLAUDE, { to: "codex", resume: true });
  assert.deepEqual([kept.agent, kept.id, kept.resumed], ["codex", NEW_CODEX, false]);
  assert.match(kept.resumeError, /busy/);
  fs.rmSync(failing.root, { recursive: true, force: true });
});

test("forking an earlier message into another app excludes later messages and tool results", async t => {
  const { root, daemon, sessions } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await sessions.fork("claude", CLAUDE, { to: "codex", through: "a1:0" });
  const params = daemon.calls.find(([m]) => m === "thread/fork")[1];
  const archive = fs.readFileSync(params.path, "utf8");
  assert.match(archive, /Build the login page/);
  assert.match(archive, /Done: the login page is built/);
  assert.doesNotMatch(archive, /Now add tests|all 12 passed|Tests pass/);
  const source = await sessions.read("claude", CLAUDE, {});
  assert.ok(source.items.some(i => i.text === "Tests pass."));
  assert.equal(source.session.movedTo[0].upTo, "a1:0");
  assert.equal(source.session.movedTo[0].fork, true);
});

test("Claude's native fork keeps compaction and complete tool records without rewriting the source", async t => {
  const { root, projects, sessions } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(projects, "-work-app");
  const source = fs.readFileSync(path.join(dir, `${CLAUDE}.jsonl`), "utf8");
  const fork = await sessions.fork("claude", CLAUDE, { to: "claude" });
  const rows = fs.readFileSync(path.join(dir, `${fork.id}.jsonl`), "utf8").trim().split("\n").map(JSON.parse);
  const original = source.trim().split("\n").map(JSON.parse);
  assert.deepEqual(rows.map(row => ({ ...row, sessionId: CLAUDE })), original);
  assert.equal(fs.readFileSync(path.join(dir, `${CLAUDE}.jsonl`), "utf8"), source);
  const page = await sessions.read("claude", fork.id, {});
  assert.ok(page.items.some(i => i.detail?.includes("all 12 passed")));
  assert.equal(page.session.model, "claude-opus-5-5");
});

test("Claude forks precisely at a text block, including earlier context but no subsequent tool calls", async t => {
  const { root, projects, sessions } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fork = await sessions.fork("claude", CLAUDE, { through: "a2:0" });
  const archive = fs.readFileSync(path.join(projects, "-work-app", `${fork.id}.jsonl`), "utf8");
  const last = JSON.parse(archive.trim().split("\n").at(-1));
  assert.deepEqual(last.message.content, [{ type: "text", text: "Adding tests." }]);
  assert.match(archive, /isCompactSummary/);
  assert.doesNotMatch(archive, /tool_use|all 12 passed|Tests pass/);
});

test("Codex forks natively through the selected completed turn, preserving native context", async t => {
  const items = [
    { id: "u1", turnId: "t1", role: "user", kind: "text", text: "First" },
    { id: "a1", turnId: "t1", role: "assistant", kind: "text", text: "Answer" },
    { id: "u2", turnId: "t2", role: "user", kind: "text", text: "Later" },
  ];
  const { root, daemon, sessions } = setup({ "thread/fork": { thread: { id: NEW_CODEX } } }, {}, { [CODEX]: items });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(sessions.fork("codex", CODEX, { through: "u1" }), /complete turns/);
  assert.equal(daemon.calls.length, 0, "never silently includes a later reply");
  await sessions.fork("codex", CODEX, { through: "a1" });
  assert.deepEqual(daemon.calls.find(([m]) => m === "thread/fork")[1], { threadId: CODEX, lastTurnId: "t1", excludeTurns: true });
});

test("invalid fork points fail before creating a chat", async t => {
  const { root, daemon, sessions } = setup();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await assert.rejects(sessions.fork("claude", CLAUDE, { to: "codex", through: "missing" }), e => e.status === 404);
  await assert.rejects(sessions.fork("claude", CLAUDE, { through: {} }), e => e.status === 400);
  assert.equal(daemon.calls.length, 0);
});

test("OpenClaw forks carry long tool output without clipping; incomplete source history is refused", async t => {
  const output = "tool output ".repeat(10000);
  const forks = [];
  const openClaw = { canMove: () => true, fork: async body => (forks.push(body), { key: "new-claw" }), history: async () => ({ items: [], mayHaveOlder: true }) };
  const { root, sessions } = setup({}, { openClaw }, { [CODEX]: [
    { id: "u1", role: "user", kind: "text", text: "Run it" },
    { id: "tool1", role: "tool", kind: "command", text: "test", detail: output },
  ] });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await sessions.fork("codex", CODEX, { to: "openclaw" });
  assert.ok(forks[0].notes.slice(1).join("").includes(output));
  assert.ok(forks[0].notes.every(note => note.length <= 50000));
  await assert.rejects(sessions.fork("openclaw", "source", { to: "codex" }), /complete history/);
  assert.equal(forks.length, 1);
});

test("fork routes require the owner and pass the exact selected point with reauthorization", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "reach-fork-route-"));
  const calls = [];
  const reach = await createReach({ roots: [root], dataDir: path.join(root, ".reach"),
    agentSessions: { fork: async (...args) => (calls.push(args), { agent: "codex", id: NEW_CODEX }) } });
  await new Promise(r => reach.server.listen(0, "127.0.0.1", r));
  t.after(async () => { reach.server.close(); await reach.close?.(); fs.rmSync(root, { recursive: true, force: true }); });
  const owner = reach.auth.issue("owner", ALL_SCOPES);
  const agent = reach.auth.issue("agent", ["terminal", "files"], "agent");
  const fork = token => fetch(`http://127.0.0.1:${reach.server.address().port}/api/sessions/claude/${CLAUDE}/fork`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ to: "codex", through: "a1:0" }),
  });
  assert.equal((await fork(agent.token)).status, 403);
  assert.equal(calls.length, 0);
  assert.equal((await fork(owner.token)).status, 200);
  assert.equal(calls[0][2].through, "a1:0");
  assert.equal(typeof calls[0][2].authorize, "function");
});
