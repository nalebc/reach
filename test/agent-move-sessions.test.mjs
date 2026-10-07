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
  return { root, projects, daemon, sessions, imported };
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
    assert.deepEqual(calls, [["claude", CLAUDE, { to: "codex" }]]);
  } finally {
    reach.server.close();
    await reach.close?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
